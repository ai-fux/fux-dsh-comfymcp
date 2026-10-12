/**
 * 环回控制端点（loopback control endpoint）。
 *
 * 为什么需要它：静态挂载进 DSH profile 的插件拿不到宿主侧 connection RPC
 * （`ctx.get('connection')` 或其 `webServer` 挂载在 include 树就绪前不可达，
 * dsh 0.1.5-rc.1 实测），设置页因此读不到配置、保存失败。本端点由插件自己
 * 监听 127.0.0.1 随机/指定端口，浏览器半区直接 HTTP 访问，与 connection RPC
 * 共用同一份方法映射（createRpcMethods 的产物）。
 *
 * 安全模型（对齐 dsh-comfyui 的同位实现）：
 * - 只绑定 127.0.0.1；
 * - CORS 仅回显环回 Origin（Vary: Origin）；
 * - 要求自定义头 `x-dsh-comfymcp`（强制跨源预检）；
 * - 拒绝 `Sec-Fetch-Site: cross-site`；
 * - 可选令牌头 `x-dsh-comfymcp-token`（controlToken 配置非空时强制）；
 * - GET /artifact（产物字节流）供 <img>/下载直连：无自定义头，但要求
 *   `token` 查询参数与 controlToken 一致（未配置令牌时仅受环回绑定保护）。
 */
import { createServer } from 'node:http'

export const DEFAULT_CONTROL_HOST = '127.0.0.1'
export const DEFAULT_CONTROL_PORT = 18801
export const CONTROL_PORT_WINDOW = 10
export const CONTROL_MARKER_HEADER = 'x-dsh-comfymcp'
export const CONTROL_TOKEN_HEADER = 'x-dsh-comfymcp-token'

/** Loopback origins only: the endpoint binds 127.0.0.1, so a page served from a
 * non-loopback origin has no legitimate path here anyway. */
export function isLoopbackOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return false
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]')
  )
}

function sendJson(response, status, payload, origin) {
  const body = JSON.stringify(payload)
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (origin !== undefined) {
    headers['access-control-allow-origin'] = origin
    headers['vary'] = 'Origin'
  }
  response.writeHead(status, headers)
  response.end(body)
}

function sendBytes(response, status, bytes, contentType, token) {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': String(bytes.byteLength),
    'cache-control': 'no-store',
    ...(token !== undefined && token.length > 0 ? {} : {}),
  })
  response.end(bytes)
}

/**
 * @param options { methods, port, portWindow, token, host, version, log }
 *   methods: { status(): Promise, configRead(): Promise, configWrite(patch): Promise,
 *              artifact(searchParams): { bytes, contentType } | { error } }
 * @returns { start(): Promise<{port,url}>, close(): void, url: string|null }
 */
