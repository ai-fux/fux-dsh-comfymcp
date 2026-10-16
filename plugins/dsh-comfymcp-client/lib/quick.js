/**
 * 快捷指令（quick commands）：把常用的「参数微调重跑」封装成一键动作。
 *
 * 典型指令「抽卡」：在种子参数变更的条件下不变更其他参数，继续执行工作流。
 * 种子可配置策略（seed.strategy）：
 *   - { mode: 'range', min, max }            限制范围均匀随机
 *   - { mode: 'digits', length }             限制随机数字长度（首位 1-9）
 *   - { mode: 'timestamp', extraDigits }     时间戳随机 + 补偿随机位数
 * 指令列表来自配置 quickCommands（JSON 数组），缺省内置「抽卡」。
 */

/** 顶部安全值：ComfyUI 种子是 INT64，JS 侧压在 Number.MAX_SAFE_INTEGER 内。 */
export const SEED_MAX_SAFE = 9007199254740991

export const DEFAULT_QUICK_COMMANDS = [
  {
    name: '抽卡',
    label: '🎲 抽卡（仅重滚种子）',
    seed: { mode: 'range', min: 1, max: 4294967295 },
  },
]

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 按策略滚动一个种子。random/now 可注入（测试确定性）。
 * @returns {number} 整数种子
 */
export function rollSeed(strategy = {}, random = Math.random, now = Date.now) {
  const mode = String(strategy?.mode ?? 'range').toLowerCase()
  if (mode === 'timestamp') {
    const extra = clampInt(strategy?.extraDigits, 3, 1, 6)
    let tail = ''
    for (let i = 0; i < extra; i++) tail += String(Math.floor(random() * 10))
    return (Number(now()) * 10 ** extra + Number(tail)) % SEED_MAX_SAFE
  }
  if (mode === 'digits') {
    const length = clampInt(strategy?.length, 9, 1, 15)
    let digits = String(1 + Math.floor(random() * 9))
    for (let i = 1; i < length; i++) digits += String(Math.floor(random() * 10))
    return Number(digits) % SEED_MAX_SAFE
  }
  const min = Number.isFinite(Number(strategy?.min)) ? Math.floor(Number(strategy.min)) : 0
  const max = Number.isFinite(Number(strategy?.max)) ? Math.floor(Number(strategy.max)) : 4294967295
  const low = Math.min(min, max)
  const high = Math.max(min, max)
  return Math.min(low + Math.floor(random() * (high - low + 1)), SEED_MAX_SAFE)
}

/** 指令条目形状：{ name, label?, workflow?, seed?, count?, batchMode? }
 *  count     生成数（默认 1；「一般未提及默认 1」）
 *  batchMode 'serial'（默认，连续调 count 次，每次重滚种子）| 'batch'（工作流批次：直接改 batch_size=count 一次执行）
 */

/** 解析配置里的快捷指令 JSON；非法条目跳过，非法整体回退缺省。 */
export function parseQuickCommands(raw) {
  const fallback = () => DEFAULT_QUICK_COMMANDS.map((entry) => ({ ...entry, seed: { ...entry.seed }, count: 1, batchMode: 'serial' }))
  if (raw === undefined || raw === null || String(raw).trim().length === 0) {
    return fallback()
  }
  let parsed
  try {
    parsed = JSON.parse(String(raw))
  } catch {
    return fallback()
  }
  if (!Array.isArray(parsed)) return fallback()
  const commands = []
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue
    const name = typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : ''
    if (name.length === 0) continue
    const mode = String(entry.batchMode ?? 'serial').toLowerCase()
    commands.push({
      name,
      label: typeof entry.label === 'string' && entry.label.trim().length > 0 ? entry.label.trim() : name,
      ...(entry.workflow !== undefined && typeof entry.workflow === 'string' ? { workflow: entry.workflow } : {}),
      ...(entry.seed !== null && typeof entry.seed === 'object' ? { seed: { ...entry.seed } } : {}),
      count: clampInt(entry.count, 1, 1, 64),
      batchMode: mode === 'batch' ? 'batch' : 'serial',
    })
  }
  return commands
}

