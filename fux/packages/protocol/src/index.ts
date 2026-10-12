export * from './version.js'
export * from './semver.js'
export * from './capability.js'
export * from './manifest.js'
export * from './ipc.js'
export * from './event-schema.js'
export * from './discovery.js'
export * from './product.js'
export * from './errors.js'
export * from './migrate.js'

import { satisfiesRange } from './semver.js'
import { FUX_PROTOCOL_VERSION } from './version.js'

export function isProtocolCompatible(requiredRange: string): boolean {
  return satisfiesRange(FUX_PROTOCOL_VERSION, requiredRange)
}
