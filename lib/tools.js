/**
 * 给 AI 的 5 个工具：搜索 → 看详情 → 发货 → 回报 → 存/改。
 *
 * 插件不执行任何命令；method_use 只返回「填好参数的完整命令或步骤」，
 * 由 AI 用自己的终端工具执行，再把结果 method_report 回来。
 */

function text(value) {
  return [{ type: 'text', text: String(value) }]
}

function fmtParams(params) {
  if (!Array.isArray(params) || params.length === 0) return '无'
  return params
    .map((param) => {
      const bits = []
      if (param.required) bits.push('必填')
      if (param.default !== undefined && param.default !== '') bits.push('默认 ' + param.default)
      return param.name + '(' + (param.type || 'string') + (param.desc ? '：' + param.desc : '') + (bits.length ? '，' + bits.join('，') : '') + ')'
    })
    .join('；')
}

function fmtHealth(health) {
  if (!health || health.state === 'ok') return ''
  const issues = Array.isArray(health.issues) && health.issues.length > 0 ? '（' + health.issues.join('；') + '）' : ''
  return (health.state === 'broken' ? ' ⚠不可用' : ' ⚠可能过时') + issues
}

function fmtTime(ms) {
  if (!ms) return '从未'
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function searchText(args, value) {
  const items = Array.isArray(value?.items) ? value.items : []
  const query = value?.query || ''
  if (items.length === 0) {
    return (
      '方法库里没有匹配「' + query + '」的方法（可搜条目 ' + (value?.total ?? 0) + ' 条）。\n' +
      '可以换几个说法再搜；如果这次做完发现是件会重复的事，用 method_save 把它存成方法（name + intent + kind + params，script 型给 script.path/script.code）。'
    )
  }
  const lines = ['方法库命中 ' + items.length + ' 条（可搜 ' + (value?.total ?? 0) + ' 条，按匹配度排序）：']
  items.forEach((item, index) => {
    lines.push(
      (index + 1) + '. ' + item.id + ' · ' + item.name + ' · ' + item.kind + ' · 用过 ' + item.uses + ' 次 · 成功率 ' + Math.round((item.okRate || 0) * 100) + '%' + fmtHealth(item.health),
    )
    if (item.intent) lines.push('   什么时候用：' + item.intent)
    lines.push('   参数：' + fmtParams(item.params))
  })
  lines.push('下一步：看中哪条就 method_get(id) 看详细步骤/脚本，然后 method_use(id, args) 让它发货；都不是你要的再考虑存新的。')
  return lines.join('\n')
}

function detailText(args, value) {
  const method = value?.method
  if (!method) return '没读到这条方法。'
  const lines = []
  lines.push('【' + method.name + '】 ' + method.id)
  lines.push('类型：' + method.kind + '｜状态：' + method.status + '｜风险：' + method.risk + '｜版本：v' + method.version)
  if (method.intent) lines.push('什么时候用：' + method.intent)
  if (method.aliases.length > 0) lines.push('别名：' + method.aliases.join('、'))
  if (method.tags.length > 0) lines.push('标签：' + method.tags.join('、'))
  lines.push('参数：' + fmtParams(method.params))
  lines.push('统计：用过 ' + method.uses + ' 次｜成功率 ' + Math.round((method.okRate || 0) * 100) + '%｜最近使用 ' + fmtTime(method.lastUsedAt))
  const health = method.health
  if (health && health.state !== 'ok') lines.push('体检：' + health.state + '（' + health.issues.join('；') + '）')
  if (method.kind !== 'playbook') {
    lines.push('脚本文件：' + (method.scriptAbs || method.scriptPath || '(未登记)'))
    if (method.script?.runtime) lines.push('运行时：' + method.script.runtime)
    if (method.script?.cwd) lines.push('工作目录模板：' + method.script.cwd)
    if (method.script?.expect) lines.push('预期结果：' + method.script.expect)
    if (method.scriptContent) {
      const body = method.scriptContent.length > 6000 ? method.scriptContent.slice(0, 6000) + '\n…（脚本过长，已截断）' : method.scriptContent
      lines.push('脚本内容：\n```\n' + body + '\n```')
    }
  }
  if (method.kind !== 'script' && method.steps) lines.push('步骤：\n' + method.steps)
  if (method.examples && method.examples.length > 0) {
    lines.push('示例：' + method.examples.slice(0, 3).map((example) => JSON.stringify(example)).join('；'))
  }
  if (method.lastFailure) {
    lines.push('上次失败（' + fmtTime(method.lastFailure.at) + '）：' + (method.lastFailure.problem || method.lastFailure.note || '没有备注'))
  }
  lines.push('下一步：参数齐了就 method_use(id, args) 发货；发现步骤/脚本/参数不对，直接用 method_save 带 id + patch 改（版本自动 +1）。')
  return lines.join('\n')
}

function useText(args, value) {
  const lines = []
  if (!value) return '没有拿到可执行内容。'
  lines.push('已发货：' + (value.name || '') + '（' + value.id + '）')
  if (value.health && value.health.state !== 'ok') {
    lines.push('⚠ 体检：' + value.health.state + '——' + (value.health.issues || []).join('；') + '。执行前先确认，必要时 method_get 并用 method_save 修好。')
  }
  if (value.risk === 'high') lines.push('⚠ 高风险方法：会改动/删除或外发数据，执行前先跟用户确认。')
  if (Array.isArray(value.warnings) && value.warnings.length > 0) lines.push('⚠ ' + value.warnings.join('；'))
  if (value.kind === 'playbook') {
    lines.push('类型：playbook（按步骤自己执行）')
    lines.push('步骤：\n' + (value.steps || '(步骤为空)'))
  } else {
    lines.push('类型：' + value.kind + (value.kind === 'hybrid' ? '（先跑命令，再按步骤收尾）' : ''))
    lines.push('命令：\n' + value.command)
    if (value.cwd) lines.push('工作目录：' + value.cwd)
    if (value.expect) lines.push('预期结果：' + value.expect)
    if (value.steps) lines.push('收尾步骤：\n' + value.steps)
  }
  if (value.params && Object.keys(value.params).length > 0) lines.push('本次参数：' + JSON.stringify(value.params))
  lines.push('下一步：' + (value.next || '执行完调 method_report 回报结果。'))
  return lines.join('\n')
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
  required: ['ok', 'message'],
}

function renderMessage(args, value) {
  return text(value && typeof value.message === 'string' ? value.message : '完成。')
}

export function registerTools(ctx, hub) {
  const disposers = []

  /**
   * 工具永远按「调用它的那个会话」解析库。
   * 关掉的会话一律抛 SESSION_DISABLED —— 就算拿不到会话上下文（回退路径），也不许绕过开关
   * 去摸全局库：关掉就是关掉，不能在后台接口里被当成「没会话」放行。
   */
  const engineOf = (exec) => {
    const explicit = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
    const sessionId = explicit || hub.currentSession() || ''
    if (!sessionId) {
      // 真·无会话（后台/命令行直调）：没有会话就没有开关可绕过，退回全局库
      return hub.globalEngine
    }
    return hub.requireEngine(sessionId)
  }

  disposers.push(
    ctx.tools.register({
      name: 'method_search',
      description: [
        '本地方法库检索：把「重复做过的事」当成可复用方法来搜。',
        '什么时候用：一件多步骤的事你以前多半做过（打包发布、清理临时文件、批量改文件名、导出报表、跑某套检查…），先搜一下再动手，能省掉重新推导和试错。',
        '只返回卡片清单（id、名字、什么时候用、参数、成功率、体检提示），不返回正文；看中了再 method_get。',
        '搜不到就按常规做；做完如果发现是件会重复的事，用 method_save 存成方法。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '用自然语言写你想做的事，越像人话越好，例如「清临时文件」「给插件打 tag 发版」。' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选：按标签收窄（文件、发布、语音…），要全部命中。' },
          limit: { type: 'integer', minimum: 1, maximum: 30, description: '返回条数，默认 5。' },
          includeDrafts: { type: 'boolean', description: '是否连草稿（未确认的方法）一起搜，默认否。' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderMessage },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const engine = engineOf(exec)
        const result = engine.search(args?.query, {
          tags: args?.tags,
          limit: args?.limit,
          includeDrafts: args?.includeDrafts === true,
        })
        return { ok: true, message: searchText(args, result) }
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'method_get',
      description: '读一条方法的完整内容：参数、脚本路径与正文、步骤、示例、体检问题、上次失败原因。method_use 之前用它确认参数怎么填、命令长什么样。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '方法 id，例如 m_7f3a9c21（来自 method_search 的返回）。' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderMessage },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const engine = engineOf(exec)
        const data = engine.detail(args?.id)
        return { ok: true, message: detailText(args, data) }
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'method_use',
      description: [
        '取用一条方法：插件把参数填好，返回「可以直接执行的完整命令」或「步骤清单」。',
        'script 型：返回 command + cwd + expect，请用你自己的终端工具（pwsh）执行这条命令——插件本身不执行任何命令。',
        'playbook 型：返回 steps，你按步骤用自己的工具做。',
        '执行完（成功或失败）都要调 method_report 回报，库里才会记成功率和体检状态。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '方法 id。' },
          args: {
            type: 'object',
            description: '参数对象，键取自方法 params。可省略有默认值的参数；必填参数缺了会报错并告诉你缺什么。',
            additionalProperties: true,
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderMessage },
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const engine = engineOf(exec)
        const data = engine.preview(args?.id, args?.args)
        return { ok: true, message: useText(args, data) }
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'method_report',
      description: [
        '回报一次方法使用的结果（method_use 之后必调）：ok=true 表示按命令/步骤真的做成了；ok=false 时带 note/problem 说明哪一步不对。',
        '失败时插件会提示怎么修；你也可以在同一个调用里带 patch 直接改好这条方法（脚本路径、参数、步骤等），版本自动 +1，可回滚。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '方法 id。' },
          ok: { type: 'boolean', description: '这次是否真的执行成功。' },
          note: { type: 'string', description: '一句话结果，例如「删了 12 个文件」「脚本报找不到路径」。' },
          problem: { type: 'string', description: '失败时：具体哪里不对（报错、路径变了、参数含义不符…），越具体越有用。' },
          patch: {
            type: 'object',
            description: '可选：顺手修这条方法。只传要改的字段（name/intent/aliases/tags/params/steps/script/risk/status）。',
            additionalProperties: true,
          },
        },
        required: ['id', 'ok'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderMessage },
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const engine = engineOf(exec)
        const data = engine.report(args?.id, {
          ok: args?.ok === true,
          note: args?.note,
          problem: args?.problem,
          patch: args?.patch,
        })
        return { ok: true, message: data.message || '已记账。' }
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'method_save',
      description: [
        '把一件事存成方法（或改已有方法）。做完一件会重复的事，就存一条；发现方法过时/不对，也用它修。',
        '必填 name；建议同时给 intent（什么时候该用它）和 params（参数）。',
        'kind=playbook：给 steps（自然语言步骤）。kind=script：给 script.path（库里 scripts/ 下已有文件）或 script.code（自动生成文件，推荐）。kind=hybrid：两者都给。',
        'script.args 是参数模板，例如 ["-NoProfile","-File","{{script}}","-Dir","{{dir}}"]；不填则默认按 params 自动生成。',
        '更新已有方法时带 id，只传要改的字段即可（patch 语义），版本自动 +1。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '更新已有方法时填它的 id；新建不要填。' },
          name: { type: 'string', description: '方法名，一句话，例如「清理 7 天前的临时文件」。' },
          intent: { type: 'string', description: '什么时候该用它（这是搜索匹配的主文本），例如「当工作区临时文件堆积、需要批量删 N 天前的 .tmp 时」。' },
          kind: { type: 'string', enum: ['script', 'playbook', 'hybrid'], description: '类型：script 跑脚本 / playbook 按步骤做 / hybrid 先脚本后步骤。默认 playbook。' },
          aliases: { type: 'array', items: { type: 'string' }, description: '别名/口语说法，例如「清缓存」「cleanup temp」。命中权重最高，值得多写几个。' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，例如 文件、发布、语音。' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'], description: '风险级：low 只读查询 / medium 有改动 / high 删除或外发。只用于提示，不拦截。' },
          status: { type: 'string', enum: ['active', 'draft', 'disabled', 'archived'], description: '状态，默认 active。' },
          steps: { type: 'string', description: 'playbook/hybrid 的自然语言步骤，一行一步，写清用什么工具、什么顺序、怎么判断成功。' },
          params: {
            type: 'array',
            description: '参数定义数组。',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '参数名，英文短横线/下划线，例如 dir、days。' },
                type: { type: 'string', enum: ['string', 'number', 'path', 'bool', 'enum'], description: '类型，默认 string。path 会在体检时检查默认值是否存在。' },
                required: { type: 'boolean', description: '是否必填。' },
                default: { description: '默认值（数字就传数字）。' },
                desc: { type: 'string', description: '一句话说明这个参数是什么。' },
                options: { type: 'array', items: { type: 'string' }, description: 'type=enum 时的可选值。' },
              },
              required: ['name'],
            },
          },
          script: {
            type: 'object',
            description: 'script / hybrid 用。给 code 会自动在库的 scripts/ 下生成文件并登记 path。',
            properties: {
              path: { type: 'string', description: '库内相对路径，例如 scripts/clean-temp.ps1（相对库根目录）。' },
              runtime: { type: 'string', enum: ['pwsh', 'bash', 'node', 'python'], description: '运行时，默认 pwsh。' },
              code: { type: 'string', description: '脚本正文；给了就自动落成文件（ps1/sh/mjs/py 按 runtime）。' },
              args: { type: 'array', items: { type: 'string' }, description: '参数模板 token 数组；{{script}} 是脚本绝对路径，{{参数名}} 是参数值。' },
              cwd: { type: 'string', description: '工作目录模板，例如 {{dir}}。' },
              expect: { type: 'string', description: '预期结果，一句话，例如「输出 deleted N files」。' },
            },
            additionalProperties: false,
          },
          examples: {
            type: 'array',
            description: '用法示例。',
            items: {
              type: 'object',
              properties: {
                args: { type: 'object', additionalProperties: true, description: '示例参数。' },
                out: { type: 'string', description: '预期输出摘要。' },
              },
            },
          },
        },
        required: [],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderMessage },
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const engine = engineOf(exec)
        const data = engine.save(args, { by: 'ai' })
        const lines = []
        lines.push((data.created ? '已新建方法' : '已更新方法') + '：' + data.id + '（v' + data.version + '）')
        if (data.warnings && data.warnings.length > 0) lines.push('提醒：' + data.warnings.join('；'))
        if (data.duplicateOf) lines.push('可能重复：' + data.duplicateOf + '，如果确认是同一件事，考虑只留一条。')
        lines.push('下次遇到同类事，method_search 就能搜到它了。')
        return { ok: true, message: lines.join('\n') }
      },
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 忽略
      }
    }
  }
}
