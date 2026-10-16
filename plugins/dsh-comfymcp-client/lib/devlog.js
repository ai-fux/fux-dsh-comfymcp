/**
 * 开发日志（开发模式专用）：把插件运行中的异常/告警收进一个环形缓冲 + JSONL 文件，
 * 让大模型在开发模式下能「发现问题 → 读报告 → 定位并修复」，而不是靠用户复述。
 *
 * 关闭开发模式（默认）时：只写盘、不主动暴露给模型；且**严禁修改任何插件源码**，
 * 必须按插件规则执行（见 lib/skills.js 的「开发模式」小节与 comfymcp_dev 工具说明）。
 *
 * 存储：<dataDir>/dev-log.jsonl（每行一条 JSON，最多保留 MAX 条）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ENTRIES = 500

export function createDevLog({ dataDir, devMode = false, max = MAX_ENTRIES, now = () => new Date().toISOString() }) {
  const file = join(dataDir ?? '', 'dev-log.jsonl')
  const buffer = []
  // devMode 支持布尔或「活值」函数：设置页保存后 bridge.config.devMode 即时变化，
  // 报告/指引按调用时取值，无需重启 DSH；传布尔则保持原语义（激活时定格）。
  const isDevMode = typeof devMode === 'function' ? () => devMode() === true : () => devMode === true

  function load() {
    if (typeof dataDir !== 'string' || dataDir.length === 0 || !existsSync(file)) return []
    try {
      return readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-max)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return { at: null, source: 'unknown', message: line }
          }
        })
    } catch {
      return []
    }
  }

  function trim() {
    if (typeof dataDir !== 'string' || dataDir.length === 0) return
    const all = load()
    if (all.length <= max) return
    try {
      writeFileSync(file, `${all.slice(-max).map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
    } catch {
      // 剪枝失败不影响写日志
    }
  }

  return {
    /** 记一条（level: info | warn | error）。写入失败绝不抛错，别把主流程带崩。 */
    add(entry = {}) {
      const record = {
        at: entry.at ?? now(),
        level: entry.level ?? 'info',
        source: String(entry.source ?? 'plugin'),
        message: String(entry.message ?? '').slice(0, 2000),
        ...(entry.detail === undefined ? {} : { detail: typeof entry.detail === 'string' ? entry.detail.slice(0, 4000) : entry.detail }),
        ...(entry.tool === undefined ? {} : { tool: String(entry.tool) }),
        ...(entry.where === undefined ? {} : { where: String(entry.where) }),
      }
      buffer.push(record)
      if (buffer.length > max) buffer.splice(0, buffer.length - max)
      if (typeof dataDir === 'string' && dataDir.length > 0) {
        try {
          mkdirSync(dataDir, { recursive: true })
          appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
          if (buffer.length % 50 === 0) trim()
        } catch {
          // 忽略写盘失败
        }
      }
      return record
    },
    /** 读最近日志（默认最近 50 条）：文件里的历史 + 本次进程内存里的，按内容去重避免重复计数。 */
    recent(limit = 50) {
      const seen = new Set()
      const merged = []
      for (const entry of [...load(), ...buffer]) {
        const key = `${entry.at}|${entry.level}|${entry.source}|${entry.message}|${entry.tool ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(entry)
      }
      return merged.slice(-Math.max(1, Number(limit) || 50))
    },
    /**
     * 生成给模型看的报告：按级别/来源汇总 + 最近错误明细 + 复现线索。
     * devMode 只影响「要不要建议改代码」，读报告本身始终允许（便于非开发模式反馈问题）。
     */
    report({ limit = 40 } = {}) {
      const entries = this.recent(200)
      const byLevel = {}
      const bySource = {}
      for (const entry of entries) {
        byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1
        bySource[entry.source] = (bySource[entry.source] ?? 0) + 1
      }
      const failures = entries.filter((entry) => entry.level === 'error').slice(-limit)
      return {
        devMode: isDevMode(),
        file: typeof dataDir === 'string' && dataDir.length > 0 ? file : null,
        total: entries.length,
        byLevel,
        bySource,
        failures,
        recent: entries.slice(-limit),
        guidance: isDevMode()
          ? '开发模式已开启：可定位插件源码（plugins/dsh-comfymcp-client/**）并直接修复；改完提示用户重装 bundle 或重启 DSH，并把结论记回 note。'
          : '开发模式未开启：严禁修改任何插件源码；请把这份报告要点转述给用户，由用户决定是否开启开发模式。',
      }
    },
    /** 清空日志（开发模式排查时用）。 */
    clear() {
      buffer.length = 0
      if (typeof dataDir === 'string' && dataDir.length > 0) {
        try {
          mkdirSync(dataDir, { recursive: true })
          writeFileSync(file, '', 'utf8')
        } catch {
          // 忽略
        }
      }
      return { ok: true }
    },
  }
}
