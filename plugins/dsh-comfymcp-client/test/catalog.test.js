import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTools, splitSteps } from '../lib/catalog.js'
import { createBusinessStore } from '../lib/business.js'

let workdir

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'comfymcp-catalog-'))
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

/** 每次调用拿一个落在本次临时目录的业务配置存储（避免测试互相污染）。 */
function businessStoreForTest() {
  return createBusinessStore({ dataDir: workdir })
}

/** Capture-only define(): records definitions, executes with a minimal runtime. */
function fakeDefine() {
  const definitions = []
  const define = (options) => {
    definitions.push(options)
    return { name: options.name, options }
  }
  return { define, definitions }
}

function fakeBridge(handlers = {}) {
  const config = {
    endpoint: 'http://x/mcp',
    hostCommand: 'node',
    hostEntry: 'host.mjs',
    workflowDirs: [join(workdir, 'wf')],
    saveSubdir: 'sub',
    artifactsDir: join(workdir, 'art'),
    autoUnloadModel: true,
    autoConnect: false,
    requestTimeoutMs: 1000,
    callTimeoutMs: 2000,
  }
  return {
    config,
    probe: handlers.probe ?? (async () => ({ ok: true, unload: { available: true, reason: 'ok' } })),
    probeUnload: handlers.probeUnload ?? (async () => ({ available: true, reason: 'ok' })),
    ensureReady: handlers.ensureReady ?? (async () => ({})),
    callRemote: handlers.callRemote ?? (async () => ({ structuredContent: {} })),
    fetchArtifacts: handlers.fetchArtifacts ?? (async () => ({ structuredContent: { files: [] } })),
    recordRun: handlers.recordRun ?? ((run) => ({ id: 'run-1', state: run.state ?? 'completed', ...run })),
  }
}

const GRAPH = {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'preset', clip: ['5', 1] } },
  '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, sampler_name: 'euler', model: ['4', 0], positive: ['6', 0] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'ComfyUI' } },
}

