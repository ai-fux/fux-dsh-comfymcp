/**
 * 本地 defineTool：与 @deepseek-ai/dsh-tools 的 defineTool 等价的最小子集，
 * 让插件入口零外部 bare import（宿主进程里裸包名解析可能命中负缓存）。
 * 方言：parameters 为 {type:'object', properties:{k:{...,required:true}}}；
 * 转换把 property 上的 required 标记提升为 JSON Schema 的 required 数组，
 * 其余字段原样透传（已是普通 JSON Schema）。
 */

function compileNode(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
  const { required, ...rest } = node
  const out = {}
  for (const [key, value] of Object.entries(rest)) {
    if (key === 'type' && value === 'json') {
      // DSH 方言：json = 任意 JSON 值，编译为仅带注解的无类型 schema
      continue
    }
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.properties = {}
      for (const [name, prop] of Object.entries(value)) out.properties[name] = compileNode(prop)
    } else if (key === 'items') {
      out.items = compileNode(value)
    } else {
      out[key] = value
    }
  }
  if (required === true) out.__required = true
  return out
}

function parameterSchemaToJsonSchema(spec) {
  const compiled = compileNode(spec ?? {})
  const properties = compiled.properties ?? {}
  const required = Object.entries(properties)
    .filter(([, prop]) => prop !== null && typeof prop === 'object' && prop.__required === true)
    .map(([name]) => name)
  for (const prop of Object.values(properties)) {
    if (prop !== null && typeof prop === 'object') delete prop.__required
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

const TYPE_CHECKS = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  boolean: (value) => typeof value === 'boolean',
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: (value) => Array.isArray(value),
}

/** Light validation mirroring the registry contract: required presence + top-level types. */
function validateArgs(schema, args, toolName) {
  const violations = []
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return [`${toolName}: arguments must be an object`]
  }
  for (const name of schema.required ?? []) {
    if (args[name] === undefined) violations.push(`${toolName}: missing required argument "${name}"`)
  }
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const value = args[name]
    if (value === undefined) continue
    const check = TYPE_CHECKS[prop?.type]
    if (check !== undefined && !check(value)) {
      violations.push(`${toolName}: argument "${name}" must be of type ${prop.type}`)
    }
  }
  return violations
}

/**
 * Build a registry-ready tool definition. Signature-compatible with the
 * subset of @deepseek-ai/dsh-tools defineTool that this plugin uses.
 */
export function defineTool(options) {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
  }
  const parameters = parameterSchemaToJsonSchema(options.parameters)
  const outputSchema = compileNode(options.output.schema ?? {})
  if (outputSchema && typeof outputSchema === 'object') delete outputSchema.__required
  const definition = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value),
    },
  }
  if (options.output.presentationMeta !== undefined) {
    definition.output.presentationMeta = (args, value) => options.output.presentationMeta(args, value)
  }
  if (options.timeoutMs !== undefined) definition.timeoutMs = options.timeoutMs
  definition.execute = async (args, exec) => {
    const violations = validateArgs(parameters, args, options.name)
    if (violations.length > 0) {
      const error = new Error(`invalid arguments: ${violations.join('; ')}`)
      error.name = 'ToolArgsError'
      error.violations = violations
      throw error
    }
    return options.execute(args, exec)
  }
  return definition
}
