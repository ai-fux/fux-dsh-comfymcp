import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { HttpNodeHealthProbe } from '../src/node-discovery.js'
import { HttpRemoteTransport } from '../src/http-remote-transport.js'
import type { IpcEvent } from '@fux/protocol'

/**
 * G-01 cross-language contract test: the Node reference client
 * (`HttpRemoteTransport` + `HttpNodeHealthProbe`) drives the Python reference
 * endpoint (`examples/python-remote-endpoint/remote_endpoint.py`) — proving the
 * remote wire protocol (docs/remote-wire-protocol.md) is implementable outside
 * Node. Skipped when no Python 3 interpreter is available.
 */

const ENDPOINT_SCRIPT = new URL('../../../examples/python-remote-endpoint/remote_endpoint.py', import.meta.url)

function findPython(): string | undefined {
  for (const candidate of [['python'], ['python3'], ['py', '-3']]) {
    // Probe with `--version`: a bare `python` (closed stdin) exits 0 silently,
    // and some Windows launchers print the banner to stderr — hence shell:true
    // plus merging both streams.
    const probe = spawnSync(candidate[0]!, [...candidate.slice(1), '--version'], {
      encoding: 'utf8',
      shell: true,
    })
    const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`
    if (probe.status === 0 && output.includes('Python 3')) return candidate.join(' ')
  }
  return undefined
}

const pythonCmd = findPython()

describe.skipIf(pythonCmd === undefined)('Python reference endpoint (wire contract, G-01)', () => {
  let child: ChildProcess
  let url: string
  let transport: HttpRemoteTransport
  const events: IpcEvent[] = []

  beforeAll(async () => {
    const [cmd, ...prefix] = pythonCmd!.split(' ')
    // fileURLToPath (not .pathname): on Windows pathname is "/F:/..." which
    // Python cannot open.
    child = spawn(cmd!, [...prefix, fileURLToPath(ENDPOINT_SCRIPT), '--demo', '--host', '127.0.0.1', '--port', '0', '--node-id', 'py-node-1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    url = await new Promise<string>((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('endpoint did not become ready in time')), 20_000)
      child.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const line = buffer.split('\n').find((l) => l.startsWith('READY'))
        if (!line) return
        clearTimeout(timer)
        const readyUrl = /url=(\S+)/.exec(line)?.[1]
        if (readyUrl) resolve(readyUrl)
        else reject(new Error(`unparseable READY line: ${line}`))
      })
      const stderr: string[] = []
      child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`endpoint exited early (code=${code})${stderr.length ? `: ${stderr.join('')}` : ''}`))
      })
    })

    transport = new HttpRemoteTransport({ url })
    transport.onEvent((event) => events.push(event))
    await transport.open()
  }, 30_000)

  afterAll(async () => {
    await transport?.close()
    child?.kill()
  })

  it('reports its capability list via GET /capabilities', async () => {
    // `let` (not const): onCapabilities may fire synchronously when the
    // capability list was already fetched during open().
    let off: (() => void) | undefined
    const capabilities = await new Promise<string[]>((resolve) => {
      off = transport.onCapabilities((list) => {
        off?.()
        resolve(list)
      })
    })
    expect(capabilities).toEqual(['demo:fail', 'demo:upper'])
  })

  it('executes an invoke round trip (POST /invoke, IpcResponse out)', async () => {
    const reply = await transport.call({ id: 'c1', capability: 'demo:upper', payload: { text: 'abc' } })
    expect(reply).toEqual({ id: 'c1', ok: true, result: 'ABC' })
  })

  it('answers a failing handler with HTTP 200 + E_PLUGIN_ERROR envelope', async () => {
    const reply = await transport.call({ id: 'c2', capability: 'demo:fail' })
    expect(reply.ok).toBe(false)
    expect(reply.ok === false && reply.error.code).toBe('E_PLUGIN_ERROR')
    expect(reply.ok === false && reply.error.retryable).toBe(false)
  })

  it('answers an unknown capability with E_CAPABILITY_NOT_FOUND', async () => {
    const reply = await transport.call({ id: 'c3', capability: 'nope:missing' })
    expect(reply.ok).toBe(false)
    expect(reply.ok === false && reply.error.code).toBe('E_CAPABILITY_NOT_FOUND')
  })

  it('answers the G4 health handshake with identity + protocolVersion', async () => {
    const probe = new HttpNodeHealthProbe({ timeoutMs: 5000 })
    const result = await probe.probe(url)
    expect(result.id).toBe('py-node-1')
    expect(result.status).toBe('ok')
    expect(result.capabilities).toContain('demo:upper')
  })

  it('pushes IpcEvent frames over the SSE stream for settled invokes', async () => {
    await transport.call({ id: 'c4', capability: 'demo:upper', payload: { text: 'sse' } })
    await vi.waitFor(() => {
      const event = events.find((e) => e.topic === 'demo:invoked')
      if (!event) throw new Error('no demo:invoked event yet')
      expect(event.payload).toMatchObject({ capability: 'demo:upper', ok: true })
      expect(event.source).toBe('py-node-1')
      expect(event.schemaVersion).toBe(1)
      expect(typeof event.occurredAt).toBe('number')
    })
  })
})
