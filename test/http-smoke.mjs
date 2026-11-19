/**
 * 真 HTTP 冒烟：起一个真 server，按真实 socket 打 /misses、/miss、/search。
 * 上面 api-test.mjs 是「假 request/response」测逻辑，这里补一层「真能跑通」。
 * 用法：<node> test/http-smoke.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
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

const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-http-'))
const hub = createHub({ pluginDir, config: {}, getService: () => undefined })
hub.init()
hub.setEnabled('sess-1', true)
hub.engineFor('sess-1').save({ name: '清理临时文件', intent: '删 .tmp', kind: 'playbook', steps: '1. 找\n2. 删' })
hub.engineFor('sess-1').search('给鱼缸换水')

// 真 webServer：把注册的前缀接到真 http.Server 上
let dispose = null
const server = http.createServer((req, res) => {
  const prefix = '/method-library/api'
  if (!req.url.startsWith(prefix)) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  registered.handler(req, res)
})
const registered = {}
const fakeCtx = {
  get: (name) => (name === 'webServer'
    ? { register: (options) => { Object.assign(registered, options); return () => {} } }
    : undefined),
}
dispose = registerApi(fakeCtx, hub)

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = 'http://127.0.0.1:' + port + '/method-library/api'

async function get(url) {
  const response = await fetch(url)
  return { status: response.status, json: await response.json() }
}
async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

await check('真 HTTP：GET /misses', async () => {
  const res = await get(base + '/misses?session=sess-1')
  eq(res.status, 200)
  assert(res.json.items.some((item) => item.query === '给鱼缸换水'), '应含刚才搜空的那条')
})

await check('真 HTTP：GET /search', async () => {
  const res = await get(base + '/search?q=' + encodeURIComponent('清理') + '&session=sess-1')
  eq(res.status, 200)
  assert(res.json.items.some((item) => item.name === '清理临时文件'), '应搜到清理临时文件')
})

await check('真 HTTP：POST /miss 转草稿', async () => {
  const res = await post(base + '/miss', { query: '给鱼缸换水', session: 'sess-1' })
  eq(res.status, 200)
  assert(res.json.id, '应返回方法 id')
})

await check('真 HTTP：中文请求体不乱码', async () => {
  const res = await post(base + '/miss', { query: '腌笃鲜怎么做', discard: true, session: 'sess-1' })
  eq(res.status, 200)
  eq(res.json.discarded, true)
})

await check('真 HTTP：未知路由 404', async () => {
  const res = await get(base + '/nope')
  eq(res.status, 404)
})

await check('真 HTTP：GET /overview 正常', async () => {
  const res = await get(base + '/overview?session=sess-1')
  eq(res.status, 200)
  assert(typeof res.json.libraryDir === 'string' && res.json.libraryDir, 'overview 应带 libraryDir')
  assert(res.json.counts && typeof res.json.counts.total === 'number', 'overview 应带 counts.total')
})

server.close()
if (typeof dispose === 'function') dispose()

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
