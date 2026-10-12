import { afterAll, describe, expect, it } from 'vitest'
import { createControlServer, isLoopbackOrigin } from '../lib/control-server.js'

const started = []

async function startServer(options = {}) {
  const methods = {
    status: async () => ({ ok: true, host: { serverInfo: { name: 'x' } } }),
    configRead: async () => ({ endpoint: 'http://127.0.0.1:18800/mcp', controlToken: options.token ?? '' }),
    configWrite: async (patch) => ({ applied: patch }),
    artifact: (searchParams) => {
      if (searchParams.get('path') === 'missing.png') return { error: 'gone' }
      return { bytes: Buffer.from([1, 2, 3]), contentType: 'image/png' }
    },
  }
  const control = createControlServer({
    methods,
    port: options.port ?? 0,
    token: options.token ?? '',
    version: '0.0.0-test',
  })
  const bound = await control.start()
  started.push(control)
  return { control, base: bound.url }
}

afterAll(() => {
  for (const control of started) control.close()
})

const MARKER = { 'x-dsh-comfymcp': '1' }

describe('control-server', () => {
  it('answers health, status and config with the {ok,value} envelope', async () => {
    const { base } = await startServer()
    const health = await (await fetch(`${base}/health`, { headers: MARKER })).json()
    expect(health.ok).toBe(true)
    expect(health.value.plugin).toBe('dsh-comfymcp-client')
    const status = await (await fetch(`${base}/status`, { headers: MARKER })).json()
    expect(status.value.host.serverInfo.name).toBe('x')
    const config = await (await fetch(`${base}/config`, { headers: MARKER })).json()
    expect(config.value.endpoint).toContain('18800')
  })

  it('writes config through set-config (POST + preflight + marker)', async () => {
    const { base } = await startServer()
    const origin = 'http://127.0.0.1:13188'
    const preflight = await fetch(`${base}/set-config`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-dsh-comfymcp,content-type' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
    const written = await (
      await fetch(`${base}/set-config`, {
        method: 'POST',
        headers: { ...MARKER, 'content-type': 'application/json', origin },
        body: JSON.stringify({ embeddedServer: true }),
      })
    ).json()
    expect(written.value.applied.embeddedServer).toBe(true)
  })

  it('rejects non-loopback origins, missing marker and cross-site fetch (guards)', async () => {
    const { base } = await startServer()
    const evilOrigin = await fetch(`${base}/status`, { headers: { ...MARKER, origin: 'http://evil.example:1' } })
    expect(evilOrigin.status).toBe(403)
    const noMarker = await fetch(`${base}/status`)
    expect(noMarker.status).toBe(403)
    const crossSite = await fetch(`${base}/status`, { headers: { ...MARKER, 'sec-fetch-site': 'cross-site' } })
    expect(crossSite.status).toBe(403)
  })

  it('enforces the token header and the artifact query token (boundary)', async () => {
    const { base } = await startServer({ token: 'secret' })
    const noToken = await fetch(`${base}/status`, { headers: MARKER })
    expect(noToken.status).toBe(403)
    const withToken = await fetch(`${base}/status`, { headers: { ...MARKER, 'x-dsh-comfymcp-token': 'secret' } })
    expect(withToken.status).toBe(200)
    const artifact = await fetch(`${base}/artifact?path=a.png&token=secret`)
    expect(artifact.status).toBe(200)
    expect(artifact.headers.get('content-type')).toBe('image/png')
    const badArtifact = await fetch(`${base}/artifact?path=a.png&token=wrong`)
    expect(badArtifact.status).toBe(403)
    const missing = await fetch(`${base}/artifact?path=missing.png&token=secret`)
    expect(missing.status).toBe(404)
  })

  it('falls through to the next port when the requested one is taken (boundary)', async () => {
    const { createServer } = await import('node:http')
    const blocker = createServer()
    await new Promise((resolve) => {
      blocker.once('listening', resolve)
      blocker.listen(0, '127.0.0.1')
    })
    const taken = blocker.address().port
    try {
      const { base } = await startServer({ port: taken })
      expect(new URL(base).port).toBe(String(taken + 1))
    } finally {
      blocker.close()
    }
  })
})

describe('isLoopbackOrigin', () => {
  it('accepts loopback hosts and rejects others', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:13188')).toBe(true)
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true)
    expect(isLoopbackOrigin('http://192.0.2.10:28080')).toBe(false)
    expect(isLoopbackOrigin('not a url')).toBe(false)
    expect(isLoopbackOrigin('')).toBe(false)
  })
})
