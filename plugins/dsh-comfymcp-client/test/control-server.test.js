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
  Object.assign(methods, options.extraMethods ?? {})
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

  // ─── 工作台：/ui 页面与 /api 路由 ───────────────────────────────────
  function workbenchMethods(calls = []) {
    return {
      pageIndex: async ({ token }) => {
        calls.push(['pageIndex', token])
        return { html: `<html>index ${token}</html>` }
      },
      pageWorkflow: async (name, { token }) => (name === 'beach' ? { html: `<html>wf ${name} ${token}</html>` } : { error: `工作流 ${name} 不存在` }),
      pageArtifacts: async ({ token }) => ({ html: `<html>artifacts ${token}</html>` }),
      listWorkflows: async () => ({ workflows: [{ name: 'beach' }] }),
      getPage: async (name) => (name === 'beach' ? { version: 1, workflow: name, sections: [] } : null),
      runPage: async (payload) => ({ ok: true, seed: payload.values?.['3:seed'] ?? null }),
      quickRun: async (payload) => ({ ok: true, command: payload.command }),
      listArtifacts: async () => ({ runs: [], tags: {} }),
      updateTags: async ({ key, patch }) => ({ key, tags: patch.tags ?? [] }),
    }
  }

  it('serves /ui pages with query token; cross-site embeds require the token', async () => {
    const { base } = await startServer({ token: 'tk', extraMethods: workbenchMethods() })
    const index = await fetch(`${base}/ui?token=tk`, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('index tk')
    const embedded = await fetch(`${base}/ui/wf/beach?token=tk`, { headers: { 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:13188' } })
    expect(embedded.status).toBe(200)
    expect(await embedded.text()).toContain('wf beach tk')
    const wrongToken = await fetch(`${base}/ui?token=nope`)
    expect(wrongToken.status).toBe(403)
    const missingPage = await fetch(`${base}/ui/wf/other?token=tk`)
    expect(missingPage.status).toBe(404)
  })

  it('without a configured token, /ui rejects cross-site embeds but allows direct navigation', async () => {
    const { base } = await startServer({ extraMethods: workbenchMethods() })
    const direct = await fetch(`${base}/ui`, { headers: { 'sec-fetch-site': 'none' } })
    expect(direct.status).toBe(200)
    const driveBy = await fetch(`${base}/ui/artifacts`, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(driveBy.status).toBe(403)
  })

  it('exposes the workbench JSON API behind the standard guard', async () => {
    const { base } = await startServer({ extraMethods: workbenchMethods() })
    const list = await (await fetch(`${base}/api/workflows`, { headers: MARKER })).json()
    expect(list.value.workflows[0].name).toBe('beach')
    const descriptor = await (await fetch(`${base}/api/wf/beach`, { headers: MARKER })).json()
    expect(descriptor.value.workflow).toBe('beach')
    const missing = await fetch(`${base}/api/wf/other`, { headers: MARKER })
    expect(missing.status).toBe(404)
    const run = await (
      await fetch(`${base}/api/run`, { method: 'POST', headers: { ...MARKER, 'content-type': 'application/json' }, body: JSON.stringify({ workflow: 'beach', values: { '3:seed': 5 } }) })
    ).json()
    expect(run.value).toMatchObject({ ok: true, seed: 5 })
    const quick = await (
      await fetch(`${base}/api/quick`, { method: 'POST', headers: { ...MARKER, 'content-type': 'application/json' }, body: JSON.stringify({ command: '抽卡' }) })
    ).json()
    expect(quick.value.command).toBe('抽卡')
    const badPost = await fetch(`${base}/api/run`, { method: 'POST', headers: { ...MARKER, 'content-type': 'text/plain' }, body: 'x' })
    expect(badPost.status).toBe(400)
    const apiNeedsMarker = await fetch(`${base}/api/artifacts`)
    expect(apiNeedsMarker.status).toBe(403)
    const tags = await (
      await fetch(`${base}/api/tags`, { method: 'POST', headers: { ...MARKER, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'k', patch: { tags: ['夕阳'] } }) })
    ).json()
    expect(tags.value.tags).toEqual(['夕阳'])
  })
})

describe('isLoopbackOrigin', () => {
  it('accepts loopback hosts and rejects others', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:13188')).toBe(true)
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true)
    expect(isLoopbackOrigin('http://192.168.1.7:28080')).toBe(false)
    expect(isLoopbackOrigin('not a url')).toBe(false)
    expect(isLoopbackOrigin('')).toBe(false)
  })
})
