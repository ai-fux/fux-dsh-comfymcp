import { describe, expect, it } from 'vitest'
import { FuxCore } from '@fux/core'
import { CapabilityBroker } from '../src/broker.js'
import { CapabilityDeniedError } from '../src/errors.js'

const manifestWithPermissions = {
  id: '@fux/example-greeter',
  name: 'Greeter',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  capabilities: [{ name: 'greeting:hello', version: '0.0.1' }],
  consumes: [],
  permissions: [
    { resource: 'greeting:hello', action: 'call' },
    { resource: 'files:read', action: 'read', scope: 'ab' },
  ],
}

const manifestWithoutPermissions = {
  id: '@fux/example-app',
  name: 'App',
  version: '0.0.1',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  capabilities: [],
  consumes: ['greeting:hello'],
}

// Same id family as manifestWithoutPermissions but with NO consumes entry, so
// the product graph includes a provider and a caller that is denied by the
// mandatory consumes gate (independent of any permission claims).
const nonConsumingCaller = {
  id: '@fux/example-app',
  name: 'App (non-consuming caller)',
  version: '0.0.2',
  protocol: '^0.1.0',
  executionMode: 'in_process',
  capabilities: [],
  consumes: [],
}

function graphWith(manifests: unknown[]): ReturnType<FuxCore['compose']>['graph'] {
  const core = new FuxCore()
  for (const manifest of manifests) core.register(manifest as never)
  return core.compose({
    id: 'perm-demo',
    name: 'Perm Demo',
    version: '0.0.1',
    plugins: manifests.map((m) => ({ id: (m as { id: string }).id })),
  }).graph
}

describe('CapabilityBroker permission claims (BR-03)', () => {
  it('exposes a caller declared permissions for policy reads', async () => {
    const graph = graphWith([manifestWithPermissions, manifestWithoutPermissions])
    const broker = new CapabilityBroker(graph, new Map())

    expect(broker.permissionsOf('@fux/example-greeter')).toEqual([
      { resource: 'greeting:hello', action: 'call', scope: undefined },
      { resource: 'files:read', action: 'read', scope: 'ab' },
    ])
    expect(broker.permissionsOf('@fux/example-app')).toBeUndefined()
  })

  it('answers hasPermission from declared claims only', async () => {
    const graph = graphWith([manifestWithPermissions, manifestWithoutPermissions])
    const broker = new CapabilityBroker(graph, new Map())

    expect(broker.hasPermission('@fux/example-greeter', 'greeting:hello', 'call')).toBe(true)
    expect(broker.hasPermission('@fux/example-greeter', 'files:read', 'read')).toBe(true)
    expect(broker.hasPermission('@fux/example-greeter', 'files:write', 'write')).toBe(false)
    expect(broker.hasPermission('@fux/example-app', 'greeting:hello', 'call')).toBe(false)
    expect(broker.hasPermission('@fux/ghost', 'greeting:hello', 'call')).toBe(false)
  })

  it('keeps the mandatory consumes gate independent of permission claims', async () => {
    const graph = graphWith([manifestWithPermissions, nonConsumingCaller])
    const broker = new CapabilityBroker(graph, new Map())
    await expect(broker.call('@fux/example-app', 'greeting:hello', {})).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    )
  })
})