export function createControlServer(options = {}) {
  const methods = options.methods
  const logger = options.logger ?? console
  const host = options.host ?? DEFAULT_CONTROL_HOST
  const requestedPort = options.port ?? DEFAULT_CONTROL_PORT
  const portWindow = options.portWindow ?? CONTROL_PORT_WINDOW
  const token = options.token ?? ''
  const version = options.version ?? '0.0.0'
  const log = options.log ?? (() => {})

  let server = null
  let actualPort = 0
  let closing = false

  const ports = requestedPort > 0
    ? Array.from({ length: portWindow }, (_, index) => requestedPort + index)
    : [0]

  async function start() {
    if (server !== null) return { port: actualPort, url: `http://${host}:${actualPort}` }
    let lastError = null
    for (const port of ports) {
      const attempt = await new Promise((resolve) => {
        const candidate = createServer((request, response) => {
          handle(request, response).catch((error) => {
            logger.error?.(`[dsh-comfymcp] control endpoint error: ${error instanceof Error ? error.message : String(error)}`)
            if (!response.headersSent) sendJson(response, 500, { ok: false, error: { code: 'internal', message: 'internal error' } }, undefined)
            else response.destroy()
          })
        })
        candidate.once('error', (error) => resolve({ error }))
        candidate.listen(port, host, () => resolve({ server: candidate, port: candidate.address().port }))
      })
      if (attempt.error !== undefined) {
        lastError = attempt.error
        continue
      }
      server = attempt.server
      actualPort = attempt.port
      log(`control endpoint listening at http://${host}:${actualPort}`)
      return { port: actualPort, url: `http://${host}:${actualPort}` }
    }
    throw lastError instanceof Error ? lastError : new Error('control endpoint: no port available')
  }

  function close() {
    closing = true
    if (server !== null) {
      server.close()
      server = null
      actualPort = 0
    }
  }

  function guard(request, response) {
    const origin = request.headers.origin
    const allowedOrigin = isLoopbackOrigin(origin) ? origin : undefined
    if (origin !== undefined && allowedOrigin === undefined) {
      sendJson(response, 403, { ok: false, error: { code: 'origin_forbidden', message: `origin "${origin}" is not allowed` } }, undefined)
      return { handled: true }
    }
    const fetchSite = String(request.headers['sec-fetch-site'] ?? '')
    if (fetchSite === 'cross-site') {
      sendJson(response, 403, { ok: false, error: { code: 'cross_site_forbidden', message: 'cross-site requests are not accepted' } }, allowedOrigin)
      return { handled: true }
    }
    if (request.method === 'OPTIONS') {
      // 预检请求不携带自定义头（这正是预检的意义），必须在 marker/token 检查之前响应
      if (allowedOrigin === undefined) {
        sendJson(response, 403, { ok: false, error: { code: 'origin_forbidden', message: 'preflight requires a loopback origin' } }, undefined)
        return { handled: true }
      }
      response.writeHead(204, {
        'access-control-allow-origin': allowedOrigin,
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': `${CONTROL_MARKER_HEADER}, ${CONTROL_TOKEN_HEADER}, Content-Type`,
        'access-control-max-age': '600',
        vary: 'Origin',
      })
      response.end()
      return { handled: true }
    }
    if (request.headers[CONTROL_MARKER_HEADER] !== '1') {
      sendJson(response, 403, { ok: false, error: { code: 'marker_missing', message: `missing ${CONTROL_MARKER_HEADER} header` } }, allowedOrigin)
      return { handled: true }
    }
    if (token.length > 0 && request.headers[CONTROL_TOKEN_HEADER] !== token) {
      sendJson(response, 403, { ok: false, error: { code: 'token_invalid', message: 'control token is missing or wrong' } }, allowedOrigin)
      return { handled: true }
    }
    return { handled: false, origin: allowedOrigin }
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > 1_000_000) {
          reject(new Error('request body too large'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      request.on('error', reject)
    })
  }

  async function handle(request, response) {
    if (closing) {
      sendJson(response, 503, { ok: false, error: { code: 'closing', message: 'control endpoint is shutting down' } }, undefined)
      return
    }
    const url = new URL(request.url ?? '/', `http://${host}`)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    // 产物字节流：<img>/下载直连，不能用自定义头；改用查询参数令牌。
    if (pathname === '/artifact' && request.method === 'GET') {
      if (token.length > 0 && url.searchParams.get('token') !== token) {
        sendJson(response, 403, { ok: false, error: { code: 'token_invalid', message: 'artifact token is missing or wrong' } }, undefined)
        return
      }
      const outcome = methods.artifact !== undefined ? methods.artifact(url.searchParams) : { error: 'artifact route unavailable' }
      if (outcome.error !== undefined) {
        sendJson(response, 404, { ok: false, error: { code: 'not_found', message: outcome.error } }, undefined)
        return
      }
      sendBytes(response, 200, outcome.bytes, outcome.contentType)
      return
    }

    // 工作台静态页面（/ui）：导航请求带不了自定义头，走查询令牌或放宽跨站。
    // 有令牌配置时令牌必须正确；未配置令牌时只放行非跨站导航（直开/同站），防任意网站嵌入探测。
    if ((pathname === '/ui' || pathname.startsWith('/ui/')) && request.method === 'GET') {
      const origin = request.headers.origin
      const allowedOrigin = isLoopbackOrigin(origin) ? origin : undefined
      if (origin !== undefined && allowedOrigin === undefined) {
        sendJson(response, 403, { ok: false, error: { code: 'origin_forbidden', message: `origin "${origin}" is not allowed` } }, undefined)
        return
      }
      const queryToken = url.searchParams.get('token') ?? ''
      const fetchSite = String(request.headers['sec-fetch-site'] ?? 'none')
      if (token.length > 0 && queryToken !== token) {
        sendJson(response, 403, { ok: false, error: { code: 'token_invalid', message: 'page token is missing or wrong' } }, allowedOrigin)
        return
      }
      if (token.length === 0 && fetchSite === 'cross-site') {
        sendJson(response, 403, { ok: false, error: { code: 'cross_site_forbidden', message: 'cross-site page embeds require the control token' } }, allowedOrigin)
        return
      }
      let outcome
      if (pathname === '/ui/artifacts') {
        outcome = methods.pageArtifacts !== undefined ? await methods.pageArtifacts({ token: queryToken }) : { error: 'artifacts page unavailable' }
      } else if (pathname.startsWith('/ui/wf/')) {
        const workflow = decodeURIComponent(pathname.slice('/ui/wf/'.length))
        outcome = methods.pageWorkflow !== undefined ? await methods.pageWorkflow(workflow, { token: queryToken }) : { error: 'workflow page unavailable' }
      } else {
        outcome = methods.pageIndex !== undefined ? await methods.pageIndex({ token: queryToken }) : { error: 'index page unavailable' }
      }
      if (outcome === null || outcome === undefined || outcome.error !== undefined) {
        sendJson(response, 404, { ok: false, error: { code: 'not_found', message: outcome?.error ?? 'page unavailable' } }, allowedOrigin)
        return
      }
      sendBytes(response, 200, Buffer.from(outcome.html, 'utf8'), 'text/html; charset=utf-8')
      return
    }

    const guardResult = guard(request, response)
    if (guardResult.handled) return
    const allowedOrigin = guardResult.origin

    if (pathname === '/health' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, value: { plugin: 'dsh-comfymcp-client', version, port: actualPort } }, allowedOrigin)
      return
    }
    if (pathname === '/status' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, value: await methods.status() }, allowedOrigin)
      return
    }
    if (pathname === '/config' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, value: await methods.configRead() }, allowedOrigin)
      return
    }
    if (pathname === '/set-config' && request.method === 'POST') {
      const contentType = String(request.headers['content-type'] ?? '')
      if (!contentType.includes('application/json')) {
        sendJson(response, 415, { ok: false, error: { code: 'unsupported_media_type', message: 'POST bodies must be application/json' } }, allowedOrigin)
        return
      }
      let payload
      try {
        payload = JSON.parse((await readBody(request)) || '{}')
      } catch {
        sendJson(response, 400, { ok: false, error: { code: 'invalid_json', message: 'request body is not valid JSON' } }, allowedOrigin)
        return
      }
      sendJson(response, 200, { ok: true, value: await methods.configWrite(payload) }, allowedOrigin)
      return
    }

    // 工作台页面 API（页面同源调用，走标准 guard：marker + 可选令牌头）
    const jsonBody = async () => {
      const contentType = String(request.headers['content-type'] ?? '')
      if (!contentType.includes('application/json')) return { error: 'POST bodies must be application/json' }
      try {
        return { payload: JSON.parse((await readBody(request)) || '{}') }
      } catch {
        return { error: 'request body is not valid JSON' }
      }
    }
    if (pathname === '/api/workflows' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, value: await methods.listWorkflows() }, allowedOrigin)
      return
    }
    if (pathname.startsWith('/api/wf/') && request.method === 'GET') {
      const workflow = decodeURIComponent(pathname.slice('/api/wf/'.length))
      const descriptor = await methods.getPage(workflow)
      if (descriptor === null || descriptor === undefined) {
        sendJson(response, 404, { ok: false, error: { code: 'not_found', message: `工作流 ${workflow} 没有页面描述符` } }, allowedOrigin)
        return
      }
      sendJson(response, 200, { ok: true, value: descriptor }, allowedOrigin)
      return
    }
    if (pathname === '/api/run' && request.method === 'POST') {
      const body = await jsonBody()
      if (body.error !== undefined) {
        sendJson(response, 400, { ok: false, error: { code: 'invalid_request', message: body.error } }, allowedOrigin)
        return
      }
      sendJson(response, 200, { ok: true, value: await methods.runPage(body.payload ?? {}) }, allowedOrigin)
      return
    }
    if (pathname === '/api/quick' && request.method === 'POST') {
      const body = await jsonBody()
      if (body.error !== undefined) {
        sendJson(response, 400, { ok: false, error: { code: 'invalid_request', message: body.error } }, allowedOrigin)
        return
      }
      sendJson(response, 200, { ok: true, value: await methods.quickRun(body.payload ?? {}) }, allowedOrigin)
      return
    }
    if (pathname === '/api/artifacts' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, value: await methods.listArtifacts() }, allowedOrigin)
      return
    }
    if (pathname === '/api/tags' && request.method === 'POST') {
      const body = await jsonBody()
      if (body.error !== undefined) {
        sendJson(response, 400, { ok: false, error: { code: 'invalid_request', message: body.error } }, allowedOrigin)
        return
      }
      try {
        const record = await methods.updateTags(body.payload ?? {})
        sendJson(response, 200, { ok: true, value: record }, allowedOrigin)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: { code: 'tag_rejected', message: error instanceof Error ? error.message : String(error) } }, allowedOrigin)
      }
      return
    }
    sendJson(response, 404, { ok: false, error: { code: 'no_route', message: `no route for ${request.method} ${pathname}` } }, allowedOrigin)
  }

  return { start, close, get url() { return actualPort > 0 ? `http://${host}:${actualPort}` : null } }
}
