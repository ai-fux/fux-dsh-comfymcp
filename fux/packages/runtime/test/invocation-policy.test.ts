import { describe, expect, it } from 'vitest'
import { FuxCore } from '@fux/core'
import { Supervisor } from '../src/supervisor.js'
import { CapabilityDeniedError, IpcInvocationError, HostNotRunningError } from '../src/errors.js'
import {
  InvocationCancelledError,
  invokeWithPolicy,
  isRetryable,
} from '../src/invocation-policy.js'
import type { FuxPluginModule } from '../src/types.js'

const retryable = new IpcInvocationError({ code: 'E_TMP', message: 'flaky', retryable: true })

function flaky(steps: number, last?: unknown) {
  let remaining = steps
  return async (): Promise<unknown> => {
    if (remaining-- > 0) throw retryable
    return last
  }
}

describe('invokeWithPolicy (CR-02)', () => {
  it('invokes once and returns when no policy is given', async () => {
    let calls = 0
    const value = await invokeWithPolicy(async () => {
      calls += 1
      return 'ok'
    })
    expect(value).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries a retryable failure up to maxRetries then succeeds', async () => {
    let calls = 0
    const op = async (): Promise<string> => {
      calls += 1
      if (calls < 3) throw retryable
      return 'ok'
    }
    const jitterless = { jitter: false, maxRetries: 3, baseDelayMs: 1 }
    await expect(invokeWithPolicy(op, { retry: jitterless })).resolves.toBe('ok')
    expect(calls).toBe(3)
  })

  it('gives up after maxRetries by rethrowing the last failure', async () => {
    const op = flaky(5, 'ok')
    await expect(
      invokeWithPolicy(op, { retry: { maxRetries: 2, baseDelayMs: 1, jitter: false } }),
    ).rejects.toBe(retryable)
  })

  it('never retries non-retryable failures by default', async () => {
    let calls = 0
    const denied = new CapabilityDeniedError('app', 'greeting:hello')
    const op = async (): Promise<never> => {
      calls += 1
      throw denied
    }
    await expect(
      invokeWithPolicy(op, { retry: { maxRetries: 3, baseDelayMs: 1, jitter: false } }),
    ).rejects.toBe(denied)
    expect(calls).toBe(1)
  })

  it('honours a retryWhen predicate to opt into retrying non-retryable errors', async () => {
    let calls = 0
    const denied = new CapabilityDeniedError('app', 'greeting:hello')
    const op = async (): Promise<string> => {
      calls += 1
      if (calls < 2) throw denied
      return 'recovered'
    }
    await expect(
      invokeWithPolicy(op, {
        retry: { maxRetries: 2, baseDelayMs: 1, jitter: false, retryWhen: () => true },
      }),
    ).resolves.toBe('recovered')
    expect(calls).toBe(2)
  })

  it('rejects with InvocationCancelledError when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(invokeWithPolicy(flaky(0), { signal: controller.signal })).rejects.toBeInstanceOf(
      InvocationCancelledError,
    )
  })

  it('rejects during the retry backoff when the signal aborts', async () => {
    const controller = new AbortController()
    const pending = invokeWithPolicy(flaky(10, 'ok'), {
      signal: controller.signal,
      retry: { maxRetries: 9, baseDelayMs: 5000, jitter: false },
    })
    setTimeout(() => controller.abort(), 5)
    await expect(pending).rejects.toBeInstanceOf(InvocationCancelledError)
  })

  it('exposes isRetryable over FuxRuntimeError instances', () => {
    expect(
      isRetryable(new IpcInvocationError({ code: 'E_X', message: 'x', retryable: true })),
    ).toBe(true)
    expect(isRetryable(new HostNotRunningError('p'))).toBe(true)
    expect(isRetryable(new CapabilityDeniedError('a', 'b'))).toBe(false)
  })
})

describe('CR-02 hooks plumbed through the Supervisor', () => {
  function startableApp() {
    const greeterManifest = {
      id: '@fux/example-greeter',
      name: 'Greeter',
      version: '0.0.1',
      protocol: '^0.1.0',
      executionMode: 'in_process',
      capabilities: [{ name: 'greeting:hello', version: '0.0.1' }],
    }
    const core = new FuxCore()
    core.register(greeterManifest)
    const { graph } = core.compose({
      id: 'cr02-demo',
      name: 'CR-02 Demo',
      version: '0.0.1',
      plugins: [{ id: '@fux/example-greeter' }],
    })
    return { core, graph }
  }

  it('retries a flaky capability through callAsSystem when a policy is supplied', async () => {
    const { core, graph } = startableApp()
    let attempts = 0
    const greeterModule: FuxPluginModule = {
      activate: ({ provide }) => {
        provide('greeting:hello', () => {
          attempts += 1
          if (attempts < 3) throw new Error('flaky')
          return 'recovered'
        })
      },
    }
    const runtime = await new Supervisor(core.events).start(graph, (pluginId) => {
      if (pluginId === '@fux/example-greeter') return greeterModule
      throw new Error(`unexpected ${pluginId}`)
    })
    try {
      const value = await runtime.callAsSystem<string>(
        'greeting:hello',
        {},
        {
          retry: { maxRetries: 3, baseDelayMs: 1, jitter: false, retryWhen: () => true },
        },
      )
      expect(value).toBe('recovered')
      expect(attempts).toBe(3)
    } finally {
      await runtime.stop()
    }
  })

  it('rejects with cancellation when callAsSystem is given an aborted signal', async () => {
    const { core, graph } = startableApp()
    const greeterModule: FuxPluginModule = {
      activate: ({ provide }) => {
        provide('greeting:hello', () => 'hi')
      },
    }
    const runtime = await new Supervisor(core.events).start(graph, () => greeterModule)
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(
        runtime.callAsSystem('greeting:hello', {}, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(InvocationCancelledError)
    } finally {
      await runtime.stop()
    }
  })

  it('leaves the call path unchanged when no policy is supplied', async () => {
    const { core, graph } = startableApp()
    const greeterModule: FuxPluginModule = {
      activate: ({ provide }) => {
        provide('greeting:hello', () => 'plain')
      },
    }
    const runtime = await new Supervisor(core.events).start(graph, () => greeterModule)
    try {
      await expect(runtime.callAsSystem<string>('greeting:hello')).resolves.toBe('plain')
    } finally {
      await runtime.stop()
    }
  })
})
