/**
 * 表单引擎：图 → 定制表单字段 → 结构化提问 → 回填可运行图。
 *
 * 字段契约（docs/protocol.md §表单契约）：
 *   fields[i] = { id, nodeId, field, kind: text|number|seed|enum|boolean|image,
 *                 label, value, default, required, min?, max?, options? }
 *
 * 推导规则（按 node class / input 名）：
 *   CLIPTextEncode.text          → text（提示词预设）
 *   KSampler.seed / *_seed       → seed（推送时随机一次；可重随/手动固定）
 *   KSampler.steps/cfg/denoise   → number（min/max 来自节点声明）
 *   CheckpointLoader*.model_name → enum（候选来自 list_models，缺省图内现值）
 *   KSampler.sampler_name 等     → enum（候选来自 node_info）
 *   SaveImage.filename_prefix    → text
 *   LoadImage.image              → image（缺省保持图内值）
 * 其余 input 不进表单（保持图内值），保证未知节点仍可运行。
 */

export const SEED_MAX = 4294967295

export class FormError extends Error {
  constructor(message, code = 'E_FORM') {
    super(message)
    this.name = 'FormError'
    this.code = code
  }
}

function asGraph(graph) {
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new FormError('graph must be an object keyed by node id', 'E_GRAPH')
  }
  return graph
}

function inputsOf(node) {
  const inputs = node?.inputs
  return inputs !== null && typeof inputs === 'object' && !Array.isArray(inputs) ? inputs : {}
}

function isSeedKey(key) {
  const lower = key.toLowerCase()
  return lower === 'seed' || lower === 'noise_seed' || lower.endsWith('_seed')
}

function numberBounds(decl) {
  const detail = Array.isArray(decl) ? decl[1] : undefined
  const min = detail !== null && typeof detail === 'object' && typeof detail.min === 'number' ? detail.min : undefined
  const max = detail !== null && typeof detail === 'object' && typeof detail.max === 'number' ? detail.max : undefined
  return { min, max }
}

function choicesOf(decl) {
  if (!Array.isArray(decl)) return []
  const first = decl[0]
  return Array.isArray(first) ? first.filter((entry) => typeof entry === 'string' || typeof entry === 'number') : []
}

/**
 * 从图 + 节点声明推导表单字段。
 * @param graph API-format graph（node id → {class_type, inputs}）
 * @param nodeInfos 可选的 node_info 快照（class_type → {input:{required:{...}}}）
 * @param modelChoices 可选的模型名列表（来自 list_models）
 * @param options.maxFields 上限（默认 24）
 */
export function deriveFields(graph, nodeInfos = {}, modelChoices = [], options = {}) {
  const safeGraph = asGraph(graph)
  const maxFields = typeof options.maxFields === 'number' && options.maxFields > 0 ? options.maxFields : 24
  const fields = []
  for (const [nodeId, nodeRaw] of Object.entries(safeGraph)) {
    if (fields.length >= maxFields) break
    const node = nodeRaw !== null && typeof nodeRaw === 'object' ? nodeRaw : {}
    const classType = String(node.class_type ?? '')
    const inputs = inputsOf(node)
    const declared = nodeInfos?.[classType]?.input?.required ?? {}
    for (const [field, rawValue] of Object.entries(inputs)) {
      if (fields.length >= maxFields) break
      // 链接输入（["节点id", 输出槽]）不是用户参数
      if (Array.isArray(rawValue)) continue
      const kind = classifyInput(field, rawValue, declared[field])
      if (kind === null) continue
      fields.push({
        id: `${nodeId}.${field}`,
        nodeId,
        field,
        kind,
        label: fieldLabel(classType, field),
        value: rawValue,
        default: rawValue,
        required: true,
        ...(kind === 'number' ? numberBounds(declared[field]) : {}),
        ...(kind === 'enum' ? { options: enumOptions(field, rawValue, declared[field], modelChoices) } : {}),
      })
    }
  }
  // 稳定顺序：提示词在前，seed 其次，其余按节点序
  const weight = (field) => (field.kind === 'text' ? 0 : field.kind === 'seed' ? 1 : field.kind === 'enum' ? 2 : 3)
  fields.sort((a, b) => weight(a) - weight(b) || a.id.localeCompare(b.id))
  return fields
}

function classifyInput(field, value, decl) {
  if (isSeedKey(field)) return 'seed'
  if (field === 'text' || field === 'positive' || field === 'negative' || field === 'filename_prefix') return 'text'
  if (field === 'model_name' || field === 'ckpt_name' || field === 'lora_name' || field === 'vae_name') return 'enum'
  if (typeof value === 'number') return 'number'
  const choices = choicesOf(decl)
  if (choices.length > 0) return 'enum'
  if (field === 'image' || field === 'image_upload') return 'image'
  return null
}

