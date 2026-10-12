import { describe, expect, it } from 'vitest'
import { DEFAULT_QUICK_COMMANDS, buildQuickRerun, parseQuickCommands, rollSeed, seedStrategyFor } from '../lib/quick.js'

describe('rollSeed strategies', () => {
  it('range: uniform within [min,max]', () => {
    const seed = rollSeed({ mode: 'range', min: 1, max: 10 }, () => 0.5)
    expect(seed).toBeGreaterThanOrEqual(1)
    expect(seed).toBeLessThanOrEqual(10)
    expect(rollSeed({ mode: 'range', min: 5, max: 5 }, () => 0.9)).toBe(5)
  })

  it('digits: length-bounded number, first digit non-zero', () => {
    let calls = 0
    const seq = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
    const seed = rollSeed({ mode: 'digits', length: 4 }, () => seq[calls++ % seq.length])
    expect(String(seed)).toHaveLength(4)
    expect(String(seed)[0]).not.toBe('0')
  })

  it('timestamp: now + compensation digits, stays INT64-safe', () => {
    const seed = rollSeed({ mode: 'timestamp', extraDigits: 3 }, () => 0.4, () => 1728651600000)
    expect(seed).toBe(1728651600000444)
    expect(rollSeed({ mode: 'timestamp', extraDigits: 6 }, () => 0.999, () => 9999999999999)).toBeLessThanOrEqual(9007199254740991)
  })
})

describe('parseQuickCommands', () => {
  it('falls back to the built-in 抽卡 on empty or invalid config', () => {
    expect(parseQuickCommands('')[0].name).toBe('抽卡')
    expect(parseQuickCommands('not json')[0].name).toBe('抽卡')
    expect(parseQuickCommands('{"a":1}')[0].name).toBe('抽卡')
    expect(DEFAULT_QUICK_COMMANDS[0].seed.mode).toBe('range')
  })

  it('keeps valid entries, drops nameless ones', () => {
    const commands = parseQuickCommands(JSON.stringify([
      { name: '抽卡', label: '🎲 抽卡', seed: { mode: 'digits', length: 6 } },
      { label: 'no name' },
      { name: '高清重跑', seed: { mode: 'range', min: 100, max: 200 } },
    ]))
    expect(commands).toHaveLength(2)
    expect(commands[0].seed).toEqual({ mode: 'digits', length: 6 })
    expect(commands[1].name).toBe('高清重跑')
  })
})

describe('seedStrategyFor / buildQuickRerun', () => {
  it('falls back to the default range strategy', () => {
    expect(seedStrategyFor([], 'nope')).toEqual({ mode: 'range', min: 1, max: 4294967295 })
  })

  it('rerun reuses form values and replaces only seed fields (composite keys)', () => {
    const lastRun = {
      name: 'beach-couple',
      form: {
        values: { '3:seed': 111, '6:text': '夕阳西下，沙滩' },
        graph: {
          '3': { class_type: 'KSampler', inputs: { seed: 111, steps: 20 } },
          '6': { class_type: 'CLIPTextEncode', inputs: { text: '夕阳西下，沙滩' } },
        },
      },
    }
    const rerun = buildQuickRerun(lastRun, { name: '抽卡', seed: { mode: 'range', min: 7, max: 7 } })
    expect(rerun.ok).toBe(true)
    expect(rerun.seed).toBe(7)
    expect(rerun.graph['3'].inputs.seed).toBe(7)
    expect(rerun.graph['3'].inputs.steps).toBe(20)
    expect(rerun.graph['6'].inputs.text).toBe('夕阳西下，沙滩')
    expect(rerun.values['3:seed']).toBe(7)
    expect(rerun.values['6:text']).toBe('夕阳西下，沙滩')
    expect(rerun.name).toBe('beach-couple-reroll')
  })

  it('rerun reports why it cannot proceed (boundary)', () => {
    expect(buildQuickRerun(null, { name: '抽卡' }).ok).toBe(false)
    expect(buildQuickRerun({ name: 'x' }, { name: '抽卡' }).reason).toContain('form.values')
    const noSeed = buildQuickRerun(
      { name: 'x', form: { values: { '6:text': 'hi' }, graph: { '6': { class_type: 'C', inputs: { text: 'hi' } } } } },
      { name: '抽卡' },
    )
    expect(noSeed.ok).toBe(false)
    expect(noSeed.reason).toContain('种子')
  })
})
