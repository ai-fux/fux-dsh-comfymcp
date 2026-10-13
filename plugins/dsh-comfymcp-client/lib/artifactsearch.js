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