function enumOptions(field, value, decl, modelChoices) {
  if (field === 'model_name' || field === 'ckpt_name' || field === 'lora_name' || field === 'vae_name') {
    const models = modelChoices.filter((entry) => typeof entry === 'string' && entry.length > 0)
    if (models.length > 0) {
      return models.includes(String(value)) ? models : [String(value), ...models].slice(0, 12)
    }
  }
  const choices = choicesOf(decl).map((entry) => String(entry))
  if (!choices.includes(String(value))) choices.unshift(String(value))
  return choices.slice(0, 12)
}

function fieldLabel(classType, field) {
  const readable = field
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
  return `${classType} · ${readable}`
}

/** Push-time seed policy: every seed field gets a fresh random once. */
export function randomizeSeeds(fields, random = Math.random) {
  return fields.map((field) =>
    field.kind === 'seed' ? { ...field, value: randomSeed(random) } : { ...field },
  )
}

export function randomSeed(random = Math.random) {
  return Math.floor(random() * (SEED_MAX + 1))
}

/**
 * 把字段批次转成 ask_user_question 的问题数组。
 * 每个字段一个问题：
 * - text   → 自由文本（custom），无固定选项
 * - number → [保留当前值] + 自定义输入
 * - seed   → [使用随机值 X] [重新随机] + 自定义固定值
 * - enum   → 候选值选项 + 自定义
 * - boolean→ [是] [否]
 * - image  → [保持当前值] + 自定义路径
 */
export function buildQuestions(fields, random = Math.random) {
  const prepared = randomizeSeeds(fields, random)
  const questions = prepared.map((field) => {
    const base = {
      id: `field:${field.id}`,
      question: field.label,
      header: fieldHeader(field.kind),
      detail: `节点 ${field.nodeId} · 输入 ${field.field}`,
    }
    switch (field.kind) {
      case 'text':
        return { ...base, question: `${field.label}（预设值：${previewOf(field.value)}）` }
      case 'number': {
        const range = field.min !== undefined || field.max !== undefined ? `（范围 ${field.min ?? '-∞'} ~ ${field.max ?? '∞'}）` : ''
        return {
          ...base,
          question: `${field.label}${range}`,
          options: [{ label: `使用当前值 ${field.value}`, description: '保持推导出的缺省参数' }],
        }
      }
      case 'seed':
        return {
          ...base,
          question: `${field.label}（本次已随机：${field.value}）`,
          options: [
            { label: `使用随机种子 ${field.value}`, description: '推送时已随机一次' },
            { label: '重新随机', description: '再随机一次新种子' },
          ],
        }
      case 'boolean':
        return { ...base, options: [{ label: 'true' }, { label: 'false' }] }
      case 'image':
        return { ...base, options: [{ label: `保持当前值 ${previewOf(field.value)}` }] }
      case 'enum':
      default:
        return {
          ...base,
          options: (field.options ?? [String(field.value)]).map((entry) => ({ label: String(entry) })),
        }
    }
  })
  return { questions, prepared }
}

function fieldHeader(kind) {
  switch (kind) {
    case 'text':
      return '提示词'
    case 'seed':
      return '种子'
    case 'number':
      return '参数'
    case 'enum':
      return '选项'
    case 'image':
      return '图像输入'
    default:
      return '字段'
  }
}

function previewOf(value) {
  const text = String(value ?? '')
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

/** Parse one answer item against its field. Returns the resolved value or undefined to keep. */
export function resolveAnswer(field, answer, random = Math.random) {
  const selected = Array.isArray(answer?.selected) ? answer.selected : []
  const custom = typeof answer?.custom === 'string' && answer.custom.trim().length > 0 ? answer.custom.trim() : ''
  const keep = selected.some((entry) => String(entry).startsWith('使用当前值') || String(entry).startsWith('保持当前值'))
  if (custom.length > 0) return coerceValue(field, custom)
  if (selected.length === 0) {
    return field.kind === 'seed' ? field.value : undefined
  }
  const label = String(selected[0])
  if (field.kind === 'seed') {
    if (label === '重新随机') return randomSeed(random)
    if (label.startsWith('使用随机种子')) return field.value
    return coerceValue(field, label)
  }
  if (keep) return undefined
  return coerceValue(field, label)
}

function coerceValue(field, text) {
  if (field.kind === 'number' || field.kind === 'seed') {
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) throw new FormError(`${field.label}: "${text}" 不是数字`, 'E_FORM_NUMBER')
    if (field.kind === 'seed') {
      const int = Math.floor(parsed)
      if (int < 0 || int > SEED_MAX) throw new FormError(`${field.label}: 种子必须在 0 ~ ${SEED_MAX}`, 'E_FORM_SEED')
      return int
    }
    if (field.min !== undefined && parsed < field.min) throw new FormError(`${field.label}: 最小 ${field.min}`, 'E_FORM_RANGE')
    if (field.max !== undefined && parsed > field.max) throw new FormError(`${field.label}: 最大 ${field.max}`, 'E_FORM_RANGE')
    return parsed
  }
  if (field.kind === 'boolean') {
    const lower = text.toLowerCase()
    if (['true', '1', 'yes', '是', 'on'].includes(lower)) return true
    if (['false', '0', 'no', '否', 'off'].includes(lower)) return false
    throw new FormError(`${field.label}: "${text}" 不是布尔值`, 'E_FORM_BOOLEAN')
  }
  return text
}

