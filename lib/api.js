/**
 * 面板用的 HTTP 接口：/method-library/api/*
 *
 * 只服务本地面板（同源、loopback），不执行任何命令，只读写库文件。
 * 所有读写都带 session：面板选中哪个会话，就读/写那个会话解析出来的库。
 * 路径前缀带 2~5 号备选：插件热重载时旧路由可能还占着，换一个前缀继续用，
 * 面板会依次探测哪个前缀是活的。
 */
const API_PREFIXES = ['/method-library/api', '/method-library/api2', '/method-library/api3', '/method-library/api4', '/method-library/api5']

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

function isLoopback(request) {
  const address = request.socket && request.socket.remoteAddress ? String(request.socket.remoteAddress) : ''
  if (address === '') return true
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === 'localhost'
}

function readBody(request, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

async function parseJsonBody(request) {
  const raw = await readBody(request)
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

export function registerApi(ctx, hub) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    return () => {}
  }

  const sessionOf = (url, body) => {
    const fromBody = body && typeof body.session === 'string' ? body.session.trim() : ''
    if (fromBody) return fromBody
    const fromQuery = url.searchParams.get('session') || ''
    return fromQuery.trim()
  }

  const engineOf = (sessionId) => (sessionId ? hub.engineFor(sessionId) : hub.globalEngine)

  async function handle(request, response, prefix) {
    if (!isLoopback(request)) {
      sendJson(response, 403, { ok: false, error: '只允许本机访问' })
      return
    }
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const route = url.pathname.slice(prefix.length).replace(/^\/+/, '') || 'overview'
    const method = (request.method || 'GET').toUpperCase()
    try {
      if (method === 'GET' && (route === 'overview' || route === '')) {
        sendJson(response, 200, hub.overviewFor(sessionOf(url, null)))
        return
      }
      if (method === 'GET' && route === 'sessions') {
        sendJson(response, 200, { ok: true, ...(await hub.listSessions()) })
        return
      }
      if (method === 'GET' && route === 'status') {
        sendJson(response, 200, { ok: true, ...hub.status() })
        return
      }
      if (method === 'GET' && route === 'method') {
        sendJson(response, 200, engineOf(sessionOf(url, null)).detail(url.searchParams.get('id') || ''))
        return
      }
      if (method === 'GET' && route === 'search') {
        const tags = (url.searchParams.get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean)
        const result = engineOf(sessionOf(url, null)).search(url.searchParams.get('q') || '', {
          tags,
          limit: Number(url.searchParams.get('limit') || 20),
          includeDrafts: url.searchParams.get('drafts') === '1',
          includeDisabled: url.searchParams.get('disabled') === '1',
        })
        sendJson(response, 200, { ok: true, ...result })
        return
      }
      if (method === 'GET' && route === 'versions') {
        sendJson(response, 200, { ok: true, versions: engineOf(sessionOf(url, null)).versions(url.searchParams.get('id') || '') })
        return
      }
      if (method === 'GET' && route === 'export') {
        const data = engineOf(sessionOf(url, null)).exportData()
        response.statusCode = 200
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.setHeader('content-disposition', 'attachment; filename="method-library-export.json"')
        response.end(JSON.stringify(data, null, 2))
        return
      }
      if (method === 'POST' && route === 'save') {
        const body = await parseJsonBody(request)
        sendJson(response, 200, engineOf(sessionOf(url, body)).save(body.card || body, { by: 'ui' }))
        return
      }
      if (method === 'POST' && route === 'archive') {
        const body = await parseJsonBody(request)
        sendJson(response, 200, engineOf(sessionOf(url, body)).archive(body.id))
        return
      }
      if (method === 'POST' && route === 'restore') {
        const body = await parseJsonBody(request)
        sendJson(response, 200, engineOf(sessionOf(url, body)).restore(body.id))
        return
      }
      if (method === 'POST' && route === 'preview') {
        const body = await parseJsonBody(request)
        sendJson(response, 200, { ok: true, payload: engineOf(sessionOf(url, body)).preview(body.id, body.args || {}) })
        return
      }
      if (method === 'POST' && route === 'rollback') {
        const body = await parseJsonBody(request)
        sendJson(response, 200, engineOf(sessionOf(url, body)).rollback(body.id, body.file))
        return
      }
      if (method === 'POST' && route === 'script') {
        const body = await parseJsonBody(request)
        sendJson(response, 200, engineOf(sessionOf(url, body)).writeScriptContent(body.id, body.content))
        return
      }
      if (method === 'POST' && route === 'import') {
        const body = await parseJsonBody(request)
        sendJson(response, 200, engineOf(sessionOf(url, body)).importData(body.data !== undefined ? body.data : body, { by: 'import' }))
        return
      }
      if (method === 'POST' && route === 'reload') {
        const body = await parseJsonBody(request)
        engineOf(sessionOf(url, body)).reload()
        sendJson(response, 200, hub.overviewFor(sessionOf(url, body)))
        return
      }
      if (method === 'POST' && route === 'settings') {
        // 全局默认库目录（没单独指定目录的会话都跟着走）
        const body = await parseJsonBody(request)
        hub.setGlobalDir(body.libraryDir)
        sendJson(response, 200, hub.overviewFor(sessionOf(url, body)))
        return
      }
      if (method === 'POST' && route === 'enable') {
        const body = await parseJsonBody(request)
        const sessionId = sessionOf(url, body)
        if (!sessionId) throw new Error('缺少会话 id')
        const result = hub.setEnabled(sessionId, body.enabled !== false)
        if (typeof hub.onSessionChanged === 'function') {
          try {
            hub.onSessionChanged(sessionId)
          } catch {
            // 让活着的会话立刻生效；失败不影响保存
          }
        }
        sendJson(response, 200, { ok: true, ...result, overview: hub.overviewFor(sessionId) })
        return
      }
      if (method === 'POST' && route === 'session-dir') {
        const body = await parseJsonBody(request)
        const sessionId = sessionOf(url, body)
        if (!sessionId) throw new Error('缺少会话 id')
        const result = hub.setSessionDir(sessionId, body.libraryDir || '', { seed: body.seed !== false })
        sendJson(response, 200, { ok: true, ...result, overview: hub.overviewFor(sessionId) })
        return
      }
      sendJson(response, 404, { ok: false, error: '没有这个接口：' + route })
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error && error.message ? error.message : String(error) })
    }
  }

  for (const prefix of API_PREFIXES) {
    try {
      const dispose = webServer.register({
        kind: 'prefix',
        path: prefix,
        handler: (request, response) => {
          void handle(request, response, prefix)
        },
      })
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // 忽略
        }
      }
    } catch {
      // 前缀被占用（热重载残留），试下一个
    }
  }
  return () => {}
}