describe('createTools catalog', () => {
  it('registers the comfymcp tools with unique names', () => {
    const { define, definitions } = fakeDefine()
    createTools({ define, bridge: fakeBridge(), askUser: async () => ({ answers: [] }) })
    const names = definitions.map((entry) => entry.name)
    expect(names).toEqual([
      'comfymcp_status',
      'comfymcp_discover',
      'comfymcp_business',
      'comfymcp_analyze_workflow',
      'comfymcp_push_form',
      'comfymcp_apply_form',
      'comfymcp_run_workflow',
      'comfymcp_fetch_artifacts',
      'comfymcp_files',
      'comfymcp_workflow_pull',
      'comfymcp_call_remote',
      'comfymcp_create',
      'comfymcp_dev',
    ])
    expect(new Set(names).size).toBe(names.length)
    for (const definition of definitions) {
      expect(definition.output.render({}, {}) instanceof Array).toBe(true)
      expect(typeof definition.execute).toBe('function')
    }
  })

  it('comfymcp_business：未命中→提示走完整流程；登记后命中→直接给工作流（本地图一并带上）', async () => {
    const { define, definitions } = fakeDefine()
    createTools({
      define,
      bridge: fakeBridge(),
      askUser: async () => ({ answers: [] }),
      business: businessStoreForTest(),
    })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_business')
    // 空配置：不硬匹配
    const miss = await tool.execute({ action: 'match', text: '帮我画一只猫' })
    expect(miss.ok).toBe(true)
    expect(miss.matched).toBeNull()
    expect(miss.nextSteps).toMatch(/完整流程/)
    // 登记一条（带图 → 自动判定业务类并摘参数）
    const saved = await tool.execute({ action: 'register', workflow: 'beach', graph: GRAPH })
    expect(saved.ok).toBe(true)
    expect(saved.matched).toMatchObject({ business: 'text2img', workflow: 'beach' })
    expect(saved.matched.params.steps).toBe(20)
    // 再匹配即命中；本地存在同名工作流文件时附带 graph，省一次取图
    const hit = await tool.execute({ action: 'match', text: '画一张海边日落' })
    expect(hit.matched?.workflow).toBe('beach')
    expect(hit.matched?.params?.steps).toBe(20)
    expect(hit.nextSteps).toMatch(/跳过|不要再检索/)
    expect(hit.nextSteps).toMatch(/文生图/) // 提示里带业务类显示名
    expect((await tool.execute({ action: 'list' })).profiles.length).toBe(1)
    expect((await tool.execute({ action: 'remove', id: 'text2img' })).profiles.length).toBe(0)
  })

  it('命中业务配置后 push_form 标题自动以业务类显示名开头（模型写了同名开头则不重复拼）', async () => {
    const { define, definitions } = fakeDefine()
    const captured = []
    createTools({
      define,
      bridge: fakeBridge(),
      askUser: async (request) => {
        captured.push(request)
        return { answers: [{ id: 'field:6.text', selected: [], custom: 'x' }] }
      },
      business: businessStoreForTest(),
    })
    const business = definitions.find((entry) => entry.name === 'comfymcp_business')
    const pushForm = definitions.find((entry) => entry.name === 'comfymcp_push_form')
    const fields = [{ id: '6.text', nodeId: '6', field: 'text', kind: 'text', value: 'preset', label: 'Prompt' }]
    // 未命中业务配置 → 标题保持模型传的（缺省「生成参数确认」）
    await pushForm.execute({ graph: GRAPH, fields, title: '白色机甲' }, { agent: 'a', signal: undefined })
    expect(captured[0].questions[0].header).toBe('白色机甲 · 1/1')
    // 命中后再推表单 → 标题自动加业务类前缀
    await business.execute({ action: 'register', workflow: 'beach', graph: GRAPH })
    await business.execute({ action: 'match', text: '画一张海边日落' })
    await pushForm.execute({ graph: GRAPH, fields }, { agent: 'a', signal: undefined })
    expect(captured[1].questions[0].header).toBe('文生图 · 生成参数确认 · 1/1')
    // 模型自己也传了 title → 拼在业务类后面
    await pushForm.execute({ graph: GRAPH, fields, title: '白色机甲' }, { agent: 'a', signal: undefined })
    expect(captured[2].questions[0].header).toBe('文生图 · 白色机甲 · 1/1')
    // 模型传的 title 已以业务类开头 → 不重复拼
    await pushForm.execute({ graph: GRAPH, fields, title: '文生图（机甲）' }, { agent: 'a', signal: undefined })
    expect(captured[3].questions[0].header).toBe('文生图（机甲） · 1/1')
  })

  it('comfymcp_business 参数预设集：preset_save/preset_remove 管理，match 命中时 presets 一并带出', async () => {
    const { define, definitions } = fakeDefine()
    createTools({
      define,
      bridge: fakeBridge(),
      askUser: async () => ({ answers: [] }),
      business: businessStoreForTest(),
    })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_business')
    await tool.execute({ action: 'register', workflow: 'beach', graph: GRAPH })
    // 校验：空参数拒绝且给原因
    const bad = await tool.execute({ action: 'preset_save', id: 'text2img', name: '高清', params: {} })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toMatch(/参数为空|至少填一项/)
    // 正常保存
    const saved = await tool.execute({ action: 'preset_save', id: 'text2img', name: '高清', params: { steps: 30, width: 1024 } })
    expect(saved.ok).toBe(true)
    expect(saved.preset).toMatchObject({ name: '高清' })
    expect(saved.presets.length).toBe(1)
    // match 命中 → matched.presets 带出，nextSteps 提示预设名
    const hit = await tool.execute({ action: 'match', text: '画一张海边日落' })
    expect(hit.matched.presets.map((entry) => entry.name)).toEqual(['高清'])
    expect(hit.nextSteps).toMatch(/参数预设.*高清/)
    // 同名覆盖；按名称删除
    await tool.execute({ action: 'preset_save', id: 'text2img', name: '高清', params: { steps: 32 } })
    const removed = await tool.execute({ action: 'preset_remove', id: 'text2img', presetId: '高清' })
    expect(removed.ok).toBe(true)
    expect(removed.presets).toEqual([])
    const missing = await tool.execute({ action: 'preset_remove', id: 'text2img', presetId: '高清' })
    expect(missing.ok).toBe(false)
  })

  it('register 带 presetName 时顺手把本次参数存成预设', async () => {
    const { define, definitions } = fakeDefine()
    createTools({
      define,
      bridge: fakeBridge(),
      askUser: async () => ({ answers: [] }),
      business: businessStoreForTest(),
    })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_business')
    const saved = await tool.execute({ action: 'register', workflow: 'beach', graph: GRAPH, presetName: '首次参数' })
    expect(saved.ok).toBe(true)
    expect(saved.preset).toMatchObject({ name: '首次参数' })
    expect(saved.preset.params.steps).toBe(20)
    expect(saved.nextSteps).toMatch(/首次参数/)
    expect((await tool.execute({ action: 'list' })).profiles[0].presets.length).toBe(1)
  })

  it('comfymcp_status folds probe results', async () => {
    const { define, definitions } = fakeDefine()
    createTools({ define, bridge: fakeBridge({
      probe: async () => ({ ok: false, error: '服务不可达', unload: { available: false, reason: 'offline' } }),
    }), askUser: async () => ({ answers: [] }) })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_status')
    const result = await tool.execute({}, { agent: undefined, signal: undefined })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('服务不可达')
  })

  it('comfymcp_analyze_workflow derives fields from a template graph', async () => {
    const { define, definitions } = fakeDefine()
    createTools({
      define,
      bridge: fakeBridge({
        callRemote: async (tool) => {
          if (tool === 'get_workflow') return { structuredContent: { graph: GRAPH } }
          if (tool === 'node_info') return { structuredContent: { classes: { KSampler: { input: { required: { sampler_name: [['euler', 'ddim']] } } } } } }
          if (tool === 'list_models') return { structuredContent: { types: { checkpoints: ['a.safetensors'] } } }
          return { structuredContent: {} }
        },
      }),
      askUser: async () => ({ answers: [] }),
    })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_analyze_workflow')
    const result = await tool.execute({ requirement: '生成一只猫；赛博朋克风格', workflowId: 'tpl-1' }, {})
    expect(result.ok).toBe(true)
    expect(result.analysis.steps).toContain('赛博朋克风格')
    const kinds = result.fields.map((field) => field.kind)
    expect(kinds).toContain('text')
    expect(kinds).toContain('seed')
  })

  it('comfymcp_push_form asks the user and normalizes answers', async () => {
    const { define, definitions } = fakeDefine()
    let capturedRequest
    createTools({
      define,
      bridge: fakeBridge(),
      askUser: async (request) => {
        capturedRequest = request
        return { answers: [{ id: 'field:6.text', selected: [], custom: 'answered' }] }
      },
    })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_push_form')
    const fields = [{ id: '6.text', nodeId: '6', field: 'text', kind: 'text', value: 'preset', label: 'Prompt' }]
    const result = await tool.execute({ graph: GRAPH, fields }, { agent: 'agent-1', signal: undefined })
    expect(capturedRequest.questions.length).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.answered).toBe(1)
    expect(result.answers[0].custom).toBe('answered')
  })

  it('comfymcp_push_form auto-accepts recommended values when the countdown expires（配置开启）', async () => {
    vi.useFakeTimers()
    try {
      const { define, definitions } = fakeDefine()
      let askCount = 0
      const bridge = fakeBridge()
      bridge.config.autoAcceptForm = true
      bridge.config.autoAcceptFormSec = 1
      createTools({
        define,
        bridge,
        askUser: (request) => {
          askCount += 1
          // 每页都写明：推荐值 + 倒计时规则 + 该干什么
          expect(request.questions[0].question).toMatch(/⏱ 1 秒未答 → 自动采用【推荐】值继续/)
          expect(request.questions[0].question).toMatch(/本框可留空/)
          expect(request.questions[0].question).toMatch(/推荐（预设）/)
          expect(request.questions[0].header).toMatch(/生成参数确认 · 1\/1/)
          return new Promise(() => {}) // 用户一直不作答
        },
      })
      const tool = definitions.find((entry) => entry.name === 'comfymcp_push_form')
      const fields = [{ id: '6.text', nodeId: '6', field: 'text', kind: 'text', value: 'preset', label: 'Prompt' }]
      const promise = tool.execute({ graph: GRAPH, fields }, {})
      await vi.advanceTimersByTimeAsync(1100)
      const result = await promise
      expect(askCount).toBe(1) // 表单确实推送过（带倒计时提示）
      expect(result.ok).toBe(true)
      expect(result.auto).toBe(true)
      expect(result.autoReason).toMatch(/倒计时 1 秒.*推荐参数/)
      expect(result.answers).toEqual([])
      expect(result.answered).toBe(0)
      expect(result.fields.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('comfymcp_push_form uses the timed ask（卡片原生倒计时）and maps pending to auto', async () => {
    const { define, definitions } = fakeDefine()
    const calls = []
    const bridge = fakeBridge()
    bridge.config.autoAcceptForm = true
    bridge.config.autoAcceptFormSec = 30
    createTools({
      define,
      bridge,
      askUser: async (request, exec, timedSeconds) => {
        calls.push({ request, exec, timedSeconds })
        expect(timedSeconds).toBe(30)
        expect(exec.callId).toBe('call-1')
        return { pending: true, callId: 'call-1' } // seam 到期返回 pending
      },
    })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_push_form')
    const fields = [{ id: '6.text', nodeId: '6', field: 'text', kind: 'text', value: 'preset', label: 'Prompt' }]
    const result = await tool.execute({ graph: GRAPH, fields }, { agent: 'agent-1', callId: 'call-1' })
    expect(calls.length).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.auto).toBe(true)
    expect(result.autoReason).toMatch(/倒计时 30 秒.*推荐参数/)
    expect(result.autoReason).toMatch(/迟到回答/)
    expect(result.answers).toEqual([])
    expect(result.fields.length).toBe(1)
  })

  it('comfymcp_push_form falls back to the local race when the timed ask hits a precondition error（兼容旧 seam）', async () => {
    vi.useFakeTimers()
    try {
      const { define, definitions } = fakeDefine()
      let calls = 0
      const bridge = fakeBridge()
      bridge.config.autoAcceptForm = true
      bridge.config.autoAcceptFormSec = 1
      createTools({
        define,
        bridge,
        askUser: async (request, exec, timedSeconds) => {
          calls += 1
          if (timedSeconds > 0) {
            // 真实前置失败形状：非活跃根代理（旧 seam / 子代理里调用）
            const error = new Error('timed questions require a live agent')
            error.code = 'DELEGATED_CALLER'
            throw error
          }
          return new Promise(() => {}) // 阻塞不作答
        },
      })
      const tool = definitions.find((entry) => entry.name === 'comfymcp_push_form')
      const fields = [{ id: '6.text', nodeId: '6', field: 'text', kind: 'text', value: 'preset', label: 'Prompt' }]
      const promise = tool.execute({ graph: GRAPH, fields }, {})
      await vi.advanceTimersByTimeAsync(1100)
      const result = await promise
      expect(calls).toBe(2) // 先试 timed → 前置失败 → 本地竞速（倒计时仍然生效）
      expect(result.auto).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('comfymcp_push_form never re-prompts after the user dismisses the form（取消后不重弹）', async () => {
    const { define, definitions } = fakeDefine()
    let calls = 0
    const bridge = fakeBridge()
    bridge.config.autoAcceptForm = true
    bridge.config.autoAcceptFormSec = 30
    createTools({
      define,
      bridge,
      askUser: async () => {
        calls += 1
        const error = new Error('the user cancelled ask_user_question')
        error.code = 'ASK_CANCELLED'
        throw error
      },
    })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_push_form')
    const fields = [{ id: '6.text', nodeId: '6', field: 'text', kind: 'text', value: 'preset', label: 'Prompt' }]
    const result = await tool.execute({ graph: GRAPH, fields }, { agent: 'a', callId: 'c1' })
    expect(calls).toBe(1) // 取消只发生一次：不会再弹一个没有倒计时的阻塞对话框
    expect(result).toMatchObject({ ok: true, cancelled: true })
    expect(result.reason).toMatch(/取消/)
    expect(result.answers).toEqual([])
  })

  it('comfymcp_push_form reports the same cancellation when auto-accept is off（默认关闭也要识别取消）', async () => {
    const { define, definitions } = fakeDefine()
    const bridge = fakeBridge() // autoAcceptForm 默认关
    createTools({
      define,
      bridge,
      askUser: async () => {
        const error = new Error('the user cancelled ask_user_question')
        error.code = 'ASK_CANCELLED'
        throw error
      },
    })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_push_form')
    const fields = [{ id: '6.text', nodeId: '6', field: 'text', kind: 'text', value: 'preset', label: 'Prompt' }]
    expect(await tool.execute({ graph: GRAPH, fields }, {})).toMatchObject({ ok: true, cancelled: true })
  })

  it('comfymcp_push_form keeps waiting and returns real answers when auto-accept is off（默认关闭）', async () => {
    const { define, definitions } = fakeDefine()
    let captured
    createTools({
      define,
      bridge: fakeBridge(),
      askUser: async (request) => {
        captured = request
        return { answers: [{ id: 'field:6.text', selected: [], custom: 'answered' }] }
      },
    })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_push_form')
    const fields = [{ id: '6.text', nodeId: '6', field: 'text', kind: 'text', value: 'preset', label: 'Prompt' }]
    const result = await tool.execute({ graph: GRAPH, fields }, {})
    expect(captured.questions[0].question).not.toMatch(/⏱/)
    expect(result.auto).toBeUndefined()
    expect(result.answers[0].custom).toBe('answered')
  })

  it('comfymcp_push_form prefers the real user answer that wins the countdown race（先答先得）', async () => {
    vi.useFakeTimers()
    try {
      const { define, definitions } = fakeDefine()
      const bridge = fakeBridge()
      bridge.config.autoAcceptForm = true
      bridge.config.autoAcceptFormSec = 30
      createTools({
        define,
        bridge,
        askUser: async () => ({ answers: [{ id: 'field:6.text', selected: [], custom: 'human' }] }),
      })
      const tool = definitions.find((entry) => entry.name === 'comfymcp_push_form')
      const fields = [{ id: '6.text', nodeId: '6', field: 'text', kind: 'text', value: 'preset', label: 'Prompt' }]
      const result = await tool.execute({ graph: GRAPH, fields }, {})
      expect(result.auto).toBeUndefined()
      expect(result.answers[0].custom).toBe('human')
      await vi.advanceTimersByTimeAsync(31000) // 计时器必须被清理，不产生未决拒绝
    } finally {
      vi.useRealTimers()
    }
  })

  it('comfymcp_push_form falls back to the default 30s countdown for invalid seconds（缺省 30 秒）', async () => {
    vi.useFakeTimers()
    try {
      for (const bad of [0, -5, 'abc', undefined]) {
        const { define, definitions } = fakeDefine()
        const bridge = fakeBridge()
        bridge.config.autoAcceptForm = true
        bridge.config.autoAcceptFormSec = bad
        let captured
        createTools({
          define,
          bridge,
          askUser: (request) => {
            captured = request
            return new Promise(() => {})
          },
        })
        const tool = definitions.find((entry) => entry.name === 'comfymcp_push_form')
        const fields = [{ id: '6.text', nodeId: '6', field: 'text', kind: 'text', value: 'preset', label: 'Prompt' }]
        const promise = tool.execute({ graph: GRAPH, fields }, {})
        await vi.advanceTimersByTimeAsync(30100)
        const result = await promise
        expect(captured.questions[0].question).toMatch(/⏱ 30 秒未答 → 自动采用【推荐】值继续/)
        expect(result.autoReason).toMatch(/倒计时 30 秒/)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('comfymcp_run_workflow saves first, integrates unload, runs, and records', async () => {
    const calls = []
    const { define, definitions } = fakeDefine()
    createTools({
      define,
      bridge: fakeBridge({
        ensureReady: async () => ({
          callTool: async (name, args) => {
            calls.push({ name, args })
            if (args.tool === 'save_workflow') return { structuredContent: { ok: true, data: { ok: true, id: 'saved-1' } } }
            if (args.tool === 'run_workflow') {
              return { structuredContent: { ok: true, data: { promptId: 'p-1', taskId: 'comfyui:1' } } }
            }
            if (args.tool === 'job_wait') return { structuredContent: { ok: true, data: { state: 'completed', outputs: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } }
            // 成果物走 fetch_outputs 落盘（服务端写 outDir 并返回本地路径 + refs）
            if (args.tool === 'fetch_outputs') {
              return {
                structuredContent: {
                  ok: true,
                  data: {
                    files: [{ path: join(workdir, 'x.png'), filename: 'x.png', bytes: 3 }],
                    artifacts: [{ id: 'a1', url: '/artifacts/a1', filename: 'x.png', kind: 'image', bytes: 3 }],
                  },
                },
              }
            }
            return { structuredContent: {} }
          },
        }),
        recordRun: (run) => ({ id: 'run-9', state: run.state ?? 'completed', ...run }),
      }),
      askUser: async () => ({ answers: [] }),
    })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_run_workflow')
    const result = await tool.execute({ name: 'demo run', graph: JSON.parse(JSON.stringify(GRAPH)) }, {})
    // save happens before run
    const saveIndex = calls.findIndex((call) => call.args.tool === 'save_workflow')
    const runIndex = calls.findIndex((call) => call.args.tool === 'run_workflow')
    expect(saveIndex).toBeGreaterThanOrEqual(0)
    expect(runIndex).toBeGreaterThan(saveIndex)
    // unload integrated: the run graph contains UnloadAllModels
    const runGraph = calls.find((call) => call.args.tool === 'run_workflow').args.arguments.graph
    const hasUnload = Object.values(runGraph).some((node) => node.class_type === 'UnloadAllModels')
    expect(hasUnload).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.state).toBe('completed')
    expect(result.localFiles).toHaveLength(1)
    expect(result.saved.subdir).toBe('sub')
  })

  it('comfymcp_run_workflow records failures without throwing (error path)', async () => {
    const recorded = []
    const { define, definitions } = fakeDefine()
    createTools({
      define,
      bridge: fakeBridge({
        ensureReady: async () => ({
          callTool: async () => {
            throw new Error('connection refused')
          },
        }),
        recordRun: (run) => {
          recorded.push(run)
          return { id: 'run-f', state: run.state ?? 'failed', ...run }
        },
      }),
      askUser: async () => ({ answers: [] }),
    })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_run_workflow')
    const result = await tool.execute({ name: 'broken', graph: GRAPH }, {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/connection refused/)
    expect(recorded[0].state).toBe('failed')
  })

  it('comfymcp_call_remote passes through and reflects isError', async () => {
    const { define, definitions } = fakeDefine()
    createTools({
      define,
      bridge: fakeBridge({
        callRemote: async () => ({ structuredContent: { isError: true, error: 'boom' } }),
      }),
      askUser: async () => ({ answers: [] }),
    })
    const tool = definitions.find((entry) => entry.name === 'comfymcp_call_remote')
    const result = await tool.execute({ tool: 'node_search', arguments: { query: 'x' } }, {})
    expect(result.ok).toBe(false)
    expect(result.data.isError).toBe(true)
  })
})

describe('splitSteps', () => {
  it('splits on sentence boundaries and caps at 12', () => {
    expect(splitSteps('生成一只猫。赛博朋克风格；霓虹灯')).toEqual(['生成一只猫', '赛博朋克风格', '霓虹灯'])
    expect(splitSteps('')).toEqual([])
    expect(splitSteps('x'.repeat(100).split('').join('；')).length).toBe(12)
  })
})
