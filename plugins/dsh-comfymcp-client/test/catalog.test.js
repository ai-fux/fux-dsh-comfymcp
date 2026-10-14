import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTools, splitSteps } from '../lib/catalog.js'

let workdir

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'comfymcp-catalog-'))
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

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
      'comfymcp_analyze_workflow',
      'comfymcp_push_form',
      'comfymcp_apply_form',
      'comfymcp_run_workflow',
      'comfymcp_fetch_artifacts',
      'comfymcp_files',
      'comfymcp_workflow_pull',
      'comfymcp_call_remote',
    ])
    expect(new Set(names).size).toBe(names.length)
    for (const definition of definitions) {
      expect(definition.output.render({}, {}) instanceof Array).toBe(true)
      expect(typeof definition.execute).toBe('function')
    }
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
