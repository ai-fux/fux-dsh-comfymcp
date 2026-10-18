/**
 * dsh-comfymcp-client —— Host 半区。
 *
 * 职责：
 * 1. 注册 comfymcp_* 工具（defineTool → ctx.tools.register）；
 * 2. 注册技能 comfymcp-generation-flow（ctx.skills.register，可选服务）；
 * 3. 注册面板通道 /comfymcp（connection RPC）与成果物字节路由（connection fetch）；
 * 4. 持有 ComfymcpBridge（MCP stdio 客户端 + 运行历史 + 卸载探测）。
 *
 * 注册全部同步完成；MCP 宿主进程是懒连接——首次工具调用才 spawn，
 * 所以 comfy-mcp 服务不可达只是调用期错误，绝不影响插件激活。
 */
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from './lib/define.js'
import { ComfymcpBridge } from './lib/bridge.js'
import { applyHomeDefaults, resolveConfig } from './lib/config.js'
import { createTools } from './lib/catalog.js'
import { createBusinessStore } from './lib/business.js'
import { createDevLog } from './lib/devlog.js'
import { createProviderStore } from './lib/providers/store.js'
import { createCreationService } from './lib/create.js'
import { GENERATION_FLOW_SKILL } from './lib/skills.js'
import { createRpcMethods, registerConnectionSurface } from './lib/rpc.js'
import { createControlServer } from './lib/control-server.js'
import { createWorkbenchMethods } from './lib/workbench.js'
import * as persist from './lib/persist.js'

export const name = '@ai-fux/fux-dsh-comfymcp'
export const version = '0.6.1'
export const description =
  'comfy-mcp 对接：自然语言设计可运行 ComfyUI 工作流、定制表单确认、强制保存运行与成果物回显；内置多模态创作台（直连魔搭/HuggingFace/Ollama/vLLM/A1111 文生图与图生图）。'

/** 硬依赖：没有工具注册能力本插件没有意义。面板通道不做注入声明——见 rpc.js 的就绪重试。 */
export const inject = ['tools']

