import type { PluginManifest, ProductPluginEntry } from '@fux/protocol'

export type ConfigSource = 'default' | 'product' | 'override'

export interface ResolvedConfig {
  config: Record<string, unknown>
  sources: Record<string, ConfigSource>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function extractDefaults(configSchema?: Record<string, unknown>): Record<string, unknown> {
  if (!configSchema) return {}
  const properties = configSchema['properties']
  if (!isPlainObject(properties)) return {}
  const defaults: Record<string, unknown> = {}
  for (const [key, definition] of Object.entries(properties)) {
    if (isPlainObject(definition) && 'default' in definition) {
      defaults[key] = definition['default']
    }
  }
  return defaults
}

export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key]
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value
  }
  return merged
}

export function resolvePluginConfig(
  manifest: PluginManifest,
  entry: Pick<ProductPluginEntry, 'config'>,
  overrides: Record<string, unknown> = {},
): ResolvedConfig {
  const sources: Record<string, ConfigSource> = {}
  const defaults = extractDefaults(manifest.configSchema)
  for (const key of Object.keys(defaults)) sources[key] = 'default'

  let config = defaults
  config = deepMerge(config, entry.config)
  for (const key of Object.keys(entry.config)) sources[key] = 'product'

  if (Object.keys(overrides).length > 0) {
    config = deepMerge(config, overrides)
    for (const key of Object.keys(overrides)) sources[key] = 'override'
  }

  return { config, sources }
}
