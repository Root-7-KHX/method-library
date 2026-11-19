/**
 * 方法库面板（Client）：侧边栏入口 + 主区管理界面。
 *
 * 数据全部走 Host 注册的 /method-library/api/*（纯文件读写，不执行任何命令）。
 * 会话级（跟 AI记忆 一样的形态）：
 * - 顶部会话切换器：● 开 / ○ 关，可以切到别的会话看它的库、改它的开关和库目录。
 * - 每个会话可以单独指定库目录；没指定就跟随「全局默认库目录」。
 */
window.__ModuleLoader__.load({
  id: '@local/method-library',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API_CANDIDATES = [
      '/method-library/api',
      '/method-library/api2',
      '/method-library/api3',
      '/method-library/api4',
      '/method-library/api5',
    ]
    const KIND_LABEL = { script: '脚本', playbook: '步骤', hybrid: '混合' }
    const STATUS_LABEL = { active: '启用', draft: '草稿', disabled: '停用', archived: '归档' }
    const RISK_LABEL = { low: '低风险', medium: '中风险', high: '高风险' }
    const RUNTIMES = ['pwsh', 'bash', 'node', 'python']

    // 分组（分类）顺序：类型 脚本→步骤→混合，其余按状态/风险从「正常」往「异常」排
    const GROUP_ORDER = {
      kind: { script: 0, playbook: 1, hybrid: 2 },
      status: { active: 0, draft: 1, disabled: 2, archived: 3 },
      risk: { low: 0, medium: 1, high: 2 },
    }
    const GROUP_MODE_LABEL = { kind: '类型', tag: '标签', status: '状态', risk: '风险', none: '全部' }
    const UNTAGGED_LABEL = '未分类'
    const GROUP_STORE_KEY = 'method-library:groupBy'

    function readStoredGroupBy() {
      try {
        const saved = window.localStorage.getItem(GROUP_STORE_KEY)
        return saved && GROUP_MODE_LABEL[saved] ? saved : 'kind'
      } catch {
        return 'kind'
      }
    }

    let apiBase = ''

    function withSession(pathname, sessionId) {
      if (!sessionId) return pathname
      return pathname + (pathname.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(sessionId)
    }

    async function request(pathname, options = {}) {
      const sessionId = options.session || ''
      const target = withSession(pathname, sessionId)
      const bases = apiBase ? [apiBase] : API_CANDIDATES
      let lastError = null
      for (const base of bases) {
        try {
          const response = await fetch(base + target, {
            credentials: 'same-origin',
            cache: 'no-store',
            method: options.method || 'GET',
            headers: options.body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
            body: options.body,
          })
          const raw = await response.text()
          let data = {}
          try {
            data = raw ? JSON.parse(raw) : {}
          } catch {
            data = { ok: false, error: '接口返回的不是 JSON' }
          }
          if (response.status === 404 && !apiBase) {
            lastError = new Error('面板接口还没起来')
            continue
          }
          if (!response.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + response.status)
          apiBase = base
          return data
        } catch (error) {
          lastError = error
          if (!apiBase) continue
          throw error
        }
      }
      throw lastError || new Error('面板接口不可用（插件可能没启用，或刚重载还在起）')
    }

    function splitList(text) {
      return String(text || '')
        .split(/[,，、\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
    }

    function parseJsonArray(text, label) {
      const raw = String(text || '').trim()
      if (!raw) return []
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new Error(label + ' JSON 不合法：' + error.message)
      }
      if (!Array.isArray(parsed)) throw new Error(label + ' 需要是数组')
      return parsed
    }

    function toDraft(method) {
      const source = method || {}
      return {
        id: source.id || '',
        name: source.name || '',
        intent: source.intent || '',
        kind: source.kind || 'playbook',
        aliases: (source.aliases || []).join('、'),
        tags: (source.tags || []).join('、'),
        risk: source.risk || 'medium',
        status: source.status || 'active',
        steps: source.steps || '',
        paramsText: JSON.stringify(source.params || [], null, 2),
        scriptPath: (source.script && source.script.path) || '',
        runtime: (source.script && source.script.runtime) || 'pwsh',
        argsText: JSON.stringify((source.script && source.script.args) || [], null, 2),
        cwd: (source.script && source.script.cwd) || '',
        expect: (source.script && source.script.expect) || '',
        content: source.scriptContent || '',
      }
    }

    function defaultParamValues(params) {
      const values = {}
      for (const param of params || []) {
        if (param && param.default !== undefined && param.default !== null && param.default !== '') values[param.name] = param.default
      }
      return values
    }

    const EMPTY_DRAFT = toDraft({
      name: '',
      intent: '',
      kind: 'playbook',
      params: [],
      script: { runtime: 'pwsh', args: [] },
    })

    function baseName(dir) {
      const text = String(dir || '').replace(/[\\/]+$/, '')
      const parts = text.split(/[\\/]/)
      return parts[parts.length - 1] || text
    }

    // ── 小组件 ────────────────────────────────────────────────────────
    function Field(props) {
      return h(
        'label',
        { className: 'ml-field' },
        h('span', { className: 'ml-label' }, props.label, props.hint ? h('span', { className: 'ml-hint' }, props.hint) : null),
        props.children,
      )
    }

    function Badge(props) {
      return h('span', { className: 'ml-badge' + (props.tone ? ' ml-badge-' + props.tone : '') }, props.children)
    }

    /** 滑块开关：role=switch + aria-checked，点空白/点按钮都能切。 */
    function Switch(props) {
      const checked = props.checked === true
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': props.label || '开关',
          className: 'ml-switch' + (checked ? ' ml-switch-on' : '') + (props.small ? ' ml-switch-sm' : ''),
          disabled: props.disabled === true,
          title: props.title || (checked ? '已开启，点击关闭' : '已关闭，点击开启'),
          onClick: (event) => {
            event.stopPropagation()
            if (props.disabled === true) return
            if (typeof props.onChange === 'function') props.onChange(!checked)
          },
        },
        h('span', { className: 'ml-switch-knob' }),
      )
    }

    function ListRow(props) {
      const item = props.item
      const issues = item.health && item.health.state !== 'ok' ? item.health.issues || [] : []
      return h(
        'button',
        {
          type: 'button',
          className: 'ml-row' + (props.active ? ' ml-row-active' : ''),
          onClick: props.onClick,
          title: item.intent || item.name,
        },
        h(
          'div',
          { className: 'ml-row-top' },
          h('span', { className: 'ml-row-name' }, item.name || '(未命名)'),
          h(Badge, { tone: item.kind === 'script' ? 'brand' : item.kind === 'hybrid' ? 'warn' : 'idle' }, KIND_LABEL[item.kind] || item.kind),
          item.risk === 'high' ? h(Badge, { tone: 'error' }, RISK_LABEL.high) : null,
          item.status !== 'active' ? h(Badge, { tone: 'idle' }, STATUS_LABEL[item.status] || item.status) : null,
        ),
        item.intent ? h('div', { className: 'ml-row-intent' }, item.intent) : null,
        h(
          'div',
          { className: 'ml-row-meta' },
          h('span', null, '用过 ' + (item.uses || 0) + ' 次'),
          h('span', null, '成功率 ' + Math.round((item.okRate || 0) * 100) + '%'),
          item.scriptPath ? h('span', { className: 'ml-mono ml-ellipsis' }, item.scriptPath) : null,
        ),
        issues.length > 0 ? h('div', { className: 'ml-row-warn' }, '⚠ ' + issues.join('；')) : null,
      )
    }

    // ── 会话切换器（按工作区分组，文件夹默认收起） ──────────────────
    function SessionPicker(props) {
      const { sessions, open, onClose, onPick, activeId, expanded = {}, onToggleGroup, onToggleEnabled } = props
      if (!open) return null
      const groups = (sessions && sessions.groups) || []
      return h(
        'div',
        { className: 'ml-picker', role: 'dialog' },
        h(
          'div',
          { className: 'ml-picker-head' },
          h('span', null, '会话开关（滑块 = 那个对话能不能用方法库）'),
          h('span', { className: 'ml-muted' }, '文件夹默认收起，点一下展开'),
        ),
        h(
          'div',
          { className: 'ml-picker-body' },
          groups.length === 0 ? h('div', { className: 'ml-empty' }, '读不到会话列表') : null,
          groups.map((group) => {
            const opened = expanded[group.key] === true
            const list = group.sessions || []
            const onCount = list.filter((item) => item.enabled !== false).length
            return h(
              'div',
              { key: group.key, className: 'ml-picker-group' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ml-picker-folder' + (opened ? ' ml-picker-folder-open' : ''),
                  onClick: () => onToggleGroup(group.key),
                  title: group.key || '',
                },
                h('span', { className: 'ml-folder-caret' }, opened ? '▾' : '▸'),
                h('span', { className: 'ml-folder-icon' }, opened ? '📂' : '📁'),
                h('span', { className: 'ml-folder-label' }, group.label || '未分组'),
                h('span', { className: 'ml-folder-count' }, onCount + '/' + list.length),
              ),
              opened
                ? h(
                    'div',
                    { className: 'ml-folder-body' },
                    list.length === 0
                      ? h('div', { className: 'ml-empty' }, '这个文件夹里没有可显示的对话')
                      : list.map((item) =>
                          h(
                            'div',
                            {
                              key: item.id,
                              role: 'button',
                              tabIndex: 0,
                              className: 'ml-picker-item' + (activeId === item.id ? ' ml-picker-item-active' : ''),
                              onClick: () => onPick(item.id),
                              onKeyDown: (event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  onPick(item.id)
                                }
                              },
                              title: item.effectiveDir || '',
                            },
                            h('span', { className: 'ml-picker-title' }, item.title || '未命名对话'),
                            item.id === sessions.current ? h(Badge, { tone: 'brand' }, '当前') : null,
                            item.libraryDir ? h(Badge, { tone: 'warn' }, '单独库') : null,
                            h(Switch, {
                              small: true,
                              checked: item.enabled !== false,
                              label: '这个对话的方法库开关',
                              title: '这个对话的方法库：' + (item.enabled !== false ? '开（点击关闭）' : '关（点击开启）'),
                              onChange: (next) => onToggleEnabled(item.id, next),
                            }),
                          ),
                        ),
                  )
                : null,
            )
          }),
        ),
        h('div', { className: 'ml-picker-foot' }, h('button', { type: 'button', className: 'ml-btn', onClick: onClose }, '关闭')),
      )
    }

    // ── 主面板（顶部「对话 / 轨迹 / …」标签栏里的「方法库」）──────────
    function MethodLibraryPanel(props) {
      const preferredSession = props && typeof props.sessionId === 'string' ? props.sessionId : ''
      const [sessions, setSessions] = useState(null)
      const [viewSession, setViewSession] = useState('')
      const [overview, setOverview] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [query, setQuery] = useState('')
      const [statusFilter, setStatusFilter] = useState('all')
      const [onlyIssues, setOnlyIssues] = useState(false)
      const [selectedId, setSelectedId] = useState('')
      const [draft, setDraft] = useState(null)
      const [paramValues, setParamValues] = useState({})
      const [message, setMessage] = useState(null)
      const [busy, setBusy] = useState(false)
      const [previewText, setPreviewText] = useState('')
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [dirInput, setDirInput] = useState('')
      const [sessDirInput, setSessDirInput] = useState('')
      const [seedCopy, setSeedCopy] = useState(true)
      const [pickerOpen, setPickerOpen] = useState(false)
      const [expandedGroups, setExpandedGroups] = useState({})
      const [groupBy, setGroupBy] = useState(readStoredGroupBy)
      const [foldedCats, setFoldedCats] = useState({})
      const [versions, setVersions] = useState([])
      const [versionPick, setVersionPick] = useState('')
      // P2 自动捕获：AI 搜不到的事（面板里可一键转草稿）
      const [misses, setMisses] = useState([])
      const [missesOpen, setMissesOpen] = useState(false)
      const fileInputRef = useRef(null)
      const viewRef = useRef('')

      const notify = useCallback((kind, text) => setMessage({ kind, text }), [])

      const applyOverview = useCallback((data) => {
        setOverview(data)
        setDirInput(data.globalLibraryDir || '')
        setSessDirInput(data.sessionLibraryDir || '')
      }, [])

      const loadSessions = useCallback(async () => {
        try {
          const data = await request('/sessions')
          setSessions(data)
          return data
        } catch {
          setSessions(null)
          return null
        }
      }, [])

      const loadOverview = useCallback(
        async (sessionId) => {
          try {
            const data = await request('/overview', { session: sessionId })
            applyOverview(data)
            setLoadError('')
            return data
          } catch (error) {
            setLoadError(error && error.message ? error.message : String(error))
            return null
          }
        },
        [applyOverview],
      )

      const bootstrap = useCallback(async () => {
        const list = await loadSessions()
        const items = (list && list.items) || []
        // 顶部标签进来的话，默认就是这个对话；否则用宿主记录的最近活跃对话
        let target = preferredSession && items.some((item) => item.id === preferredSession) ? preferredSession : ''
        if (!target) target = (list && (list.current || (items[0] && items[0].id))) || ''
        viewRef.current = target
        setViewSession(target)
        if (target) await loadOverview(target)
        else await loadOverview('')
      }, [loadSessions, loadOverview, preferredSession])

      const refresh = useCallback(async () => {
        await loadSessions()
        const target = viewRef.current
        await loadOverview(target)
      }, [loadSessions, loadOverview])

      // 「AI 搜不到的事」清单：换会话/刷新时顺带拉一次（全局数据，不分库）
      const loadMisses = useCallback(async () => {
        try {
          const data = await request('/misses', { session: viewRef.current })
          setMisses(Array.isArray(data && data.items) ? data.items : [])
        } catch {
          setMisses([])
        }
      }, [])

      const handleMiss = useCallback(
        async (query, discard) => {
          try {
            await request('/miss', { method: 'POST', body: JSON.stringify({ query, discard: discard === true, session: viewRef.current }) })
            await loadMisses()
            if (!discard) {
              await refresh()
              setMessage({ kind: 'ok', text: '「' + query + '」已转成草稿，补一下步骤和参数就能用。' })
            }
          } catch (error) {
            setMessage({ kind: 'error', text: error && error.message ? error.message : String(error) })
          }
        },
        [refresh, loadMisses],
      )

      useEffect(() => {
        void bootstrap()
      }, [bootstrap])

      // 捕获清单是全局的，但要在会话确定之后拉（带 session 参数走后端鉴权）
      useEffect(() => {
        void loadMisses()
      }, [loadMisses, viewSession])

      const pickSession = useCallback(
        async (sessionId) => {
          viewRef.current = sessionId
          setViewSession(sessionId)
          setPickerOpen(false)
          setSelectedId('')
          setDraft(null)
          setPreviewText('')
          await loadOverview(sessionId)
        },
        [loadOverview],
      )

      const counts = (overview && overview.counts) || { total: 0, issues: 0, active: 0, draft: 0, archived: 0 }
      const methods = (overview && overview.methods) || []
      const sessionEnabled = !!(overview && overview.enabled !== false)
      const usingOwnLibrary = !!(overview && overview.usingSessionLibrary)
      const sessionTitle = useMemo(() => {
        const items = (sessions && sessions.items) || []
        const hit = items.find((item) => item.id === viewSession)
        return hit ? hit.title || '未命名对话' : '未选择会话'
      }, [sessions, viewSession])

      const filtered = useMemo(() => {
        const text = query.trim().toLowerCase()
        return methods.filter((item) => {
          if (statusFilter !== 'all' && item.status !== statusFilter) return false
          if (onlyIssues && (!item.health || item.health.state === 'ok')) return false
          if (!text) return true
          const hay = [item.name, item.intent, (item.aliases || []).join(' '), (item.tags || []).join(' '), item.id].join(' ').toLowerCase()
          return hay.includes(text)
        })
      }, [methods, query, statusFilter, onlyIssues])

      // 分类：把过滤后的方法按 类型 / 标签 / 状态 / 风险 分组，组内保持原顺序
      const groups = useMemo(() => {
        if (groupBy === 'none') return [{ key: '__all__', label: '全部方法', items: filtered }]
        const bucket = new Map()
        const order = GROUP_ORDER[groupBy] || {}
        for (const item of filtered) {
          let key
          let label
          if (groupBy === 'tag') {
            const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean) : []
            if (tags.length === 0) {
              key = '__untagged__'
              label = UNTAGGED_LABEL
            } else {
              key = tags[0]
              label = tags[0]
            }
          } else {
            const value = (item[groupBy] || '').toString() || 'unknown'
            key = value
            label = groupBy === 'kind' ? KIND_LABEL[value] || value : groupBy === 'status' ? STATUS_LABEL[value] || value : RISK_LABEL[value] || value
          }
          if (!bucket.has(key)) bucket.set(key, { key, label, items: [], order: order[key] === undefined ? 90 : order[key] })
          bucket.get(key).items.push(item)
        }
        const list = Array.from(bucket.values())
        if (groupBy === 'tag') list.sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label, 'zh'))
        else list.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'zh'))
        return list
      }, [filtered, groupBy])

      const changeGroupBy = useCallback((next) => {
        setGroupBy(next)
        try {
          window.localStorage.setItem(GROUP_STORE_KEY, next)
        } catch {
          /* 存不了就算了，只是记不住偏好 */
        }
      }, [])

      const toggleCategory = useCallback((key) => {
        setFoldedCats((prev) => ({ ...prev, [key]: prev[key] !== true }))
      }, [])

      const patchDraft = useCallback((patch) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev)), [])

      const openMethod = useCallback(
        async (id) => {
          if (!id) return
          try {
            const data = await request('/method?id=' + encodeURIComponent(id), { session: viewRef.current })
            setSelectedId(id)
            setDraft(toDraft(data.method))
            setParamValues(defaultParamValues(data.method.params))
            setPreviewText('')
            try {
              const versionData = await request('/versions?id=' + encodeURIComponent(id), { session: viewRef.current })
              setVersions(versionData.versions || [])
              setVersionPick('')
            } catch {
              setVersions([])
            }
          } catch (error) {
            notify('err', error.message)
          }
        },
        [notify],
      )

      const buildCard = useCallback(() => {
        if (!draft) throw new Error('没有正在编辑的方法')
        if (!String(draft.name).trim()) throw new Error('方法名不能为空')
        const params = parseJsonArray(draft.paramsText, '参数定义')
        const card = {
          name: String(draft.name).trim(),
          intent: draft.intent,
          kind: draft.kind,
          aliases: splitList(draft.aliases),
          tags: splitList(draft.tags),
          risk: draft.risk,
          status: draft.status,
          steps: draft.steps,
          params,
        }
        if (draft.id) card.id = draft.id
        if (draft.kind !== 'playbook') {
          const args = parseJsonArray(draft.argsText, '参数模板')
          card.script = {
            path: String(draft.scriptPath || '').trim(),
            runtime: draft.runtime,
            args,
            cwd: draft.cwd,
            expect: draft.expect,
          }
          if (!draft.id && String(draft.content || '').trim()) card.script.code = String(draft.content)
          if (draft.id && String(draft.content || '').trim() && !String(draft.scriptPath || '').trim()) {
            card.script.code = String(draft.content)
          }
        }
        return card
      }, [draft])

      const save = useCallback(async () => {
        if (!draft) return
        setBusy(true)
        try {
          const card = buildCard()
          card.session = viewRef.current
          const result = await request('/save', { method: 'POST', body: JSON.stringify({ card, session: viewRef.current }) })
          if (draft.id && String(draft.content || '').trim() && String(draft.scriptPath || '').trim()) {
            await request('/script', { method: 'POST', body: JSON.stringify({ id: draft.id, content: draft.content, session: viewRef.current }) })
          }
          const notes = []
          notes.push((result.created ? '已新建' : '已保存') + '（v' + result.version + '）')
          if (result.warnings && result.warnings.length > 0) notes.push(result.warnings.join('；'))
          if (result.duplicateOf) notes.push('可能和 ' + result.duplicateOf + ' 重复')
          notify('ok', notes.join('；'))
          await refresh()
          await openMethod(result.id)
        } catch (error) {
          notify('err', error.message)
        } finally {
          setBusy(false)
        }
      }, [draft, buildCard, refresh, openMethod, notify])

      const archiveMethod = useCallback(async () => {
        if (!draft || !draft.id) return
        if (!window.confirm('把「' + draft.name + '」归档？它会从搜索结果里消失，但可以随时恢复。')) return
        setBusy(true)
        try {
          await request('/archive', { method: 'POST', body: JSON.stringify({ id: draft.id, session: viewRef.current }) })
          notify('ok', '已归档，可在「归档」筛选里恢复')
          await refresh()
          await openMethod(draft.id)
        } catch (error) {
          notify('err', error.message)
        } finally {
          setBusy(false)
        }
      }, [draft, refresh, openMethod, notify])

      const restoreMethod = useCallback(async () => {
        if (!draft || !draft.id) return
        setBusy(true)
        try {
          await request('/restore', { method: 'POST', body: JSON.stringify({ id: draft.id, session: viewRef.current }) })
          notify('ok', '已恢复为启用')
          await refresh()
          await openMethod(draft.id)
        } catch (error) {
          notify('err', error.message)
        } finally {
          setBusy(false)
        }
      }, [draft, refresh, openMethod, notify])

      const runPreview = useCallback(async () => {
        if (!draft || !draft.id) {
          notify('err', '先保存成方法，才能试运行')
          return
        }
        setBusy(true)
        setPreviewText('')
        try {
          const data = await request('/preview', { method: 'POST', body: JSON.stringify({ id: draft.id, args: paramValues, session: viewRef.current }) })
          const payload = data.payload
          const lines = []
          if (payload.kind === 'playbook') {
            lines.push('步骤（照着自己执行）：')
            lines.push(payload.steps || '(步骤为空)')
          } else {
            lines.push('要执行的命令（复制到终端执行，插件不会自己跑）：')
            lines.push(payload.command)
            if (payload.warnings && payload.warnings.length > 0) lines.push('', '提示：' + payload.warnings.join('；'))
            if (payload.cwd) lines.push('', '工作目录：' + payload.cwd)
            if (payload.expect) lines.push('预期结果：' + payload.expect)
            if (payload.steps) lines.push('', '收尾步骤：', payload.steps)
          }
          setPreviewText(lines.join('\n'))
          await refresh()
          await openMethod(draft.id)
        } catch (error) {
          notify('err', error.message)
        } finally {
          setBusy(false)
        }
      }, [draft, paramValues, refresh, openMethod, notify])

      const toggleGroup = useCallback((key) => {
        setExpandedGroups((prev) => ({ ...prev, [key]: prev[key] !== true }))
      }, [])

      /** 本地先改（滑块立刻动），失败再回滚。 */
      const patchSessionEnabled = useCallback((sessionId, enabled) => {
        setSessions((prev) => {
          if (!prev) return prev
          const items = (prev.items || []).map((item) => (item.id === sessionId ? { ...item, enabled } : item))
          const groups = (prev.groups || []).map((group) => ({
            ...group,
            sessions: (group.sessions || []).map((item) => (item.id === sessionId ? { ...item, enabled } : item)),
          }))
          return { ...prev, items, groups, disabledCount: items.filter((item) => !item.enabled).length }
        })
        setOverview((prev) => (prev && prev.sessionId === sessionId ? { ...prev, enabled } : prev))
      }, [])

      const titleOfSession = useCallback(
        (sessionId) => {
          const items = (sessions && sessions.items) || []
          const hit = items.find((item) => item.id === sessionId)
          return hit && hit.title ? hit.title : '这个对话'
        },
        [sessions],
      )

      // 会话开关：直接影响 AI 在那个会话里能不能用方法库（点列表里的滑块也能改）
      const toggleEnabledFor = useCallback(
        async (sessionId, next) => {
          if (!sessionId) {
            notify('err', '先选一个会话')
            return
          }
          patchSessionEnabled(sessionId, next)
          try {
            const data = await request('/enable', { method: 'POST', body: JSON.stringify({ session: sessionId, enabled: next }) })
            if (data.overview && sessionId === viewRef.current) applyOverview(data.overview)
            notify('ok', (next ? '已开启「' : '已关闭「') + titleOfSession(sessionId) + '」的方法库' + (next ? '（立即生效）' : '：那个对话里工具会隐藏、提示词不注入'))
            await loadSessions()
          } catch (error) {
            patchSessionEnabled(sessionId, !next)
            notify('err', error.message)
          }
        },
        [patchSessionEnabled, applyOverview, loadSessions, notify, titleOfSession],
      )

      const saveSessionDir = useCallback(async () => {
        const sessionId = viewRef.current
        if (!sessionId) {
          notify('err', '先选一个会话')
          return
        }
        setBusy(true)
        try {
          const data = await request('/session-dir', {
            method: 'POST',
            body: JSON.stringify({ session: sessionId, libraryDir: sessDirInput, seed: seedCopy }),
          })
          if (data.overview) applyOverview(data.overview)
          notify('ok', '这个会话的库目录：' + (data.overview ? data.overview.effectiveLibraryDir : sessDirInput))
          await refresh()
        } catch (error) {
          notify('err', error.message)
        } finally {
          setBusy(false)
        }
      }, [sessDirInput, seedCopy, applyOverview, refresh, notify])

      const followGlobalDir = useCallback(async () => {
        const sessionId = viewRef.current
        if (!sessionId) return
        setBusy(true)
        try {
          const data = await request('/session-dir', { method: 'POST', body: JSON.stringify({ session: sessionId, libraryDir: '' }) })
          if (data.overview) applyOverview(data.overview)
          notify('ok', '已改为跟随全局默认库目录')
          await refresh()
        } catch (error) {
          notify('err', error.message)
        } finally {
          setBusy(false)
        }
      }, [applyOverview, refresh, notify])

      const changeDir = useCallback(async () => {
        setBusy(true)
        try {
          await request('/settings', { method: 'POST', body: JSON.stringify({ libraryDir: dirInput }) })
          notify('ok', '全局默认库目录已切换（没单独指定目录的会话都跟着走）')
          await refresh()
        } catch (error) {
          notify('err', error.message)
        } finally {
          setBusy(false)
        }
      }, [dirInput, refresh, notify])

      const resetDir = useCallback(async () => {
        if (!overview) return
        setBusy(true)
        try {
          await request('/settings', { method: 'POST', body: JSON.stringify({ libraryDir: overview.defaultGlobalLibraryDir }) })
          notify('ok', '已恢复默认全局库目录')
          await refresh()
        } catch (error) {
          notify('err', error.message)
        } finally {
          setBusy(false)
        }
      }, [overview, refresh, notify])

      // 系统原生「选择文件夹」对话框（和 QQ机器人插件里表情包管理那个一样）。
      // 选完只回填输入框，点「保存并迁移」/「保存」才真正切换库目录。
      const chooseFolder = useCallback(
        async (currentDir) => {
          setBusy(true)
          try {
            const data = await request('/pick-dir', { method: 'POST', body: JSON.stringify({ dir: currentDir || '' }) })
            const dir = data && typeof data.dir === 'string' ? data.dir : ''
            if (dir === '') {
              notify('err', '已取消：没有选择文件夹')
              return ''
            }
            return dir
          } catch (error) {
            notify('err', '打开选择文件夹失败：' + error.message)
            return ''
          } finally {
            setBusy(false)
          }
        },
        [notify],
      )

      const chooseGlobalDir = useCallback(async () => {
        const dir = await chooseFolder(dirInput !== '' ? dirInput : overview ? overview.globalLibraryDir : '')
        if (!dir) return
        setDirInput(dir)
        notify('ok', '已选择文件夹：' + dir + '（点「保存并迁移」生效）')
      }, [chooseFolder, dirInput, overview, notify])

      const chooseSessionDir = useCallback(async () => {
        if (!viewSession) {
          notify('err', '先选一个会话')
          return
        }
        const dir = await chooseFolder(sessDirInput !== '' ? sessDirInput : overview ? overview.effectiveLibraryDir : '')
        if (!dir) return
        setSessDirInput(dir)
        notify('ok', '已选择文件夹：' + dir + '（点「保存」生效）')
      }, [chooseFolder, sessDirInput, overview, viewSession, notify])

      const exportJson = useCallback(async () => {
        try {
          const bases = apiBase ? [apiBase] : API_CANDIDATES
          let text = ''
          for (const base of bases) {
            const response = await fetch(base + withSession('/export', viewRef.current), { credentials: 'same-origin', cache: 'no-store' })
            if (response.ok) {
              text = await response.text()
              apiBase = base
              break
            }
          }
          if (!text) throw new Error('导出失败')
          const blob = new Blob([text], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = 'method-library-export-' + new Date().toISOString().slice(0, 10) + '.json'
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 2000)
          notify('ok', '已导出 JSON')
        } catch (error) {
          notify('err', error.message)
        }
      }, [notify])

      const importJson = useCallback(
        async (event) => {
          const file = event.target.files && event.target.files[0]
          event.target.value = ''
          if (!file) return
          setBusy(true)
          try {
            const text = await file.text()
            const parsed = JSON.parse(text)
            const result = await request('/import', { method: 'POST', body: JSON.stringify({ data: parsed, session: viewRef.current }) })
            notify('ok', '导入完成：新增 ' + result.created + ' 条，更新 ' + result.updated + ' 条' + (result.failures && result.failures.length ? '，失败 ' + result.failures.length + ' 条' : ''))
            await refresh()
          } catch (error) {
            notify('err', error.message)
          } finally {
            setBusy(false)
          }
        },
        [refresh, notify],
      )

      const rollback = useCallback(async () => {
        if (!draft || !draft.id || !versionPick) {
          notify('err', '先选一个历史版本')
          return
        }
        if (!window.confirm('回滚到选中的历史版本？当前内容会先存一份快照。')) return
        setBusy(true)
        try {
          const data = await request('/rollback', { method: 'POST', body: JSON.stringify({ id: draft.id, file: versionPick, session: viewRef.current }) })
          notify('ok', '已回滚（现在是 v' + data.version + '）')
          await refresh()
          await openMethod(draft.id)
        } catch (error) {
          notify('err', error.message)
        } finally {
          setBusy(false)
        }
      }, [draft, versionPick, refresh, openMethod, notify])

      const newMethod = useCallback(() => {
        setSelectedId('')
        setDraft({
          ...EMPTY_DRAFT,
          name: '',
          intent: '',
          aliases: '',
          tags: '',
          paramsText: '[]',
          argsText: JSON.stringify(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '{{script}}'], null, 2),
          content: '',
        })
        setParamValues({})
        setPreviewText('')
        setVersions([])
        setMessage(null)
      }, [])

      const duplicate = useCallback(() => {
        if (!draft) return
        setSelectedId('')
        setDraft({ ...draft, id: '', name: draft.name + '（副本）', content: '' })
        setVersions([])
        setPreviewText('')
        notify('ok', '已复制成新方法草稿，改完保存')
      }, [draft, notify])

      const copyPreview = useCallback(async () => {
        if (!previewText) return
        try {
          await navigator.clipboard.writeText(previewText)
          notify('ok', '已复制')
        } catch {
          notify('err', '复制失败，手动选中复制吧')
        }
      }, [previewText, notify])

      // ── 渲染 ──────────────────────────────────────────────────────
      const header = h(
        'div',
        { className: 'ml-header' },
        h('div', { className: 'ml-title' }, '方法库'),
        h(
          'div',
          { className: 'ml-sessionbar' },
          h(
            'button',
            { type: 'button', className: 'ml-btn ml-session-btn', onClick: () => setPickerOpen((value) => !value), disabled: busy, title: '切换要查看/设置的会话' },
            h('span', { className: 'ml-session-dot' + (sessionEnabled ? ' ml-dot-on' : ' ml-dot-off') }, sessionEnabled ? '●' : '○'),
            h('span', { className: 'ml-session-name' }, sessionTitle),
            h('span', { className: 'ml-caret' }, '▾'),
          ),
          h(
            'div',
            { className: 'ml-switch-wrap', title: '关掉后这个对话里 AI 看不到方法库工具，提示词也不注入' },
            h('span', { className: 'ml-switch-label' }, '本对话'),
            h(Switch, {
              checked: sessionEnabled,
              disabled: busy || !viewSession,
              label: '本对话的方法库开关',
              title: '这个对话的方法库：' + (sessionEnabled ? '开（点击关闭）' : '关（点击开启）'),
              onChange: (next) => toggleEnabledFor(viewRef.current, next),
            }),
          ),
        ),
        h(
          'div',
          { className: 'ml-header-actions' },
          h('button', { type: 'button', className: 'ml-btn', onClick: newMethod, disabled: busy }, '新建'),
          h('button', { type: 'button', className: 'ml-btn', onClick: refresh, disabled: busy }, '刷新'),
          h('button', { type: 'button', className: 'ml-btn', onClick: () => setSettingsOpen((value) => !value), disabled: busy }, '设置'),
          h('button', { type: 'button', className: 'ml-btn', onClick: exportJson, disabled: busy }, '导出'),
          h('button', { type: 'button', className: 'ml-btn', onClick: () => fileInputRef.current && fileInputRef.current.click(), disabled: busy }, '导入'),
          h('input', { ref: fileInputRef, type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: importJson }),
        ),
      )

      const pathBar = h(
        'div',
        { className: 'ml-pathbar' },
        h('span', { className: 'ml-path-label' }, '当前库：'),
        h('span', { className: 'ml-dir', title: overview ? overview.effectiveLibraryDir : '' }, overview ? overview.effectiveLibraryDir : '（未连接）'),
        usingOwnLibrary ? h(Badge, { tone: 'warn' }, '本会话单独库') : h(Badge, { tone: 'idle' }, '跟随全局'),
        h('span', { className: 'ml-muted' }, counts.total + ' 条方法'),
      )

      const settings = settingsOpen
        ? h(
            'div',
            { className: 'ml-settings' },
            h('div', { className: 'ml-settings-title' }, '全局默认库目录（没单独指定目录的会话都用它）'),
            h(
              'div',
              { className: 'ml-settings-row' },
              h('input', { className: 'ml-input ml-grow', value: dirInput, onChange: (event) => setDirInput(event.target.value), placeholder: overview ? overview.defaultGlobalLibraryDir : '' }),
              h('button', { type: 'button', className: 'ml-btn', onClick: chooseGlobalDir, disabled: busy, title: '打开系统的「选择文件夹」对话框，选好自动填到左边' }, '选择文件夹…'),
              h('button', { type: 'button', className: 'ml-btn ml-btn-primary', onClick: changeDir, disabled: busy }, '保存并迁移'),
              h('button', { type: 'button', className: 'ml-btn', onClick: resetDir, disabled: busy }, '恢复默认'),
            ),
            h('div', { className: 'ml-settings-row' }, h('span', { className: 'ml-muted' }, '改位置时会把 methods.json、scripts/、logs/、archive/ 复制到新目录（不删旧目录）。')),
            h('div', { className: 'ml-settings-divider' }),
            h('div', { className: 'ml-settings-title' }, '当前选中会话：' + sessionTitle),
            h(
              'div',
              { className: 'ml-settings-row' },
              h('input', {
                className: 'ml-input ml-grow',
                value: sessDirInput,
                onChange: (event) => setSessDirInput(event.target.value),
                placeholder: '留空 = 跟随全局（' + (overview ? overview.globalLibraryDir : '') + '）',
              }),
              h('button', { type: 'button', className: 'ml-btn', onClick: chooseSessionDir, disabled: busy || !viewSession, title: '打开系统的「选择文件夹」对话框，选好自动填到左边' }, '选择文件夹…'),
              h('button', { type: 'button', className: 'ml-btn ml-btn-primary', onClick: saveSessionDir, disabled: busy || !viewSession }, '保存'),
              h('button', { type: 'button', className: 'ml-btn', onClick: followGlobalDir, disabled: busy || !viewSession || !usingOwnLibrary }, '跟随全局'),
            ),
            h(
              'label',
              { className: 'ml-settings-row ml-check' },
              h('input', { type: 'checkbox', checked: seedCopy, onChange: (event) => setSeedCopy(event.target.checked) }),
              h('span', { className: 'ml-muted' }, '指定新目录且那里还没有 methods.json 时，把当前库复制一份过去（不勾 = 从空库开始）'),
            ),
            h('div', { className: 'ml-settings-row' }, h('span', { className: 'ml-muted' }, '会话开关在旁边「本对话」滑块上切换：关掉的会话里 AI 看不到这 5 个工具，提示词也不注入。新对话默认是关的，要用就在那个对话上把滑块打开。')),
          )
        : null

      const toolbar = h(
        'div',
        { className: 'ml-toolbar' },
        h('input', {
          className: 'ml-input ml-grow',
          value: query,
          placeholder: '搜名字 / 别名 / 什么时候用…（本地即时过滤）',
          onChange: (event) => setQuery(event.target.value),
        }),
        h(
          'select',
          { className: 'ml-input ml-select', value: statusFilter, onChange: (event) => setStatusFilter(event.target.value) },
          h('option', { value: 'all' }, '全部状态'),
          h('option', { value: 'active' }, '启用'),
          h('option', { value: 'draft' }, '草稿'),
          h('option', { value: 'disabled' }, '停用'),
          h('option', { value: 'archived' }, '归档'),
        ),
        h(
          'button',
          { type: 'button', className: 'ml-btn' + (onlyIssues ? ' ml-btn-active' : ''), onClick: () => setOnlyIssues((value) => !value) },
          '只看有问题的' + (counts.issues ? '（' + counts.issues + '）' : ''),
        ),
        h(
          'select',
          {
            className: 'ml-input ml-select',
            value: groupBy,
            title: '按什么分类显示',
            onChange: (event) => changeGroupBy(event.target.value),
          },
          h('option', { value: 'kind' }, '按类型分组'),
          h('option', { value: 'tag' }, '按标签分组'),
          h('option', { value: 'status' }, '按状态分组'),
          h('option', { value: 'risk' }, '按风险分组'),
          h('option', { value: 'none' }, '不分组'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ml-btn' + (missesOpen ? ' ml-btn-active' : ''),
            title: 'AI 搜过但库里没有的事，可以一键转成草稿',
            onClick: () => {
              setMissesOpen((value) => !value)
              if (!missesOpen) void loadMisses()
            },
          },
          '搜不到的' + (misses.length ? '（' + misses.length + '）' : ''),
        ),
      )

      // 「搜不到」清单：AI 搜空了才记下的，看一眼就知道库里还缺什么
      const missesPanel =
        missesOpen && misses.length > 0
          ? h(
              'div',
              { className: 'ml-misses' },
              h('div', { className: 'ml-misses-head' }, 'AI 搜过、但库里没有的事（点一下转成草稿）'),
              ...misses.map((item) =>
                h(
                  'div',
                  { key: item.query, className: 'ml-miss-row' },
                  h('span', { className: 'ml-miss-text', title: item.query }, item.query),
                  item.count > 1 ? h('span', { className: 'ml-miss-count' }, '×' + item.count) : null,
                  h(
                    'button',
                    { type: 'button', className: 'ml-btn ml-btn-sm', onClick: () => void handleMiss(item.query, false) },
                    '转草稿',
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'ml-btn ml-btn-sm', onClick: () => void handleMiss(item.query, true) },
                    '不要',
                  ),
                ),
              ),
            )
          : missesOpen
            ? h('div', { className: 'ml-misses ml-misses-empty' }, '目前没有搜不到的记录。AI 搜空一次就会记一条到这里。')
            : null

      const list = h(
        'div',
        { className: 'ml-list' },
        filtered.length === 0
          ? h('div', { className: 'ml-empty' }, methods.length === 0 ? '这个会话的库里还没有方法。点「新建」，或让 AI 做完一件事后用 method_save 存一条。' : '没有符合条件的。')
          : groups.map((group) => {
              const folded = foldedCats[group.key] === true && groups.length > 1
              return h(
                'div',
                { key: group.key, className: 'ml-cat' },
                groups.length > 1
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'ml-cat-head' + (folded ? '' : ' ml-cat-head-open'),
                        onClick: () => toggleCategory(group.key),
                        title: folded ? '展开这一类' : '收起这一类',
                      },
                      h('span', { className: 'ml-cat-caret' }, folded ? '▸' : '▾'),
                      h('span', { className: 'ml-cat-label' }, group.label),
                      h('span', { className: 'ml-cat-count' }, String(group.items.length)),
                    )
                  : null,
                folded
                  ? null
                  : h(
                      'div',
                      { className: 'ml-cat-body' },
                      group.items.map((item) => h(ListRow, { key: item.id, item, active: item.id === selectedId, onClick: () => openMethod(item.id) })),
                    ),
              )
            }),
      )

      const current = draft
      const isScriptKind = current && current.kind !== 'playbook'
      const isStepsKind = current && current.kind !== 'script'
      const canPreview = current && current.id

      const editor = current
        ? h(
            'div',
            { className: 'ml-editor' },
            h(
              'div',
              { className: 'ml-editor-head' },
              h('div', { className: 'ml-editor-title' }, current.id ? '编辑方法 ' + current.id : '新建方法'),
              h(
                'div',
                { className: 'ml-editor-actions' },
                h('button', { type: 'button', className: 'ml-btn ml-btn-primary', onClick: save, disabled: busy }, busy ? '处理中…' : '保存'),
                h('button', { type: 'button', className: 'ml-btn', onClick: duplicate, disabled: busy || !current.id }, '复制'),
                current.id ? h('button', { type: 'button', className: 'ml-btn', onClick: archiveMethod, disabled: busy }, '归档') : null,
                current.id && current.status === 'archived' ? h('button', { type: 'button', className: 'ml-btn', onClick: restoreMethod, disabled: busy }, '恢复') : null,
              ),
            ),
            h(
              'div',
              { className: 'ml-grid' },
              h(Field, { label: '方法名' }, h('input', { className: 'ml-input', value: current.name, onChange: (event) => patchDraft({ name: event.target.value }), placeholder: '一句话，例如：清理 7 天前的临时文件' })),
              h(
                Field,
                { label: '类型' },
                h(
                  'select',
                  { className: 'ml-input', value: current.kind, onChange: (event) => patchDraft({ kind: event.target.value }) },
                  h('option', { value: 'playbook' }, 'playbook · 按步骤做'),
                  h('option', { value: 'script' }, 'script · 跑脚本'),
                  h('option', { value: 'hybrid' }, 'hybrid · 先脚本后步骤'),
                ),
              ),
              h(
                Field,
                { label: '风险级', hint: '只用于提醒，不拦截' },
                h(
                  'select',
                  { className: 'ml-input', value: current.risk, onChange: (event) => patchDraft({ risk: event.target.value }) },
                  h('option', { value: 'low' }, RISK_LABEL.low),
                  h('option', { value: 'medium' }, RISK_LABEL.medium),
                  h('option', { value: 'high' }, RISK_LABEL.high),
                ),
              ),
              h(
                Field,
                { label: '状态' },
                h(
                  'select',
                  { className: 'ml-input', value: current.status, onChange: (event) => patchDraft({ status: event.target.value }) },
                  h('option', { value: 'active' }, STATUS_LABEL.active),
                  h('option', { value: 'draft' }, STATUS_LABEL.draft),
                  h('option', { value: 'disabled' }, STATUS_LABEL.disabled),
                  h('option', { value: 'archived' }, STATUS_LABEL.archived),
                ),
              ),
            ),
            h(Field, { label: '什么时候用（intent）', hint: '搜索匹配的主文本，写清楚触发场景' }, h('textarea', { className: 'ml-input ml-textarea-sm', value: current.intent, onChange: (event) => patchDraft({ intent: event.target.value }), rows: 2 })),
            h(
              'div',
              { className: 'ml-grid' },
              h(Field, { label: '别名 / 口语说法', hint: '用顿号或逗号分隔，命中权重最高' }, h('input', { className: 'ml-input', value: current.aliases, onChange: (event) => patchDraft({ aliases: event.target.value }), placeholder: '清缓存、cleanup temp' })),
              h(Field, { label: '标签', hint: '用顿号或逗号分隔' }, h('input', { className: 'ml-input', value: current.tags, onChange: (event) => patchDraft({ tags: event.target.value }), placeholder: '文件、清理、日常' })),
            ),
            h(Field, { label: '参数定义（JSON 数组）', hint: 'name/type/required/default/desc；path 类型会在体检时检查默认值' }, h('textarea', { className: 'ml-input ml-code', value: current.paramsText, onChange: (event) => patchDraft({ paramsText: event.target.value }), rows: 6, spellCheck: false })),
            isScriptKind
              ? h(
                  'div',
                  { className: 'ml-section' },
                  h('div', { className: 'ml-section-title' }, '脚本'),
                  h(
                    'div',
                    { className: 'ml-grid' },
                    h(Field, { label: '脚本路径', hint: '相对库目录，例如 scripts/clean-temp.ps1' }, h('input', { className: 'ml-input', value: current.scriptPath, onChange: (event) => patchDraft({ scriptPath: event.target.value }) })),
                    h(
                      Field,
                      { label: '运行时' },
                      h(
                        'select',
                        { className: 'ml-input', value: current.runtime, onChange: (event) => patchDraft({ runtime: event.target.value }) },
                        RUNTIMES.map((runtime) => h('option', { key: runtime, value: runtime }, runtime)),
                      ),
                    ),
                    h(Field, { label: '工作目录模板', hint: '可写 {{参数名}}' }, h('input', { className: 'ml-input', value: current.cwd, onChange: (event) => patchDraft({ cwd: event.target.value }) })),
                    h(Field, { label: '预期结果' }, h('input', { className: 'ml-input', value: current.expect, onChange: (event) => patchDraft({ expect: event.target.value }), placeholder: '例如：输出 deleted N files' })),
                  ),
                  h(Field, { label: '参数模板（JSON 数组）', hint: '{{script}} 是脚本绝对路径，{{参数名}} 是参数值' }, h('textarea', { className: 'ml-input ml-code', value: current.argsText, onChange: (event) => patchDraft({ argsText: event.target.value }), rows: 5, spellCheck: false })),
                  h(Field, { label: '脚本内容', hint: current.id ? '保存时写回上面的脚本路径（会先备份旧版到 archive/）' : '新建时自动在 scripts/ 下生成文件' }, h('textarea', { className: 'ml-input ml-code ml-code-tall', value: current.content, onChange: (event) => patchDraft({ content: event.target.value }), rows: 10, spellCheck: false, placeholder: '脚本正文' })),
                )
              : null,
            isStepsKind ? h(Field, { label: '步骤（playbook / hybrid 用）', hint: '一行一步，写清用什么工具、什么顺序、怎么算成功' }, h('textarea', { className: 'ml-input ml-code', value: current.steps, onChange: (event) => patchDraft({ steps: event.target.value }), rows: 8, placeholder: '1. …\n2. …' })) : null,
            h(
              'div',
              { className: 'ml-section' },
              h('div', { className: 'ml-section-title' }, '试运行（只拼命令，不执行）'),
              (() => {
                const params = []
                try {
                  params.push(...parseJsonArray(current.paramsText, '参数定义'))
                } catch {
                  // 参数 JSON 还没写完
                }
                return params.length > 0
                  ? h(
                      'div',
                      { className: 'ml-params' },
                      params.map((param) =>
                        h(
                          'label',
                          { key: param.name, className: 'ml-param' },
                          h('span', { className: 'ml-label' }, param.name, param.required ? h('span', { className: 'ml-required' }, ' *') : null, param.desc ? h('span', { className: 'ml-hint' }, param.desc) : null),
                          h('input', {
                            className: 'ml-input',
                            value: paramValues[param.name] === undefined ? '' : paramValues[param.name],
                            placeholder: param.default !== undefined ? String(param.default) : param.type || 'string',
                            onChange: (event) => setParamValues((prev) => ({ ...prev, [param.name]: event.target.value })),
                          }),
                        ),
                      ),
                    )
                  : h('div', { className: 'ml-muted' }, '没有参数。')
              })(),
              h(
                'div',
                { className: 'ml-row-actions' },
                h('button', { type: 'button', className: 'ml-btn', onClick: runPreview, disabled: busy || !canPreview }, canPreview ? '生成命令' : '先保存再试运行'),
                previewText ? h('button', { type: 'button', className: 'ml-btn', onClick: copyPreview }, '复制') : null,
              ),
              previewText ? h('pre', { className: 'ml-pre' }, previewText) : null,
            ),
            current.id && versions.length > 0
              ? h(
                  'div',
                  { className: 'ml-section' },
                  h('div', { className: 'ml-section-title' }, '历史版本（共 ' + versions.length + ' 份快照）'),
                  h(
                    'div',
                    { className: 'ml-row-actions' },
                    h(
                      'select',
                      { className: 'ml-input ml-select', value: versionPick, onChange: (event) => setVersionPick(event.target.value) },
                      h('option', { value: '' }, '选择版本…'),
                      versions.map((item) => h('option', { key: item.file, value: item.file }, 'v' + item.version + ' · ' + new Date(item.at).toLocaleString())),
                    ),
                    h('button', { type: 'button', className: 'ml-btn', onClick: rollback, disabled: busy || !versionPick }, '回滚'),
                  ),
                )
              : null,
          )
        : h('div', { className: 'ml-empty ml-empty-editor' }, '左边选一条方法开始编辑，或点「新建」。')

      return h(
        'div',
        { className: 'ml-root' },
        header,
        pathBar,
        settings,
        toolbar,
        missesPanel,
        pickerOpen
          ? h(SessionPicker, {
              sessions,
              open: pickerOpen,
              activeId: viewSession,
              expanded: expandedGroups,
              onToggleGroup: toggleGroup,
              onToggleEnabled: toggleEnabledFor,
              onClose: () => setPickerOpen(false),
              onPick: pickSession,
            })
          : null,
        loadError ? h('div', { className: 'ml-banner ml-banner-error' }, '面板接口连接失败：' + loadError) : null,
        !sessionEnabled ? h('div', { className: 'ml-banner ml-banner-warn' }, '这个对话的方法库是关的：AI 看不到工具、提示词也不注入。把上面的「本对话」滑块打开即可。') : null,
        h('div', { className: 'ml-body' }, h('div', { className: 'ml-list-wrap' }, list), h('div', { className: 'ml-editor-wrap' }, editor)),
        h(
          'div',
          { className: 'ml-footer' },
          h('span', null, '本库 ' + counts.total + ' 条：启用 ' + counts.active + ' · 草稿 ' + counts.draft + ' · 归档 ' + counts.archived + (counts.issues ? ' · ⚠ ' + counts.issues : '')),
          h('span', { className: 'ml-muted' }, '库目录名：' + baseName(overview ? overview.effectiveLibraryDir : '')),
          message ? h('span', { className: message.kind === 'err' ? 'ml-msg ml-msg-err' : 'ml-msg ml-msg-ok' }, message.text) : null,
        ),
      )
    }

    const STYLES = `
      .ml-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;position:relative;box-sizing:border-box}
      .ml-root *,.ml-root *::before,.ml-root *::after{box-sizing:border-box}
      .ml-header{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
      .ml-title{font-weight:600;font-size:14px}
      .ml-header-actions{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
      .ml-btn{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;white-space:nowrap}
      .ml-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
      .ml-btn:disabled{opacity:.5;cursor:default}
      .ml-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
      .ml-btn-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
      .ml-btn-sm{padding:2px 7px;font-size:11px}
      .ml-misses{padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:4px;max-height:180px;overflow:auto}
      .ml-misses-empty{color:var(--dsw-alias-label-secondary);font-size:12px}
      .ml-misses-head{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:2px}
      .ml-miss-row{display:flex;align-items:center;gap:8px}
      .ml-miss-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
      .ml-miss-count{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none}
      .ml-btn-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
      .ml-switch-wrap{display:flex;align-items:center;gap:7px}
      .ml-switch-label{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .ml-switch{position:relative;display:inline-flex;align-items:center;width:36px;height:20px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .16s,border-color .16s;flex:none}
      .ml-switch:disabled{opacity:.5;cursor:default}
      .ml-switch:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}
      .ml-switch-on{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
      .ml-switch-on:hover:not(:disabled){border-color:var(--dsw-alias-state-success-primary)}
      .ml-switch-knob{position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:transform .16s}
      .ml-switch-on .ml-switch-knob{transform:translateX(16px)}
      .ml-switch-sm{width:30px;height:17px}
      .ml-switch-sm .ml-switch-knob{width:9px;height:9px;top:3px;left:3px}
      .ml-switch-sm.ml-switch-on .ml-switch-knob{transform:translateX(13px)}
      .ml-sessionbar{display:flex;align-items:center;gap:6px;min-width:0;flex:0 1 auto}
      .ml-session-btn{display:flex;align-items:center;gap:6px;max-width:340px}
      .ml-session-dot{font-size:10px}
      .ml-dot-on{color:var(--dsw-alias-state-success-primary)}
      .ml-dot-off{color:var(--dsw-alias-state-idle-primary)}
      .ml-session-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}
      .ml-caret{color:var(--dsw-alias-label-secondary);font-size:10px}
      .ml-pathbar{display:flex;align-items:center;gap:8px;padding:6px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
      .ml-path-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
      .ml-dir{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:56%;flex:1;min-width:120px}
      .ml-picker{position:absolute;top:52px;left:14px;z-index:30;width:min(520px,calc(100% - 28px));max-height:min(60vh,520px);overflow-y:auto;overflow-x:hidden;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.18);display:flex;flex-direction:column}
      .ml-picker-head{padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}
      .ml-picker-body{padding:6px}
      .ml-picker-group{padding:3px 0}
      .ml-picker-folder{display:flex;align-items:center;gap:7px;width:100%;min-width:0;text-align:left;background:transparent;border:1px solid transparent;border-radius:8px;padding:7px 8px;cursor:pointer;color:inherit;font:inherit;font-size:12px}
      .ml-picker-folder:hover{background:var(--dsw-alias-bg-layer-1)}
      .ml-picker-folder-open{background:var(--dsw-alias-bg-layer-1)}
      .ml-folder-caret{width:10px;color:var(--dsw-alias-label-secondary);font-size:10px}
      .ml-folder-icon{font-size:12px;line-height:1}
      .ml-folder-label{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ml-folder-count{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .ml-folder-body{display:flex;flex-direction:column;gap:2px;padding:2px 0 4px 20px;min-width:0}
      .ml-picker-item{display:flex;align-items:center;gap:8px;width:100%;min-width:0;text-align:left;background:transparent;border:1px solid transparent;border-radius:8px;padding:5px 8px;cursor:pointer;color:inherit;font:inherit;font-size:12px}
      .ml-picker-item:hover{background:var(--dsw-alias-bg-layer-1)}
      .ml-picker-item-active{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
      .ml-picker-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ml-picker-item .ml-badge{flex:none}
      .ml-picker-item .ml-switch{flex:none;margin-left:2px}
      .ml-picker-foot{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;justify-content:flex-end}
      .ml-settings{border-bottom:1px solid var(--dsw-alias-border-l1);padding:10px 14px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1)}
      .ml-settings-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
      .ml-settings-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .ml-settings-divider{height:1px;background:var(--dsw-alias-border-l1);margin:4px 0}
      .ml-check{font-size:12px}
      .ml-toolbar{display:flex;gap:8px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
      .ml-input{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;font-size:12px;font-family:inherit;outline:none;min-width:0}
      .ml-input:focus{border-color:var(--dsw-alias-brand-primary)}
      .ml-grow{flex:1;min-width:160px}
      .ml-select{max-width:140px}
      .ml-code{font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.45;resize:vertical}
      .ml-code-tall{min-height:160px}
      .ml-textarea-sm{resize:vertical}
      .ml-body{display:flex;flex:1;min-height:0}
      .ml-list-wrap{width:360px;min-width:260px;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto}
      .ml-list{display:flex;flex-direction:column;gap:4px;padding:8px}
      .ml-cat{display:flex;flex-direction:column;gap:2px;min-width:0}
      .ml-cat-head{display:flex;align-items:center;gap:6px;width:100%;min-width:0;text-align:left;background:transparent;border:1px solid transparent;border-radius:8px;padding:5px 7px;cursor:pointer;color:inherit;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary)}
      .ml-cat-head:hover{background:var(--dsw-alias-bg-layer-1)}
      .ml-cat-head-open{color:var(--dsw-alias-label-primary)}
      .ml-cat-caret{width:9px;font-size:9px;flex:none;color:var(--dsw-alias-label-secondary)}
      .ml-cat-label{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ml-cat-count{flex:none;font-size:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px;color:var(--dsw-alias-label-secondary)}
      .ml-cat-body{display:flex;flex-direction:column;gap:4px;min-width:0;padding-left:2px}
      .ml-row{display:flex;flex-direction:column;gap:4px;text-align:left;background:transparent;border:1px solid transparent;border-radius:8px;padding:8px 10px;cursor:pointer;color:inherit;font:inherit}
      .ml-row:hover{background:var(--dsw-alias-bg-layer-1)}
      .ml-row-active{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-brand-primary)}
      .ml-row-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .ml-row-name{font-weight:600;font-size:13px}
      .ml-row-intent{font-size:12px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .ml-row-meta{display:flex;gap:10px;font-size:11px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
      .ml-row-warn{font-size:11px;color:var(--dsw-alias-state-warn-primary)}
      .ml-badge{font-size:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 7px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .ml-badge-brand{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
      .ml-badge-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
      .ml-badge-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
      .ml-badge-idle{opacity:.75}
      .ml-editor-wrap{flex:1;min-width:0;overflow:auto}
      .ml-editor{padding:14px 16px;display:flex;flex-direction:column;gap:10px;max-width:980px}
      .ml-editor-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .ml-editor-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-secondary)}
      .ml-editor-actions{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
      .ml-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}
      .ml-field{display:flex;flex-direction:column;gap:4px;min-width:0}
      .ml-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
      .ml-hint{font-size:11px;color:var(--dsw-alias-state-idle-primary);margin-left:6px}
      .ml-required{color:var(--dsw-alias-state-error-primary);margin-left:2px}
      .ml-section{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}
      .ml-section-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
      .ml-params{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
      .ml-param{display:flex;flex-direction:column;gap:4px}
      .ml-row-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .ml-pre{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:0;max-height:280px;overflow:auto}
      .ml-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:16px}
      .ml-empty-editor{padding:40px 16px;text-align:center}
      .ml-muted{font-size:11px;color:var(--dsw-alias-label-secondary)}
      .ml-mono{font-family:ui-monospace,Consolas,monospace;font-size:11px}
      .ml-ellipsis{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ml-banner{padding:8px 14px;font-size:12px}
      .ml-banner-error{color:var(--dsw-alias-state-error-primary)}
      .ml-banner-warn{color:var(--dsw-alias-state-warn-primary)}
      .ml-footer{display:flex;gap:14px;align-items:center;padding:6px 14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
      .ml-msg-ok{color:var(--dsw-alias-state-success-primary)}
      .ml-msg-err{color:var(--dsw-alias-state-error-primary)}
    `

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-method-library', 'styles')
          style.textContent = STYLES
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'method-library: panel styles')

        // 顶部标签栏（对话 / 轨迹 / 上下文 / AI记忆 / 方法库）里的「方法库」
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.view', () =>
              ctx.slots.register(
                {
                  name: 'conversation.view',
                  id: 'method-library',
                  order: 45,
                  label: () => '方法库',
                },
                MethodLibraryPanel,
              ),
            ),
          'method-library: conversation view tab',
        )
      },
    }
  },
})
