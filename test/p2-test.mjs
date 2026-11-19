/**
 * P2 自测：口语近义扩展（近似语义检索）+ 搜不到自动捕获 + 关闭会话硬拦。
 * 用法：<node> test/p2-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEngine } from '../lib/engine.js'
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

const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-p2-'))
const engine = createEngine({ pluginDir, config: {}, fixedLibraryDir: '' })
engine.reload()

// 建三条方法：故意用和查询不一样的说话方式，测扩展能不能拐过去
const one = engine.save({
  name: '清理临时文件',
  intent: '当工作区临时文件堆积、需要批量删掉 N 天前的 .tmp 时用',
  kind: 'script',
  script: { code: 'Write-Output "cleaned"', runtime: 'pwsh' },
  tags: ['文件'],
})
const two = engine.save({
  name: '打标签发布',
  intent: '给插件升版本、打 tag 并发布到仓库',
  kind: 'playbook',
  steps: '1. 升版本号\n2. git tag\n3. push',
  tags: ['发布'],
})
engine.save({ name: '读天气', intent: '查今天天气', kind: 'playbook', steps: '1. 看天气' })

check('基线：原词能搜到', () => {
  const hit = engine.search('清理临时文件')
  assert(hit.items.length > 0, '应该搜得到')
  eq(hit.items[0].id, one.id, '最相关的那条要排第一')
})

check('语义扩展：口语换说法也能搜到（删垃圾 -> 清理临时文件）', () => {
  const hit = engine.search('把垃圾文件删了')
  assert(hit.items.length > 0, '换说法也应该搜得到，实际一条没有')
  assert(hit.items.some((item) => item.id === one.id), '应命中「清理临时文件」，实际命中：' + hit.items.map((i) => i.name).join('、'))
})

check('语义扩展：换说法发版（上线 -> 发布）', () => {
  const hit = engine.search('上线前要做的事')
  assert(hit.items.some((item) => item.id === two.id), '应命中「打标签发布」，实际命中：' + hit.items.map((i) => i.name).join('、'))
})

check('扩展不能把无关方法也捞上来（读天气不该命中删文件）', () => {
  const hit = engine.search('查天气')
  assert(hit.items.length > 0, '应该搜得到读天气')
  eq(hit.items[0].name, '读天气')
  assert(!hit.items.some((item) => item.id === one.id), '搜天气不该把「清理临时文件」也带出来')
})

check('搜不到时自动记一笔', () => {
  const before = engine.misses().total
  const hit = engine.search('给猫洗澡剪指甲')
  eq(hit.items.length, 0, '这条本来就不该搜到')
  const after = engine.misses().total
  eq(after, before + 1, '搜不到应该记一条，方便后面转草稿')
})

check('同一条查询重复搜不重复记，只累计次数', () => {
  const before = engine.misses().total
  engine.search('给猫洗澡剪指甲')
  engine.search('给猫洗澡剪指甲')
  eq(engine.misses().total, before, '同一条不该记成多条')
  const item = engine.misses().items.find((row) => row.query === '给猫洗澡剪指甲')
  assert(item && item.count >= 3, '应累计次数，实际：' + JSON.stringify(item && item.count))
})

check('太短的查询不算（避免噪声）', () => {
  const before = engine.misses().total
  engine.search('的')
  eq(engine.misses().total, before, '一个字不该记')
})

check('面板搜索不污染捕获清单（captureMiss:false）', () => {
  const before = engine.misses().total
  engine.search('完全不可能命中的东西啊', { captureMiss: false })
  eq(engine.misses().total, before, '面板手动试词不该记进捕获清单')
})

check('搜不到的记录能一键转成草稿方法', () => {
  const target = engine.misses().items.find((row) => row.query === '给猫洗澡剪指甲')
  assert(target, '应有这条记录')
  const result = engine.resolveMiss(target.query)
  eq(result.ok, true)
  assert(result.id, '应生成方法 id')
  const detail = engine.detail(result.id)
  eq(detail.method.status, 'draft', '生成的应该是草稿')
  assert(engine.misses().items.every((row) => row.query !== target.query), '转完之后该条要从清单里消失')
})

check('搜不到的记录也能直接丢弃', () => {
  engine.search('纯粹是噪声的查询语句')
  const result = engine.resolveMiss('纯粹是噪声的查询语句', { discard: true })
  eq(result.discarded, true)
  assert(engine.misses().items.every((row) => row.query !== '纯粹是噪声的查询语句'), '丢弃后不该还在清单里')
})

check('转草稿后，同样的查询这次能搜到', () => {
  engine.search('给狗修毛')
  const row = engine.misses().items.find((item) => item.query === '给狗修毛')
  assert(row, '应有捕获记录')
  engine.resolveMiss(row.query)
  // 转出来的是草稿，草稿默认不进检索结果（这是原本就有的规矩），要带上 includeDrafts 才看得到
  const hit = engine.search('给狗修毛', { includeDrafts: true })
  assert(hit.items.length > 0, '转成草稿后带上 includeDrafts 应该能搜到了')
})

// ── 关闭会话硬拦 ────────────────────────────────────────────────────────
const hub = createHub({ pluginDir, config: {}, getService: () => undefined })
hub.init()

check('关掉的会话拿不到引擎（requireEngine 抛错）', () => {
  let error = null
  try {
    hub.requireEngine('sess-closed')
  } catch (caught) {
    error = caught
  }
  assert(error, '关掉的会话应抛错')
  eq(error.code, 'SESSION_DISABLED')
})

check('但面板只读浏览仍能进去看（engineFor 不抛）', () => {
  const peek = hub.engineFor('sess-closed')
  assert(peek, '面板只读浏览要能拿到引擎，否则没法整理关掉的会话')
})

check('开启后 requireEngine 正常返回', () => {
  hub.setEnabled('sess-open', true)
  assert(hub.requireEngine('sess-open'), '开启后应能拿到引擎')
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
