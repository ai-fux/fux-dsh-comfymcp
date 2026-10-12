export class FuxCoreError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'FuxCoreError'
    this.code = code
  }
}

export class DuplicatePluginError extends FuxCoreError {
  constructor(pluginId: string) {
    super('E_DUPLICATE_PLUGIN', `plugin already registered: ${pluginId}`)
    this.name = 'DuplicatePluginError'
  }
}

export class PluginNotRegisteredError extends FuxCoreError {
  readonly pluginId: string

  constructor(pluginId: string, reason?: string) {
    super(
      'E_PLUGIN_NOT_REGISTERED',
      `plugin not registered: ${pluginId}${reason ? ` (${reason})` : ''}`,
    )
    this.name = 'PluginNotRegisteredError'
    this.pluginId = pluginId
  }
}

export class ProtocolIncompatibleError extends FuxCoreError {
  readonly pluginId: string
  readonly requiredRange: string
  readonly currentVersion: string

  constructor(pluginId: string, requiredRange: string, currentVersion: string) {
    super(
      'E_PROTOCOL_INCOMPATIBLE',
      `plugin ${pluginId} requires protocol "${requiredRange}" but runtime provides ${currentVersion}`,
    )
    this.name = 'ProtocolIncompatibleError'
    this.pluginId = pluginId
    this.requiredRange = requiredRange
    this.currentVersion = currentVersion
  }
}

export class MissingDependencyError extends FuxCoreError {
  constructor(pluginId: string, dependencyId: string, reason?: string) {
    super(
      'E_MISSING_DEPENDENCY',
      `plugin ${pluginId} requires "${dependencyId}"${reason ? ` but ${reason}` : ''}`,
    )
    this.name = 'MissingDependencyError'
  }
}

export class DependencyVersionConflictError extends FuxCoreError {
  readonly pluginId: string
  readonly dependencyId: string
  readonly found: string
  readonly requiredRange: string

  constructor(pluginId: string, dependencyId: string, found: string, requiredRange: string) {
    super(
      'E_DEPENDENCY_VERSION_CONFLICT',
      `plugin ${pluginId} requires "${dependencyId}" at "${requiredRange}" but active version is ${found}`,
    )
    this.name = 'DependencyVersionConflictError'
    this.pluginId = pluginId
    this.dependencyId = dependencyId
    this.found = found
    this.requiredRange = requiredRange
  }
}

export class DependencyCycleError extends FuxCoreError {
  readonly cycle: string[]

  constructor(cycle: string[]) {
    super('E_DEPENDENCY_CYCLE', `dependency cycle detected: ${cycle.join(' -> ')}`)
    this.name = 'DependencyCycleError'
    this.cycle = cycle
  }
}

export class DuplicateCapabilityError extends FuxCoreError {
  readonly capability: string

  constructor(capability: string, firstProvider: string, secondProvider: string) {
    super(
      'E_DUPLICATE_CAPABILITY',
      `capability "${capability}" provided by both "${firstProvider}" and "${secondProvider}"`,
    )
    this.name = 'DuplicateCapabilityError'
    this.capability = capability
  }
}

export class MissingCapabilityError extends FuxCoreError {
  readonly consumer: string
  readonly capability: string

  constructor(consumer: string, capability: string) {
    super(
      'E_MISSING_CAPABILITY',
      `plugin "${consumer}" consumes capability "${capability}" but no active plugin provides it`,
    )
    this.name = 'MissingCapabilityError'
    this.consumer = consumer
    this.capability = capability
  }
}

export class InvalidTransitionError extends FuxCoreError {
  readonly pluginId: string
  readonly from: string
  readonly to: string

  constructor(pluginId: string, from: string, to: string) {
    super('E_INVALID_TRANSITION', `illegal lifecycle transition for ${pluginId}: ${from} -> ${to}`)
    this.name = 'InvalidTransitionError'
    this.pluginId = pluginId
    this.from = from
    this.to = to
  }
}

export class EmptyProductError extends FuxCoreError {
  constructor(productId: string) {
    super('E_EMPTY_PRODUCT', `product "${productId}" has no enabled plugins`)
    this.name = 'EmptyProductError'
  }
}
