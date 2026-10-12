import { describe, expect, it } from 'vitest'
import { parseProductDefinition } from '../src/product.js'
import { FUX_PROTOCOL_VERSION, isProtocolCompatible } from '../src/index.js'

const validProduct = {
  id: 'demo-hello',
  name: 'Demo Hello',
  version: '0.0.1',
  plugins: [{ id: '@fux/example-greeter' }],
}

describe('parseProductDefinition', () => {
  it('parses a valid product and applies defaults', () => {
    const product = parseProductDefinition(validProduct)
    expect(product.profile).toBe('dev')
    expect(product.plugins[0]?.enabled).toBe(true)
    expect(product.plugins[0]?.config).toEqual({})
  })

  it('rejects products without plugins', () => {
    expect(() => parseProductDefinition({ ...validProduct, plugins: [] })).toThrow()
  })

  it('rejects invalid versions', () => {
    expect(() => parseProductDefinition({ ...validProduct, version: 'v1' })).toThrow()
  })

  it('rejects unknown profiles', () => {
    expect(() => parseProductDefinition({ ...validProduct, profile: 'production' })).toThrow()
  })

  it('defaults connectors to an empty list when absent', () => {
    const product = parseProductDefinition(validProduct)
    expect(product.connectors).toEqual([])
  })

  it('parses declared connectors with advisory kind and config', () => {
    const product = parseProductDefinition({
      ...validProduct,
      connectors: [{ id: 'logs:out', kind: 'publish_subscribe', config: { channel: 'logs' } }],
    })
    expect(product.connectors).toEqual([
      { id: 'logs:out', kind: 'publish_subscribe', config: { channel: 'logs' } },
    ])
  })

  it('defaults a connector config when omitted', () => {
    const product = parseProductDefinition({
      ...validProduct,
      connectors: [{ id: 'health' }],
    })
    expect(product.connectors[0]).toMatchObject({ id: 'health', config: {} })
  })

  it('rejects an invalid connector id', () => {
    expect(() =>
      parseProductDefinition({ ...validProduct, connectors: [{ id: 'Bad id' }] }),
    ).toThrow()
  })
})

describe('isProtocolCompatible', () => {
  it('accepts ranges satisfied by the current protocol version', () => {
    expect(isProtocolCompatible(`^${FUX_PROTOCOL_VERSION}`)).toBe(true)
    expect(isProtocolCompatible('*')).toBe(true)
  })

  it('rejects incompatible ranges', () => {
    expect(isProtocolCompatible('^9.0.0')).toBe(false)
  })
})
