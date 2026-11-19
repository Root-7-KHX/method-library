/**
 * API 层自测：搜不到清单的两个路由，以及「关掉的会话」在面板接口上的边界。
 * 用假的 webServer 直接把请求喂进 handler，不真开端口。
 * 用法：<node> test/api-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHub } from '../lib/hub.js'
import { registerApi } from '../lib/api.js'

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error && error.message ? error.message : String(error) })
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败')
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error((message || '不相等') + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
}

const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-api-'))
const hub = createHub({ pluginDir, config: {}, getService: () => undefined })
hub.init()

// 假 webServer：把注册的 handler 拿在手里，后面直接喂请求
// register 收的是 { kind, path, handler } 对象（不是函数），这里按真实形状取。
let handler = null
let registeredPath = ''
const fakeCtx = {
  get: (name) => (name === 'webServer'
    ? {
        register: (options) => {
          handler = options.handler
          registeredPath = options.path
          return () => {}
        },
      }
    : undefined),
}
registerApi(fakeCtx, hub)
assert(typeof handler === 'function', 'registerApi 应该注册一个 handler')
assert(registeredPath.startsWith('/'), '注册路径应该是个前缀，实际：' + registeredPath)
const API_PREFIX = registeredPath

/**
 * 模拟一次请求；返回 { status, json }
 * api.js 的 sendJson 是 `response.statusCode = ...; response.setHeader(...); response.end(...)`，
 * readBody 是 `request.on('data'/'end')` 的写法（真 EventEmitter），所以这里都按真实形状来假。
 */
async function call(method, pathname, body, remoteAddress = '127.0.0.1') {
  const url = new URL(pathname, 'http://127.0.0.1')
  const listeners = new Map()
  const request = {
    method,
    url: url.pathname + url.search,
    socket: { remoteAddress },
    headers: { host: remoteAddress },
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return request
    },
    destroy: () => {},
  }
  const emit = (event, arg) => {
    for (const fn of listeners.get(event) || []) fn(arg)
  }

  let payload = null
  let status = 0
  // handler 内部是 `void handle(...)`，不返回 Promise，所以只能等 response.end 来收尾。
  let settle = null
  const finished = new Promise((resolve) => { settle = resolve })
  const response = {
    set statusCode(value) { status = value },
    get statusCode() { return status },
    setHeader: () => {},
    end: (chunk) => {
      try {
        payload = chunk ? JSON.parse(String(chunk)) : null
      } catch {
        payload = String(chunk)
      }
      settle()
    },
  }
  handler(request, response)
  // 请求体在 handler 挂完监听之后再喂，否则 'data' 事件没人接
  queueMicrotask(() => {
    if (body !== undefined) emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    emit('end')
  })
  await finished
  return { status, json: payload }
}

hub.setEnabled('sess-on', true)
hub.engineFor('sess-on').save({
  name: '清理临时文件',
  intent: '批量删掉 N 天前的 .tmp',
  kind: 'playbook',
  steps: '1. 找\n2. 删',
})

// ── 搜不到清单 ──────────────────────────────────────────────────────────
hub.engineFor('sess-on').search('给鱼缸换水') // 触发一次捕获

await check('GET /misses 能拿到捕获清单', async () => {
  const res = await call('GET', '/method-library/api/misses?session=sess-on')
  eq(res.status, 200)
  assert(Array.isArray(res.json.items), '应返回 items 数组')
  assert(res.json.items.some((item) => item.query === '给鱼缸换水'), '应包含刚才搜不到的那条')
})

let createdId = ''
await check('POST /miss 能一键转成草稿', async () => {
  const res = await call('POST', '/method-library/api/miss', { query: '给鱼缸换水', session: 'sess-on' })
  eq(res.status, 200)
  assert(res.json.id, '应返回新方法 id')
  createdId = res.json.id
  const detail = await call('GET', '/method-library/api/method?id=' + createdId + '&session=sess-on')
  eq(detail.json.method.name, '给鱼缸换水')
  eq(detail.json.method.status, 'draft')
})

await check('转完之后清单里就没有这条了', async () => {
  const res = await call('GET', '/method-library/api/misses?session=sess-on')
  assert(!res.json.items.some((item) => item.query === '给鱼缸换水'), '处理过的应从清单消失')
})

await check('POST /miss 带 discard 只丢弃、不建方法', async () => {
  hub.engineFor('sess-on').search('纯噪声查询词')
  const before = (await call('GET', '/method-library/api/misses?session=sess-on')).json.total
  const res = await call('POST', '/method-library/api/miss', { query: '纯噪声查询词', discard: true, session: 'sess-on' })
  eq(res.json.discarded, true)
  assert(!res.json.id, '丢弃不该生成方法')
  const after = (await call('GET', '/method-library/api/misses?session=sess-on')).json.total
  eq(after, before - 1)
})

// ── 开关边界 ────────────────────────────────────────────────────────────
// 注意：面板接口的 /search 走 peekEngine，是「只读浏览」——用户主动切到关着的会话也能看库内容。
// AI 侧（tools.js）才做硬拦，那条由 test/p2-test.mjs 覆盖，这里只钉住面板这边的边界。
await check('关掉的会话：面板 /search 仍可只读浏览', async () => {
  const res = await call('GET', '/method-library/api/search?q=清理&session=sess-closed')
  eq(res.status, 200, '面板只读搜索不该被开关拦住')
  assert(Array.isArray(res.json.items), '应返回 items')
})

let closedMethodId = ''
await check('关掉的会话：面板只读 /method 仍能看', async () => {
  hub.setEnabled('sess-closed', true)
  closedMethodId = hub.engineFor('sess-closed').save({ name: '关掉前存的', intent: '测试', kind: 'playbook', steps: '1. 做' }).id
  hub.setEnabled('sess-closed', false)
  const res = await call('GET', '/method-library/api/method?id=' + closedMethodId + '&session=sess-closed')
  eq(res.status, 200, '面板只读浏览不该被开关拦住')
  eq(res.json.method.name, '关掉前存的')
})

await check('写操作仍然被开关拦住', async () => {
  const res = await call('POST', '/method-library/api/save', {
    session: 'sess-closed',
    card: { name: '偷偷写', intent: 'x', kind: 'playbook', steps: '1. a' },
  })
  assert(res.status >= 400, '关掉的会话不该能写，实际状态码 ' + res.status)
})

await check('开着但有自己库的会话：搜索只返回自己库里的', async () => {
  hub.setEnabled('sess-own', true)
  hub.setSessionDir('sess-own', path.join(pluginDir, 'own-library'))
  hub.engineFor('sess-own').save({ name: '自己的方法', intent: '独占', kind: 'playbook', steps: '1. 做' })
  const res = await call('GET', '/method-library/api/search?q=方法&session=sess-own')
  eq(res.status, 200)
  assert(res.json.items.every((item) => item.name !== '清理临时文件'), '不该看到别的库的方法，实际：' + res.json.items.map((i) => i.name).join('、'))
  assert(res.json.items.some((item) => item.name === '自己的方法'), '应看到自己库里的')
})

await check('非本机请求被拒绝', async () => {
  const res = await call('GET', '/method-library/api/overview', undefined, '8.8.8.8')
  eq(res.status, 403, '外网来源应被拒')
})

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log((item.ok ? 'PASS ' : 'FAIL ') + item.name + (item.ok ? '' : ' -> ' + item.error))
}
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过')
try {
  fs.rmSync(pluginDir, { recursive: true, force: true })
} catch {
  // 忽略
}
process.exit(failed.length === 0 ? 0 : 1)
