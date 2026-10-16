import { describe, expect, it } from 'vitest'
import { DEFAULTS, resolveConfig, splitPathList, candidateHostEntries, resolveServerEntry, applyHomeDefaults, defaultHomeDir } from '../lib/config.js'

describe('home dir defaults', () => {
  it('derives workflows/artifacts/data under the home dir and respects explicit paths', () => {
    const env = { DSH_HOME: 'F:\\dsh-data\\.dsh' }
    expect(defaultHomeDir(env).replaceAll('\\', '/')).toBe('F:/dsh-data/.dsh/comfymcp')
    const derived = applyHomeDefaults({ homeDir: '', workflowDirs: [], artifactsDir: '', dataDir: '' }, env, (p) => p)
    expect(derived.workflowDirs[0].replaceAll('\\', '/')).toBe('F:/dsh-data/.dsh/comfymcp/workflows')
    expect(derived.artifactsDir.replaceAll('\\', '/')).toBe('F:/dsh-data/.dsh/comfymcp/artifacts')
    expect(derived.dataDir.replaceAll('\\', '/')).toBe('F:/dsh-data/.dsh/comfymcp/data')
    const explicit = applyHomeDefaults({ homeDir: 'F:\\mine', workflowDirs: ['C:\\keep'], artifactsDir: 'C:\\art', dataDir: '' }, env, (p) => p)
    expect(explicit.homeDir.replaceAll('\\', '/')).toBe('F:/mine')
    expect(explicit.workflowDirs).toEqual(['C:\\keep'])
    expect(explicit.artifactsDir).toBe('C:\\art')
    expect(explicit.dataDir.replaceAll('\\', '/')).toBe('F:/mine/data')
  })
})


describe('resolveConfig', () => {
  it('falls back to defaults with an empty row and env', () => {
    const config = resolveConfig({}, {})
    expect(config.endpoint).toBe(DEFAULTS.endpoint)
    expect(config.autoUnloadModel).toBe(true)
    expect(config.timedAsk).toBe(true)
    expect(config.workflowDirs).toEqual([])
    expect(config.callTimeoutMs).toBe(300000)
  })

  it('coerces timedAsk from row and env (boolean key, false disables timed ask_user)', () => {
    expect(resolveConfig({ timedAsk: false }, {}).timedAsk).toBe(false)
    expect(resolveConfig({ timedAsk: 'false' }, {}).timedAsk).toBe(false)
    expect(resolveConfig({}, { DSH_COMFYMCP_TIMED_ASK: 'false' }).timedAsk).toBe(false)
    expect(resolveConfig({ timedAsk: true }, {}).timedAsk).toBe(true)
  })

  it('layering: env beats row, row beats defaults', () => {
    const config = resolveConfig(
      { endpoint: 'http://row:1/mcp', callTimeoutMs: 5, workflowDirs: 'C:\\a;C:\\b' },
      { DSH_COMFYMCP_ENDPOINT: 'http://env:2/mcp' },
    )
    expect(config.endpoint).toBe('http://env:2/mcp')
    expect(config.callTimeoutMs).toBe(5)
    expect(config.workflowDirs).toEqual(['C:\\a', 'C:\\b'])
  })

  it('accepts the COMFY_MCP_ENDPOINT alias and boolean coercion', () => {
    const config = resolveConfig({ autoUnloadModel: 'off' }, { COMFY_MCP_ENDPOINT: 'http://x/mcp' })
    expect(config.endpoint).toBe('http://x/mcp')
    expect(config.autoUnloadModel).toBe(false)
  })

  it('resolves the artifacts dir with the injected path resolver', () => {
    const config = resolveConfig({ artifactsDir: 'art' }, {}, (p) => `<root>/${p}`)
    expect(config.artifactsDir).toBe('<root>/art')
  })

  it('ignores malformed values', () => {
    const config = resolveConfig({ callTimeoutMs: 'nope', autoConnect: 'maybe', workflowDirs: 42 }, {})
    expect(config.callTimeoutMs).toBe(DEFAULTS.callTimeoutMs)
    expect(config.autoConnect).toBe(true)
    expect(config.workflowDirs).toEqual([])
  })
})

describe('splitPathList', () => {
  it('splits on semicolons and tolerates drive-colon paths', () => {
    expect(splitPathList('C:\\a;C:\\b')).toEqual(['C:\\a', 'C:\\b'])
    expect(splitPathList('/x:/y')).toEqual(['/x', '/y'])
    expect(splitPathList(' ; ; ')).toEqual([])
  })
})

describe('candidateHostEntries', () => {
  it('derives the workspace path from a profile-installed plugin dir', () => {
    const entries = candidateHostEntries('C:\\profile\\node_modules\\dsh-comfymcp-client')
    expect(entries[0]).toBe('C:/profile/node_modules/dsh-comfymcp-client/vendor/fux-comfymcp-host.mjs')
    expect(entries[1]).toBe('C:/profile/projects/dsh-comfymcp/mcp/bin/fux-comfymcp-host.mjs')
    expect(entries.at(-1)).toBe('projects/dsh-comfymcp/mcp/bin/fux-comfymcp-host.mjs')
  })
})

describe('embedded server config', () => {
  it('defaults embeddedServer off and coerces the boolean from env or row', () => {
    expect(resolveConfig({}, {}).embeddedServer).toBe(false)
    expect(resolveConfig({ embeddedServer: 'on' }, {}).embeddedServer).toBe(true)
    expect(resolveConfig({}, { DSH_COMFYMCP_EMBEDDED_SERVER: '1' }).embeddedServer).toBe(true)
  })

  it('defaults controlPort to 18801 and allows 0 for a random port; controlToken passes through', () => {
    expect(resolveConfig({}, {}).controlPort).toBe(18801)
    expect(resolveConfig({ controlPort: 0 }, {}).controlPort).toBe(0)
    expect(resolveConfig({ controlPort: '0' }, {}).controlPort).toBe(0)
    expect(resolveConfig({ controlPort: '18900' }, {}).controlPort).toBe(18900)
    expect(resolveConfig({ controlToken: ' t ' }, {}).controlToken).toBe('t')
  })

  it('resolves the server entry: env beats config beats hostEntry derivation', () => {
    expect(resolveServerEntry({ DSH_COMFYMCP_SERVER_ENTRY: 'E:\\s.mjs' }, 'C:\\c.mjs', 'C:\\h\\mcp\\bin\\host.mjs')).toBe('E:\\s.mjs')
    expect(resolveServerEntry({}, 'C:\\c.mjs', 'C:\\h\\mcp\\bin\\host.mjs')).toBe('C:\\c.mjs')
    expect(resolveServerEntry({}, '', 'C:\\proj\\mcp\\bin\\fux-comfymcp-host.mjs')).toBe('C:/proj/comfy-mcp-server/bin/comfy-mcp-server.mjs')
    expect(resolveServerEntry({}, '', '')).toBe('')
  })
})
