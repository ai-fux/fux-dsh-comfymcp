import { z } from 'zod'
import { CapabilityDescriptorSchema } from './capability.js'
import { SEMVER_REGEX, isValidRange } from './semver.js'
import { ProtocolError } from './errors.js'

export const PLUGIN_ID_REGEX = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

export const PluginIdSchema = z.string().regex(PLUGIN_ID_REGEX)

export const ExecutionModeSchema = z.enum(['in_process', 'worker', 'remote'])
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>

/**
 * A permission the plugin *claims* it needs. BR-03: this is declarative only —
 * the framework never enforces it. It is exposed to an upstream authorization
 * policy that may read it. Meaning of resource/action/scope is open (e.g.
 * `resource: 'greeting:hello'`, `action: 'call'`, `scope: 'family'`); a claim
 * with no `scope` is unscoped.
 */
export const PermissionSchema = z.object({
  resource: z.string().min(1).max(128),
  action: z.string().min(1).max(32),
  scope: z.string().min(1).max(128).optional(),
})
export type Permission = z.infer<typeof PermissionSchema>

export const PluginManifestSchema = z
  .object({
    id: PluginIdSchema,
    name: z.string().min(1).max(100),
    version: z.string().regex(SEMVER_REGEX),
    protocol: z.string().min(1).max(64).refine(isValidRange, {
      message:
        'invalid semver range (allowed: *, x.y.z, ^x.y.z, ~x.y.z, alternatives joined with ||)',
    }),
    executionMode: ExecutionModeSchema,
    description: z.string().max(1000).optional(),
    author: z.string().max(200).optional(),
    license: z.string().max(50).optional(),
    capabilities: z.array(CapabilityDescriptorSchema).max(64).default([]),
    consumes: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{1,31}:[a-z][a-z0-9-]{1,31}$/))
      .max(64)
      .default([]),
    // BR-03: optional declarative permission claims. Present purely for an
    // upstream authorization policy to read; absence means 'no claims'.
    permissions: z.array(PermissionSchema).max(128).optional(),
    dependencies: z.array(PluginIdSchema).max(64).default([]),
    // AR-01: optional per-dependency semver range preflight. Absent means no version check.
    dependenciesRanges: z.record(PluginIdSchema, z.string().refine(isValidRange)).optional(),
    configSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((manifest, ctx) => {
    const capabilityNames = manifest.capabilities.map((c) => c.name)
    if (new Set(capabilityNames).size !== capabilityNames.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate capability names in manifest' })
    }
    if (new Set(manifest.consumes).size !== manifest.consumes.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate consumes entries in manifest' })
    }
    if (manifest.permissions) {
      const keys = manifest.permissions.map((p) => `${p.resource}:${p.action}:${p.scope ?? ''}`)
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({ code: 'custom', message: 'duplicate permission claims in manifest' })
      }
    }
  })

export type PluginManifest = z.infer<typeof PluginManifestSchema>

export function parseManifest(input: unknown): PluginManifest {
  const result = PluginManifestSchema.safeParse(input)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }))
    throw new ProtocolError('Invalid plugin manifest', issues)
  }
  return result.data
}
