import { z } from 'zod'
import { SEMVER_REGEX } from './semver.js'

export const CAPABILITY_SEGMENT_REGEX = /^[a-z][a-z0-9-]{1,31}$/
export const CAPABILITY_NAME_REGEX = /^[a-z][a-z0-9-]{1,31}:[a-z][a-z0-9-]{1,31}$/

export const CapabilityNameSchema = z.string().regex(CAPABILITY_NAME_REGEX)

export function isValidCapabilityName(name: string): boolean {
  return CAPABILITY_NAME_REGEX.test(name)
}

export interface CapabilityNameParts {
  domain: string
  action: string
}

export function parseCapabilityName(name: string): CapabilityNameParts | null {
  if (!isValidCapabilityName(name)) return null
  const [domain, action] = name.split(':') as [string, string]
  return { domain, action }
}

export const CapabilityPermissionSchema = z.enum(['read', 'write', 'admin'])
export type CapabilityPermission = z.infer<typeof CapabilityPermissionSchema>

export const CapabilityDescriptorSchema = z.object({
  name: CapabilityNameSchema,
  version: z.string().regex(SEMVER_REGEX),
  description: z.string().max(500).optional(),
  // BR-03: advisory permission declaration. Absent implies the default safe policy.
  permissions: z.array(CapabilityPermissionSchema).max(16).optional(),
})

export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>
