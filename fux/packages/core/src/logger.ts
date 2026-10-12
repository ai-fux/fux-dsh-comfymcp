export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function createConsoleLogger(level: LogLevel = 'info'): Logger {
  const write = (threshold: LogLevel) => (entryLevel: LogLevel) =>
    LEVEL_WEIGHT[entryLevel] >= LEVEL_WEIGHT[threshold]

  const logger: Logger = {
    debug(message, meta) {
      if (write(level)('debug')) console.log('[fux:debug]', message, meta ?? '')
    },
    info(message, meta) {
      if (write(level)('info')) console.log('[fux:info]', message, meta ?? '')
    },
    warn(message, meta) {
      if (write(level)('warn')) console.warn('[fux:warn]', message, meta ?? '')
    },
    error(message, meta) {
      if (write(level)('error')) console.error('[fux:error]', message, meta ?? '')
    },
    child(bindings) {
      const tag = JSON.stringify(bindings)
      const wrap =
        (original: (message: string, meta?: Record<string, unknown>) => void) =>
        (message: string, meta?: Record<string, unknown>) =>
          original(`${tag} ${message}`, meta)
      return {
        debug: wrap(logger.debug),
        info: wrap(logger.info),
        warn: wrap(logger.warn),
        error: wrap(logger.error),
        child: (more) => logger.child({ ...bindings, ...more }),
      }
    },
  }
  return logger
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
}
