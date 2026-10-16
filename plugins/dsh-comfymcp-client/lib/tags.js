/**
 * 成果物标签存储（结构化数据 <dataDir>/tags.json）。
 *
 * 每个产物 key 一条记录：
 *   { key, tags: [], collections: [], fields: {}, prompt: '', source: '', updatedAt }
 *   - tags        标签（去重合并，置空串删除）
 *   - collections 标签集合（去重合并）
 *   - fields      动态字段（对象合并；值为 null 删除该字段）
 *   - prompt      绑定提示词
 *   - source      标签项目使用来源
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function createTagStore({ dataDir, now = () => new Date().toISOString() }) {
  const file = join(dataDir ?? '', 'tags.json')

  function load() {
    try {
      if (typeof dataDir !== 'string' || dataDir.length === 0 || !existsSync(file)) return {}
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed !== null && typeof parsed === 'object' && parsed.records !== null && typeof parsed.records === 'object'
        ? parsed.records
        : {}
    } catch {
      return {}
    }
  }

  function persist(records) {
    if (typeof dataDir !== 'string' || dataDir.length === 0) return
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(file, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, 'utf8')
  }

  function mergeList(current, incoming) {
    if (!Array.isArray(incoming)) return current
    const next = new Set(current)
    for (const item of incoming) {
      const value = String(item ?? '').trim()
      if (value.length === 0) continue
      next.add(value)
    }
    return [...next]
  }

  return {
    all() {
      return load()
    },
    get(key) {
      const records = load()
      return records[String(key ?? '')] ?? null
    },
    /** 合并更新一条记录；fields 值为 null 表示删除该动态字段。返回更新后的记录。 */
    update(key, patch = {}) {
      const normalKey = String(key ?? '').trim()
      if (normalKey.length === 0) throw new Error('标签更新需要产物 key')
      const records = load()
      const current = records[normalKey] ?? { key: normalKey, tags: [], collections: [], fields: {}, prompt: '', source: '' }
      const replaceList = (value) =>
        Array.isArray(value) ? value.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0) : undefined
      const tagsSet = replaceList(patch.tagsSet)
      const collectionsSet = replaceList(patch.collectionsSet)
      const next = {
        ...current,
        key: normalKey,
        tags: tagsSet !== undefined ? tagsSet : mergeList(current.tags, patch.tags),
        collections: collectionsSet !== undefined ? collectionsSet : mergeList(current.collections, patch.collections),
        fields: (() => {
          const merged = { ...(current.fields ?? {}) }
          if (patch.fields !== null && typeof patch.fields === 'object') {
            for (const [field, value] of Object.entries(patch.fields)) {
              if (value === null) delete merged[field]
              else merged[field] = value
            }
          }
          return merged
        })(),
        prompt: typeof patch.prompt === 'string' ? patch.prompt : (current.prompt ?? ''),
        source: typeof patch.source === 'string' ? patch.source : (current.source ?? ''),
        updatedAt: now(),
      }
      records[normalKey] = next
      persist(records)
      return next
    },
    remove(key) {
      const normalKey = String(key ?? '').trim()
      if (normalKey.length === 0) return false
      const records = load()
      if (!(normalKey in records)) return false
      delete records[normalKey]
      persist(records)
      return true
    },
  }
}
