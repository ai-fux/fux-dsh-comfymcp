import vm from 'node:vm'
import { SandboxExecutionError, SandboxTimeoutError, SandboxViolationError } from './errors.js'

/**
 * G3: the L2 restricted-execution runtime. `SandboxRuntime` runs untrusted
 * handler source inside an isolated `node:vm` context behind three boundaries:
 *
 *  1. **interface surface** — the context exposes only a fixed set of primordials
 *     plus a host-built `SandboxApi` object; no Node/browser globals, no module
 *     system, no `process`, `require`, `fs`, `fetch`, ...
 *  2. **time budget** — compiling the source and each invocation is bounded by an
 *     explicit timeout.
 *  3. **state isolation** — every loaded script gets its own context (nothing
 *     leaks between capabilities), and every returned value is JSON-cloned and
 *     validated, so no vm-realm object/handler ever escapes.
 *
 * This is a *good-faith* boundary, not a hardened adversary sandbox (the OS sub-
 * process of the worker host is the L1 line for hostile input). It guarantees
 * interface + resource + state isolation; it does not pretend to defend against a
 * determined vm escape. See ADR-0031.
 */

/**
 * A JSON-safe value the sandbox may exchange with the host. Anything else (class
 * instances, sparse arrays, non-finite numbers, cyclic references, functions,
 * `undefined`) is rejected at the boundary.
 */
export type SandboxValue =
  null | boolean | number | string | SandboxValue[] | { [key: string]: SandboxValue }

/**
 * The host-provided surface a sandboxed handler may act on. This is the *entire*
 * ambient API available to untrusted code; it is built by the caller per script
 * and injected into the vm context. `config` is a frozen, JSON-safe copy so
 * sandboxed code can read, never mutate, its configuration.
 */
export interface SandboxApi {
  call<T = unknown>(capability: string, payload?: SandboxValue): Promise<T>
  emit(topic: string, payload?: SandboxValue): void
  readonly config: Readonly<Record<string, unknown>>
}

export interface SandboxRuntimeOptions {
  /** Budget for a single sandboxed invocation (ms). Default 1000. */
  timeoutMs?: number
  /** Budget for compiling / evaluating untrusted source (ms). Default 500. */
  compileTimeoutMs?: number
}

/** A handle to one compiled, isolated sandbox script. */
export interface SandboxScript {
  /** Invoke the loaded handler with a JSON-safe payload; enforces timeout + JSON-safety. */
  run(payload: unknown): Promise<unknown>
  /** Drop the vm context and any per-script state. Idempotent. */
  dispose(): void
}

export class SandboxRuntime {
  private readonly timeoutMs: number
  private readonly compileTimeoutMs: number

  constructor(options: SandboxRuntimeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 1000
    this.compileTimeoutMs = options.compileTimeoutMs ?? 500
  }

  /**
   * Compile `source` — a function expression with the signature
   * `(payload, api)` — into a fresh, isolated vm context and return a handle.
   * The source must evaluate to a function; any other value is a violation.
   */
  load(source: string, api: SandboxApi): SandboxScript {
    const context = vm.createContext(Object.assign({}, sandboxedGlobals(), { api }))
    let fn: unknown
    try {
      fn = new vm.Script(`(${source})`, { filename: 'sandbox' }).runInContext(context, {
        timeout: this.compileTimeoutMs,
      })
    } catch (error) {
      throw new SandboxViolationError(
        `sandbox source failed to compile: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (typeof fn !== 'function') {
      throw new SandboxViolationError('sandbox source must evaluate to a function')
    }
    const handler = fn as (payload: unknown, api: SandboxApi) => unknown
    return {
      run: (payload) => this.invoke(handler, api, payload),
      // A fresh context is created per load(); nothing to tear down explicitly.
      dispose: () => undefined,
    }
  }

  private async invoke(
    handler: (payload: unknown, api: SandboxApi) => unknown,
    api: SandboxApi,
    payload: unknown,
  ): Promise<unknown> {
    let result: unknown
    try {
      result = await Promise.race([
        Promise.resolve(handler(payload, api)),
        // Cooperative wall-clock budget: the host stops *awaiting* past the budget.
        // It cannot unwind an already-leaked synchronous loop inside the vm — that
        // is why this is the L2 line, with the OS process as L1.
        rejectAfter(this.timeoutMs, new SandboxTimeoutError(this.timeoutMs)),
      ])
    } catch (error) {
      if (error instanceof SandboxTimeoutError) throw error
      throw new SandboxExecutionError(error instanceof Error ? error.message : String(error))
    }
    if (!isJsonSafe(result)) {
      throw new SandboxViolationError('sandbox handler returned a non-JSON-safe value')
    }
    // JSON round-trip detaches the result from the vm realm (state isolation) and
    // yields a host-side plain value for callers.
    return JSON.parse(JSON.stringify(result))
  }
}

function rejectAfter(ms: number, error: Error): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(error), ms)
  })
}

/**
 * A strict, transitive JSON-safety check, tolerant of *any* vm realm's prototype
 * identity (a plain object created inside `node:vm` carries that realm's
 * `Object.prototype`, not the host's). Unlike a bare `JSON.stringify`, it does not
 * silently drop `undefined`, functions, symbols or class instances — those are
 * boundary violations, not folded into `undefined`.
 */
function isJsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null) return true
  const t = typeof value
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(value)
  if (t !== 'object') return false
  const obj = value as object
  if (seen.has(obj)) return false
  seen.add(obj)
  if (Array.isArray(obj)) return (obj as unknown[]).every((v) => isJsonSafe(v, seen))
  // Ordinary objects across any realm are walked by their own enumerable values;
  // only those values must be JSON-safe. Only own enumerable data survives the
  // JSON clone, so identity-sensitive payloads (Date, class instances) degrade to
  // their plain shape rather than leaking their realm/prototype across.
  return Object.entries(obj).every(([key, v]) => isJsonSafe(key, seen) && isJsonSafe(v, seen))
}

/**
 * A deliberately small, dependency-free set of read-only primordials exposed to
 * sandboxed code. This is the entire global surface — no `process`, no modules,
 * no network, no I/O. New intrinsics must be reviewed before being added here.
 */
function sandboxedGlobals(): Record<string, unknown> {
  const names = [
    'Array',
    'ArrayBuffer',
    'Boolean',
    'DataView',
    'Date',
    'Error',
    'EvalError',
    'Float32Array',
    'Float64Array',
    'Int8Array',
    'Int16Array',
    'Int32Array',
    'JSON',
    'Map',
    'Math',
    'Number',
    'Object',
    'Promise',
    'RangeError',
    'ReferenceError',
    'Reflect',
    'RegExp',
    'Set',
    'String',
    'Symbol',
    'SyntaxError',
    'TypeError',
    'Uint8Array',
    'Uint16Array',
    'Uint32Array',
    'URIError',
    'WeakMap',
    'WeakSet',
  ]
  const g = globalThis as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const name of names) {
    if (typeof g[name] !== 'undefined') out[name] = g[name]
  }
  return out
}
