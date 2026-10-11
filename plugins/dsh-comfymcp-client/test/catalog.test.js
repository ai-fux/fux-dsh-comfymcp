import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  it('registers the seven comfymcp tools with unique names', () => {
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

  it('comfymcp_run_workflow saves first, integrates unload, runs, and records', async () => {
    const calls = []
    const { define, definitions } = fakeDefine()
    createTools({
      define,
      bridge: fakeBridge({
        ensureReady: async () => ({
          callTool: async (name, args) => {
            calls.push({ name, args })
            if (name === 'fetch_artifacts') {
              return { structuredContent: { files: [{ path: join(workdir, 'x.png'), filename: 'x.png', kind: 'image', bytes: 3 }] } }
            }
            if (args.tool === 'save_workflow') return { structuredContent: { ok: true, id: 'saved-1' } }
            if (args.tool === 'run_workflow') {
              return { structuredContent: { promptId: 'p-1', state: 'completed', artifacts: [{ id: 'a1', url: '/artifacts/a1', filename: 'x.png', kind: 'image', bytes: 3 }] } }
            }
            if (args.tool === 'job_wait') return { structuredContent: { state: 'completed' } }
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