/**
 * 回填：把答案写进图的 inputs，返回 { graph, applied, kept }。
 * 未回答且无自定义的字段保持图内原值（kept）。
 */
export function applyAnswers(graph, fields, answers, random = Math.random) {
  const safeGraph = asGraph(graph)
  const byId = new Map(answers.map((entry) => [String(entry?.id ?? ''), entry]))
  let applied = 0
  const kept = []
  for (const field of fields) {
    const answer = byId.get(`field:${field.id}`)
    let value
    try {
      value = resolveAnswer(field, answer, random)
    } catch (error) {
      if (error instanceof FormError) throw error
      throw new FormError(String(error), 'E_FORM')
    }
    if (value === undefined) {
      kept.push(field.id)
      continue
    }
    const node = safeGraph[field.nodeId]
    if (node === undefined || node === null || typeof node !== 'object') {
      throw new FormError(`节点 ${field.nodeId} 不存在`, 'E_FORM_NODE')
    }
    if (node.inputs === undefined || node.inputs === null || typeof node.inputs !== 'object') {
      node.inputs = {}
    }
    node.inputs[field.field] = value
    applied += 1
  }
  return { graph: safeGraph, applied, kept }
}

/**
 * 卸载节点整合（已验证的接入模式）：在输出链路上插入 UnloadAllModels——
 * 上游输出 → UnloadAllModels.value →（其 any 透传输出）→ 原输入。这样该节点
 * 必然随链路执行，推理完成后释放显存。插入点优先 Save/Preview 类终端节点的
 * 输入链接，其次任意终端节点，最后任意链接。
 */
export function integrateUnloadNode(graph, options = {}) {
  const safeGraph = asGraph(graph)
  if (options.enabled !== true) return { graph: safeGraph, inserted: false, reason: 'disabled' }
  const isConsumed = (id) =>
    Object.values(safeGraph).some((node) =>
      Object.values(inputsOf(node)).some((value) => Array.isArray(value) && String(value[0]) === id),
    )
  const candidates = []
  for (const [id, nodeRaw] of Object.entries(safeGraph)) {
    const node = nodeRaw !== null && typeof nodeRaw === 'object' ? nodeRaw : {}
    for (const [field, value] of Object.entries(inputsOf(node))) {
      if (Array.isArray(value) && value.length >= 2) {
        candidates.push({ nodeId: id, field, link: value, terminal: !isConsumed(id) })
      }
    }
  }
  if (candidates.length === 0) {
    return { graph: safeGraph, inserted: false, reason: 'no upstream link found' }
  }
  const saveLike = candidates.find((entry) => /save|preview|output|video/i.test(String(safeGraph[entry.nodeId]?.class_type ?? '')))
  const target = saveLike ?? candidates.find((entry) => entry.terminal) ?? candidates[0]
  const unloadId = options.nodeId ?? nextFreeId(safeGraph, 'UnloadAllModels')
  safeGraph[unloadId] = {
    class_type: 'UnloadAllModels',
    inputs: { value: target.link },
  }
  safeGraph[target.nodeId].inputs[target.field] = [unloadId, 0]
  return { graph: safeGraph, inserted: true, nodeId: unloadId, at: `${target.nodeId}.${target.field}` }
}

function nextFreeId(graph, prefix) {
  let index = Object.keys(graph).length + 1
  while (graph[`${prefix}${index}`] !== undefined) index += 1
  return `${prefix}${index}`
}

/** 从图里提取第一条正向提示词文本（用于运行记录与卡片摘要）。 */
export function firstPromptText(graph) {
  for (const node of Object.values(asGraph(graph))) {
    const inputs = inputsOf(node)
    if (typeof inputs.text === 'string' && inputs.text.trim().length > 0) return inputs.text
  }
  return ''
}

/** 从图里提取第一个 seed 值。 */
export function firstSeed(graph) {
  for (const node of Object.values(asGraph(graph))) {
    for (const [field, value] of Object.entries(inputsOf(node))) {
      if (isSeedKey(field) && typeof value === 'number') return value
    }
  }
  return null
}
