import { describe, expect, it } from 'vitest'
import { PluginRegistry } from '../src/registry.js'
import {
  DuplicatePluginError,
  PluginNotRegisteredError,
  ProtocolIncompatibleError,
} from '../src/errors.js'

const manifest = {
  id: '@fux/example-greeter',
  name: 'Greeter',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
}

describe('PluginRegistry', () => {
  it('registers a valid manifest', () => {
    const registry = new PluginRegistry()
    const registered = registry.register(manifest)
    expect(registered.id).toBe('@fux/example-greeter')
    expect(registry.has('@fux/example-greeter')).toBe(true)
    expect(registry.size).toBe(1)
  })

  it('rejects duplicate registration', () => {
    const registry = new PluginRegistry()
    registry.register(manifest)
    expect(() => registry.register(manifest)).toThrow(DuplicatePluginError)
  })

  it('rejects manifests with incompatible protocol ranges', () => {
    const registry = new PluginRegistry()
    expect(() =>
      registry.register({ ...manifest, id: '@fux/old-plugin', protocol: '^8.0.0' }),
    ).toThrow(ProtocolIncompatibleError)
  })

  it('rejects invalid manifests with structured errors', () => {
    const registry = new PluginRegistry()
    expect(() => registry.register({ id: 'bad' })).toThrow()
  })

  it('unregisters plugins', () => {
    const registry = new PluginRegistry()
    registry.register(manifest)
    expect(registry.unregister('@fux/example-greeter')).toBe(true)
    expect(registry.unregister('@fux/example-greeter')).toBe(false)
    expect(registry.get('@fux/example-greeter')).toBeUndefined()
  })

  it('lists all registered manifests', () => {
    const registry = new PluginRegistry()
    registry.register(manifest)
    registry.register({ ...manifest, id: '@fux/example-app' })
    expect(
      registry
        .list()
        .map((m) => m.id)
        .sort(),
    ).toEqual(['@fux/example-app', '@fux/example-greeter'])
  })
})

describe('PluginNotRegisteredError', () => {
  it('carries the plugin id and optional reason', () => {
    const error = new PluginNotRegisteredError('x:y', 'required by z')
    expect(error.pluginId).toBe('x:y')
    expect(error.message).toContain('required by z')
  })
})
