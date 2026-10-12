import { z } from 'zod'

export const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export const SemverSchema = z.string().regex(SEMVER_REGEX)

export interface SemverParts {
  major: number
  minor: number
  patch: number
  prerelease?: string
  build?: string
}

export function parseSemver(version: string): SemverParts | null {
  const match = version.match(SEMVER_REGEX)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
    build: match[5],
  }
}

function comparePrerelease(a: string, b: string): number {
  const segA = a.split('.')
  const segB = b.split('.')
  const len = Math.min(segA.length, segB.length)
  for (let i = 0; i < len; i++) {
    const s1 = segA[i] as string
    const s2 = segB[i] as string
    if (s1 === s2) continue
    const n1 = Number(s1)
    const n2 = Number(s2)
    const bothNumeric = !Number.isNaN(n1) && !Number.isNaN(n2)
    if (bothNumeric) return n1 < n2 ? -1 : 1
    return s1 < s2 ? -1 : 1
  }
  return segA.length - segB.length
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa) throw new TypeError(`Invalid semver: ${a}`)
  if (!pb) throw new TypeError(`Invalid semver: ${b}`)
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch
  if (pa.prerelease === pb.prerelease) return 0
  if (!pa.prerelease) return 1
  if (!pb.prerelease) return -1
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

const SINGLE_RANGE_REGEX =
  /^([~^]?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function isValidSingleRange(range: string): boolean {
  if (range === '*' || range === 'x') return true
  return SINGLE_RANGE_REGEX.test(range)
}

function splitRangeAlternatives(range: string): string[] | null {
  const alternatives = range.split('||').map((segment) => segment.trim())
  if (alternatives.length === 0) return null
  if (alternatives.some((segment) => segment.length === 0)) return null
  return alternatives
}

export function isValidRange(range: string): boolean {
  const alternatives = splitRangeAlternatives(range)
  if (!alternatives) return false
  return alternatives.every(isValidSingleRange)
}

function satisfiesSingleRange(version: string, range: string): boolean {
  if (range === '*' || range === 'x') return true
  const match = range.match(/^([~^]?)(.+)$/)
  if (!match) return false
  const operator = match[1] as string
  const baseRaw = match[2] as string
  const base = parseSemver(baseRaw)
  if (!base) return false

  if (operator === '') return compareSemver(version, baseRaw) === 0

  const cmpBase = compareSemver(version, baseRaw)
  if (cmpBase < 0) return false

  let upper: string
  if (operator === '~') {
    upper = `${base.major}.${base.minor + 1}.0`
  } else {
    if (base.major === 0 && base.minor === 0) return cmpBase === 0
    upper = base.major === 0 ? `0.${base.minor + 1}.0` : `${base.major + 1}.0.0`
  }
  return compareSemver(version, upper) < 0
}

export function satisfiesRange(version: string, range: string): boolean {
  const alternatives = splitRangeAlternatives(range)
  if (!alternatives) return false
  return alternatives.some((alternative) => satisfiesSingleRange(version, alternative))
}
