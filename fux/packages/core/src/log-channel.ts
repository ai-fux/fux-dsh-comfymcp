import type { LogLevel, Logger } from './logger.js'

/**
 * FR-01: unified log channel + optional persistence hook. A LogChannel carries
 * the same logging methods as a `Logger`, but routes every record through an
 * optional `LogSink` in addition to the base logger. The base logger is always
 * kept (console / noop / whatever the caller already uses), so existing logging
 * keeps working verbatim — the channel is a pure bypass. A `LogSink` failure is
 * swallowed and never breaks the base log path.
 */

export interface LogEntry {
  level: LogLevel
  message: string
  meta?: Record<string, unknown>
  source?: string
  occurredAt: number
}

/** Optional durability / observability hook for emitted log records. */
export interface LogSink {
  append(entry: LogEntry): Promise<void> | void
}

export interface LogChannel extends Logger {
  /** Install (or replace) the optional persistence / observability sink. */
  setSink(sink?: LogSink): void
}

/**
 * Build a unified log channel over an existing logger. Records go to the base
 * logger exactly as before, and are additionally appended to `sink` when set.
 * A missing or failing sink never disturbs the base path (synchronous throws
 * and async rejections are both contained).
 */
export function createLogChannel(base: Logger, sink?: LogSink): LogChannel {
  let currentSink: LogSink | undefined = sink

  const emit = (
    level: LogLevel,
    message: string,
    meta: Record<string, unknown> | undefined,
    bindings: Record<string, unknown>,
  ): void => {
    base[level](message, meta)
    if (!currentSink) return
    const entry: LogEntry = {
      level,
      message,
      ...(meta ? { meta } : {}),
      ...(typeof bindings.source === 'string' ? { source: bindings.source } : {}),
      occurredAt: Date.now(),
    }
    try {
      const result = currentSink.append(entry)
      if (
        result &&
        typeof result === 'object' &&
        typeof (result as Promise<void>).catch === 'function'
      ) {
        void (result as Promise<void>).catch((error) =>
          base.error('log sink append failed', { error }),
        )
      }
    } catch (error) {
      base.error('log sink append failed', { error })
    }
  }

  const make = (bindings: Record<string, unknown>): LogChannel => {
    const prefix = Object.keys(bindings).length ? `${JSON.stringify(bindings)} ` : ''
    const level = (levelName: LogLevel) => (message: string, meta?: Record<string, unknown>) =>
      emit(levelName, `${prefix}${message}`, meta, bindings)
    return {
      debug: level('debug'),
      info: level('info'),
      warn: level('warn'),
      error: level('error'),
      child: (more) => make({ ...bindings, ...more }),
      setSink(next) {
        currentSink = next
      },
    }
  }

  return make({})
}
