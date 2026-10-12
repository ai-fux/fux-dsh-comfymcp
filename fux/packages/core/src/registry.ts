import {
  FUX_PROTOCOL_VERSION,
  isProtocolCompatible,
  parseManifest,
  type PluginManifest,
} from '@fux/protocol'
import { DuplicatePluginError, ProtocolIncompatibleError } from './errors.js'

export class PluginRegistry {
  private readonly plugins = new Map<string, PluginManifest>()
  private readonly versionsById = new Map<string, PluginManifest[]>()

  register(input: unknown): PluginManifest {
    const manifest = parseManifest(input)
    if (this.plugins.has(manifest.id)) {
      throw new DuplicatePluginError(manifest.id)
    }
    if (!isProtocolCompatible(manifest.protocol)) {
      throw new ProtocolIncompatibleError(manifest.id, manifest.protocol, FUX_PROTOCOL_VERSION)
    }
    this.plugins.set(manifest.id, manifest)
    return manifest
  }

  /**
   * G8: register an **additional candidate version** of a plugin. Unlike
   * `register`, this never replaces the single canonical manifest for an id and
   * never throws a duplicate error — it just makes that version available to
   * `candidates()` so `resolveProduct`'s optional auto-version-resolution can
   * pick it when a declared `dependenciesRanges` would otherwise conflict. Additive;
   * a registry that only uses `register` keeps its exact prior behavior.
   */
  registerVersion(input: unknown): PluginManifest {
    const manifest = parseManifest(input)
    if (!isProtocolCompatible(manifest.protocol)) {
      throw new ProtocolIncompatibleError(manifest.id, manifest.protocol, FUX_PROTOCOL_VERSION)
    }
    const versions = this.versionsById.get(manifest.id) ?? []
    versions.push(manifest)
    this.versionsById.set(manifest.id, versions)
    return manifest
  }

  get(pluginId: string): PluginManifest | undefined {
    return this.plugins.get(pluginId)
  }

  /**
   * All versions known for `pluginId`: the canonical `register`ed manifest
   * first, then every `registerVersion`ed candidate, in registration order.
   * Empty when the plugin id is completely unknown.
   */
  candidates(pluginId: string): PluginManifest[] {
    const main = this.plugins.get(pluginId)
    const extras = this.versionsById.get(pluginId) ?? []
    return main ? [main, ...extras] : [...extras]
  }

  has(pluginId: string): boolean {
    return this.plugins.has(pluginId)
  }

  list(): PluginManifest[] {
    return [...this.plugins.values()]
  }

  unregister(pluginId: string): boolean {
    this.versionsById.delete(pluginId)
    return this.plugins.delete(pluginId)
  }

  get size(): number {
    return this.plugins.size
  }
}
