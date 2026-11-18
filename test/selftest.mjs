/**
 * 离线自测：不启动 DSH，直接跑引擎（存储 / 检索 / 发货 / 记账 / 体检 / 迁移 / 导入导出）。
 * 用法：<node> test/selftest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEngine } from '../lib/engine.js'

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
function includes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) throw new Error((message || '缺少文本') + '：' + needle + '\n实际：' + haystack)
}

const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-test-'))
const engine = createEngine({ pluginDir, config: { searchLimit: 5 } })
const overview0 = engine.init()
eq(overview0.counts.total, 0, '初始应为空库')
assert(overview0.libraryDir.includes(pluginDir), '默认库目录应在插件目录内')
assert(fs.existsSync(path.join(overview0.libraryDir, 'methods.json')), '应生成 methods.json')
assert(fs.existsSync(path.join(overview0.libraryDir, 'scripts')), '应生成 scripts/')

// ── 建两条方法 ──────────────────────────────────────────────────────────
const playbook = engine.save(
  {
    name: '给 DSH 插件打包并发布',
    intent: '当插件改完、需要发一个新版本给用户时用：改版本号、打包、打 tag、上传 GitHub release',
    kind: 'playbook',
    aliases: ['发版', '发布插件', 'publish plugin'],
    tags: ['发布', '插件'],
    risk: 'medium',
    params: [{ name: 'version', type: 'string', required: true, desc: '新版本号，例如 1.3.2' }],
    steps: '1. 改 package.json 的 version\n2. 跑 build-dist.mjs\n3. git tag v{{version}}\n4. gh release create',
  },
  { by: 'ai' },
)
eq(playbook.created, true)

const script = engine.save(
  {
    name: '清理 7 天前的临时文件',
    intent: '当工作区临时文件堆积、需要批量删掉 N 天前的 .tmp/.log 时使用',
    kind: 'script',
    aliases: ['清临时文件', '清缓存'],
    tags: ['文件', '清理'],
    risk: 'high',
    params: [
      { name: 'dir', type: 'path', required: true, default: pluginDir, desc: '目标目录' },
      { name: 'days', type: 'number', required: false, default: 7, desc: '保留天数' },
    ],
    script: {
      runtime: 'pwsh',
      code: 'Get-ChildItem -Path $dir | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$days) } | Remove-Item -Force',
      expect: '输出 deleted N files',
    },
  },
  { by: 'ai' },
)
eq(script.created, true)
assert(script.method.scriptPath.startsWith('scripts/'), '脚本应落在 scripts/ 下')
assert(fs.existsSync(path.join(overview0.libraryDir, script.method.scriptPath)), '脚本文件应真的存在')

check('.ps1 脚本写成 UTF-8 BOM（PowerShell 5.1 读中文不乱码）', () => {
  const abs = path.join(overview0.libraryDir, script.method.scriptPath)
  const bytes = fs.readFileSync(abs)
  eq(bytes[0], 0xef, '第 1 字节')
  eq(bytes[1], 0xbb, '第 2 字节')
  eq(bytes[2], 0xbf, '第 3 字节')
  const text = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')
  assert(!text.startsWith('\uFEFF'), '去 BOM 后不应还有 BOM')
})

// ── 检索 ───────────────────────────────────────────────────────────────
check('中文口语能搜到（清缓存）', () => {
  const result = engine.search('清缓存')
  assert(result.items.length > 0, '应命中')
  eq(result.items[0].id, script.id)
})
check('意图描述能搜到（发版本）', () => {
  const result = engine.search('发一个新版本')
  assert(result.items.length > 0, '应命中')
  eq(result.items[0].id, playbook.id)
})
check('空查询返回最近使用', () => {
  const result = engine.search('', { limit: 10 })
  eq(result.items.length, 2)
})
check('完全无关的词不应命中', () => {
  const result = engine.search('量子纠缠光谱仪')
  eq(result.items.length, 0)
})

// ── 发货 ───────────────────────────────────────────────────────────────
check('script 型拼出可执行命令', () => {
  const payload = engine.preview(script.id, { dir: 'C:\\temp', days: 3 })
  eq(payload.kind, 'script')
  includes(payload.command, '-NoProfile')
  includes(payload.command, '-ExecutionPolicy Bypass')
  includes(payload.command, '-File')
  includes(payload.command, '.ps1')
  includes(payload.command, 'C:\\temp')
  includes(payload.command, '-days 3')
  assert(/pwsh|powershell/i.test(payload.command), '命令应指向 pwsh 或 powershell：' + payload.command)
  assert(payload.cwd === '', 'cwd 未配置时应为空')
  includes(payload.next, 'method_report')
})
check('必填参数缺失时报错并说明缺什么', () => {
  let error = null
  try {
    engine.preview(playbook.id, {})
  } catch (caught) {
    error = caught
  }
  assert(error, '应抛错')
  includes(error.message, 'version')
  eq(error.code, 'MISSING_PARAMS')
})
check('playbook 型返回步骤', () => {
  const payload = engine.preview(playbook.id, { version: '1.3.2' })
  eq(payload.kind, 'playbook')
  includes(payload.steps, 'build-dist.mjs')
})

// ── 记账 ───────────────────────────────────────────────────────────────
check('成功回报累加成功率', () => {
  engine.report(script.id, { ok: true, note: '删了 12 个' })
  const method = engine.overview().methods.find((item) => item.id === script.id)
  eq(method.uses, 1, '成功 preview 一次应记 1 次使用')
  eq(method.okRate, 1)
})
check('失败回报写进体检并给修复建议', () => {
  const result = engine.report(script.id, { ok: false, note: '路径不存在', problem: 'C:\\temp 不在' })
  includes(result.message, '执行失败')
  includes(result.message, 'method_save')
  const method = engine.overview().methods.find((item) => item.id === script.id)
  assert(method.health.state !== 'ok', '体检应提示有问题')
})
check('带 patch 回报会改好方法并升版本', () => {
  const before = engine.overview().methods.find((item) => item.id === script.id).version
  const result = engine.report(script.id, {
    ok: true,
    patch: { params: [{ name: 'dir', type: 'path', required: true, default: pluginDir, desc: '目标目录' }, { name: 'days', type: 'number', default: 14, desc: '保留天数' }] },
  })
  eq(result.version, before + 1)
  const detail = engine.detail(script.id)
  const days = detail.method.params.find((param) => param.name === 'days')
  eq(days.default, 14)
  assert(fs.readdirSync(path.join(overview0.libraryDir, 'archive')).length >= 1, '旧版本应留快照')
})

// ── 体检 ───────────────────────────────────────────────────────────────
check('脚本被删掉后体检为 broken', () => {
  const abs = path.join(overview0.libraryDir, script.method.scriptPath)
  fs.unlinkSync(abs)
  const method = engine.overview().methods.find((item) => item.id === script.id)
  eq(method.health.state, 'broken')
  includes(method.health.issues.join('；'), '脚本文件不存在')
})

// ── 归档 / 恢复 ────────────────────────────────────────────────────────
check('归档后搜不到，恢复后能搜到', () => {
  engine.archive(playbook.id)
  eq(engine.search('发版本').items.length, 0)
  engine.restore(playbook.id)
  assert(engine.search('发版本').items.length > 0)
})

// ── 导入导出 ───────────────────────────────────────────────────────────
check('导出再导进空库', () => {
  const exported = engine.exportData()
  eq(exported.methods.length, 2)
  const pluginDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-test2-'))
  const engine2 = createEngine({ pluginDir: pluginDir2, config: {} })
  engine2.init()
  const result = engine2.importData(exported)
  assert(result.created + result.updated === 2, '应导入 2 条，实际：' + JSON.stringify(result))
  eq(engine2.overview().counts.total, 2)
})

// ── 迁移库目录 ─────────────────────────────────────────────────────────
check('改库目录会搬数据', () => {
  const target = path.join(pluginDir, 'moved-library')
  const next = engine.setLibraryDir(target)
  eq(path.resolve(next.libraryDir), path.resolve(target))
  assert(fs.existsSync(path.join(target, 'methods.json')), '数据应被搬过去')
  eq(engine.overview().counts.total, 2)
  assert(engine.search('发版本').items.length > 0, '迁移后还能搜')
})

// ── 汇总 ───────────────────────────────────────────────────────────────
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
