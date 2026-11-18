/**
 * 方法库核心引擎：纯文件存储 + BM25 检索 + 只读体检 + 命令拼装 + 记账。
 *
 * 设计约束（见方案 v0.3）：
 * - 插件零执行权：这里只拼命令 / 给步骤，绝不 spawn 进程。
 * - 库是纯文件：methods.json + scripts/ + logs/ + archive/，目录可自选。
 * - AI 自己执行、自己回报；体检只读文件，不跑任何东西。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export const KINDS = ['script', 'playbook', 'hybrid']
export const STATUSES = ['active', 'draft', 'disabled', 'archived']
export const RISKS = ['low', 'medium', 'high']
export const RUNTIMES = ['pwsh', 'bash', 'node', 'python']

const RUNTIME_EXT = { pwsh: '.ps1', bash: '.sh', node: '.mjs', python: '.py' }
const K1 = 1.2
const B = 0.75
const FIELD_WEIGHTS = { name: 3, alias: 2.5, intent: 1.5, tags: 1.2, body: 0.8 }
const STALE_MS = 90 * 24 * 3600 * 1000

function nowMs() {
  return Date.now()
}

function str(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function newId() {
  return 'm_' + randomBytes(4).toString('hex')
}

function normalizeText(value) {
  return str(value).toLowerCase().replace(/\s+/g, ' ').trim()
}

function looksLikePath(value) {
  const text = str(value).trim()
  if (text.length < 2 || text.length > 320) return false
  if (/^[A-Za-z]:[\\/]/.test(text)) return true
  if (/^\\\\[^\\]/.test(text)) return true
  if (text.startsWith('./') || text.startsWith('../') || text.startsWith('/')) return true
  return false
}

/** 中文用字 + 字 bigram，英文数字按词。 */
export function tokenize(text) {
  const out = []
  const lower = str(text).toLowerCase()
  const re = /[\u3400-\u9fff\uf900-\ufaff]+|[a-z0-9_]+/g
  let match
  while ((match = re.exec(lower)) !== null) {
    const chunk = match[0]
    if (/^[a-z0-9_]/.test(chunk)) {
      if (chunk.length >= 2) out.push({ term: chunk, w: 1 })
      continue
    }
    if (chunk.length === 1) {
      out.push({ term: chunk, w: 0.85 })
      continue
    }
    for (let i = 0; i < chunk.length; i += 1) {
      out.push({ term: chunk[i], w: 0.5 })
      if (i + 1 < chunk.length) out.push({ term: chunk.slice(i, i + 2), w: 1 })
    }
  }
  return out
}

function quoteArg(value) {
  const text = str(value)
  if (text === '') return '""'
  if (/^[A-Za-z0-9_\-.:\\/@=+%~]+$/.test(text)) return text
  return '"' + text.replace(/"/g, '\\"') + '"'
}

function substitute(template, values) {
  return str(template).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (all, key) => {
    const value = values[key]
    return value === undefined || value === null ? '' : str(value)
  })
}

function runtimeCmd(runtime) {
  if (runtime === 'pwsh') return 'pwsh'
  if (runtime === 'bash') return 'bash'
  if (runtime === 'node') return 'node'
  if (runtime === 'python') return 'python'
  return 'pwsh'
}

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile()
  } catch {
    return false
  }
}

