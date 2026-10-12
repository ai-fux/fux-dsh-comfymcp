import { z } from 'zod'
import { PluginIdSchema } from './manifest.js'
import { SEMVER_REGEX } from './semver.js'
import { ProtocolError } from './errors.js'

export const RuntimeProfileSchema = z.enum(['dev', 'team'])
export type RuntimeProfile = z.infer<typeof RuntimeProfileSchema>

export const ProductPluginEntrySchema = z.object({
  id: PluginIdSchema,
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
})

export type ProductPluginEntry = z.infer<typeof ProductPluginEntrySchema>

export const ConnectorIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*$/)

export const ConnectorKindSchema = z.enum(['request_reply', 'publish_subscribe', 'stream'])

/**
 * A connector **declared** in a product. The schema carries only metadata
 * (id / advisory kind / config); the concrete transport is resolved by the
 * host-provided connector resolver at runtime (CR-04 / ADR-0010).
 */
export const ConnectorDefinitionSchema = z.object({
  id: ConnectorIdSchema,
  kind: ConnectorKindSchema.optional(),
  config: z.record(z.string(), z.unknown()).default({}),
})

export type ConnectorDefinition = z.infer<typeof ConnectorDefinitionSchema>

export const ProductDefinitionSchema = z.object({
  id: PluginIdSchema,
  name: z.string().min(1).max(100),
  version: z.string().regex(SEMVER_REGEX),
  profile: RuntimeProfileSchema.default('dev'),
  plugins: z.array(ProductPluginEntrySchema).min(1).max(128),
  // Additive (S-level): absent connectors default to []. Products without a
  // connectors section parse exactly as before; FUX_PROTOCOL_VERSION is unchanged.
  connectors: z.array(ConnectorDefinitionSchema).max(64).default([]),
})

export type ProductDefinition = z.infer<typeof ProductDefinitionSchema>

export function parseProductDefinition(input: unknown): ProductDefinition {
  const result = ProductDefinitionSchema.safeParse(input)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }))
    throw new ProtocolError('Invalid product definition', issues)
  }
  return result.data
}
