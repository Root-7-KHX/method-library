/**
 * 会话层：哪个会话用方法库、用哪个库目录。
 *
 * - 会话注册表存在 data/sessions.json：{ lastActive, sessions: { [id]: { enabled, libraryDir } } }
 * - 默认所有会话都启用；关掉某个会话 = 那个会话里工具直接报错、提示词一个字都不注入。
 * - 会话可以单独指定库目录（不同项目各用一个库）；没指定就跟随「全局默认库目录」。
 * - 引擎按目录缓存：同一目录的会话共用一个内存索引，切会话不会重复扫盘。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import { createEngine } from './engine.js'

const REGISTRY_VERSION = 1

function str(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

function atomicWrite(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(3).toString('hex')
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
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

function normalizeDirKey(dir) {
  return path.resolve(dir).replace(/[\\/]+$/, '').toLowerCase()
}

export function createHub({ pluginDir, config = {}, getService }) {
  const dataDir = path.join(pluginDir, 'data')
  const registryFile = path.join(dataDir, 'sessions.json')
  // 默认关闭：新对话不会自动拥有方法库，要在面板里手动打开那个对话。
  const defaultEnabled = config.defaultSessionEnabled === true
  const globalEngine = createEngine({ pluginDir, config })
  const state = { version: REGISTRY_VERSION, lastActive: '', sessions: {} }
  const engines = new Map()
  engines.set(normalizeDirKey(globalEngine.libraryDir()), globalEngine)

  loadRegistry()

  function loadRegistry() {
    try {
      if (!fs.existsSync(registryFile)) return
      const raw = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
      if (!raw || typeof raw !== 'object') return
      state.lastActive = typeof raw.lastActive === 'string' ? raw.lastActive : ''
      const sessions = raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions) ? raw.sessions : {}
      for (const [key, value] of Object.entries(sessions)) {
        if (!key || !value || typeof value !== 'object') continue
        const entry = {}
        if (typeof value.enabled === 'boolean') entry.enabled = value.enabled
        if (typeof value.libraryDir === 'string' && value.libraryDir.trim() !== '') entry.libraryDir = path.resolve(value.libraryDir.trim())
        state.sessions[key] = entry
      }
    } catch {
      // 坏注册表就当没有：默认全开、全跟随全局
    }
  }

  function persistRegistry() {
    try {
      atomicWrite(
        registryFile,
        JSON.stringify(
          {
            version: REGISTRY_VERSION,
            lastActive: state.lastActive,
            sessions: state.sessions,
          },
          null,
          2,
        ),
      )
    } catch {
      // 写不进去不影响使用
    }
  }

  function sessionEntry(sessionId) {
    const key = str(sessionId).trim()
    const entry = key ? state.sessions[key] : null
    return entry && typeof entry === 'object' ? entry : {}
  }

  function isEnabled(sessionId) {
    const entry = sessionEntry(sessionId)
    if (entry.enabled === true) return true
    if (entry.enabled === false) return false
    return defaultEnabled
  }

  function setEnabled(sessionId, enabled) {
    const key = str(sessionId).trim()
    if (!key) throw new Error('缺少会话 id')
    const next = { ...sessionEntry(key) }
    const value = enabled === true
    if (value === defaultEnabled) delete next.enabled
    else next.enabled = value
    if (Object.keys(next).length === 0) delete state.sessions[key]
    else state.sessions[key] = next
    persistRegistry()
    return { sessionId: key, enabled: isEnabled(key) }
  }

  function sessionDir(sessionId) {
    const raw = str(sessionEntry(sessionId).libraryDir).trim()
    return raw ? path.resolve(raw) : ''
  }

  function setSessionDir(sessionId, dir, options = {}) {
    const key = str(sessionId).trim()
    if (!key) throw new Error('缺少会话 id')
    const target = str(dir).trim()
    const next = { ...sessionEntry(key) }
    if (!target) {
      delete next.libraryDir
      if (Object.keys(next).length === 0) delete state.sessions[key]
      else state.sessions[key] = next
      persistRegistry()
      return { sessionId: key, libraryDir: '', effectiveLibraryDir: effectiveDir(key) }
    }
    const resolved = path.resolve(target)
    if (options.seed !== false) seedLibrary(effectiveDir(key), resolved)
    next.libraryDir = resolved
    state.sessions[key] = next
    persistRegistry()
    return { sessionId: key, libraryDir: resolved, effectiveLibraryDir: effectiveDir(key) }
  }

  /** 把一个库「复制一份」到目标目录（目标已有 methods.json 就不动）。 */
  function seedLibrary(fromDir, toDir) {
    try {
      if (!fromDir || normalizeDirKey(fromDir) === normalizeDirKey(toDir)) return false
      const targetMethods = path.join(toDir, 'methods.json')
      if (fs.existsSync(targetMethods)) return false
      if (!fs.existsSync(path.join(fromDir, 'methods.json'))) return false
      fs.mkdirSync(toDir, { recursive: true })
      fs.copyFileSync(path.join(fromDir, 'methods.json'), targetMethods)
      for (const extra of ['methods.json.bak']) {
        const src = path.join(fromDir, extra)
        if (fs.existsSync(src)) copyRecursive(src, path.join(toDir, extra))
      }
      copyRecursive(path.join(fromDir, 'scripts'), path.join(toDir, 'scripts'))
      return true
    } catch {
      return false
    }
  }

  function effectiveDir(sessionId) {
    return sessionDir(sessionId) || globalEngine.libraryDir()
  }

  function engineFor(sessionId) {
    const dir = effectiveDir(sessionId)
    if (normalizeDirKey(dir) === normalizeDirKey(globalEngine.libraryDir())) return globalEngine
    const key = normalizeDirKey(dir)
    let engine = engines.get(key)
    if (!engine) {
      engine = createEngine({ pluginDir, config, fixedLibraryDir: dir })
      try {
        engine.init()
      } catch {
        // 下次调用会重试
      }
      engines.set(key, engine)
    }
    return engine
  }

  function requireEngine(sessionId) {
    if (!isEnabled(sessionId)) {
      const error = new Error('本对话没有开启方法库；要在这个对话里用，先去左侧栏「方法库」面板打开「本对话」开关。')
      error.code = 'SESSION_DISABLED'
      throw error
    }
    return engineFor(sessionId)
  }

  function noteVisible(sessionId) {
    const key = str(sessionId).trim()
    if (!key || state.lastActive === key) return
    state.lastActive = key
    persistRegistry()
  }

  function currentSession() {
    return state.lastActive || null
  }

  function setGlobalDir(dir) {
    const before = normalizeDirKey(globalEngine.libraryDir())
    const overview = globalEngine.setLibraryDir(dir)
    const after = normalizeDirKey(globalEngine.libraryDir())
    if (before !== after) {
      // 全局库换目录后，把缓存里指向旧全局目录的条目改成新的，避免给同一个目录再开一个引擎
      if (engines.get(before) === globalEngine) engines.delete(before)
      engines.set(after, globalEngine)
    }
    return overview
  }

  function overviewFor(sessionId) {
    const id = str(sessionId).trim()
    const engine = id ? engineFor(id) : globalEngine
    const base = engine.overview()
    const globalDir = globalEngine.libraryDir()
    const ownDir = id ? sessionDir(id) : ''
    return {
      ...base,
      sessionId: id,
      enabled: id ? isEnabled(id) : true,
      sessionLibraryDir: ownDir,
      globalLibraryDir: globalDir,
      effectiveLibraryDir: engine.libraryDir(),
      defaultGlobalLibraryDir: globalEngine.defaultLibraryDir(),
      defaultSessionEnabled: defaultEnabled,
      usingSessionLibrary: ownDir !== '',
    }
  }

  /** 会话列表（给面板的切换器用）：按工作区分组，带 ●/○ 启用状态和各自库目录。 */
  async function listSessions() {
    let records = []
    const query = getService('sessionQuery')
    try {
      if (query && typeof query.listSessions === 'function') records = await query.listSessions()
    } catch {
      records = []
    }
    if (!Array.isArray(records) || records.length === 0) {
      const agents = getService('agents')
      if (agents && typeof agents.list === 'function') {
        records = agents.list().map((agent) => ({ header: { id: agent.id, createdAt: Date.now() }, live: true }))
      }
    }
    const seen = new Set()
    const rows = []
    for (const record of Array.isArray(records) ? records : []) {
      const header = record && record.header ? record.header : record || {}
      const id = str(header.id ?? (record && record.sessionId)).trim()
      if (!id || seen.has(id)) continue
      if (header.origin === 'subagent') continue
      seen.add(id)
      rows.push({
        id,
        createdAt: Number.isFinite(Number(header.createdAt)) ? Number(header.createdAt) : null,
        live: record && record.live === true,
        cwd: typeof header.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd.trim() : null,
      })
      if (rows.length >= 60) break
    }
    const titles = new Map()
    try {
      const ids = rows.map((row) => row.id)
      if (query && typeof query.readTitleSnapshots === 'function' && ids.length > 0) {
        const results = await query.readTitleSnapshots(ids)
        for (const item of Array.isArray(results) ? results : []) {
          const value = item && typeof item === 'object' && 'value' in item ? item.value : item
          const title = value?.title?.title ?? value?.title ?? (typeof value === 'string' ? value : null)
          if (typeof title === 'string' && title.trim() !== '') titles.set(str(item.sessionId ?? item.id), title.trim())
        }
      }
    } catch {
      titles.clear()
    }
    let workspaceNames = new Map()
    try {
      const registry = getService('workspaceRegistry')
      const list = registry && typeof registry.list === 'function' ? registry.list() || [] : []
      for (const workspace of list) {
        if (!workspace || !workspace.path) continue
        workspaceNames.set(normalizeDirKey(workspace.path), str(workspace.title) || path.basename(workspace.path))
      }
    } catch {
      workspaceNames = new Map()
    }
    const current = currentSession()
    const workspaceLabelOf = (cwd) => {
      if (!cwd) return '未分组'
      const named = workspaceNames.get(normalizeDirKey(cwd))
      if (named) return named
      const base = path.basename(cwd)
      // DSH 自带默认工作区（新对话没选工作区就落这里），别让它看起来像插件建的东西
      if (/^default-workspace$/i.test(base)) return '默认工作区（DSH 自带）'
      return base
    }
    const items = rows
      .map((row) => ({
        id: row.id,
        title: titles.get(row.id) || '',
        createdAt: row.createdAt,
        live: row.live,
        cwd: row.cwd,
        workspace: workspaceLabelOf(row.cwd),
        enabled: isEnabled(row.id),
        libraryDir: sessionDir(row.id),
        effectiveDir: effectiveDir(row.id),
      }))
      .filter((item) => item.title !== '' || item.enabled || item.id === current)
    if (current && !items.some((item) => item.id === current)) {
      items.unshift({
        id: current,
        title: titles.get(current) || '',
        createdAt: null,
        live: true,
        cwd: null,
        workspace: '未分组',
        enabled: isEnabled(current),
        libraryDir: sessionDir(current),
        effectiveDir: effectiveDir(current),
      })
    }
    const groups = []
    const byWorkspace = new Map()
    for (const item of items) {
      const key = item.workspace
      let group = byWorkspace.get(key)
      if (!group) {
        group = { key, label: key, sessions: [] }
        byWorkspace.set(key, group)
        groups.push(group)
      }
      group.sessions.push(item)
    }
    return {
      current: current || (items.find((item) => item.enabled) || {}).id || null,
      items,
      groups,
      globalLibraryDir: globalEngine.libraryDir(),
      defaultGlobalLibraryDir: globalEngine.defaultLibraryDir(),
      defaultSessionEnabled: defaultEnabled,
      disabledCount: items.filter((item) => !item.enabled).length,
      ownDirCount: items.filter((item) => item.libraryDir !== '').length,
    }
  }

  function status() {
    return {
      current: currentSession(),
      globalLibraryDir: globalEngine.libraryDir(),
      defaultGlobalLibraryDir: globalEngine.defaultLibraryDir(),
      defaultSessionEnabled: defaultEnabled,
      sessionCount: Object.keys(state.sessions).length,
      engineCount: engines.size,
    }
  }

  return {
    init: () => {
      globalEngine.init()
      return status()
    },
    globalEngine,
    globalDir: () => globalEngine.libraryDir(),
    defaultGlobalDir: () => globalEngine.defaultLibraryDir(),
    setGlobalDir,
    isEnabled,
    setEnabled,
    sessionDir,
    setSessionDir,
    effectiveDir,
    engineFor,
    requireEngine,
    overviewFor,
    listSessions,
    noteVisible,
    currentSession,
    status,
    registryPath: () => registryFile,
  }
}
