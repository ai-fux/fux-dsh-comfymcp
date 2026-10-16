/**
 * 节点目录适配器：把「官方解析」的多种真实形状统一为插件的扁平输入模型。
 *
 * 已实证的形状（scripts/probe-node-info.mjs 抓取）：
 * 1) 内嵌链路 node_info → { nodes: { Cls: { classType, displayName, inputs: [
 *      { name, group, type: 'COMBO', options: [...] }            枚举=COMBO+options
 *      { name, type: 'INT'|'FLOAT'|'STRING'|'BOOLEAN'|'MODEL',   标量/链接
 *        required, default, min, max, step, tooltip } ] } }, missing: [] }
 * 2) 旧约定：type 为数组（即枚举选项列表）
 * 3) 官方 ComfyUI object_info 裸形状：{ Cls: { input: { required: { name: [type, cfg] },
 *      optional: { ... } }, input_order, output, output_name } }
 * 4) 分页行形状：{ rows: [ { classType | class_type, inputs: [...] } ] }
 * 统一输出：{ Cls: { classType, displayName, inputs: [{name,type,required,default,
 *   min,max,step,options,group,tooltip}] } }——resolveNodeInfo 取单类。
 */

function normalizeInput(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const name = String(entry.name ?? '')
  if (name.length === 0) return null
  let type = entry.type
  let options
  if (Array.isArray(type)) {
    options = type.map((item) => String(item))
    type = 'COMBO'
  } else {
    type = String(type ?? '').toUpperCase()
    if (type === 'COMBO' && Array.isArray(entry.options)) {
      options = entry.options.map((item) => String(item))
    }
  }
  return {
    name,
    type,
    required: entry.required === true || String(entry.group ?? '') === 'required',
    ...(entry.default !== undefined ? { default: entry.default } : {}),
    ...(entry.min !== undefined ? { min: entry.min } : {}),
    ...(entry.max !== undefined ? { max: entry.max } : {}),
    ...(entry.step !== undefined ? { step: entry.step } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(entry.group !== undefined ? { group: String(entry.group) } : {}),
    ...(entry.tooltip !== undefined ? { tooltip: String(entry.tooltip) } : {}),
  }
}

/** 官方 object_info 单类形状 → 扁平输入数组。 */
function inputsFromObjectInfo(node) {
  const input = node?.input
  if (input === null || typeof input !== 'object') return []
  const fields = []
  for (const kind of ['required', 'optional']) {
    const bucket = input[kind]
    if (bucket === null || typeof bucket !== 'object') continue
    for (const [name, spec] of Object.entries(bucket)) {
      let type = spec
      let config = {}
      if (Array.isArray(spec)) {
        if (spec.length > 0 && Array.isArray(spec[0])) {
          // COMBO：type 本身是选项数组，cfg 在第二位
          type = spec[0]
          config = spec[1] !== null && typeof spec[1] === 'object' ? spec[1] : {}
        } else if (spec.length > 0 && typeof spec[0] === 'string' && spec[0].toUpperCase() === 'COMBO') {
          type = spec[1]
          config = spec[2] !== null && typeof spec[2] === 'object' ? spec[2] : {}
        } else {
          type = spec[0]
          config = spec[1] !== null && typeof spec[1] === 'object' ? spec[1] : {}
        }
      }
      const normalized = normalizeInput({
        name,
        type,
        group: kind,
        required: kind === 'required',
        ...(config !== null && typeof config === 'object'
          ? {
              default: config.default,
              min: config.min,
              max: config.max,
              step: config.step,
              ...(Array.isArray(type) ? {} : { options: config.options }),
              tooltip: config.tooltip ?? config.label,
            }
          : {}),
      })
      if (normalized !== null) fields.push(normalized)
    }
  }
  return fields
}

function normalizeClassEntry(classType, entry) {
  if (entry === null || typeof entry !== 'object') return null
  const inputs = Array.isArray(entry.inputs) ? entry.inputs.map(normalizeInput).filter(Boolean) : inputsFromObjectInfo(entry)
  return {
    classType: String(entry.classType ?? entry.class_type ?? classType),
    displayName: String(entry.displayName ?? entry.classType ?? entry.class_type ?? classType),
    ...(entry.category !== undefined ? { category: String(entry.category) } : {}),
    inputs,
  }
}

/**
 * 适配整本节点目录。接受形状 1/2/3/4；无法识别时返回 {}（调用方退化为图内标量）。
 */
export function normalizeNodeCatalog(raw) {
  const source = raw === null || typeof raw !== 'object' ? {} : raw
  let entries = null
  if (source.nodes !== null && typeof source.nodes === 'object' && !Array.isArray(source.nodes)) {
    entries = Object.entries(source.nodes)
  } else if (Array.isArray(source.rows)) {
    entries = source.rows.map((row) => [String(row?.classType ?? row?.class_type ?? ''), row])
  } else if (Object.keys(source).length > 0 && !('error' in source)) {
    // 官方 object_info 裸形状：顶层直接是类名 → 类定义
    entries = Object.entries(source)
  }
  if (entries === null) return {}
  const catalog = {}
  for (const [classType, entry] of entries) {
    if (classType.length === 0 || entry === null || typeof entry !== 'object') continue
    const normalized = normalizeClassEntry(classType, entry)
    if (normalized !== null) catalog[classType] = normalized
  }
  return catalog
}

/** 取单类（精确名 → 大小写不敏感兜底）。 */
export function resolveNodeInfo(catalog, classType) {
  if (catalog === null || typeof catalog !== 'object') return null
  const direct = catalog[classType]
  if (direct !== undefined) return direct
  const lower = String(classType ?? '').toLowerCase()
  for (const [key, entry] of Object.entries(catalog)) {
    if (key.toLowerCase() === lower || String(entry?.classType ?? '').toLowerCase() === lower) return entry
  }
  return null
}
