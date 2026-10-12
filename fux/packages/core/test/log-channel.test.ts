import { describe, expect, it, vi } from 'vitest'
import { createLogChannel, type LogEntry, type LogSink } from '../src/log-channel.js'
import { createConsoleLogger, noopLogger, type Logger } from '../src/logger.js'

/** A logger that captures every record in memory (for assertions). */
function captureBase(): { logger: Logger; records: Array<[string, string, unknown]> } {
  const records: Array<[string, string, unknown]> = []
  const logger: Logger = {
    debug: (m, meta) => void records.push(['debug', m, meta]),
    info: (m, meta) => void records.push(['info', m, meta]),
    warn: (m, meta) => void records.push(['warn', m, meta]),
    error: (m, meta) => void records.push(['error', m, meta]),
    child: () => logger,
  }
  return { logger, records }
}

describe('createLogChannel (FR-01)', () => {
  it('forwards records to the base logger unchanged when no sink is set', () => {
    const { logger, records } = captureBase()
    const channel = createLogChannel(logger)
    channel.info('hello')
    channel.warn('careful', { reason: 'x' })
    expect(records).toEqual([
      ['info', 'hello', undefined],
      ['warn', 'careful', { reason: 'x' }],
    ])
  })

  it('appends each record to a log sink in addition to the base logger', () => {
    const { logger } = captureBase()
    const appended: LogEntry[] = []
    const sink: LogSink = { append: (e) => void appended.push(e) }
    const channel = createLogChannel(logger, sink)
    channel.info('hello', { who: 'FUX' })
    channel.error('boom')
    expect(appended).toHaveLength(2)
    expect(appended[0]!).toMatchObject({
      level: 'info',
      message: 'hello',
      meta: { who: 'FUX' },
    })
    expect(typeof appended[0]!.occurredAt).toBe('number')
  })

  it('child() prefixes bindings and tags the source into sink entries', () => {
    const { logger } = captureBase()
    const appended: LogEntry[] = []
    const channel = createLogChannel(logger, { append: (e) => void appended.push(e) })
    const child = channel.child({ source: 'plugin-a' })
    child.debug('step 1')
    expect(appended).toHaveLength(1)
    expect(appended[0]!.source).toBe('plugin-a')
    expect(appended[0]!.message).toContain('plugin-a')
  })

  it('setSink installs/replaces the sink after construction', () => {
    const { logger } = captureBase()
    const appended: LogEntry[] = []
    const channel = createLogChannel(logger)
    channel.info('before') // no sink yet
    channel.setSink({ append: (e) => void appended.push(e) })
    channel.info('after')
    expect(appended).toHaveLength(1)
    expect(appended[0]!.message).toBe('after')
  })

  it('keeps the base path healthy when the sink throws synchronously', () => {
    const { logger } = captureBase()
    const error = vi.spyOn(logger, 'error')
    const channel = createLogChannel(logger, {
      append: () => {
        throw new Error('sink failed')
      },
    })
    expect(() => channel.info('still-logs')).not.toThrow()
    expect(error).toHaveBeenCalledWith('log sink append failed', expect.anything())
  })

  it('does not break the base path when an async sink rejects', async () => {
    const { logger } = captureBase()
    const error = vi.spyOn(logger, 'error')
    const channel = createLogChannel(logger, {
      append: async () => {
        throw new Error('backend down')
      },
    })
    channel.info('still-logs')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(error).toHaveBeenCalledWith('log sink append failed', expect.anything())
  })

  it('works with the real console logger and noopLogger without throwing', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const channel = createLogChannel(createConsoleLogger(), { append: () => undefined })
      channel.info('works')
    } finally {
      consoleSpy.mockRestore()
    }
    expect(() => createLogChannel(noopLogger).warn('noop')).not.toThrow()
  })
})
