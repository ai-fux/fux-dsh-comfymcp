import { describe, expect, it } from 'vitest'
import { GENERATION_FLOW_CONTENT, SKILL_NAME } from '../lib/skills.js'

describe('generation flow skill: autoAcceptForm 表单倒计时策略', () => {
  it('pins the hard rule: countdown on → no standalone ask_user_question, fold choices into the form', () => {
    // 第 0 步：策略识别
    expect(GENERATION_FLOW_CONTENT).toContain('config.autoAcceptForm=true')
    expect(GENERATION_FLOW_CONTENT).toContain('不得**再发任何独立的 ask_user_question 追问对话框')
    // 第 1 步：含糊需求走表单字段（推荐项第一位）
    expect(GENERATION_FLOW_CONTENT).toContain('禁止用 ask_user_question 追问')
    expect(GENERATION_FLOW_CONTENT).toContain('做成表单枚举字段')
    expect(GENERATION_FLOW_CONTENT).toContain('推荐项排第一位')
    // 第 4 步：auto:true 直接继续 + 不另发追问
    expect(GENERATION_FLOW_CONTENT).toContain('auto:true')
    expect(GENERATION_FLOW_CONTENT).toContain('另发追问')
    // 决策速记
    expect(GENERATION_FLOW_CONTENT).toContain('一切问题并入 push_form')
  })

  it('keeps the free-ask behaviour when the policy is off', () => {
    expect(GENERATION_FLOW_CONTENT).toContain('config.autoAcceptForm=false')
    expect(GENERATION_FLOW_CONTENT).toMatch(/autoAcceptForm=false[\s\S]{0,80}用户含糊时先追问/)
  })

  it('keeps the stable skill identity', () => {
    expect(SKILL_NAME).toBe('comfymcp-generation-flow')
  })
})