function findOnPath(name) {
  const pathValue = str(process.env.PATH || process.env.Path || '')
  const exts = str(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
  for (const dir of pathValue.split(';')) {
    const base = dir.trim().replace(/^"|"$/g, '')
    if (!base) continue
    const direct = path.join(base, name)
    if (isExecutableFile(direct)) return direct
    for (const ext of exts) {
      if (!ext) continue
      const candidate = path.join(base, name + ext.toLowerCase())
      if (isExecutableFile(candidate)) return candidate
      const upper = path.join(base, name + ext.toUpperCase())
      if (isExecutableFile(upper)) return upper
    }
  }
  return ''
}

/**
 * 解析运行时：本机可能只有 Windows PowerShell 5.1（没有 pwsh 7），
 * 也可能 pwsh 装在 PATH 之外。这里按 PATH → 常见安装目录 → PS 5.1 兜底。
 */
function resolveRuntime(runtime) {
  const systemRoot = str(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows')
  if (runtime === 'pwsh') {
    const onPath = findOnPath('pwsh')
    if (onPath) return { exe: onPath, actual: 'pwsh', warnings: [] }
    const candidates = [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
      'C:\\Program Files\\PowerShell\\6\\pwsh.exe',
      path.join(systemRoot, 'Program Files', 'PowerShell', '7', 'pwsh.exe'),
    ]
    for (const candidate of candidates) {
      if (isExecutableFile(candidate)) return { exe: candidate, actual: 'pwsh', warnings: [] }
    }
    const legacy = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (isExecutableFile(legacy)) {
      return { exe: legacy, actual: 'powershell', warnings: ['本机没有 PowerShell 7（pwsh），已自动改用 Windows PowerShell 5.1'] }
    }
    return { exe: 'powershell', actual: 'powershell', warnings: ['没有找到 pwsh，按 Windows PowerShell 调用'] }
  }
  if (runtime === 'bash') {
    const onPath = findOnPath('bash')
    return { exe: onPath || 'bash', actual: 'bash', warnings: onPath ? [] : ['PATH 里没有 bash，命令可能跑不起来'] }
  }
  if (runtime === 'node') {
    const onPath = findOnPath('node')
    return { exe: onPath || 'node', actual: 'node', warnings: onPath ? [] : ['PATH 里没有 node，命令可能跑不起来'] }
  }
  if (runtime === 'python') {
    const onPath = findOnPath('python') || findOnPath('py')
    return { exe: onPath || 'python', actual: 'python', warnings: onPath ? [] : ['PATH 里没有 python，命令可能跑不起来'] }
  }
  return { exe: runtimeCmd(runtime), actual: runtime, warnings: [] }
}

function shellToken(exe) {
  if (exe.includes(' ')) return '& ' + quoteArg(exe)
  return quoteArg(exe)
}

export function createEngine({ pluginDir, config = {}, fixedLibraryDir = '' }) {
  const pluginDataDir = path.join(pluginDir, 'data')
  const settingsPath = path.join(pluginDataDir, 'settings.json')
  const fixedDir = str(fixedLibraryDir).trim() ? path.resolve(str(fixedLibraryDir).trim()) : ''

  const state = {
    methods: [],
    loadedAt: 0,
  }
  let index = null
  let healthCache = new Map()
  let apiBase = '/method-library/api'
  let loaded = false
  let lastError = ''
  let settings = readSettings()

  function readSettings() {
    try {
      if (!fs.existsSync(settingsPath)) return {}
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch {
      return {}
    }
  }

  function writeSettings(next) {
    settings = next
    try {
      fs.mkdirSync(pluginDataDir, { recursive: true })
      atomicWrite(settingsPath, JSON.stringify(next, null, 2))
    } catch (error) {
      // 设置写不进去不该让插件崩
      lastError = '设置保存失败：' + (error && error.message ? error.message : String(error))
    }
  }

  function defaultLibraryDir() {
    return path.join(pluginDataDir, 'library')
  }

  function libraryDir() {
    // 会话单独指定库目录时，这个引擎固定读写那个目录，不碰全局设置。
    if (fixedDir) return fixedDir
    const configured = str(config.libraryDir).trim()
    if (configured) return path.resolve(configured)
    const fromSettings = str(settings.libraryDir).trim()
    if (fromSettings) return path.resolve(fromSettings)
    return defaultLibraryDir()
  }

  function isFixedDir() {
    return fixedDir !== ''
  }

  function paths() {
    const root = libraryDir()
    return {
      root,
      methodsFile: path.join(root, 'methods.json'),
      scripts: path.join(root, 'scripts'),
      logs: path.join(root, 'logs'),
      archive: path.join(root, 'archive'),
      readme: path.join(root, 'README.txt'),
    }
  }

  function atomicWrite(file, text) {
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(3).toString('hex')
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
  }

  function ensureTree() {
    const p = paths()
    fs.mkdirSync(p.root, { recursive: true })
    fs.mkdirSync(p.scripts, { recursive: true })
    fs.mkdirSync(p.logs, { recursive: true })
    fs.mkdirSync(p.archive, { recursive: true })
    if (!fs.existsSync(p.readme)) {
      try {
        fs.writeFileSync(
          p.readme,
          [
            '这是 DSH「方法库」插件的数据目录。',
            '',
            'methods.json  方法卡片（建议用面板编辑，别手改坏了）',
            'scripts/      script 型方法引用的真实脚本文件，可以直接手改，改完面板里刷新即可',
            'logs/         使用与回报流水（usage.jsonl）',
            'archive/      软删除与历史版本快照，可恢复',
            '',
            '整个文件夹可以随便复制/备份/迁移；面板「设置」里能改库目录。',
          ].join('\r\n'),
          'utf8',
        )
      } catch {
        // 忽略
      }
    }
  }

  function emptyDoc() {
    return { version: 1, updatedAt: nowMs(), methods: [] }
  }

  function load() {
    ensureTree()
    const p = paths()
    let doc = null
    const missing = !fs.existsSync(p.methodsFile)
    if (!missing) {
      try {
        doc = JSON.parse(fs.readFileSync(p.methodsFile, 'utf8'))
      } catch {
        const bak = p.methodsFile + '.bak'
        try {
          doc = JSON.parse(fs.readFileSync(bak, 'utf8'))
          lastError = 'methods.json 解析失败，已回退到上一次备份（.bak）'
        } catch {
          const corrupt = p.methodsFile + '.corrupt-' + nowMs()
          try {
            fs.copyFileSync(p.methodsFile, corrupt)
          } catch {
            // 忽略
          }
          lastError = 'methods.json 损坏，已另存为 ' + path.basename(corrupt) + '，现在从空库开始'
          doc = emptyDoc()
        }
      }
    } else {
      doc = emptyDoc()
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.methods)) doc = emptyDoc()
    state.methods = doc.methods.map((item) => sanitizeLoaded(item)).filter(Boolean)
    state.loadedAt = nowMs()
    loaded = true
    healthCache = new Map()
    rebuildIndex()
    if (missing) {
      try {
        persist()
      } catch {
        // 首次建库失败不阻塞
      }
    }
    return state.methods.length
  }

  function sanitizeLoaded(raw) {
    if (!raw || typeof raw !== 'object') return null
    const method = { ...raw }
    method.id = str(method.id) || newId()
    method.name = str(method.name).trim() || '(未命名方法)'
    method.intent = str(method.intent)
    method.kind = KINDS.includes(method.kind) ? method.kind : 'playbook'
    method.aliases = Array.isArray(method.aliases) ? method.aliases.map(str).filter(Boolean) : []
    method.tags = Array.isArray(method.tags) ? method.tags.map(str).filter(Boolean) : []
    method.params = Array.isArray(method.params) ? method.params.map((p) => sanitizeParam(p)).filter(Boolean) : []
    method.examples = Array.isArray(method.examples) ? method.examples : []
    method.steps = str(method.steps)
    method.risk = RISKS.includes(method.risk) ? method.risk : 'medium'
    method.status = STATUSES.includes(method.status) ? method.status : 'active'
    method.version = clampInt(method.version, 1, 99999, 1)
    method.createdAt = Number(method.createdAt) || nowMs()
    method.updatedAt = Number(method.updatedAt) || method.createdAt
    method.script = method.script && typeof method.script === 'object' ? method.script : null
    method.stats = method.stats && typeof method.stats === 'object' ? method.stats : { uses: 0, ok: 0, fail: 0 }
    method.stats.uses = Number(method.stats.uses) || 0
    method.stats.ok = Number(method.stats.ok) || 0
    method.stats.fail = Number(method.stats.fail) || 0
    method.lastFailure = method.lastFailure && typeof method.lastFailure === 'object' ? method.lastFailure : null
    return method
  }

  function sanitizeParam(raw) {
    if (typeof raw === 'string') return { name: raw.trim(), type: 'string', required: false, default: undefined, desc: '' }
    if (!raw || typeof raw !== 'object') return null
    const name = str(raw.name).trim()
    if (!name) return null
    const type = ['string', 'number', 'path', 'bool', 'enum'].includes(raw.type) ? raw.type : 'string'
    return {
      name,
      type,
      required: raw.required === true,
      default: raw.default === undefined ? undefined : raw.default,
      desc: str(raw.desc),
      ...(type === 'enum' && Array.isArray(raw.options) ? { options: raw.options.map(str) } : {}),
    }
  }

  function persist() {
    const p = paths()
    ensureTree()
    const doc = { version: 1, updatedAt: nowMs(), methods: state.methods }
    const text = JSON.stringify(doc, null, 2)
    try {
      if (fs.existsSync(p.methodsFile)) fs.copyFileSync(p.methodsFile, p.methodsFile + '.bak')
    } catch {
      // 忽略备份失败
    }
    atomicWrite(p.methodsFile, text)
  }

  function usageLog(entry) {
    try {
      const p = paths()
      fs.mkdirSync(p.logs, { recursive: true })
      const file = path.join(p.logs, 'usage.jsonl')
      fs.appendFileSync(file, JSON.stringify({ at: nowMs(), ...entry }) + '\n', 'utf8')
      const size = fs.statSync(file).size
      if (size > 4 * 1024 * 1024) {
        try {
          fs.renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'))
        } catch {
          // 忽略
        }
      }
    } catch {
      // 日志失败不影响主流程
    }
  }

  // ── 索引（BM25）──────────────────────────────────────────────────────────
  function rebuildIndex() {
    const docs = []
    const df = new Map()
    for (const method of state.methods) {
      const fields = [
        [method.name, FIELD_WEIGHTS.name],
        [method.aliases.join(' '), FIELD_WEIGHTS.alias],
        [method.intent, FIELD_WEIGHTS.intent],
        [method.tags.join(' '), FIELD_WEIGHTS.tags],
        [[method.steps, method.script?.path, method.script?.expect, method.risk].filter(Boolean).join(' '), FIELD_WEIGHTS.body],
      ]
      const tf = new Map()
      let len = 0
      for (const [text, weight] of fields) {
        if (!text) continue
        for (const token of tokenize(text)) {
          tf.set(token.term, (tf.get(token.term) || 0) + weight * token.w)
        }
      }
      for (const value of tf.values()) len += value
      for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1)
      docs.push({ id: method.id, tf, len })
    }
    const total = docs.length
    const avg = total > 0 ? docs.reduce((sum, doc) => sum + doc.len, 0) / total : 0
    const byId = new Map(docs.map((doc) => [doc.id, doc]))
    index = { docs, byId, df, total, avg, builtAt: nowMs(), count: total }
  }

  function ensureIndex() {
    if (!index || index.count !== state.methods.length) rebuildIndex()
    return index
  }

  function scoreOf(method, queryTokens, queryNorm) {
    const idx = index
    const doc = idx.byId.get(method.id)
    if (!doc) return { raw: 0, strong: 0 }
    const merged = new Map()
    for (const token of queryTokens) {
      // 同一个词多次出现只按最高权重算，避免重复词把分数带偏；bigram / 英文词算「强命中」
      const prev = merged.get(token.term)
      const strong = token.w >= 1
      if (!prev) merged.set(token.term, { w: token.w, strong })
      else if (token.w > prev.w) merged.set(token.term, { w: token.w, strong: prev.strong || strong })
      else if (strong) merged.set(token.term, { w: prev.w, strong: true })
    }
    let raw = 0
    let strong = 0
    for (const [term, info] of merged) {
      const tf = doc.tf.get(term) || 0
      if (tf <= 0) continue
      const dfv = idx.df.get(term) || 0
      const idf = Math.log(1 + (idx.total - dfv + 0.5) / (dfv + 0.5))
      const norm = 1 - B + B * (doc.len / (idx.avg || 1))
      raw += info.w * idf * ((tf * (K1 + 1)) / (tf + K1 * norm))
      if (info.strong) strong += 1
    }
    if (queryNorm) {
      const names = [method.name, ...(method.aliases || [])].map(normalizeText).filter(Boolean)
      if (names.includes(queryNorm)) {
        raw += 8
        strong += 1
      } else if (names.some((name) => name.includes(queryNorm) || queryNorm.includes(name))) {
        raw += 2.5
        strong += 1
      }
      if (normalizeText(method.intent).includes(queryNorm)) {
        raw += 1.2
        strong += 1
      }
    }
    return { raw, strong }
  }

  function okRateOf(method) {
    const uses = method.stats?.uses || 0
    const ok = method.stats?.ok || 0
    const fail = method.stats?.fail || 0
    if (ok + fail === 0) return uses > 0 ? 1 : 0.5
    return ok / (ok + fail)
  }

  function multiplierOf(method) {
    let factor = 1
    const uses = method.stats?.uses || 0
    factor *= 1 + 0.12 * Math.log10(1 + uses)
    const rate = okRateOf(method)
    if (uses >= 3) factor *= 0.7 + 0.3 * rate
    const last = method.stats?.lastUsedAt || 0
    if (last > 0) {
      const age = nowMs() - last
      if (age < 7 * 86400000) factor *= 1.1
      else if (age < 30 * 86400000) factor *= 1.05
    }
    if (method.status === 'draft') factor *= 0.6
    if (method.status === 'disabled') factor *= 0.2
    return factor
  }

  // ── 体检（只读，不执行）───────────────────────────────────────────────
  function resolveScriptPath(method) {
    const rel = str(method?.script?.path).trim()
    if (!rel) return ''
    if (path.isAbsolute(rel)) return path.resolve(rel)
    return path.resolve(paths().root, rel)
  }

  function healthOf(method) {
    const absScript = method.kind === 'playbook' ? '' : resolveScriptPath(method)
    let scriptSig = 'n/a'
    if (method.kind !== 'playbook') {
      if (!absScript) scriptSig = 'none'
      else {
        try {
          scriptSig = fs.existsSync(absScript) ? 'ok:' + fs.statSync(absScript).mtimeMs : 'missing'
        } catch {
          scriptSig = 'error'
        }
      }
    }
    const sig = [
      method.updatedAt,
      scriptSig,
      method.kind,
      JSON.stringify(method.params || []),
      method.stats?.lastUsedAt || 0,
      method.stats?.lastReportAt || 0,
      method.lastFailure?.at || 0,
    ].join('|')
    const cached = healthCache.get(method.id)
    if (cached && cached.sig === sig && nowMs() - cached.at < 60000) return cached.value
    const issues = []
    let level = 'ok'
    const bump = (next) => {
      if (next === 'broken') level = 'broken'
      else if (level === 'ok' && next === 'stale') level = 'stale'
    }
    if (method.kind !== 'playbook') {
      if (!str(method.script?.path).trim()) {
        issues.push('没有登记脚本文件')
        bump('broken')
      } else {
        const abs = resolveScriptPath(method)
        if (!abs || !fs.existsSync(abs)) {
          issues.push('脚本文件不存在')
          bump('broken')
        }
      }
    }
    if (method.kind !== 'script' && !str(method.steps).trim()) {
      issues.push('步骤为空')
      bump('broken')
    }
    for (const param of method.params || []) {
      if (param.type !== 'path') continue
      const value = str(param.default).trim()
      if (!value || !looksLikePath(value)) continue
      if (!fs.existsSync(value)) {
        issues.push('默认路径不存在：' + value)
        bump('stale')
      }
    }
    const last = method.stats?.lastUsedAt || 0
    if ((method.stats?.uses || 0) > 0 && last > 0 && nowMs() - last > STALE_MS) {
      issues.push('超过 90 天没用了')
      bump('stale')
    }
    if (method.lastFailure?.at && last && method.lastFailure.at >= (method.stats?.lastReportAt || 0)) {
      issues.push('上次执行失败' + (method.lastFailure.note ? '：' + method.lastFailure.note : ''))
      bump('stale')
    }
    const value = { state: level, issues, checkedAt: nowMs() }
    healthCache.set(method.id, { sig, at: nowMs(), value })
    return value
  }

  // ── 读写与合并 ────────────────────────────────────────────────────────
  function findMethod(id) {
    const key = str(id).trim()
    if (!key) return null
    return state.methods.find((method) => method.id === key) || null
  }

  function summarize(method) {
    return {
      id: method.id,
      name: method.name,
      intent: method.intent,
      kind: method.kind,
      tags: method.tags,
      aliases: method.aliases,
      params: (method.params || []).map((param) => ({ ...param })),
      risk: method.risk,
      status: method.status,
      version: method.version,
      uses: method.stats?.uses || 0,
      okRate: Number(okRateOf(method).toFixed(2)),
      lastUsedAt: method.stats?.lastUsedAt || 0,
      updatedAt: method.updatedAt,
      scriptPath: method.script?.path || '',
      health: healthOf(method),
    }
  }

  function detailOf(method) {
    const out = summarize(method)
    let scriptContent = ''
    const abs = resolveScriptPath(method)
    if (abs && fs.existsSync(abs)) {
      try {
        const stat = fs.statSync(abs)
        if (stat.size <= 512 * 1024) scriptContent = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')
      } catch {
        scriptContent = ''
      }
    }
    return {
      ...out,
      steps: method.steps,
      script: method.script ? { ...method.script } : null,
      scriptAbs: abs,
      scriptContent,
      aliases: method.aliases,
      examples: method.examples,
      stats: { ...(method.stats || {}) },
      lastFailure: method.lastFailure ? { ...method.lastFailure } : null,
      source: method.source || null,
      createdAt: method.createdAt,
    }
  }

  function writeScriptFile(name, runtime, code) {
    const p = paths()
    const ext = RUNTIME_EXT[runtime] || '.ps1'
    const base = (str(name).trim() || 'method').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'method'
    let filename = base + ext
    let i = 1
    while (fs.existsSync(path.join(p.scripts, filename))) {
      i += 1
      filename = base + '-' + i + ext
    }
    const abs = path.join(p.scripts, filename)
    fs.mkdirSync(p.scripts, { recursive: true })
    fs.writeFileSync(abs, scriptFileText(str(code), ext), 'utf8')
    return 'scripts/' + filename
  }

  /**
   * Windows PowerShell 5.1 读无 BOM 的 UTF-8 .ps1 会按 ANSI(GBK) 解码，
   * 中文注释/字符串直接乱码甚至语法错误 —— 所以 .ps1 一律写 UTF-8 BOM。
   * 其它运行时（.sh/.mjs/.py）不加 BOM，免得 shebang 失效。
   */
  function scriptFileText(text, ext) {
    const body = str(text).replace(/^\uFEFF/, '')
    return ext === '.ps1' ? '\uFEFF' + body : body
  }

  function normalizeScript(raw, warnings) {
    const source = raw && typeof raw === 'object' ? raw : {}
    const runtime = RUNTIMES.includes(source.runtime) ? source.runtime : 'pwsh'
    const args = Array.isArray(source.args) ? source.args.map(str) : []
    return {
      path: str(source.path).trim(),
      runtime,
      args,
      cwd: str(source.cwd).trim(),
      expect: str(source.expect).trim(),
      ...(typeof source.code === 'string' ? { code: source.code } : {}),
    }
  }

  function applyPatch(base, patch, warnings) {
    const next = { ...base }
    if (patch.name !== undefined) {
      const value = str(patch.name).trim()
      if (value) next.name = value
      else warnings.push('name 不能为空，已保留原值')
    }
    if (patch.intent !== undefined) next.intent = str(patch.intent)
    if (patch.steps !== undefined) next.steps = str(patch.steps)
    if (patch.kind !== undefined) {
      if (KINDS.includes(patch.kind)) next.kind = patch.kind
      else warnings.push('kind 只能是 ' + KINDS.join(' / ') + '，已保留原值')
    }
    if (patch.risk !== undefined) {
      if (RISKS.includes(patch.risk)) next.risk = patch.risk
      else warnings.push('risk 只能是 ' + RISKS.join(' / '))
    }
    if (patch.status !== undefined) {
      if (STATUSES.includes(patch.status)) next.status = patch.status
      else warnings.push('status 只能是 ' + STATUSES.join(' / '))
    }
    if (patch.aliases !== undefined) {
      if (Array.isArray(patch.aliases)) next.aliases = patch.aliases.map(str).map((s) => s.trim()).filter(Boolean)
      else warnings.push('aliases 需要字符串数组')
    }
    if (patch.tags !== undefined) {
      if (Array.isArray(patch.tags)) next.tags = patch.tags.map(str).map((s) => s.trim()).filter(Boolean)
      else warnings.push('tags 需要字符串数组')
    }
    if (patch.params !== undefined) {
      if (Array.isArray(patch.params)) {
        next.params = patch.params.map((p) => sanitizeParam(p)).filter(Boolean)
      } else warnings.push('params 需要数组')
    }
    if (patch.examples !== undefined) {
      if (Array.isArray(patch.examples)) next.examples = patch.examples
      else warnings.push('examples 需要数组')
    }
    if (patch.script !== undefined) {
      if (patch.script && typeof patch.script === 'object') {
        const current = next.script ? { ...next.script } : {}
        const incoming = patch.script
        for (const key of ['path', 'runtime', 'cwd', 'expect']) {
          if (incoming[key] !== undefined) current[key] = str(incoming[key])
        }
        if (incoming.args !== undefined) current.args = Array.isArray(incoming.args) ? incoming.args.map(str) : []
        if (incoming.runtime !== undefined && !RUNTIMES.includes(incoming.runtime)) warnings.push('script.runtime 不支持，已保留原值')
        if (incoming.runtime !== undefined && RUNTIMES.includes(incoming.runtime)) current.runtime = incoming.runtime
        if (typeof incoming.code === 'string') current.code = incoming.code
        next.script = current
      } else if (patch.script === null) {
        next.script = null
      } else {
        warnings.push('script 需要对象')
      }
    }
    return next
  }

  function snapshot(method, reason) {
    try {
      const p = paths()
      fs.mkdirSync(p.archive, { recursive: true })
      const file = path.join(p.archive, method.id + '-v' + (method.version || 1) + '-' + nowMs() + '.json')
      fs.writeFileSync(file, JSON.stringify({ reason, at: nowMs(), method }, null, 2), 'utf8')
    } catch {
      // 快照失败不阻塞
    }
  }

  function findDuplicate(candidate) {
    const name = normalizeText(candidate.name)
    const aliases = new Set((candidate.aliases || []).map(normalizeText).filter(Boolean))
    for (const method of state.methods) {
      if (method.id === candidate.id) continue
      if (method.status === 'archived') continue
      if (normalizeText(method.name) === name) return method
      const overlap = (method.aliases || []).map(normalizeText).filter((alias) => aliases.has(alias))
      if (overlap.length > 0) return method
    }
    return null
  }

  function save(card, options = {}) {
    loadIfNeeded()
    const input = card && typeof card === 'object' ? card : {}
    const warnings = []
    const by = str(options.by) || 'ai'
    const existing = input.id ? findMethod(input.id) : null
    const now = nowMs()

    if (existing) {
      if (input.id !== existing.id) warnings.push('id 不接受修改')
      const merged = applyPatch(existing, input, warnings)
      if (merged.kind !== 'playbook') {
        const script = normalizeScript(merged.script, warnings)
        if (script.code !== undefined && str(script.code).trim() !== '') {
          script.path = writeScriptFile(merged.name, script.runtime, script.code)
          delete script.code
        }
        merged.script = script
        if (!script.path) warnings.push('script 型方法缺少脚本文件（面板里补一个，或传 script.code 自动生成）')
      }
      const duplicate = findDuplicate(merged)
      if (duplicate) warnings.push('和已有方法「' + duplicate.name + '」(' + duplicate.id + ') 撞名/撞别名，考虑合并')
      snapshot(existing, 'update')
      merged.version = (existing.version || 1) + 1
      merged.updatedAt = now
      merged.updatedBy = by
      state.methods = state.methods.map((method) => (method.id === existing.id ? merged : method))
      persist()
      rebuildIndex()
      healthCache.delete(merged.id)
      usageLog({ op: 'save', id: merged.id, by, action: 'update', version: merged.version })
      return { ok: true, created: false, id: merged.id, version: merged.version, duplicateOf: duplicate ? duplicate.id : null, warnings, method: summarize(merged) }
    }

    const fresh = {
      id: newId(),
      name: '',
      intent: '',
      kind: 'playbook',
      aliases: [],
      tags: [],
      params: [],
      examples: [],
      steps: '',
      risk: 'medium',
      status: by === 'ai' ? 'active' : 'active',
      script: null,
      stats: { uses: 0, ok: 0, fail: 0, lastUsedAt: 0, lastReportAt: 0 },
      lastFailure: null,
      source: card?.source && typeof card.source === 'object' ? card.source : { kind: by, at: now },
      createdAt: now,
      updatedAt: now,
      version: 1,
      updatedBy: by,
    }
    const merged = applyPatch(fresh, input, warnings)
    if (!normalizeText(merged.name)) throw new Error('新建方法需要 name（一句话说清这件事叫什么）')
    if (!KINDS.includes(merged.kind)) merged.kind = 'playbook'
    if (merged.kind !== 'playbook') {
      const script = normalizeScript(merged.script, warnings)
      if (typeof script.code === 'string' && script.code.trim() !== '') {
        script.path = writeScriptFile(merged.name, script.runtime, script.code)
        delete script.code
      } else {
        delete script.code
      }
      merged.script = script
      if (!script.path) throw new Error('script / hybrid 类型需要脚本：传 script.path（库里已有的相对路径）或 script.code（自动生成文件）')
    } else {
      merged.script = merged.script ? normalizeScript(merged.script, warnings) : null
      if (!normalizeText(merged.steps)) warnings.push('playbook 没有写 steps，AI 拿不到步骤')
    }
    if (merged.kind === 'hybrid' && !normalizeText(merged.steps)) warnings.push('hybrid 没写 steps，只有脚本部分可用')
    const duplicate = findDuplicate(merged)
    if (duplicate) warnings.push('和已有方法「' + duplicate.name + '」(' + duplicate.id + ') 很像，可能是重复的')
    merged.version = 1
    state.methods.push(merged)
    persist()
    rebuildIndex()
    usageLog({ op: 'save', id: merged.id, by, action: 'create', version: 1 })
    return { ok: true, created: true, id: merged.id, version: 1, duplicateOf: duplicate ? duplicate.id : null, warnings, method: summarize(merged) }
  }

  function archive(id) {
    loadIfNeeded()
    const method = findMethod(id)
    if (!method) throw new Error('没有 id 为 ' + (id || '(空)') + ' 的方法')
    if (method.status === 'archived') return { ok: true, id: method.id, status: 'archived', already: true }
    snapshot(method, 'archive')
    method.status = 'archived'
    method.archivedAt = nowMs()
    method.updatedAt = nowMs()
    persist()
    usageLog({ op: 'archive', id: method.id })
    return { ok: true, id: method.id, status: 'archived' }
  }

  function restore(id) {
    loadIfNeeded()
    const method = findMethod(id)
    if (!method) throw new Error('没有 id 为 ' + (id || '(空)') + ' 的方法')
    method.status = 'active'
    method.archivedAt = 0
    method.updatedAt = nowMs()
    persist()
    usageLog({ op: 'restore', id: method.id })
    return { ok: true, id: method.id, status: 'active' }
  }

  // ── 检索 ─────────────────────────────────────────────────────────────
  function search(query, options = {}) {
    loadIfNeeded()
    ensureIndex()
    const limit = clampInt(options.limit, 1, 30, clampInt(config.searchLimit, 1, 30, 5))
    const includeDrafts = options.includeDrafts === true
    const includeDisabled = options.includeDisabled === true
    const tagList = Array.isArray(options.tags) ? options.tags.map((tag) => normalizeText(tag)).filter(Boolean) : []
    const text = str(query).trim()
    const norm = normalizeText(text)

    let pool = state.methods.filter((method) => method.status !== 'archived')
    if (!includeDisabled) pool = pool.filter((method) => method.status !== 'disabled')
    if (!includeDrafts) pool = pool.filter((method) => method.status !== 'draft')
    if (tagList.length > 0) {
      pool = pool.filter((method) => {
        const tags = (method.tags || []).map(normalizeText)
        return tagList.every((tag) => tags.some((own) => own.includes(tag) || tag.includes(own)))
      })
    }

    if (!norm) {
      const recent = [...pool]
        .sort((a, b) => (b.stats?.lastUsedAt || 0) - (a.stats?.lastUsedAt || 0) || (b.stats?.uses || 0) - (a.stats?.uses || 0) || b.updatedAt - a.updatedAt)
        .slice(0, limit)
      return {
        total: pool.length,
        query: '',
        items: recent.map((method) => ({ ...summarize(method), score: 0, matched: '最近使用' })),
      }
    }

    const tokens = tokenize(text)
    const hasStrongQuery = tokens.some((token) => token.w >= 1)
    const scored = []
    for (const method of pool) {
      const { raw, strong } = scoreOf(method, tokens, norm)
      // 只蹭到单个字的命中（如「批量」里的「量」）不算命中：有强词时要求至少一个强命中
      if (hasStrongQuery && strong === 0) continue
      const score = raw * multiplierOf(method)
      if (score <= 0) continue
      scored.push({ method, score })
    }
    scored.sort((a, b) => b.score - a.score)
    const max = scored.length > 0 ? scored[0].score : 0
    const items = scored.slice(0, limit).map(({ method, score }) => ({
      ...summarize(method),
      score: max > 0 ? Number((score / max).toFixed(2)) : 0,
    }))
    return { total: pool.length, query: text, items }
  }

  // ── 发货：拼命令 / 给步骤（绝不执行）────────────────────────────────────
  function resolveArgs(method, args) {
    const provided = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    const values = {}
    const missing = []
    for (const param of method.params || []) {
      let value = provided[param.name]
      if (value === undefined || value === null || value === '') value = param.default
      if (value === undefined || value === null || value === '') {
        if (param.required) missing.push(param)
        continue
      }
      if (param.type === 'number') {
        const num = Number(value)
        if (!Number.isFinite(num)) throw new Error('参数 ' + param.name + ' 需要数字，收到：' + str(value))
        value = num
      }
      if (param.type === 'bool') {
        value = value === true || value === 'true' || value === '1' || value === 1
      }
      if (param.type === 'enum' && Array.isArray(param.options) && param.options.length > 0 && !param.options.includes(String(value))) {
        throw new Error('参数 ' + param.name + ' 只能是：' + param.options.join(' / '))
      }
      values[param.name] = value
    }
    return { values, missing }
  }

  function defaultArgs(method) {
    const script = method.script || {}
    const runtime = script.runtime || 'pwsh'
    const params = method.params || []
    if (runtime === 'pwsh') {
      // 默认带 -ExecutionPolicy Bypass：很多 Windows 机器默认策略禁止直接跑 .ps1
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '{{script}}']
      for (const param of params) args.push('-' + param.name, '{{' + param.name + '}}')
      return args
    }
    const args = ['{{script}}']
    for (const param of params) args.push('--' + param.name, '{{' + param.name + '}}')
    return args
  }

  function buildCommand(method, values) {
    const script = method.script || {}
    const runtime = script.runtime || 'pwsh'
    const abs = resolveScriptPath(method)
    const template = Array.isArray(script.args) && script.args.length > 0 ? script.args : defaultArgs(method)
    const withValues = { ...values, script: abs }
    const argv = template.map((token) => {
      const replaced = substitute(token, withValues)
      return replaced === token && !/\{\{/.test(token) ? token : replaced
    })
    const resolved = resolveRuntime(runtime)
    const command = [shellToken(resolved.exe), ...argv.map((arg) => (str(arg).includes('{{') ? str(arg) : quoteArg(arg)))].join(' ')
    const cwd = substitute(script.cwd, withValues).trim()
    return {
      scriptAbs: abs,
      command,
      cwd: cwd || '',
      expect: str(script.expect).trim(),
      runtime,
      actualRuntime: resolved.actual,
      warnings: resolved.warnings,
    }
  }

  function preview(id, args) {
    loadIfNeeded()
    const method = findMethod(id)
    if (!method) throw new Error('没有 id 为 ' + (id || '(空)') + ' 的方法；先用 method_search 找一下')
    if (method.status === 'archived') throw new Error('方法「' + method.name + '」已归档，先恢复再用')
    const { values, missing } = resolveArgs(method, args)
    if (missing.length > 0) {
      const list = missing.map((param) => param.name + (param.type ? '(' + param.type + ')' : '') + (param.desc ? '：' + param.desc : '')).join('、')
      const error = new Error('缺少必填参数：' + list + '。请从上下文补上再调用 method_use。')
      error.code = 'MISSING_PARAMS'
      error.missing = missing.map((param) => ({ name: param.name, type: param.type, desc: param.desc }))
      throw error
    }
    method.stats.uses = (method.stats.uses || 0) + 1
    method.stats.lastUsedAt = nowMs()
    persist()
    usageLog({ op: 'use', id: method.id, args: values })
    const health = healthOf(method)
    const payload = {
      ok: true,
      id: method.id,
      name: method.name,
      kind: method.kind,
      risk: method.risk,
      params: values,
      health,
    }
    if (method.kind === 'playbook') {
      return {
        ...payload,
        steps: method.steps,
        next: '请按上面的步骤用你自己的工具执行；做完把结果调 method_report 回报（ok 真/假 + 一句话）。',
      }
    }
    const built = buildCommand(method, values)
    return {
      ...payload,
      command: built.command,
      cwd: built.cwd,
      expect: built.expect,
      runtime: built.actualRuntime,
      warnings: built.warnings,
      steps: method.kind === 'hybrid' ? method.steps : '',
      next:
        '插件不执行命令。请用你的终端工具（pwsh）执行上面的 command' +
        (built.cwd ? '（工作目录 ' + built.cwd + '）' : '') +
        '，然后把结果调 method_report 回报：成功 ok:true，失败 ok:false 并带上 problem/note。若命令本身不对，用 method_save 带 patch 修正脚本/参数/步骤。',
    }
  }

  function report(id, payload = {}) {
    loadIfNeeded()
    const method = findMethod(id)
    if (!method) throw new Error('没有 id 为 ' + (id || '(空)') + ' 的方法')
    const ok = payload.ok === true
    const now = nowMs()
    if (!method.stats) method.stats = { uses: 0, ok: 0, fail: 0 }
    if (ok) {
      method.stats.ok = (method.stats.ok || 0) + 1
      method.lastFailure = null
    } else {
      method.stats.fail = (method.stats.fail || 0) + 1
      method.lastFailure = {
        at: now,
        note: str(payload.note).slice(0, 500),
        problem: str(payload.problem).slice(0, 1000),
      }
    }
    method.stats.lastReportAt = now
    method.updatedAt = now
    let patched = null
    let patchWarnings = []
    if (payload.patch && typeof payload.patch === 'object' && !Array.isArray(payload.patch)) {
      const saved = save({ ...payload.patch, id: method.id }, { by: 'ai' })
      patched = saved.id
      patchWarnings = saved.warnings || []
    }
    persist()
    rebuildIndex()
    healthCache.delete(method.id)
    usageLog({ op: 'report', id: method.id, ok, note: str(payload.note).slice(0, 200) })
    const fresh = findMethod(method.id) || method
    const health = healthOf(fresh)
    const messages = []
    messages.push(ok ? '已记账：' + fresh.name + ' 执行成功（累计 成功 ' + fresh.stats.ok + ' / 失败 ' + fresh.stats.fail + '）。' : '已记账：' + fresh.name + ' 执行失败（累计 成功 ' + fresh.stats.ok + ' / 失败 ' + fresh.stats.fail + '）。')
    if (!ok && !payload.patch) {
      messages.push('要修这条方法：先 method_get 看当前步骤/脚本，再用 method_save 带 patch 修正（例如脚本路径变了改 script.path、参数不对改 params、步骤过时改 steps）；修完版本自动 +1，可回滚。')
    }
    if (patched) messages.push('已写入修正，版本 +1（v' + fresh.version + '）。')
    if (patchWarnings.length > 0) messages.push('提醒：' + patchWarnings.join('；'))
    if (health.state !== 'ok') messages.push('体检：' + health.state + (health.issues.length ? '（' + health.issues.join('；') + '）' : ''))
    return { ok: true, id: fresh.id, state: health.state, health, patched, version: fresh.version, message: messages.join('') }
  }

  // ── 面板数据 ─────────────────────────────────────────────────────────
  function overview() {
    loadIfNeeded()
    const methods = state.methods.map((method) => summarize(method))
    const counts = {
      total: state.methods.length,
      active: methods.filter((item) => item.status === 'active').length,
      draft: methods.filter((item) => item.status === 'draft').length,
      disabled: methods.filter((item) => item.status === 'disabled').length,
      archived: methods.filter((item) => item.status === 'archived').length,
      issues: methods.filter((item) => item.health && item.health.state !== 'ok').length,
    }
    return {
      ok: true,
      libraryDir: libraryDir(),
      defaultLibraryDir: defaultLibraryDir(),
      methods,
      counts,
      settings: {
        searchLimit: clampInt(config.searchLimit, 1, 30, 5),
        draftDays: clampInt(config.draftDays, 7, 3650, 90),
      },
      lastError,
      index: { count: index ? index.count : 0, builtAt: index ? index.builtAt : 0 },
    }
  }

  function detail(id) {
    loadIfNeeded()
    const method = findMethod(id)
    if (!method) throw new Error('没有 id 为 ' + (id || '(空)') + ' 的方法')
    return { ok: true, method: detailOf(method), libraryDir: libraryDir() }
  }

  function setLibraryDir(next) {
    loadIfNeeded()
    if (fixedDir) throw new Error('这个会话用的是单独库目录，请在会话设置里改，别改全局')
    const target = path.resolve(str(next).trim())
    if (!target) throw new Error('目录不能为空')
    const current = libraryDir()
    if (path.resolve(target) === path.resolve(current)) return overview()
    migrate(current, target)
    const nextSettings = { ...settings, libraryDir: target }
    writeSettings(nextSettings)
    loaded = false
    healthCache = new Map()
    load()
    usageLog({ op: 'libraryDir', from: current, to: target })
    return overview()
  }

  function copyRecursive(src, dest) {
    if (!fs.existsSync(src)) return
    const stat = fs.statSync(src)
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true })
      for (const name of fs.readdirSync(src)) copyRecursive(path.join(src, name), path.join(dest, name))
      return
    }
    try {
      fs.copyFileSync(src, dest)
    } catch {
      // 单个文件失败就跳过
    }
  }

  function copyMerge(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true })
    for (const name of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, name)
      const dest = path.join(destDir, name)
      if (!fs.existsSync(dest)) copyRecursive(src, dest)
    }
  }

  /** 迁移：当前库有数据、目标目录没有 methods.json 时把数据搬过去；目标已有数据则合并脚本/日志/归档，不覆盖其 methods.json。 */
  function migrate(fromDir, toDir) {
    if (path.resolve(fromDir) === path.resolve(toDir)) return
    try {
      if (!fs.existsSync(fromDir)) {
        fs.mkdirSync(toDir, { recursive: true })
        return
      }
      fs.mkdirSync(toDir, { recursive: true })
      const targetHasMethods = fs.existsSync(path.join(toDir, 'methods.json'))
      for (const item of ['methods.json', 'README.txt']) {
        const src = path.join(fromDir, item)
        const dest = path.join(toDir, item)
        if (!fs.existsSync(src)) continue
        if (!fs.existsSync(dest)) fs.copyFileSync(src, dest)
      }
      if (!targetHasMethods && fs.existsSync(path.join(fromDir, 'methods.json.bak'))) {
        try {
          fs.copyFileSync(path.join(fromDir, 'methods.json.bak'), path.join(toDir, 'methods.json.bak'))
        } catch {
          // 忽略
        }
      }
      for (const dir of ['scripts', 'logs', 'archive']) {
        const src = path.join(fromDir, dir)
        if (fs.existsSync(src)) copyMerge(src, path.join(toDir, dir))
      }
    } catch (error) {
      throw new Error('迁移库目录失败：' + (error && error.message ? error.message : String(error)))
    }
  }

  function exportData() {
    loadIfNeeded()
    return {
      ok: true,
      format: 'dsh-method-library',
      version: 1,
      exportedAt: nowMs(),
      methods: state.methods.map((method) => ({ ...method })),
    }
  }

  function importData(raw, options = {}) {
    loadIfNeeded()
    let parsed = raw
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('导入内容不是合法 JSON')
      }
    }
    const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.methods) ? parsed.methods : null
    if (!list) throw new Error('导入内容需要是方法数组，或者 { methods: [...] }')
    let created = 0
    let updated = 0
    const failures = []
    for (const item of list) {
      try {
        const exists = item && item.id ? findMethod(item.id) : null
        const payload = exists ? { ...item, id: exists.id } : { ...item, id: undefined }
        const result = save(payload, { by: options.by || 'import' })
        if (result.created) created += 1
        else updated += 1
      } catch (error) {
        failures.push(String(error && error.message ? error.message : error))
      }
    }
    return { ok: true, created, updated, failures }
  }

  function versions(id) {
    loadIfNeeded()
    const method = findMethod(id)
    if (!method) throw new Error('没有 id 为 ' + (id || '(空)') + ' 的方法')
    const dir = paths().archive
    if (!fs.existsSync(dir)) return []
    const out = []
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(method.id + '-v') || !name.endsWith('.json')) continue
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
        out.push({
          file: name,
          version: raw?.method?.version || 0,
          at: Number(raw?.at) || 0,
          reason: str(raw?.reason),
          name: str(raw?.method?.name),
        })
      } catch {
        // 坏快照跳过
      }
    }
    out.sort((a, b) => b.at - a.at)
    return out
  }

  function rollback(id, file) {
    loadIfNeeded()
    const method = findMethod(id)
    if (!method) throw new Error('没有 id 为 ' + (id || '(空)') + ' 的方法')
    const base = path.basename(str(file))
    if (!base.startsWith(method.id + '-v') || !base.endsWith('.json')) throw new Error('不是这条方法的历史版本文件')
    const abs = path.join(paths().archive, base)
    const root = path.resolve(paths().root)
    if (!path.resolve(abs).startsWith(root)) throw new Error('快照路径越界')
    if (!fs.existsSync(abs)) throw new Error('快照文件不存在：' + base)
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'))
    const snapshotMethod = raw?.method
    if (!snapshotMethod || typeof snapshotMethod !== 'object') throw new Error('快照内容不合法')
    const restored = save(
      {
        id: method.id,
        name: snapshotMethod.name,
        intent: snapshotMethod.intent,
        kind: snapshotMethod.kind,
        aliases: snapshotMethod.aliases,
        tags: snapshotMethod.tags,
        params: snapshotMethod.params,
        steps: snapshotMethod.steps,
        risk: snapshotMethod.risk,
        status: snapshotMethod.status === 'archived' ? 'active' : snapshotMethod.status,
        script: snapshotMethod.script ? { ...snapshotMethod.script, code: undefined } : null,
      },
      { by: 'ui' },
    )
    usageLog({ op: 'rollback', id: method.id, file: base })
    return { ok: true, id: method.id, version: restored.version, warnings: restored.warnings }
  }

  function writeScriptContent(id, content) {
    loadIfNeeded()
    const method = findMethod(id)
    if (!method) throw new Error('没有 id 为 ' + (id || '(空)') + ' 的方法')
    const abs = resolveScriptPath(method)
    if (!abs) throw new Error('这条方法还没登记脚本文件（先在详情里填 script.path 或给 code 自动生成）')
    const root = path.resolve(paths().root)
    const resolved = path.resolve(abs)
    if (!resolved.startsWith(root + path.sep)) throw new Error('脚本路径不在库目录内，拒绝写入')
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    try {
      if (fs.existsSync(resolved)) {
        const p = paths()
        fs.mkdirSync(p.archive, { recursive: true })
        fs.copyFileSync(resolved, path.join(p.archive, method.id + '-script-' + nowMs() + path.extname(resolved)))
      }
    } catch {
      // 备份失败不阻塞
    }
    fs.writeFileSync(resolved, scriptFileText(content, path.extname(resolved).toLowerCase()), 'utf8')
    method.updatedAt = nowMs()
    persist()
    healthCache.delete(method.id)
    usageLog({ op: 'script', id: method.id, bytes: str(content).length })
    return { ok: true, id: method.id, bytes: str(content).length }
  }

  function loadIfNeeded() {
    if (!loaded) load()
  }

  function reload() {
    loaded = false
    healthCache = new Map()
    load()
    return overview()
  }

  return {
    init: () => {
      loadIfNeeded()
      return overview()
    },
    reload,
    libraryDir,
    defaultLibraryDir,
    isFixedDir,
    paths,
    overview,
    detail,
    save,
    archive,
    restore,
    search,
    preview,
    report,
    setLibraryDir,
    exportData,
    importData,
    versions,
    rollback,
    writeScriptContent,
    getApiBase: () => apiBase,
    setApiBase: (value) => {
      apiBase = value
    },
    lastError: () => lastError,
    findMethod,
    summarize,
    healthOf,
  }
}
