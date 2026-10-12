/**
 * 工作流图格式适配：ComfyUI 前端「UI 格式」→ 后端「API 格式」，含内联子图展平。
 *
 * UI 格式（ComfyUI 保存在 user/default/workflows 的文件）：
 *   { nodes: [ { id, type, inputs: [ {name,type,link,widget:{name}} ], widgets_values: [...] } ],
 *     links: [ [linkId, originId, originSlot, targetId, targetSlot, type] ],
 *     definitions: { subgraphs: [ { id, inputs, outputs, nodes, links, inputNode:{id:-10}, outputNode:{id:-20} } ] } }
 * API 格式（可提交执行）：{ "<nodeId>": { class_type, inputs: { field: value | [originId, slot] } } }
 *
 * 子图（subgraph）展平规则（依据实机 image_z_image.json 结构）：
 * - 子图节点 type = 定义 id（UUID）；
 * - 定义内虚拟边界节点：inputNode(-10) 只作为内部链路的 origin，outputNode(-20) 只作为 target；
 * - def.inputs[i].linkIds 指向「-10 → 内部节点」的链路，槽位序即外节点 inputs 的序：
 *     外节点该输入有 link → 取外部引用；无 link（widget）→ 取外节点 widgets_values 中同名字段的值；
 * - 外节点 outputs[s].links 的外部链路 → 重映射到「产生该输出的内部节点 + 槽位」；
 * - 内部节点 id 加前缀 `<外节点id>:`，可嵌套递归展平。
 */

const SKIP_TYPES = /^(MarkdownNote|Note|NotePlus|PrimitiveNode|Reroute|ReroutePrimitive|PreviewAny)$/
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i
/** ComfyUI 前端在 seed 之后插入的隐藏控件值（不是后端输入）。 */
const HIDDEN_CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize'])

/** 是否为 ComfyUI UI 格式工作流。 */
export function isUiWorkflow(raw) {
  return raw !== null && typeof raw === 'object' && Array.isArray(raw.nodes)
}

/** 是否为 API 格式图（形如 { "3": { class_type, inputs } }）。 */
export function isApiGraph(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const values = Object.values(raw)
  return values.length > 0 && values.every((node) => node !== null && typeof node === 'object' && typeof node.class_type === 'string')
}

/** linkId → [String(originId), originSlot]。 */
function linkMapOf(links) {
  const map = new Map()
  for (const link of Array.isArray(links) ? links : []) {
    if (Array.isArray(link) && link.length >= 5) map.set(link[0], [String(link[1]), link[2]])
    else if (link !== null && typeof link === 'object' && link.id !== undefined) map.set(link.id, [String(link.origin_id), link.origin_slot])
  }
  return map
}

/** 写入 API 输入：含点号的虚拟输入（如 values.a）折叠为父级对象（values:{a:...}）。 */
function setInput(inputs, name, value) {
  const dot = name.indexOf('.')
  if (dot <= 0) {
    inputs[name] = value
    return
  }
  const parent = name.slice(0, dot)
  const leaf = name.slice(dot + 1)
  if (inputs[parent] === null || typeof inputs[parent] !== 'object' || Array.isArray(inputs[parent])) inputs[parent] = {}
  inputs[parent][leaf] = value
}

/** widget 名顺序 + widgets_values 对齐（剔除 seed 后的隐藏控件位）。 */
function widgetPairs(node) {
  const names = []
  for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
    if (input !== null && typeof input === 'object' && input.widget !== null && typeof input.widget === 'object' && typeof input.widget.name === 'string') {
      names.push(input.widget.name)
    }
  }
  const rawValues = Array.isArray(node.widgets_values) ? node.widgets_values : []
  const pairs = []
  let index = 0
  for (const value of rawValues) {
    if (typeof value === 'string' && HIDDEN_CONTROL_VALUES.has(value) && pairs.length > 0 && /seed/i.test(names[index - 1] ?? '')) continue
    if (index >= names.length) break
    pairs.push([names[index], value])
    index += 1
  }
  return { names, pairs }
}

/**
 * UI 格式 → API 格式（含子图展平）。
 * @returns { graph, skipped, unsupported, incomplete, subgraphs, converted }
 */
