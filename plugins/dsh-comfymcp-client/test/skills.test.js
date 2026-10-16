import { describe, expect, it } from 'vitest'
import { GENERATION_FLOW_CONTENT, SKILL_NAME } from '../lib/skills.js'

describe('generation flow skill: autoAcceptForm 表单倒计时策略', () => {
  it('pins the timed-ask semantics: visible countdown, pending → recommended values, late answers honored', () => {
    // 第 0 步：策略识别 + pending 语义
    expect(GENERATION_FLOW_CONTENT).toContain('config.autoAcceptForm=true')
    expect(GENERATION_FLOW_CONTENT).toContain('自带可见倒计时')
    expect(GENERATION_FLOW_CONTENT).toContain('{ pending: true }')
    expect(GENERATION_FLOW_CONTENT).toContain('把推荐项当作用户已确认，直接继续执行')
    expect(GENERATION_FLOW_CONTENT).toContain('迟到补答会以用户消息送达')
    // 策略关闭 → 阻塞等待
    expect(GENERATION_FLOW_CONTENT).toContain('显式传 `timeout: -1`')
    // 第 1 步：含糊需求走表单字段（推荐项第一位）
    expect(GENERATION_FLOW_CONTENT).toContain('不要发独立的开放式追问对话框')
    expect(GENERATION_FLOW_CONTENT).toContain('做成表单枚举字段')
    expect(GENERATION_FLOW_CONTENT).toContain('推荐项排第一位')
    // 第 4 步：auto:true 直接继续 + 不另发追问
    expect(GENERATION_FLOW_CONTENT).toContain('auto:true')
    expect(GENERATION_FLOW_CONTENT).toContain('另发追问')
    // 运行段：开关关闭时移除工作流自带的卸载节点
    expect(GENERATION_FLOW_CONTENT).toContain('自动移除工作流自带的卸载节点')
    // 决策速记
    expect(GENERATION_FLOW_CONTENT).toContain('pending/auto:true → 按推荐项直接继续')
  })

  it('keeps the free-ask behaviour when the policy is off', () => {
    expect(GENERATION_FLOW_CONTENT).toContain('config.autoAcceptForm=false')
    expect(GENERATION_FLOW_CONTENT).toMatch(/autoAcceptForm=false[\s\S]{0,80}用户含糊时先追问/)
  })

  it('keeps the stable skill identity', () => {
    expect(SKILL_NAME).toBe('comfymcp-generation-flow')
  })

  it('业务配置命中提示与参数预设（0.4.0）：标题自动带业务类、预设按名套用', () => {
    // 第 2 步：matched.presets 预设集语义
    expect(GENERATION_FLOW_CONTENT).toContain('matched.presets')
    expect(GENERATION_FLOW_CONTENT).toContain('参数预设集')
    expect(GENERATION_FLOW_CONTENT).toContain('用户点名预设')
    // 命中后表单标题自动带业务类显示名；模型不要重复拼
    expect(GENERATION_FLOW_CONTENT).toContain('业务类显示名')
    expect(GENERATION_FLOW_CONTENT).toMatch(/自动在前面拼上业务类显示名[\s\S]{0,60}不要自己重复拼/)
    // register 可带 presetName 存预设
    expect(GENERATION_FLOW_CONTENT).toContain('presetName')
  })
})
