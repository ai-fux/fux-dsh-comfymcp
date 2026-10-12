import { describe, expect, it } from 'vitest'
import {
  IpcEventSchema,
  IpcRequestSchema,
  ipcFail,
  ipcOk,
  isIpcSuccess,
  newRequestId,
} from '../src/ipc.js'

describe('ipcOk / ipcFail', () => {
  it('omits result key when undefined', () => {
    const response = ipcOk('r1')
    expect(response).toEqual({ id: 'r1', ok: true })
    expect('result' in response).toBe(false)
  })

  it('keeps result when provided', () => {
    expect(ipcOk('r1', 42)).toEqual({ id: 'r1', ok: true, result: 42 })
  })

  it('builds failures with default retryable=false', () => {
    expect(ipcFail('r1', 'E_TIMEOUT', 'timed out')).toEqual({
      id: 'r1',
      ok: false,
      error: { code: 'E_TIMEOUT', message: 'timed out', retryable: false },
    })
  })

  it('guards success responses', () => {
    expect(isIpcSuccess(ipcOk('r1'))).toBe(true)
    expect(isIpcSuccess(ipcFail('r1', 'E_INTERNAL', 'x'))).toBe(false)
  })
})

describe('IpcRequestSchema', () => {
  it('accepts a well-formed request', () => {
    const parsed = IpcRequestSchema.safeParse({
      id: 'r1',
      capability: 'greeting:hello',
      payload: { who: 'fux' },
      timeoutMs: 5000,
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects malformed capability names', () => {
    const parsed = IpcRequestSchema.safeParse({ id: 'r1', capability: 'greeting' })
    expect(parsed.success).toBe(false)
  })

  it('rejects non-positive timeouts', () => {
    const parsed = IpcRequestSchema.safeParse({
      id: 'r1',
      capability: 'greeting:hello',
      timeoutMs: 0,
    })
    expect(parsed.success).toBe(false)
  })
})

describe('IpcEventSchema', () => {
  it('accepts a well-formed event', () => {
    const parsed = IpcEventSchema.safeParse({
      topic: 'app:ready',
      payload: { ok: true },
      source: '@fux/example-app',
      occurredAt: 1724500000000,
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects negative timestamps and malformed topics', () => {
    expect(IpcEventSchema.safeParse({ topic: 'app:ready', occurredAt: -1 }).success).toBe(false)
    expect(IpcEventSchema.safeParse({ topic: 'ready', occurredAt: 1 }).success).toBe(false)
  })

  it('accepts an explicit schema version and omits it by default (BR-04)', () => {
    expect(
      IpcEventSchema.safeParse({ topic: 'app:ready', occurredAt: 1, schemaVersion: 2 }).success,
    ).toBe(true)
    const legacy = IpcEventSchema.safeParse({ topic: 'app:ready', occurredAt: 1 })
    expect(legacy.success).toBe(true)
    if (legacy.success) expect(legacy.data.schemaVersion).toBeUndefined()
  })

  it('rejects non-positive schema versions', () => {
    expect(
      IpcEventSchema.safeParse({ topic: 'app:ready', occurredAt: 1, schemaVersion: 0 }).success,
    ).toBe(false)
  })
})

describe('newRequestId', () => {
  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newRequestId()))
    expect(ids.size).toBe(100)
  })
})
