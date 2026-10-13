/**
 * 成果物检索：对运行记录做模糊/字段化筛选。
 *
 * 检索维度（全部大小写不敏感）：
 * - text：模糊词 —— 命中 正向/负向提示词、工作流名、文件名、标签/标签集合、
 *   动态字段（名与值）、运行参数（字段名与值）；
 * - tags：标签条件（多个），与 mode 一起决定 AND / OR；
 * - params：`field=value` 参数条件，字段名相等且值包含（或全等）；
 * - fields：`key=value` 动态字段条件（标签库里登记的自定义字段）；
 * - files：`filename 关键词` 模糊匹配文件名。
 *
 * mode: 'and' | 'or'（默认 and）。各组条件之间按 mode 组合；
 * 同一组内的多个条件：and 需全中、or 命中其一。
 */

function text(value) {
  return String(value ?? '').toLowerCase()
}

/** 收集一条运行记录里所有可被模糊命中的文本。 */
export function haystackOf(run, tagRecords = {}) {
  const parts = []
  const push = (value) => {
    if (value !== null && value !== undefined && String(value).length > 0) parts.push(String(value))
  }
  push(run?.name)
  push(run?.prompt)
  push(run?.prompts?.positive)
  push(run?.prompts?.negative)
  push(run?.error)
  for (const param of Array.isArray(run?.params) ? run.params : []) {
    push(param?.field)
    push(param?.value)
  }
  for (const file of Array.isArray(run?.localFiles) ? run.localFiles : []) {
    push(file?.filename)
    push(file?.path)
    push(file?.kind)
    const key = file?.key ?? file?.path ?? file?.filename
    const meta = tagRecords[key]
    if (meta !== null && typeof meta === 'object') {
      for (const tag of Array.isArray(meta.tags) ? meta.tags : []) push(tag)
      for (const collection of Array.isArray(meta.collections) ? meta.collections : []) push(collection)
      push(meta.prompt)
      push(meta.source)
      for (const [name, value] of Object.entries(meta.fields ?? {})) {
        push(name)
        push(value)
      }
    }
  }
  return parts.join('\n').toLowerCase()
}

/** 解析 `field=value, field2!=value2` 形式的条件串。 */
export function parseConditions(input) {
  if (typeof input !== 'string' || input.trim().length === 0) return []
  return input
    .split(/[,;\n]+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const match = /^([^=!]+?)\s*(!=|=)\s*(.*)$/.exec(chunk)
      if (match === null) return { field: chunk, op: '~', value: '' }
      return { field: match[1].trim(), op: match[2], value: match[3].trim() }
    })
    .filter((condition) => condition.field.length > 0)
}

function paramMatches(run, condition) {
  const field = text(condition.field)
  const value = text(condition.value)
  for (const param of Array.isArray(run?.params) ? run.params : []) {
    if (text(param?.field) !== field) continue
    const actual = text(param?.value)
    if (condition.op === '!=') {
      if (actual !== value) return true
      continue
    }
    if (value.length === 0 || actual.includes(value)) return true
  }
  return false // 未出现该参数（或无差值）→ 不命中
}

function fieldMatches(run, condition, tagRecords) {
  const field = text(condition.field)
  const value = text(condition.value)
  for (const file of Array.isArray(run?.localFiles) ? run.localFiles : []) {
    const key = file?.key ?? file?.path ?? file?.filename
    const meta = tagRecords[key]
    const fields = meta !== null && typeof meta === 'object' && meta.fields !== null && typeof meta.fields === 'object' ? meta.fields : {}
    for (const [name, actual] of Object.entries(fields)) {
      if (text(name) !== field) continue
      if (condition.op === '!=') {
        if (text(actual) !== value) return true
        continue
      }
      if (value.length === 0 || text(actual).includes(value)) return true
    }
  }
  return false // 未出现该动态字段（或无差值）→ 不命中
}

function tagsOf(run, tagRecords) {
  const tags = []
  for (const file of Array.isArray(run?.localFiles) ? run.localFiles : []) {
    const key = file?.key ?? file?.path ?? file?.filename
    const meta = tagRecords[key]
    if (meta === null || typeof meta !== 'object') continue
    for (const tag of Array.isArray(meta.tags) ? meta.tags : []) tags.push(text(tag))
    for (const collection of Array.isArray(meta.collections) ? meta.collections : []) tags.push(text(collection))
  }
  return tags
}

