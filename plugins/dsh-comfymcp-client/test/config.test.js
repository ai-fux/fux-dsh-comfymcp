import { describe, expect, it } from 'vitest'
import { DEFAULTS, resolveConfig, splitPathList, candidateHostEntries } from '../lib/config.js'

describe('resolveConfig', () => {
  it('falls back to defaults with an empty row and env', () => {
    const config = resolveConfig({}, {})
    expect(config.endpoint).toBe(DEFAULTS.endpoint)
    expect(config.autoUnloadModel).toBe(true)
    expect(config.workflowDirs).toEqual([])
    expect(config.callTimeoutMs).toBe(300000)
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
    expect(entries[0]).toBe('C:/profile/projects/dsh-comfymcp/mcp/bin/fux-comfymcp-host.mjs')
  })
})
