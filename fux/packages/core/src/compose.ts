import {
  FUX_PROTOCOL_VERSION,
  parseProductDefinition,
  type PluginManifest,
  type ProductDefinition,
} from '@fux/protocol'
import { PluginRegistry } from './registry.js'
import { resolveProduct, type ResolveResult } from './resolver.js'
import { resolvePluginConfig } from './config.js'
import { EventBus } from './events.js'
import {
  CapabilityLookup,
  type CapabilityBinding,
  type GraphPluginNode,
  type RuntimeGraph,
} from './graph.js'
import type { Logger } from './logger.js'
import { noopLogger } from './logger.js'

export interface ComposeOptions {
  configOverrides?: Record<string, Record<string, unknown>>
  /** G8: forwards to `resolveProduct.autoResolveDependencyVersions` (default off). */
  autoResolveDependencyVersions?: boolean
}

export interface ComposeResult {
  graph: RuntimeGraph
  lookup: CapabilityLookup
  resolution: ResolveResult
  cached: boolean
}

interface CacheEntry {
  key: string
  result: ComposeResult
}

export class FuxCore {
  readonly registry = new PluginRegistry()
  readonly events = new EventBus()
  private readonly graphs = new Map<string, CacheEntry>()
  private readonly logger: Logger

  constructor(options: { logger?: Logger } = {}) {
    this.logger = options.logger ?? noopLogger
  }

  register(input: unknown): PluginManifest {
    return this.registry.register(input)
  }

  /** G8: register an additional candidate version of a plugin (see
   *  `PluginRegistry.registerVersion`). */
  registerVersion(input: unknown): PluginManifest {
    return this.registry.registerVersion(input)
  }

  compose(productInput: unknown, options: ComposeOptions = {}): ComposeResult {
    const product = parseProductDefinition(productInput)
    const key = JSON.stringify({
      product,
      overrides: options.configOverrides ?? {},
      autoResolve: options.autoResolveDependencyVersions ?? false,
    })
    const cached = this.graphs.get(product.id)
    if (cached && cached.key === key) {
      this.logger.debug('compose cache hit', { productId: product.id })
      return { ...cached.result, cached: true }
    }

    const resolution = resolveProduct(this.registry, product, {
      autoResolveDependencyVersions: options.autoResolveDependencyVersions,
    })
    const plugins = new Map<string, GraphPluginNode>()
    for (const pluginId of resolution.order) {
      const manifest = resolution.plugins.get(pluginId)
      if (!manifest) continue
      const entry = product.plugins.find((candidate) => candidate.id === pluginId)
      const overrides = options.configOverrides?.[pluginId] ?? {}
      const { config } = resolvePluginConfig(
        manifest,
        entry ?? { id: pluginId, enabled: true, config: {} },
        overrides,
      )
      plugins.set(pluginId, { manifest, config })
    }

    const capabilities = new Map<string, CapabilityBinding>()
    for (const [pluginId, manifest] of resolution.plugins) {
      for (const capability of manifest.capabilities) {
        capabilities.set(capability.name, {
          providerId: pluginId,
          executionMode: manifest.executionMode,
        })
      }
    }

    const graph: RuntimeGraph = {
      productId: product.id,
      productName: product.name,
      productVersion: product.version,
      profile: product.profile,
      builtAt: Date.now(),
      protocolVersion: FUX_PROTOCOL_VERSION,
      order: resolution.order,
      plugins,
      capabilities,
      connectors: product.connectors,
    }

    const result: ComposeResult = {
      graph,
      lookup: new CapabilityLookup(graph),
      resolution,
      cached: false,
    }
    this.graphs.set(product.id, { key, result })
    this.logger.info('product composed', {
      productId: product.id,
      plugins: resolution.order.length,
      capabilities: capabilities.size,
    })
    return result
  }
}

export type { ProductDefinition }
