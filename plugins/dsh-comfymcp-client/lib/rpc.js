/**
 * 面板通道：/comfymcp 连接 RPC 方法映射 + 成果物字节 Fetch 路由。
 *
 * 方法（endpoint → payload → result）：
 *   status      {}                     → 探测结果（含置灰判定数据）
 *   runs        {limit?}               → 运行历史
 *   run         {id}                   → 单条运行记录
 *   artifact    {path}（fetch 路由）    → 字节流（仅 artifactsDir/工作流空间内）
 */

export const RPC_CHANNEL = '/comfymcp'
export const ARTIFACT_ROUTE = '/comfymcp/artifact'

export function createRpcMethods({ bridge, persist }) {
  return {
    async status() {
      return bridge.probe()
    },
    async runs(payload) {
      const limit = typeof payload?.limit === 'number' && payload.limit > 0 ? Math.min(payload.limit, 100) : 20
      return { runs: bridge.listRuns(limit) }
    },
    async run(payload) {
      const id = typeof payload?.id === 'string' ? payload.id : ''
      const record = bridge.getRun(id)
      if (record === null) {
        return { error: 'run not found' }
      }
      return record
    },
    async configRead() {
      return { ...bridge.config }
    },
    async configWrite(payload) {
      const patch = persist.sanitizeOverlayPatch(payload)
      const ok = persist.writeOverlay(patch)
      if (!ok) {
        return { error: '覆盖层写入失败，配置未保存' }
      }
      bridge.applyOverlay(patch)
      return { applied: { ...bridge.config } }
    },
  }
}

/**
 * Register the panel channel + artifact fetch route.
 *
 * `connection.rpc.handle` internally mounts an HTTP route on the owner context's
 * `webServer` service, which in the web profile lands ASYNCHRONOUSLY after the
 * include tree applies (dsh-web-app defers its own webServer reads until the
 * loader settles for the same reason). Touching it too early raises the cordis
 * property guard and would fail activation. Registration therefore retries on a
 * timer until it succeeds; activation never fails because of this surface.
 *
 * @param ctx Host context with the optional connection service
 * @param options { attempts, intervalMs, schedule, log } test/verbosity seams
 * @returns disposers actually registered (always one: the retry disposer)
 */
export function registerConnectionSurface({ ctx, methods, bridge, options = {} }) {
  const maxAttempts = options.attempts ?? 120
  const intervalMs = options.intervalMs ?? 1000
  const log = options.log ?? (() => {})
  const schedule = options.schedule ?? ((fn) => setTimeout(fn, intervalMs))
  const handler = async (endpoint, payload) => {
    const method = methods[endpoint]
    if (method === undefined) {
      return { ok: false, error: { code: 'E_NO_METHOD', message: `unknown endpoint: ${endpoint}`, details: {} } }
    }
    try {
      const value = await method(payload)
      return { ok: true, value }
    } catch (error) {
      return {
        ok: false,
        error: { code: 'E_METHOD', message: error instanceof Error ? error.message : String(error), details: {} },
      }
    }
  }
  let disposed = false
  let attempts = 0
  let timer = null
  let registered = []
  const disposeRegistered = () => {
    for (const dispose of registered) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    registered = []
  }
  const tryOnce = () => {
    if (disposed) return
    attempts += 1
    try {
      const connection = ctx.get('connection')
      if (connection === undefined || typeof connection?.rpc?.handle !== 'function') {
        throw new Error('connection service unavailable')
      }
      registered.push(connection.rpc.handle(RPC_CHANNEL, handler))
      if (typeof connection?.fetch?.register === 'function') {
        registered.push(
          connection.fetch.register({
            path: ARTIFACT_ROUTE,
            methods: ['GET'],
            requestBody: 'buffered',
            fetch: async (request) => {
              const url = new URL(request.url)
              const outcome = bridge.readArtifactBytes(url.searchParams)
              if (outcome.error !== undefined) {
                return new Response(JSON.stringify({ error: outcome.error }), {
                  status: 404,
                  headers: { 'content-type': 'application/json' },
                })
              }
              return new Response(new Uint8Array(outcome.bytes), {
                status: 200,
                headers: { 'content-type': outcome.contentType, 'cache-control': 'no-store' },
              })
            },
          }),
        )
      }
      log(`panel channel ${RPC_CHANNEL} ready (attempts=${attempts})`)
    } catch (error) {
      disposeRegistered()
      if (attempts < maxAttempts) {
        timer = schedule(tryOnce, intervalMs)
        return
      }
      log(`panel channel unavailable after ${attempts} attempts: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  tryOnce()
  return [
    () => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      disposeRegistered()
    },
  ]
}
