import { describe, expect, it } from 'vitest'
import { compareSemver, isValidRange, parseSemver, satisfiesRange } from '../src/semver.js'

describe('parseSemver', () => {
  it('parses a plain release', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
  })

  it('parses prerelease and build metadata', () => {
    expect(parseSemver('0.1.0-rc.1')).toMatchObject({
      major: 0,
      minor: 1,
      patch: 0,
      prerelease: 'rc.1',
    })
    expect(parseSemver('1.0.0-alpha+build.5')).toMatchObject({
      prerelease: 'alpha',
      build: 'build.5',
    })
  })

  it('rejects invalid versions', () => {
    expect(parseSemver('1.2')).toBeNull()
    expect(parseSemver('v1.2.3')).toBeNull()
    expect(parseSemver('1.2.3.4')).toBeNull()
    expect(parseSemver('')).toBeNull()
    expect(parseSemver('01.2.3')).toBeNull()
  })
})

describe('compareSemver', () => {
  it('compares major, minor and patch', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareSemver('1.2.3', '1.3.0')).toBeLessThan(0)
    expect(compareSemver('1.2.3', '1.2.10')).toBeLessThan(0)
  })

  it('treats prerelease as lower than release', () => {
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
  })

  it('orders prerelease identifiers', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-beta')).toBeLessThan(0)
  })

  it('ignores build metadata', () => {
    expect(compareSemver('1.0.0+a', '1.0.0+b')).toBe(0)
  })

  it('throws on invalid input', () => {
    expect(() => compareSemver('bad', '1.0.0')).toThrow(TypeError)
  })
})

describe('isValidRange', () => {
  it('accepts wildcard, exact and caret/tilde ranges', () => {
    expect(isValidRange('*')).toBe(true)
    expect(isValidRange('x')).toBe(true)
    expect(isValidRange('1.2.3')).toBe(true)
    expect(isValidRange('^1.2.3')).toBe(true)
    expect(isValidRange('~0.1.0')).toBe(true)
    expect(isValidRange('1.2.3-rc.1')).toBe(true)
  })

  it('rejects comparators and partial versions', () => {
    expect(isValidRange('>=1.0.0')).toBe(false)
    expect(isValidRange('1.2')).toBe(false)
    expect(isValidRange('^1.x')).toBe(false)
  })

  it('accepts alternative sets joined with ||', () => {
    expect(isValidRange('0.1.0 || 0.2.0')).toBe(true)
    expect(isValidRange('^0.1.0 || ~0.3.0')).toBe(true)
    expect(isValidRange('* || 1.0.0')).toBe(true)
    expect(isValidRange('0.1.0 ||0.2.0')).toBe(true)
    expect(isValidRange(' 0.1.0 || 0.2.0 ')).toBe(true)
  })

  it('rejects malformed alternative sets', () => {
    expect(isValidRange('||')).toBe(false)
    expect(isValidRange('')).toBe(false)
    expect(isValidRange('0.1.0 ||')).toBe(false)
    expect(isValidRange('0.1.0 || >=2.0.0')).toBe(false)
    expect(isValidRange('0.1.0 || 1.2')).toBe(false)
  })
})

describe('satisfiesRange', () => {
  it('matches exact versions only', () => {
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true)
    expect(satisfiesRange('1.2.4', '1.2.3')).toBe(false)
  })

  it('treats ^0.0.x as exact', () => {
    expect(satisfiesRange('0.0.1', '^0.0.1')).toBe(true)
    expect(satisfiesRange('0.0.2', '^0.0.1')).toBe(false)
  })

  it('keeps minor stable for ^0.x', () => {
    expect(satisfiesRange('0.1.5', '^0.1.0')).toBe(true)
    expect(satisfiesRange('0.2.0', '^0.1.0')).toBe(false)
    expect(satisfiesRange('0.0.9', '^0.1.0')).toBe(false)
  })

  it('keeps major stable for ^1.x and above', () => {
    expect(satisfiesRange('1.9.9', '^1.2.3')).toBe(true)
    expect(satisfiesRange('2.0.0', '^1.2.3')).toBe(false)
    expect(satisfiesRange('1.2.2', '^1.2.3')).toBe(false)
  })

  it('keeps minor stable for tilde', () => {
    expect(satisfiesRange('1.2.9', '~1.2.3')).toBe(true)
    expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false)
  })

  it('accepts everything for wildcard', () => {
    expect(satisfiesRange('0.0.1', '*')).toBe(true)
    expect(satisfiesRange('99.0.0', 'x')).toBe(true)
  })

  it('excludes prereleases below the range base', () => {
    expect(satisfiesRange('0.1.0-rc.1', '^0.1.0')).toBe(false)
  })

  it('matches any alternative in a || set', () => {
    expect(satisfiesRange('0.1.0', '0.1.0 || 0.2.0')).toBe(true)
    expect(satisfiesRange('0.2.0', '0.1.0 || 0.2.0')).toBe(true)
    expect(satisfiesRange('0.1.5', '0.1.0 || 0.2.0')).toBe(false)
    expect(satisfiesRange('0.1.5', '0.1.0 || ^0.2.0')).toBe(false)
    expect(satisfiesRange('0.2.9', '0.1.0 || ^0.2.0')).toBe(true)
  })

  it('supports skipping unsupported versions via sets', () => {
    expect(satisfiesRange('0.1.9', '^0.1.0 || ^0.3.0')).toBe(true)
    expect(satisfiesRange('0.2.5', '^0.1.0 || ^0.3.0')).toBe(false)
    expect(satisfiesRange('0.3.1', '^0.1.0 || ^0.3.0')).toBe(true)
  })
})
