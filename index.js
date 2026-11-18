/**
 * 本地方法库（Method Library）· DSH 插件入口
 *
 * 一句话：把重复做过的事沉淀成「方法卡片」，AI 搜索命中后拿到填好参数的命令
 * 或步骤，自己执行；结果回报入库；方法过时能被 AI 自己修好。
 *
 * 这个插件永远不执行任何命令（零执行权），只做：检索 / 填参 / 发货 / 记账。
 *
 * 会话级（跟 AI记忆 一样的形态）：
 * - 每个会话有 ● 开 / ○ 关；关掉的会话看不到这 5 个工具、提示词一个字都不注入。
 * - 每个会话可以单独指定库目录（不同项目用不同的库），没指定就跟随全局默认。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHub } from './lib/hub.js'
import { registerTools } from './lib/tools.js'
import { registerApi } from './lib/api.js'

export const inject = ['tools', 'webServer', 'systemPrompt']

const TOOL_NAMES = ['method_search', 'method_get', 'method_use', 'method_report', 'method_save']

const PROMPT_TEXT = [
  '## 本地方法库',
  '遇到可能重复做过的多步操作（发布、清理、批量改名、导出报表、跑检查…），先 method_search 搜一下再动手，能省掉重新推导和试错。',
  '命中就 method_get 看参数、method_use 取用：script 型返回一条填好参数的完整命令，你自己用终端工具执行（插件不执行）；playbook 型返回步骤，你照做。',
  '做完不管成败都调 method_report 回报（失败带 problem/note，可同轮带 patch 直接修正方法）；发现这事以后还会重复，用 method_save 存成方法：name、intent（什么时候用它）、params 要写清。',
].join('\n')

const SECTION_REGISTRY_KEY = Symbol.for('method-library.prompt-sections')

/** hot reload 时用于回收上一个插件实例留下的 section / restrict，避免重复注册报错。 */
function sectionRegistry() {
  try {
    if (!globalThis[SECTION_REGISTRY_KEY]) globalThis[SECTION_REGISTRY_KEY] = new Map()
    return globalThis[SECTION_REGISTRY_KEY]
  } catch {
    return new Map()
  }
}

function serviceOf(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
    return ctx[name]
  } catch {
    return undefined
  }
}

function agentPromptService(agentCtx) {
  if (!agentCtx) return undefined
  const direct = serviceOf(agentCtx, 'systemPrompt')
  return direct
}

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const pluginDir = path.dirname(fileURLToPath(import.meta.url))
  const hub = createHub({ pluginDir, config: cfg, getService: (name) => serviceOf(ctx, name) })

  try {
    hub.init()
  } catch (error) {
    try {
      console.warn('[method-library] 初始化失败：' + (error && error.message ? error.message : String(error)))
    } catch {
      // 忽略
    }
  }

  ctx.effect(() => registerTools(ctx, hub), 'method-library: tools')
  ctx.effect(() => registerApi(ctx, hub), 'method-library: panel api')

  // ── 按会话安装提示词 / 隐藏工具 ──────────────────────────────────────
  const liveAgents = new Map()
  const scopes = new Map()

  const disposeScope = (sessionId) => {
    const entry = scopes.get(sessionId)
    if (!entry) return
    for (const dispose of entry.disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // agent 已经销毁时 disposal 可能失败
      }
    }
    scopes.delete(sessionId)
    sectionRegistry().delete(sessionId)
  }

  const applySessionScope = (agent) => {
    if (!agent || !agent.id) return
    const sessionId = String(agent.id)
    const agentCtx = agent.ctx
    if (!agentCtx || typeof agentCtx.effect !== 'function') return
    disposeScope(sessionId)
    const disposers = []
    const enabled = hub.isEnabled(sessionId)
    if (enabled) {
      const systemPrompt = agentPromptService(agentCtx)
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        try {
          const dispose = agentCtx.effect(
            () =>
              systemPrompt.section({
                name: 'method-library',
                order: 99990,
                text: PROMPT_TEXT,
              }),
            'method-library: prompt hint',
          )
          disposers.push(dispose)
        } catch {
          // 旧实例的 section 还在时不要拖垮整个插件
        }
      }
    } else if (agentCtx.tools && typeof agentCtx.tools.restrict === 'function') {
      try {
        const dispose = agentCtx.effect(
          () => agentCtx.tools.restrict({ deny: TOOL_NAMES }),
          'method-library: hide tools in disabled conversation',
        )
        disposers.push(dispose)
      } catch {
        // restrict 不可用时退化为工具报错
      }
    }
    scopes.set(sessionId, { disposers })
    sectionRegistry().set(sessionId, { sessionId })
  }

  /** 面板里切换「本对话」开关后，让当前活着的会话立刻生效（不用等新会话）。 */
  hub.onSessionChanged = (sessionId) => {
    const agent = liveAgents.get(String(sessionId))
    if (agent) {
      try {
        applySessionScope(agent)
      } catch {
        // 忽略
      }
    }
  }

  const installAgent = (payload) => {
    const agent = payload && payload.agent ? payload.agent : payload
    if (!agent || !agent.id) return
    const sessionId = String(agent.id)
    liveAgents.set(sessionId, agent)
    try {
      applySessionScope(agent)
    } catch {
      // 单个会话装不上不影响其它会话
    }
  }

  const uninstallAgent = (payload) => {
    const agent = payload && payload.agent ? payload.agent : payload
    if (!agent || !agent.id) return
    const sessionId = String(agent.id)
    liveAgents.delete(sessionId)
    disposeScope(sessionId)
  }

  if (typeof ctx.on === 'function') {
    ctx.effect(() => {
      const disposers = []
      const on = (name, handler) => {
        try {
          const dispose = ctx.on(name, handler)
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch {
          // 事件不存在就跳过
        }
      }
      on('agent/created', installAgent)
      on('agent/disposed', uninstallAgent)

      // 面板要「当前对话」：记最近一次有动静的会话（同 AI记忆 的做法）
      const note = (sessionId) => {
        if (typeof sessionId === 'string' && sessionId !== '') hub.noteVisible(sessionId)
      }
      on('api-session/added', (summary) => note(summary && (summary.sessionId || (summary.header && summary.header.id))))
      on('api-session/activity', (sessionId) => note(sessionId))
      on('session/event', (session, event) => {
        if (!session || !event) return
        if (event.type !== 'user/message' && event.type !== 'assistant/message') return
        note(session.id || session.sessionId)
      })

      // 插件重载时，把当前已经活着的会话也补装一遍（否则老会话会没有提示词）
      try {
        const agents = serviceOf(ctx, 'agents')
        const list = agents && typeof agents.list === 'function' ? agents.list() : []
        for (const agent of Array.isArray(list) ? list : []) installAgent(agent)
      } catch {
        // 拿不到就不补装
      }

      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // 忽略
          }
        }
        for (const sessionId of [...scopes.keys()]) disposeScope(sessionId)
      }
    }, 'method-library: per-conversation prompt and tool scope')
  }

  return { hub }
}