export function apply(ctx, config) {
  const overlayPath = persist.overlayPath()
  const overlay = persist.readOverlay(overlayPath)
  const effective = resolveConfig({ ...(config ?? {}), ...overlay }, process.env, resolvePath)
  // 插件自有主目录：缺省 DSH 内置数据目录下 comfymcp/，其下派生 workflows/artifacts/data
  applyHomeDefaults(effective, process.env, resolvePath)
  console.log(
    `[dsh-comfymcp-client] 主目录 ${effective.homeDir}（workflows=${effective.workflowDirs[0]} | artifacts=${effective.artifactsDir} | data=${effective.dataDir}）`,
  )
  // 开发模式活值：applyOverlay 保存 devMode 后 bridge.config 原地更新，
  // devLog/comfymcp_dev 按调用时取值即时生效（无需重启 DSH）；覆盖层保证重启后仍开启。
  const isDevMode = () => bridge.config.devMode === true
  // 开发日志先于桥接创建：运行失败/探测失败无条件落 dev-log.jsonl（非开发模式也固定留档），
  // 供 comfymcp_dev(action=report) 事后读取反馈；devMode 只影响报告指引，不门控记录。
  const devLog = createDevLog({ dataDir: effective.dataDir, devMode: isDevMode })
  const bridge = new ComfymcpBridge(effective, {
    // 插件自身目录：内置 comfy-mcp-server（vendor/）的定位基准
    pluginDir: dirname(fileURLToPath(import.meta.url)),
    log: (line) => console.log(`[dsh-comfymcp-client] ${line}`),
    devLog,
  })

  ctx.effect(() => {
    const disposers = []

    // 1. 模型工具
    const askUser = async (request, exec, timedSeconds = 0) => {
      const userQuestions = ctx.get('userQuestions')
      if (userQuestions === undefined || typeof userQuestions.ask !== 'function') {
        throw new Error('userQuestions 服务不可用：无法推送表单（检查 dsh-user-questions 是否启用）')
      }
      const payload = {
        questions: request.questions,
        ...(exec?.agent !== undefined ? { agent: exec.agent } : {}),
        ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
      }
      // 计时提问：卡片自带可见倒计时；到期由 seam 返回 { pending: true }（问题仍可后答）。
      // 需要活跃根代理 + 本次工具调用 id（卡片按 callId 配对）；不满足则回落阻塞式 ask。
      if (
        timedSeconds > 0 &&
        exec?.agent !== undefined &&
        typeof exec?.callId === 'string' && exec.callId.length > 0 &&
        typeof userQuestions.askTimed === 'function'
      ) {
        return userQuestions.askTimed({ ...payload, agent: exec.agent }, exec.callId, Math.round(timedSeconds * 1000))
      }
      return userQuestions.ask(payload)
    }
    // 业务配置（首次生成的工作流选择优化）：工具层与工作台共用同一个存储实例
    const business = createBusinessStore({ dataDir: effective.dataDir })
    // 多模态创作：服务商清单（providers.json）+ 创作任务/历史（creations/）
    const providerStore = createProviderStore({ dataDir: effective.dataDir })
    const creation = createCreationService({ config: bridge.config, store: providerStore, devLog })
    const tools = createTools({ define: defineTool, bridge, askUser, business, devLog, devMode: isDevMode, providerStore, creation })
    for (const tool of tools) {
      disposers.push(ctx.tools.register(tool))
    }

    // 2. 技能（可选服务）
    const skills = ctx.get('skills')
    if (skills !== undefined && typeof skills.register === 'function') {
      try {
        disposers.push(skills.register(GENERATION_FLOW_SKILL))
      } catch (error) {
        console.error(`[dsh-comfymcp-client] 技能注册失败: ${String(error)}`)
      }
    }

    // 3. 面板通道：环回控制端点（主通道）+ connection RPC（动态路径，尽力而为）
    const log = (line) => console.log(`[dsh-comfymcp-client] ${line}`)
    const methods = createRpcMethods({
      bridge,
      persist: {
        sanitizeOverlayPatch: persist.sanitizeOverlayPatch,
        writeOverlay: (patch) => persist.writeOverlay(overlayPath, { ...persist.readOverlay(overlayPath), ...patch }),
      },
    })
    // 工作台（/ui 静态页 + /api 页面 API）：工作流编排静态页、手动执行、成果物标签、快捷指令
    const workbench = createWorkbenchMethods({
      bridge,
      config: effective,
      business,
      providersStore: providerStore,
      creationService: creation,
      persistWrite: (patch) => persist.writeOverlay(overlayPath, { ...persist.readOverlay(overlayPath), ...patch }),
    })
    Object.assign(methods, workbench)
    const control = createControlServer({
      methods,
      port: effective.controlPort,
      token: effective.controlToken,
      version,
      log,
      devLog,
    })
    control
      .start()
      .then((bound) => {
        bridge.controlUrl = bound.url
        log(`设置页通道就绪：${bound.url}（浏览器直连环回控制端点）`)
      })
      .catch((error) => {
        bridge.controlUrl = null
        console.error(`[dsh-comfymcp-client] 控制端点启动失败（设置页将不可用）：${error instanceof Error ? error.message : String(error)}`)
      })
    disposers.push(() => control.close())
    disposers.push(...registerConnectionSurface({ ctx, methods, bridge, options: { log } }))

    // 4. 自动连接（预热；失败不影响激活）
    if (effective.autoConnect) {
      bridge
        .probe()
        .then((probe) => {
          if (probe.ok) {
            console.log(`[dsh-comfymcp-client] comfy-mcp 就绪（unload=${probe.unload.available ? '可用' : '不可用'}）`)
          } else {
            console.log(`[dsh-comfymcp-client] comfy-mcp 暂不可达：${probe.error}`)
          }
        })
        .catch(() => {})
    }

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
      void bridge.close()
    }
  })
}