export function apiGraphFromUi(raw) {
  if (!isUiWorkflow(raw)) {
    return isApiGraph(raw)
      ? { graph: raw, skipped: [], unsupported: [], incomplete: [], subgraphs: 0, converted: false }
      : { graph: null, skipped: [], unsupported: [], incomplete: [], subgraphs: 0, converted: false }
  }
  const definitions = new Map()
  for (const definition of Object.values(raw.definitions?.subgraphs ?? {})) {
    if (definition !== null && typeof definition === 'object' && definition.id !== undefined) definitions.set(String(definition.id), definition)
  }
  const linkRefs = linkMapOf(raw.links)
  const nodeById = new Map()
  for (const node of raw.nodes) {
    if (node !== null && typeof node === 'object' && node.id !== undefined) nodeById.set(String(node.id), node)
  }
  const graph = {}
  const skipped = []
  const unsupported = []
  const incomplete = []
  let subgraphs = 0
  const topLevelIds = new Set()

  /** 递归展开；返回该节点自身的 API id（子图无自身节点，返回 null）。 */
  function expand(node, prefix) {
    const type = String(node.type ?? '')
    const rawId = String(node.id ?? '')
    if (type.length === 0 || rawId.length === 0) return null
    if (SKIP_TYPES.test(type)) {
      skipped.push(`${prefix}${type}`)
      return null
    }
    if (node.mode === 2 || node.mode === 4) {
      skipped.push(`${prefix}${type}(mode=${node.mode})`)
      return null
    }
    const definition = definitions.get(type)
    if (definition === undefined) {
      if (UUID_LIKE.test(type)) {
        unsupported.push(type)
        return null
      }
      const { pairs } = widgetPairs(node)
      const rawValues = Array.isArray(node.widgets_values) ? node.widgets_values : []
      if (rawValues.length > 0 && pairs.length === 0) incomplete.push(`${prefix}${type}`)
      const inputs = {}
      for (const [name, value] of pairs) setInput(inputs, name, value)
      for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
        if (input === null || typeof input !== 'object' || input.link === null || input.link === undefined) continue
        const name = String(input.name ?? input.widget?.name ?? '')
        if (name.length === 0) continue
        const ref = resolveRef(input.link)
        if (ref !== null) setInput(inputs, name, ref)
      }
      graph[`${prefix}${rawId}`] = { class_type: type, inputs }
      if (prefix.length === 0) topLevelIds.add(rawId)
      return `${prefix}${rawId}`
    }
    // ---- 子图展开 ----
    subgraphs += 1
    const innerPrefix = `${prefix}${rawId}:`
    const { names, pairs } = widgetPairs(node)
    const outerWidgets = new Map(pairs)
    const outerInputs = Array.isArray(node.inputs) ? node.inputs : []
    const promotedValues = []
    const defInputs = Array.isArray(definition.inputs) ? definition.inputs : []
    for (let i = 0; i < defInputs.length; i += 1) {
      const defInput = defInputs[i]
      const outerEntry = outerInputs[i]
      let value
      if (outerEntry !== null && typeof outerEntry === 'object' && outerEntry.link !== null && outerEntry.link !== undefined) {
        value = resolveRef(outerEntry.link)
      } else if (outerWidgets.has(String(defInput?.name ?? ''))) {
        value = outerWidgets.get(String(defInput?.name ?? ''))
      } else if (names.length === 0) {
        const rawValues = Array.isArray(node.widgets_values) ? node.widgets_values : []
        if (i < rawValues.length) value = rawValues[i]
      }
      promotedValues.push(value === undefined ? null : value)
    }
    const innerLinks = linkMapOf(definition.links)
    const innerInputs = new Map()
    for (const [linkId, ref] of innerLinks) {
      const [originId, originSlot] = ref
      if (originId === String(definition.inputNode?.id ?? -10)) {
        const value = promotedValues[originSlot]
        if (value !== undefined && value !== null) innerInputs.set(linkId, Array.isArray(value) ? value : value)
        else innerInputs.set(linkId, undefined)
      } else {
        innerInputs.set(linkId, [`${innerPrefix}${originId}`, originSlot])
      }
    }
    for (const inner of Array.isArray(definition.nodes) ? definition.nodes : []) {
      const innerType = String(inner?.type ?? '')
      const innerId = String(inner?.id ?? '')
      if (innerId.length === 0 || innerType.length === 0) continue
      if (SKIP_TYPES.test(innerType)) {
        skipped.push(`${innerPrefix}${innerType}`)
        continue
      }
      if (inner.mode === 2 || inner.mode === 4) {
        skipped.push(`${innerPrefix}${innerType}(mode=${inner.mode})`)
        continue
      }
      if (definitions.has(innerType)) {
        expand(inner, innerPrefix) // 嵌套子图
        continue
      }
      const { pairs: innerPairs } = widgetPairs(inner)
      const inputs = {}
      for (const [name, value] of innerPairs) setInput(inputs, name, value)
      for (const input of Array.isArray(inner.inputs) ? inner.inputs : []) {
        if (input === null || typeof input !== 'object' || input.link === null || input.link === undefined) continue
        const name = String(input.name ?? input.widget?.name ?? '')
        if (name.length === 0) continue
        const value = innerInputs.get(input.link)
        if (value === undefined) continue
        setInput(inputs, name, value)
      }
      graph[`${innerPrefix}${innerId}`] = { class_type: innerType, inputs }
    }
    // 子图输出 → 外部链路重映射
    const outerOutputs = Array.isArray(node.outputs) ? node.outputs : []
    const defOutputs = Array.isArray(definition.outputs) ? definition.outputs : []
    for (let s = 0; s < defOutputs.length; s += 1) {
      const linkIds = Array.isArray(defOutputs[s]?.linkIds) ? defOutputs[s].linkIds : []
      for (const innerLinkId of linkIds) {
        const innerRef = innerLinks.get(innerLinkId)
        if (innerRef === undefined) continue
        const [originId, originSlot] = innerRef
        if (originId === String(definition.inputNode?.id ?? -10)) continue
        const target = [`${innerPrefix}${originId}`, originSlot]
        for (const externalLinkId of Array.isArray(outerOutputs[s]?.links) ? outerOutputs[s].links : []) linkRefs.set(externalLinkId, target)
      }
    }
    return null
  }

  /** 解析链路引用；若来源是尚未展开的子图则先展开。 */
  function resolveRef(linkId) {
    const cached = linkRefs.get(linkId)
    if (cached !== undefined && !String(cached[0]).startsWith('-')) return cached
    const source = nodeById.get(String(cached?.[0] ?? ''))
    if (source !== undefined) {
      expand(source, '')
      const again = linkRefs.get(linkId)
      if (again !== undefined && !String(again[0]).startsWith('-')) return again
    }
    return cached !== undefined && !String(cached[0]).startsWith('-') ? cached : null
  }

  // 先展开全部子图（它们会写回 linkRefs），再处理普通节点
  for (const node of raw.nodes) {
    if (node !== null && typeof node === 'object' && definitions.has(String(node.type ?? ''))) expand(node, '')
  }
  for (const node of raw.nodes) {
    if (node !== null && typeof node === 'object' && !definitions.has(String(node.type ?? ''))) expand(node, '')
  }
  // 丢弃指向未知节点的链接，避免提交无效图
  const known = new Set(Object.keys(graph))
  for (const node of Object.values(graph)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (value === undefined) delete node.inputs[field]
      else if (Array.isArray(value) && value.length === 2 && !known.has(String(value[0]))) delete node.inputs[field]
    }
  }
  return { graph, skipped, unsupported, incomplete, subgraphs, converted: true }
}

/** 便捷入口：展平 + 转换统计。 */
export function flattenWorkflow(raw) {
  return apiGraphFromUi(raw)
}

/** 是否含内联子图（服务端转换器不支持展平子图，需走本地路径）。 */
export function hasSubgraphs(raw) {
  if (!isUiWorkflow(raw)) return false
  const definitions = Object.values(raw.definitions?.subgraphs ?? {})
  return definitions.length > 0
}
