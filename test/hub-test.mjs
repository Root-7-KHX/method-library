/**
 * 会话层自测：会话开关、按会话库目录、按目录缓存引擎、跟随全局。
 * 用法：<node> test/hub-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHub } from '../lib/hub.js'

const results = []
function check(name, fn) {
  try {
    fn()
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
function norm(value) {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase()
}

const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-hub-'))
const hub = createHub({ pluginDir, config: {}, getService: () => undefined })
hub.init()

check('默认所有会话都关闭（新对话要手动打开）', () => {
  eq(hub.isEnabled('sess-a'), false)
  eq(hub.isEnabled('sess-b'), false)
  eq(hub.isEnabled(''), false)
})

check('默认配置可以改成 true', () => {
  const other = createHub({ pluginDir, config: { defaultSessionEnabled: true }, getService: () => undefined })
  other.init()
  eq(other.isEnabled('sess-x'), true)
})

check('手动开启后可用、再关掉又不可用', () => {
  hub.setEnabled('sess-a', true)
  eq(hub.isEnabled('sess-a'), true)
  assert(hub.requireEngine('sess-a'), '开启后应能拿到引擎')
  hub.setEnabled('sess-a', false)
  eq(hub.isEnabled('sess-a'), false)
  let error = null
  try {
    hub.requireEngine('sess-a')
  } catch (caught) {
    error = caught
  }
  assert(error, '关掉后应抛错')
  eq(error.code, 'SESSION_DISABLED')
  hub.setEnabled('sess-a', true)
  assert(hub.requireEngine('sess-a'), '重新开启后应能拿到引擎')
})

check('没单独指定目录时跟随全局', () => {
  const overview = hub.overviewFor('sess-a')
  eq(overview.usingSessionLibrary, false)
  eq(norm(overview.effectiveLibraryDir), norm(hub.globalDir()))
})

check('全局库写一条方法', () => {
  const result = hub.engineFor('sess-a').save({ name: '全局方法', intent: '测试用', kind: 'playbook', steps: '1. 做' })
  eq(result.created, true)
  eq(hub.overviewFor('sess-a').counts.total, 1)
})

check('给会话单独指定库目录会自动复制一份', () => {
  const target = path.join(pluginDir, 'sess-b-library')
  const result = hub.setSessionDir('sess-b', target, { seed: true })
  eq(norm(result.effectiveLibraryDir), norm(target))
  const overview = hub.overviewFor('sess-b')
  eq(overview.usingSessionLibrary, true)
  eq(overview.counts.total, 1, '种子复制应带上原有方法')
  assert(fs.existsSync(path.join(target, 'methods.json')), '目标目录应有 methods.json')
})

check('两个会话的库互相独立', () => {
  hub.engineFor('sess-b').save({ name: 'B 库专用', intent: '只在 B', kind: 'playbook', steps: '1. 做' })
  eq(hub.overviewFor('sess-b').counts.total, 2)
  eq(hub.overviewFor('sess-a').counts.total, 1, '全局库不应被 B 库影响')
  assert(hub.globalDir() !== hub.effectiveDir('sess-b'), 'B 的库目录应不同于全局')
})

check('同一目录的会话共用同一个引擎实例', () => {
  const a = hub.engineFor('sess-a')
  const b = hub.engineFor('sess-c')
  assert(a === b, '没单独目录的会话应共用一个引擎')
})

check('关一个不能影响别的会话', () => {
  hub.setEnabled('sess-b', true)
  hub.setEnabled('sess-a', false)
  eq(hub.isEnabled('sess-a'), false)
  eq(hub.isEnabled('sess-b'), true, '关一个不能影响别的会话')
})

check('会话目录可以改回跟随全局', () => {
  hub.setSessionDir('sess-b', '')
  eq(hub.overviewFor('sess-b').usingSessionLibrary, false)
  eq(norm(hub.effectiveDir('sess-b')), norm(hub.globalDir()))
})

check('切换全局目录后，跟随的会话会跟着走', () => {
  const nextGlobal = path.join(pluginDir, 'global-library-2')
  hub.setGlobalDir(nextGlobal)
  eq(norm(hub.globalDir()), norm(nextGlobal))
  eq(norm(hub.effectiveDir('sess-a')), norm(nextGlobal))
  assert(fs.existsSync(path.join(nextGlobal, 'methods.json')), '全局数据应被搬过去')
  eq(hub.overviewFor('sess-a').counts.total, 1, '搬迁后数据还在')
})

check('会话注册表落盘可重载', () => {
  hub.setEnabled('sess-a', true)
  hub.setSessionDir('sess-b', path.join(pluginDir, 'sess-b-library'))
  const reloaded = createHub({ pluginDir, config: {}, getService: () => undefined })
  reloaded.init()
  eq(reloaded.isEnabled('sess-a'), true, '开启状态要保留')
  eq(reloaded.isEnabled('sess-b'), true, '之前显式开过的 sess-b 也要保留')
  eq(reloaded.isEnabled('sess-z'), false, '从没设置过的会话默认关')
  eq(reloaded.overviewFor('sess-b').usingSessionLibrary, true)
})

check('listSessions 在没有 sessionQuery 时也不炸', () => {
  const promise = hub.listSessions()
  assert(promise && typeof promise.then === 'function', '应返回 Promise')
  promise.catch(() => {})
})

await Promise.all(results.map((item) => Promise.resolve()))
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
