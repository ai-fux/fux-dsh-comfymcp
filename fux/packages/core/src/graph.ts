import type { ConnectorDefinition, ExecutionMode, RuntimeProfile } from '@fux/protocol'
import type { PluginManifest } from '@fux/protocol'

export interface GraphPluginNode {
  manifest: PluginManifest
  config: Record<string, unknown>
}

export interface CapabilityBinding {
  providerId: string
  executionMode: ExecutionMode
}

export interface RuntimeGraph {
  readonly productId: string
  readonly productName: string
  readonly productVersion: string
  readonly profile: RuntimeProfile
  readonly builtAt: number
  readonly protocolVersion: string
  readonly order: readonly string[]
  readonly plugins: ReadonlyMap<string, GraphPluginNode>
  readonly capabilities: ReadonlyMap<string, CapabilityBinding>
  /** Declared external-pathway connectors (empty unless the product declares some). */
  readonly connectors: ReadonlyArray<ConnectorDefinition>
}

export class CapabilityLookup {
  private readonly bindings: ReadonlyMap<string, CapabilityBinding>

  constructor(graph: RuntimeGraph) {
    this.bindings = graph.capabilities
  }

  resolve(capability: string): CapabilityBinding | undefined {
    return this.bindings.get(capability)
  }

  get size(): number {
    return this.bindings.size
  }
}

export function graphSummary(graph: RuntimeGraph): string[] {
  const lines: string[] = [
    `product ${graph.productName} (${graph.productId}@${graph.productVersion}) profile=${graph.profile}`,
    `protocol ${graph.protocolVersion} builtAt=${new Date(graph.builtAt).toISOString()}`,
  ]
  for (const pluginId of graph.order) {
    const node = graph.plugins.get(pluginId)
    const provides = node?.manifest.capabilities.map((c) => c.name).join(', ') || '-'
    lines.push(`  ${pluginId} [${node?.manifest.executionMode}] provides: ${provides}`)
  }
  return lines
}
