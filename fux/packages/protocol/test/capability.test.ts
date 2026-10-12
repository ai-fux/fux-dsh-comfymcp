import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_NAME_REGEX,
  CapabilityDescriptorSchema,
  isValidCapabilityName,
  parseCapabilityName,
} from '../src/capability.js'

describe('isValidCapabilityName', () => {
  it('accepts domain:action names', () => {
    expect(isValidCapabilityName('greeting:hello')).toBe(true)
    expect(isValidCapabilityName('db:query')).toBe(true)
    expect(isValidCapabilityName('http-api:route')).toBe(true)
  })

  it('rejects malformed names', () => {
    expect(isValidCapabilityName('greeting')).toBe(false)
    expect(isValidCapabilityName('Greeting:hello')).toBe(false)
    expect(isValidCapabilityName('greet:1x')).toBe(false)
    expect(isValidCapabilityName('greeting:')).toBe(false)
    expect(isValidCapabilityName('a:b:c')).toBe(false)
    expect(isValidCapabilityName('')).toBe(false)
  })

  it('enforces segment length limits', () => {
    const longSegment = 'a'.repeat(33)
    expect(isValidCapabilityName(`${longSegment}:hello`)).toBe(false)
    expect(CAPABILITY_NAME_REGEX.test(`ab:hello`)).toBe(true)
  })
})

describe('parseCapabilityName', () => {
  it('splits into domain and action', () => {
    expect(parseCapabilityName('db:query')).toEqual({ domain: 'db', action: 'query' })
  })

  it('returns null for invalid names', () => {
    expect(parseCapabilityName('dbquery')).toBeNull()
  })
})

describe('CapabilityDescriptorSchema (BR-03)', () => {
  it('accepts optional advisory permissions', () => {
    const parsed = CapabilityDescriptorSchema.safeParse({
      name: 'greeting:hello',
      version: '0.0.1',
      permissions: ['read', 'write'],
    })
    expect(parsed.success).toBe(true)
  })

  it('omits permissions by default (absent = default safe policy)', () => {
    const parsed = CapabilityDescriptorSchema.safeParse({
      name: 'greeting:hello',
      version: '0.0.1',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.permissions).toBeUndefined()
  })

  it('rejects unknown permission values', () => {
    const parsed = CapabilityDescriptorSchema.safeParse({
      name: 'greeting:hello',
      version: '0.0.1',
      permissions: ['delete'],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects more than 16 permission entries (boundary)', () => {
    const many = Array.from({ length: 17 }, () => 'read' as const)
    const parsed = CapabilityDescriptorSchema.safeParse({
      name: 'greeting:hello',
      version: '0.0.1',
      permissions: many,
    })
    expect(parsed.success).toBe(false)
  })
})