/** 按指令名取种子策略；未配置时用范围策略兜底。 */
export function seedStrategyFor(commands, name) {
  const hit = commands.find((entry) => entry.name === name)
  return hit?.seed && typeof hit.seed === 'object' ? { ...hit.seed } : { mode: 'range', min: 1, max: 4294967295 }
}

/**
 * 组装抽卡重跑：以上一次成功运行为基准，仅替换种子字段，其余表单答案原样复用。
 * values 使用复合键 `nodeId:field`（同名字段跨节点不冲突）。
 * @param lastRun bridge 运行记录（需 form.values + form.graph）
 * @param command 指令条目
 * @param deps { rollSeed?, now? }
 * @returns { ok, name, graph, values, seed, reason? }
 */
export function buildQuickRerun(lastRun, command, deps = {}) {
  const random = deps.rollSeed ?? Math.random
  const now = deps.now ?? Date.now
  if (lastRun === null || lastRun === undefined || typeof lastRun !== 'object') {
    return { ok: false, reason: '没有可复用的运行记录（先跑一次工作流）' }
  }
  const values = lastRun.form?.values
  if (values === null || values === undefined || typeof values !== 'object' || lastRun.form?.graph === undefined) {
    return { ok: false, reason: '上次运行没有可复用的参数（form.values/graph 缺失）' }
  }
  const strategy = seedStrategyFor([command], command?.name)
  const seed = rollSeed(strategy, random, now)
  const graph = structuredClone(lastRun.form.graph)
  const valuesNext = { ...values }
  // 图里所有看起来是种子的整型字段统一替换，values 同步更新（复合键）
  let replaced = 0
  for (const [nodeId, node] of Object.entries(graph)) {
    if (node === null || typeof node !== 'object' || node.inputs === null || typeof node.inputs !== 'object') continue
    for (const [field, value] of Object.entries(node.inputs)) {
      if (typeof value !== 'number' || !Number.isInteger(value)) continue
      if (!/seed/i.test(field)) continue
      node.inputs[field] = seed
      valuesNext[`${nodeId}:${field}`] = seed
      replaced += 1
    }
  }
  return {
    ok: replaced > 0,
    name: `${lastRun.name}-reroll`,
    graph,
    values: valuesNext,
    seed,
    reason: replaced > 0 ? `替换 ${replaced} 个种子字段` : '图中没有识别到种子字段',
  }
}

/**
 * 批次模式：把图里的批次字段（batch_size / batchSize）直接改为 count，values 同步更新。
 * 一般工作流只有 KSampler 的 batch_size；改不到时返回 ok:false 让上层回退提示。
 */
export function applyBatchSize(graph, values = {}, count = 1, deps = {}) {
  const clone = deps.clone ?? ((value) => structuredClone(value))
  const safeCount = clampInt(count, 1, 1, 64)
  const next = clone(graph)
  const valuesNext = { ...values }
  const touched = []
  for (const [nodeId, node] of Object.entries(next)) {
    if (node === null || typeof node !== 'object' || node.inputs === null || typeof node.inputs !== 'object') continue
    for (const field of Object.keys(node.inputs)) {
      if (!/^batch_?size$/i.test(field)) continue
      const current = node.inputs[field]
      if (typeof current !== 'number' || !Number.isInteger(current)) continue // 链接引用等非标量不动
      node.inputs[field] = safeCount
      valuesNext[`${nodeId}:${field}`] = safeCount
      touched.push(`${nodeId}:${field}`)
    }
  }
  return {
    ok: touched.length > 0,
    graph: next,
    values: valuesNext,
    count: safeCount,
    fields: touched,
    reason: touched.length > 0 ? `批次字段改为 ${safeCount}（${touched.join('、')}）` : '图中没有可改的 batch_size 字段',
  }
}
