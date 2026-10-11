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
import { resolve as resolvePath } from 'node:path'
import { defineTool } from './lib/define.js'
import { ComfymcpBridge } from './lib/bridge.js'
import { resolveConfig } from './lib/config.js'
import { createTools } from './lib/catalog.js'
import { GENERATION_FLOW_SKILL } from './lib/skills.js'
import { createRpcMethods, registerConnectionSurface } from './lib/rpc.js'
import * as persist from './lib/persist.js'

export const name = 'dsh-comfymcp-client'
export const version = '0.1.0'
export const description =
  'comfy-mcp 对接：自然语言设计可运行 ComfyUI 工作流、定制表单确认、强制保存运行与成果物回显。'

/** 硬依赖：工具注册 + 面板通道（connection.rpc.handle 内部以本 ctx 挂 webServer 路由）。 */
export const inject = ['tools', 'connection', 'webServer']

export function apply(ctx, config) {
  const overlayPath = persist.overlayPath()
  const overlay = persist.readOverlay(overlayPath)
  const effective = resolveConfig({ ...(config ?? {}), ...overlay }, process.env, resolvePath)
  const bridge = new ComfymcpBridge(effective, {
    log: (line) => console.log(`[dsh-comfymcp-client] ${line}`),
  })

  ctx.effect(() => {
    const disposers = []

    // 1. 模型工具
    const askUser = async (request, exec) => {
      const userQuestions = ctx.get('userQuestions')
      if (userQuestions === undefined || typeof userQuestions.ask !== 'function') {
        throw new Error('userQuestions 服务不可用：无法推送表单（检查 dsh-user-questions 是否启用）')
      }
      return userQuestions.ask({
        questions: request.questions,
        ...(exec?.agent !== undefined ? { agent: exec.agent } : {}),
        ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
      })
    }
    const tools = createTools({ define: defineTool, bridge, askUser })
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

    // 3. 面板通道 + 成果物字节路由（可选服务）
    const methods = createRpcMethods({
      bridge,
      persist: {
        sanitizeOverlayPatch: persist.sanitizeOverlayPatch,
        writeOverlay: (patch) => persist.writeOverlay(overlayPath, { ...persist.readOverlay(overlayPath), ...patch }),
      },
    })
    disposers.push(...registerConnectionSurface({ ctx, methods, bridge }))

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
