import { z } from 'zod'
import { CapabilityNameSchema } from './capability.js'

export const IpcErrorCodeSchema = z.enum([
  'E_VALIDATION',
  'E_CAPABILITY_NOT_FOUND',
  'E_CAPABILITY_DENIED',
  'E_PLUGIN_ERROR',
  'E_TIMEOUT',
  'E_PLUGIN_CRASHED',
  'E_INTERNAL',
])

export type IpcErrorCode = z.infer<typeof IpcErrorCodeSchema>

export const IpcRequestSchema = z.object({
  id: z.string().min(1).max(128),
  capability: CapabilityNameSchema,
  payload: z.unknown().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
})

export type IpcRequest = z.infer<typeof IpcRequestSchema>

export const IpcErrorSchema = z.object({
  code: IpcErrorCodeSchema,
  message: z.string().min(1).max(2000),
  retryable: z.boolean().default(false),
})

export type IpcError = z.infer<typeof IpcErrorSchema>

export const IpcSuccessSchema = z.object({
  id: z.string().min(1).max(128),
  ok: z.literal(true),
  result: z.unknown().optional(),
})

export type IpcSuccess = z.infer<typeof IpcSuccessSchema>

export const IpcFailureSchema = z.object({
  id: z.string().min(1).max(128),
  ok: z.literal(false),
  error: IpcErrorSchema,
})

export type IpcFailure = z.infer<typeof IpcFailureSchema>

export const IpcResponseSchema = z.union([IpcSuccessSchema, IpcFailureSchema])
export type IpcResponse = z.infer<typeof IpcResponseSchema>

export const IpcEventSchema = z.object({
  topic: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,31}:[a-z][a-z0-9-]{1,31}$/)
    .max(100),
  payload: z.unknown().optional(),
  source: z.string().min(1).max(200).optional(),
  occurredAt: z.number().int().nonnegative(),
  // BR-04: event schema version. Absent means schema version 1 (legacy events stay readable).
  schemaVersion: z.number().int().positive().max(9999).optional(),
})

export type IpcEvent = z.infer<typeof IpcEventSchema>

export function ipcOk(id: string, result?: unknown): IpcSuccess {
  return result === undefined ? { id, ok: true } : { id, ok: true, result }
}

export function ipcFail(
  id: string,
  code: IpcErrorCode,
  message: string,
  retryable = false,
): IpcFailure {
  return { id, ok: false, error: { code, message, retryable } }
}

export function isIpcSuccess(response: IpcResponse): response is IpcSuccess {
  return response.ok
}

let requestCounter = 0

export function newRequestId(prefix = 'req'): string {
  requestCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${requestCounter}`
}
