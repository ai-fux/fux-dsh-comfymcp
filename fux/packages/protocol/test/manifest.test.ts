import { describe, expect, it } from 'vitest'
import { parseManifest } from '../src/manifest.js'
import { ProtocolError } from '../src/errors.js'

const validManifest = {
  id: '@fux/example-greeter',
  name: 'Greeter',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  capabilities: [{ name: 'greeting:hello', version: '0.0.1' }],
  consumes: ['log:write'],
}

describe('parseManifest', () => {
  it('parses a valid manifest and applies defaults', () => {
    const manifest = parseManifest(validManifest)
    expect(manifest.id).toBe('@fux/example-greeter')
    expect(manifest.dependencies).toEqual([])
    expect(manifest.capabilities).toHaveLength(1)
    expect(manifest.consumes).toEqual(['log:write'])
  })

  it('rejects invalid plugin ids', () => {
    expect(() => parseManifest({ ...validManifest, id: 'Not_Valid' })).toThrow(ProtocolError)
    expect(() => parseManifest({ ...validManifest, id: '' })).toThrow(ProtocolError)
  })

  it('rejects invalid versions', () => {
    expect(() => parseManifest({ ...validManifest, version: '1.2' })).toThrow(ProtocolError)
  })

  it('rejects invalid protocol ranges', () => {
    expect(() => parseManifest({ ...validManifest, protocol: '>=1.0.0' })).toThrow(ProtocolError)
  })

  it('accepts protocol version sets joined with ||', () => {
    const manifest = parseManifest({ ...validManifest, protocol: '^0.1.0 || 0.3.0' })
    expect(manifest.protocol).toBe('^0.1.0 || 0.3.0')
    expect(() => parseManifest({ ...validManifest, protocol: '0.1.0 || bad' })).toThrow(
      ProtocolError,
    )
  })

  it('rejects unknown execution modes', () => {
    expect(() => parseManifest({ ...validManifest, executionMode: 'inproc' })).toThrow(
      ProtocolError,
    )
  })

  it('rejects malformed capability names', () => {
    expect(() =>
      parseManifest({
        ...validManifest,
        capabilities: [{ name: 'greeting', version: '0.0.1' }],
      }),
    ).toThrow(ProtocolError)
  })

  it('rejects duplicate capability declarations', () => {
    expect(() =>
      parseManifest({
        ...validManifest,
        capabilities: [
          { name: 'greeting:hello', version: '0.0.1' },
          { name: 'greeting:hello', version: '0.0.2' },
        ],
      }),
    ).toThrow(ProtocolError)
  })

  it('rejects duplicate consumes entries', () => {
    expect(() => parseManifest({ ...validManifest, consumes: ['log:write', 'log:write'] })).toThrow(
      ProtocolError,
    )
  })

  it('reports structured issues', () => {
    try {
      parseManifest({ ...validManifest, version: 'nope' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError)
      const issues = (error as ProtocolError).issues
      expect(issues.length).toBeGreaterThan(0)
      expect(issues[0]?.path).toContain('version')
    }
  })
})

describe('parseManifest permissions (BR-03)', () => {
  it('parses optional declarative permission claims', () => {
    const manifest = parseManifest({
      ...validManifest,
      permissions: [
        { resource: 'greeting:hello', action: 'call' },
        { resource: 'files:read', action: 'read', scope: 'ab' },
      ],
    })
    expect(manifest.permissions).toEqual([
      { resource: 'greeting:hello', action: 'call', scope: undefined },
      { resource: 'files:read', action: 'read', scope: 'ab' },
    ])
  })

  it('leaves permissions undefined when not declared', () => {
    const manifest = parseManifest(validManifest)
    expect(manifest.permissions).toBeUndefined()
  })

  it('rejects duplicate permission claims', () => {
    expect(() =>
      parseManifest({
        ...validManifest,
        permissions: [
          { resource: 'files:read', action: 'read' },
          { resource: 'files:read', action: 'read' },
        ],
      }),
    ).toThrow(ProtocolError)
  })
})

describe('parseManifest dependenciesRanges (AR-01)', () => {
  it('accepts optional dependency semver ranges', () => {
    const manifest = parseManifest({
      ...validManifest,
      dependencies: ['@fux/base'],
      dependenciesRanges: { '@fux/base': '^0.1.0' },
    })
    expect(manifest.dependenciesRanges).toEqual({ '@fux/base': '^0.1.0' })
  })

  it('leaves dependenciesRanges undefined when not declared', () => {
    const manifest = parseManifest(validManifest)
    expect(manifest.dependenciesRanges).toBeUndefined()
  })

  it('rejects malformed dependency range values', () => {
    expect(() =>
      parseManifest({ ...validManifest, dependenciesRanges: { '@fux/base': '>=1.0.0' } }),
    ).toThrow(ProtocolError)
  })
})