/**
 * 复合查询语法（单输入框，字段限定 + 排除 + 与/或）：
 *
 *   空格           同一「与」组内的条件，需同时满足
 *   |（或 OR）     分组：任一组满足即命中
 *   -前缀          取反（NOT）
 *   字段:值        限定：tag 标签/集合、param 运行参数、field 动态字段、
 *                  prompt 提示词、file 文件名、name 工作流名、state 状态、seed 种子、kind 类型
 *   值运算符       =（相等）、!=、~（包含，默认）、>、>=、<、<=
 *   双引号         "值中含空格"
 *
 * 示例：
 *   fashion | night city            含 fashion，或含 night city
 *   tag:夕阳 tag:旅拍               同时带这两个标签
 *   param:steps>=25 -tag:废片       步数 ≥25 且不带「废片」
 *   prompt:"sunset beach" file:.png
 */
const FIELD_ALIASES = new Set(['tag', 'tags', 'collection', 'collections', 'param', 'params', 'field', 'fields', 'prompt', 'file', 'filename', 'name', 'state', 'seed', 'kind'])

/** 拆分词条（尊重双引号）。 */
function tokenize(input) {
  const tokens = []
  let current = ''
  let quoted = false
  for (const char of String(input)) {
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

/** 单条词条 → { negate, field, op, value }。 */
export function parseTerm(raw) {
  let token = String(raw ?? '').trim()
  if (token.length === 0) return null
  let negate = false
  if (token.startsWith('-') && token.length > 1) {
    negate = true
    token = token.slice(1)
  }
  let field = ''
  const colon = token.indexOf(':')
  if (colon > 0) {
    const head = token.slice(0, colon).toLowerCase()
    if (FIELD_ALIASES.has(head)) {
      field = head.replace(/s$/, '').replace('filename', 'file').replace('collection', 'tag')
      token = token.slice(colon + 1)
    }
  }
  let op = '~'
  let value = token
  const match = /^(>=|<=|!=|=|>|<)(.*)$/.exec(token)
  if (match !== null) {
    op = match[1]
    value = match[2]
  }
  if (value.length === 0) return null
  return { negate, field, op, value }
}

/**
 * 解析整条查询 → OR 分组，每组内含 AND 词条。
 * @returns { groups: Array<{ terms: Array<object> }>, raw: string, isEmpty: boolean }
 */
export function parseQuery(input) {
  const raw = String(input ?? '').trim()
  if (raw.length === 0) return { groups: [], raw, isEmpty: true }
  const groups = raw
    .split(/\s*\|\s*|\s+OR\s+/i)
    .map((chunk) => ({ terms: tokenize(chunk).map(parseTerm).filter((term) => term !== null) }))
    .filter((group) => group.terms.length > 0)
  return { groups, raw, isEmpty: groups.length === 0 }
}

function compare(actual, op, expected) {
  const left = String(actual ?? '')
  const right = String(expected ?? '')
  if (op === '=') return left === right
  if (op === '!=') return left !== right
  if (op === '~') return left.toLowerCase().includes(right.toLowerCase())
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  const numeric = left.trim().length > 0 && right.trim().length > 0 && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
  const a = numeric ? leftNumber : left.toLowerCase()
  const b = numeric ? rightNumber : right.toLowerCase()
  if (op === '>') return a > b
  if (op === '>=') return a >= b
  if (op === '<') return a < b
  if (op === '<=') return a <= b
  return false
}

/** 某个字段上可供比较的值集合（param/field 返回 {field,value} 形状）。 */
function valuesOf(run, field, tagRecords) {
  const out = []
  const files = Array.isArray(run?.localFiles) ? run.localFiles : []
  const metas = files
    .map((file) => tagRecords[file?.key ?? file?.path ?? file?.filename])
    .filter((meta) => meta !== null && typeof meta === 'object')
  if (field === 'tag') {
    for (const meta of metas) {
      for (const tag of Array.isArray(meta.tags) ? meta.tags : []) out.push(tag)
      for (const collection of Array.isArray(meta.collections) ? meta.collections : []) out.push(collection)
    }
    return out
  }
  if (field === 'param') {
    for (const param of Array.isArray(run?.params) ? run.params : []) out.push({ field: param?.field, value: param?.value })
    return out
  }
  if (field === 'field') {
    for (const meta of metas) {
      for (const [name, value] of Object.entries(meta.fields ?? {})) out.push({ field: name, value })
    }
    return out
  }
  if (field === 'prompt') return [run?.prompts?.positive, run?.prompts?.negative, run?.prompt].filter(Boolean)
  if (field === 'file') return files.map((file) => file?.filename ?? file?.path)
  if (field === 'name') return [run?.name]
  if (field === 'state') return [run?.state]
  if (field === 'seed') return [run?.seed]
  if (field === 'kind') return files.map((file) => file?.kind)
  return [haystackOf(run, tagRecords)]
}

/** 单条词条是否命中。 */
export function matchTerm(run, term, tagRecords = {}) {
  const values = valuesOf(run, term.field, tagRecords)
  let hit = false
  for (const entry of values) {
    if (entry !== null && typeof entry === 'object') {
      // {field,value} 形状：先按 field=值 里的字段名对齐，再比较值
      const eq = /^([^=!<>]+)(=|!=|~|>=|<=|>|<)(.*)$/.exec(term.value)
      if (eq !== null) {
        if (String(entry.field).toLowerCase() !== eq[1].trim().toLowerCase()) continue
        if (compare(entry.value, eq[2], eq[3])) hit = true
        continue
      }
      if (compare(entry.field, term.op, term.value)) hit = true
      continue
    }
    if (compare(entry, term.op, term.value)) hit = true
  }
  return term.negate ? !hit : hit
}

/**
 * 复合查询匹配：组间 OR、组内 AND。
 * @returns { matched: boolean, hits: string[] }
 */
export function matchRunQuery(run, parsed, tagRecords = {}) {
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : []
  if (groups.length === 0) return { matched: true, hits: [] }
  for (const group of groups) {
    const groupHits = []
    let ok = true
    for (const term of group.terms) {
      if (matchTerm(run, term, tagRecords)) groupHits.push(`${term.negate ? '非' : ''}${term.field ? `${term.field}:` : ''}${term.op === '~' ? '' : term.op}${term.value}`)
      else {
        ok = false
        break
      }
    }
    if (ok) return { matched: true, hits: groupHits }
  }
  return { matched: false, hits: [] }
}

/**
 * 单条记录是否命中检索条件。
 * @returns { matched: boolean, hits: string[] } hits 用于页面高亮/说明命中来源
 */
export function matchRun(run, criteria = {}, tagRecords = {}) {
  const mode = criteria.mode === 'or' ? 'or' : 'and'
  const groups = []
  const hits = []

  const keywords = [criteria.text, criteria.prompts, criteria.files]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase())
  if (keywords.length > 0) {
    const haystack = haystackOf(run, tagRecords)
    const results = keywords.map((keyword) => haystack.includes(keyword))
    results.forEach((ok, index) => {
      if (ok) hits.push(`模糊:${keywords[index]}`)
    })
    groups.push(mode === 'or' ? results.some(Boolean) : results.every(Boolean))
  }

  const tags = (Array.isArray(criteria.tags) ? criteria.tags : parseConditions(criteria.tagText).map((condition) => condition.field))
    .map((tag) => text(tag))
    .filter((tag) => tag.length > 0)
  if (tags.length > 0) {
    const owned = tagsOf(run, tagRecords)
    const results = tags.map((tag) => owned.some((entry) => entry.includes(tag)))
    results.forEach((ok, index) => {
      if (ok) hits.push(`标签:${tags[index]}`)
    })
    groups.push(mode === 'or' ? results.some(Boolean) : results.every(Boolean))
  }

  const paramConditions = Array.isArray(criteria.params) ? criteria.params : parseConditions(criteria.paramText)
  if (paramConditions.length > 0) {
    const results = paramConditions.map((condition) => paramMatches(run, condition))
    results.forEach((ok, index) => {
      if (ok) hits.push(`参数:${paramConditions[index].field}=${paramConditions[index].value}`)
    })
    groups.push(mode === 'or' ? results.some(Boolean) : results.every(Boolean))
  }

  const fieldConditions = Array.isArray(criteria.fields) ? criteria.fields : parseConditions(criteria.fieldText)
  if (fieldConditions.length > 0) {
    const results = fieldConditions.map((condition) => fieldMatches(run, condition, tagRecords))
    results.forEach((ok, index) => {
      if (ok) hits.push(`字段:${fieldConditions[index].field}=${fieldConditions[index].value}`)
    })
    groups.push(mode === 'or' ? results.some(Boolean) : results.every(Boolean))
  }

  if (groups.length === 0) return { matched: true, hits: [] }
  return { matched: mode === 'or' ? groups.some(Boolean) : groups.every(Boolean), hits }
}
