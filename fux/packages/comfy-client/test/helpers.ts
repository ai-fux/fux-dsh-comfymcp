/** Test helper: activate a FuxPluginModule against a mock PluginContext. */
import type { CapabilityHandler, FuxPluginModule } from '@fux/runtime'

export type HandlerMap = Record<string, CapabilityHandler>

export async function activatePluginForTest(
  module: FuxPluginModule,
  config: Record<string, unknown> = {},
): Promise<HandlerMap> {
  const handlers: HandlerMap = {}
  const ctx = {
    pluginId: '@fux-mcp/comfy-client',
    config,
    provide(capability: string, handler: CapabilityHandler): void {
      handlers[capability] = handler
    },
    async call<T>(capability: string): Promise<T> {
      throw new Error(`mock ctx cannot call ${capability}`)
    },
    events: {
      on(): () => void {
        return () => {}
      },
      emit(): void {},
    },
  }
  await module.activate(ctx as Parameters<FuxPluginModule['activate']>[0])
  return handlers
}
