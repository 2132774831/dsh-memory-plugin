/* ============================================================================
 * dsh-local-memory — Host 半侧
 * ----------------------------------------------------------------------------
 * 纯本地长期记忆，跨对话、跨项目，全部数据在一个本地 JSON 文件里：
 * 不联网、不调大模型、不需要任何 key。
 *
 * 提供：
 *   1) 四个模型工具：memory_save / memory_search / memory_forget / memory_list
 *   2) 每轮自动回忆（用你的输入做关键词检索，命中就注入上下文）
 *   3) 系统提示词里的记忆库说明
 *   4) 设置页要用的 HTTP 路由（读配置、保存配置、查看/新增/编辑/删除记忆）
 *
 * 注入的服务只用三个确定存在的：tools / systemPrompt / webServer。
 * sessions（拿会话 cwd）走 ctx.get() 软获取。
 *
 * 注意：DSH 的 ToolExecution 里 `agent` 只有 `{id}`，没有 cwd。
 * 会话工作目录的权威来源是 `ctx.sessions.get(id).header.cwd`。
 * ========================================================================== */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MAX_TEXT_LENGTH, MemoryStore, defaultStoreFile } from './store.js'
import { detectProject } from './projects.js'

const NS = 'dsh-local-memory'
const ROUTE_BASE = '/dsh-local-memory'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'dsh-local-memory-config.json')

/** 插件默认配置。 */
export const DEFAULTS = {
  enabled: true,
  storeFile: defaultStoreFile(DSH_HOME),
  maxMemories: 5000,

  // 自动回忆
  autoRecall: true,
  autoRecallMaxItems: 5,
  autoRecallMinChars: 8,

  // 写入行为
  autoTagProject: true,

  // 呈现
  injectBrief: true
}

const BOOL_KEYS = ['enabled', 'autoRecall', 'autoTagProject', 'injectBrief']
const TEXT_KEYS = ['storeFile']
const RANGES = {
  maxMemories: [10, 100000],
  autoRecallMaxItems: [1, 20],
  autoRecallMinChars: [0, 500]
}

/**
 * 归一化配置。
 * @param {unknown} input 原始配置。
 * @returns {typeof DEFAULTS} 归一化后的配置。
 */
export function normalizeConfig(input) {
  const out = { ...DEFAULTS }
  const src = input && typeof input === 'object' ? input : {}

  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in src) || src[key] === undefined || src[key] === null) continue
    const value = src[key]
    if (BOOL_KEYS.includes(key)) {
      out[key] = value === true || value === 'true' || value === 1 || value === '1'
    } else if (RANGES[key]) {
      const [lo, hi] = RANGES[key]
      const n = Number(value)
      out[key] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : DEFAULTS[key]
    } else if (TEXT_KEYS.includes(key)) {
      out[key] = String(value).slice(0, 512).trim()
    } else {
      out[key] = value
    }
  }

  if (!out.storeFile) out.storeFile = DEFAULTS.storeFile
  return out
}

function readConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')))
  } catch (err) {
    return { ...DEFAULTS }
  }
}

function writeConfig(next) {
  const cfg = normalizeConfig(next)
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  const tmp = `${CONFIG_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  fs.renameSync(tmp, CONFIG_FILE)
  return cfg
}

/* ── 工具 schema ─────────────────────────────────────────────────────────── */

const SAVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: {
      type: 'string',
      description: '要记住的内容。写成能独立读懂的一句话，包含「为什么」，不要只写「做了什么」。'
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '可选标签，如 ["topic:auth"]、["pref"]。检索时可以按标签过滤。'
    }
  }
}

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', description: '自然语言查询。中文按词匹配，具体一些更容易命中。' },
    tags: { type: 'array', items: { type: 'string' }, description: '只在这些标签的记忆里找。' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回几条，默认 10。' }
  }
}

const FORGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', description: '要删除的记忆 id（从 memory_list / memory_search 结果里拿）。' }
  }
}

const LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回几条，默认 20。' },
    tag: { type: 'string', description: '只看带这个标签的记忆。' }
  }
}

/** 纯文本内容块。 */
function textBlock(text) {
  return [{ type: 'text', text: String(text == null ? '' : text) }]
}

/** 组装一个 DSH 工具定义。execute 内兜异常，失败也返回可读文本而不是炸掉整轮。 */
function defineTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => textBlock(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    },
    execute: async (args, exec) => {
      try {
        return await spec.run(args && typeof args === 'object' ? args : {}, exec || {})
      } catch (err) {
        return `[记忆库调用失败] ${String((err && err.message) || err)}`
      }
    },
    isConcurrencySafe: spec.concurrencySafe || (() => true)
  }
}

/** 把时间戳格式化成 YYYY-MM-DD。 */
function formatDate(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return '未知时间'
  try {
    return new Date(n).toISOString().slice(0, 10)
  } catch (err) {
    return '未知时间'
  }
}

/** 把一条记忆渲染成给模型看的一行。 */
function renderMemoryLine(memory, index) {
  const tags = Array.isArray(memory.tags) && memory.tags.length ? ` [${memory.tags.join(', ')}]` : ''
  const project = memory.project ? ` (${memory.project})` : ''
  return `${index}. ${memory.text}${tags}${project}  —— id=${memory.id} · ${formatDate(memory.updatedAt || memory.createdAt)}`
}

/**
 * 注册 Host 半侧。
 * @param {import('cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  const disposers = []

  let store = new MemoryStore(readConfig().storeFile)

  /** 重新读配置，并把 store 指向配置里的文件。 */
  function loadConfig() {
    const cfg = readConfig()
    if (store.file !== cfg.storeFile) store = new MemoryStore(cfg.storeFile, { maxMemories: cfg.maxMemories })
    return cfg
  }

  loadConfig()

  /* ── 会话 cwd：从 sessions store 的 header.cwd 拿 ─────────────────────── */

  /**
   * Agent 只有 {id}，cwd 得从 sessions store 取。
   * @param {object} [agent] Agent 对象。
   * @returns {string|null} 会话工作目录。
   */
  function getSessionCwd(agent) {
    const id = agent && agent.id
    if (!id) return null
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(id) : undefined
      const cwd = session && session.header && session.header.cwd
      return typeof cwd === 'string' ? cwd : null
    } catch (err) {
      return null
    }
  }

  /** 工具执行上下文 → 会话工作目录。 */
  function execCwd(exec) {
    const agent = exec && exec.agent
    const fromSession = getSessionCwd(agent)
    if (typeof fromSession === 'string' && fromSession.trim()) return fromSession
    for (const candidate of [agent && agent.cwd, exec && exec.cwd]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate
    }
    return process.cwd()
  }

  /** 当前项目名（用于自动打标签）。 */
  function currentProject(cwd, cfg) {
    if (!cfg.autoTagProject) return ''
    try {
      return detectProject(cwd).name
    } catch (err) {
      return ''
    }
  }

  /* ── 1. 工具注册 ───────────────────────────────────────────────────────── */

  function registerTool(definition) {
    try {
      disposers.push(ctx.tools.register(definition))
    } catch (err) {
      // 重名等情况不该拖垮整个插件
    }
  }

  registerTool(defineTool({
    name: 'memory_save',
    description:
      '把一条值得长期保留的结论写进本地记忆库（存在你本机的文件里，不上传、不联网）。' +
      '适合记：用户偏好、项目约定、历史决策及其原因、踩过的坑、明确的待办。' +
      '不要记：代码里一眼能看出来的东西、临时中间状态、能从 diff 直接读到的东西。' +
      '文本重复时不会新增，而是合并标签并刷新时间。',
    parameters: SAVE_SCHEMA,
    concurrencySafe: () => false,
    run: async (args, exec) => {
      const cfg = loadConfig()
      if (!cfg.enabled) return '[记忆库已关闭] 请在设置页打开「启用本地记忆」。'
      const text = String(args.text || '').trim()
      if (!text) return '没有传入要记住的内容（text 为空）。'
      if (text.length > MAX_TEXT_LENGTH) return `内容太长（上限 ${MAX_TEXT_LENGTH} 字），请精简后再存。`

      const project = currentProject(execCwd(exec), cfg)
      const { memory, created } = store.add({
        text,
        tags: Array.isArray(args.tags) ? args.tags : [],
        project
      })
      return created
        ? `已记住（id=${memory.id}）${memory.project ? `，项目标签：${memory.project}` : ''}。`
        : `这条已经记过了（id=${memory.id}），已合并标签并刷新时间。`
    }
  }))

  registerTool(defineTool({
    name: 'memory_search',
    description:
      '在本地记忆库里检索。默认搜全部记忆（不论哪个对话、哪个项目写的）。' +
      '在动手改代码前、或用户提到「之前/上次/当时」「我们说好」这类跨会话上下文时应该先调用它。' +
      '中文按词与二字组合匹配，查得具体一点更容易命中。',
    parameters: SEARCH_SCHEMA,
    run: async (args) => {
      const cfg = loadConfig()
      if (!cfg.enabled) return '[记忆库已关闭] 请在设置页打开「启用本地记忆」。'
      const query = String(args.query || '').trim()
      if (!query) return '没有传入查询内容（query 为空）。'

      const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 10
      const result = store.search({ q: query, tags: args.tags, limit })
      if (!result.memories.length) {
        const hint = result.total === 0
          ? '记忆库还是空的。'
          : `记忆库里共有 ${result.total} 条，但没有匹配「${query}」的。`
        return `${hint} 如果这件事值得记，可以用 memory_save 写进去。`
      }
      store.markUsed(result.memories.map((memory) => memory.id))
      const lines = [`找到 ${result.memories.length} 条相关记忆（库里共 ${result.total} 条）：`, '']
      result.memories.forEach((memory, index) => lines.push(renderMemoryLine(memory, index + 1)))
      return lines.join('\n')
    }
  }))

  registerTool(defineTool({
    name: 'memory_list',
    description: '列出本地记忆库里最近的记忆（不检索，纯按时间倒序）。用来看看都记了些什么。',
    parameters: LIST_SCHEMA,
    run: async (args) => {
      const cfg = loadConfig()
      if (!cfg.enabled) return '[记忆库已关闭] 请在设置页打开「启用本地记忆」。'
      const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 20
      const result = store.search({ limit, tags: args.tag ? [args.tag] : undefined })
      if (!result.memories.length) return '记忆库还是空的。'
      const lines = [`最近的 ${result.memories.length} 条记忆（库里共 ${result.total} 条）：`, '']
      result.memories.forEach((memory, index) => lines.push(renderMemoryLine(memory, index + 1)))
      return lines.join('\n')
    }
  }))

  registerTool(defineTool({
    name: 'memory_forget',
    description: '从本地记忆库里删除一条记忆。只有在内容确实过时或写错时才用；不确定先问用户。',
    parameters: FORGET_SCHEMA,
    concurrencySafe: () => false,
    run: async (args) => {
      const cfg = loadConfig()
      if (!cfg.enabled) return '[记忆库已关闭] 请在设置页打开「启用本地记忆」。'
      const id = String(args.id || '').trim()
      if (!id) return '没有传入要删除的 id。'
      const ok = store.remove(id)
      return ok ? `已删除 ${id}。` : `没找到 id=${id} 的记忆（可能已经被删过了）。`
    }
  }))

  /* ── 2. 系统提示词：让模型知道有这个记忆库 ─────────────────────────────── */

  try {
    disposers.push(ctx.systemPrompt.section({
      name: `${NS}:brief`,
      order: 60,
      text: () => {
        const cfg = readConfig()
        if (!cfg.enabled || cfg.injectBrief === false) return ''
        let count = 0
        try {
          count = store.stats().count
        } catch (err) {
          count = 0
        }
        return [
          '## 本地长期记忆（dsh-local-memory）',
          '',
          '这个会话接了一个**纯本地**的长期记忆库：数据只存在你本机的文件里，不联网、不上传。',
          `当前已记录 ${count} 条记忆，跨对话、跨项目共享。`,
          '',
          '用法约定：',
          '- 回忆用户偏好、项目约定、历史决策、踩过的坑：`memory_search`。',
          '- 确认了一个值得长期保留的结论：`memory_save`。',
          '- 想看看都记了什么：`memory_list`；内容过时了用 `memory_forget` 删掉。',
          '- 记忆是可能过期的历史结论：与当前代码/用户最新说法冲突时，以现状为准。',
          '- 不要记代码里一眼能看出来的东西，也不要把临时中间状态记进去。'
        ].join('\n')
      }
    }))
  } catch (err) {
    // 提示词注册失败不影响工具可用
  }

  /* ── 3. 每轮自动回忆 ───────────────────────────────────────────────────── */

  /** 从消息数组里取最后一条用户消息的文本。 */
  function latestUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (!message || message.role !== 'user') continue
      const content = message.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        const parts = content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
        if (parts.length) return parts.join('\n')
      }
    }
    return ''
  }

  try {
    disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        const cfg = loadConfig()
        if (!cfg.enabled || !cfg.autoRecall) return decision
        if (!decision || decision.kind !== 'enter') return decision
        const messages = Array.isArray(decision.messages) ? decision.messages : null
        if (!messages) return decision

        const query = latestUserText(messages).trim()
        if (query.length < cfg.autoRecallMinChars) return decision
        if (query.startsWith('/')) return decision

        const result = store.search({ q: query, limit: cfg.autoRecallMaxItems })
        if (!result.memories.length) return decision
        store.markUsed(result.memories.map((memory) => memory.id))

        const lines = ['[本地记忆自动回忆 · 供参考，可能过期，请自行核对]', '']
        result.memories.forEach((memory, index) => lines.push(renderMemoryLine(memory, index + 1)))
        const text = lines.join('\n')

        // UserMessage 字段是 readonly 的：造一条**新**消息，绝不改原对象。
        const injected = { role: 'user', content: [{ type: 'text', text }] }
        return { ...decision, messages: [injected, ...messages] }
      } catch (err) {
        // 自动回忆是尽力而为，失败就安静放行
      }
      return decision
    }))
  } catch (err) {
    // 事件不可用时退化为「只有工具、没有自动回忆」
  }

  /* ── 4. HTTP 路由（设置页用） ───────────────────────────────────────────── */

  registerRoutes(ctx, { disposers, loadConfig })

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (err) {
        // 逐个清理，互不影响
      }
    }
    disposers.length = 0
  })
}

/**
 * 注册设置页要用的路由。全部挂在 `/dsh-local-memory` 前缀下。
 * @param {import('cordis').Context} ctx 插件上下文。
 * @param {object} deps 依赖。
 */
function registerRoutes(ctx, deps) {
  const { disposers, loadConfig } = deps
  if (!ctx.webServer || typeof ctx.webServer.register !== 'function') return

  /** 浏览器信任栅栏：自定义路由必须过一遍，否则任意网页都能读写记忆。 */
  function rejected(req, res) {
    try {
      const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : undefined) || ctx.connection
      if (!conn || typeof conn.requestRejection !== 'function') return false
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch (err) {
      return false
    }
  }

  function sendJson(res, code, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length)
    })
    res.end(body)
  }

  function readBody(req, limit = 256 * 1024) {
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          req.destroy()
          resolve('')
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })
  }

  /** 当前 store（配置里的文件可能被改过，每次现取）。 */
  function currentStore() {
    const cfg = loadConfig()
    return { cfg, store: new MemoryStore(cfg.storeFile, { maxMemories: cfg.maxMemories }) }
  }

  /** 概览：配置 + 统计 + 一段记忆列表。 */
  function statePayload(query) {
    const { cfg, store } = currentStore()
    const stats = store.stats()
    const result = store.search({
      q: query.q || '',
      tags: query.tag ? [query.tag] : undefined,
      limit: Number(query.limit) > 0 ? Number(query.limit) : 50
    })
    return {
      ok: true,
      config: cfg,
      defaults: DEFAULTS,
      configFile: CONFIG_FILE,
      stats,
      total: result.total,
      matched: result.matched,
      memories: result.memories
    }
  }

  disposers.push(ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_BASE,
    handler: async (req, res) => {
      if (rejected(req, res)) return

      let url
      try {
        url = new URL(req.url, 'http://localhost')
      } catch (err) {
        sendJson(res, 400, { ok: false, error: 'bad url' })
        return
      }
      const sub = url.pathname.slice(ROUTE_BASE.length) || '/'
      const method = (req.method || 'GET').toUpperCase()
      const query = Object.fromEntries(url.searchParams.entries())

      try {
        // 概览 / 检索
        if (sub === '/state' && method === 'GET') {
          sendJson(res, 200, statePayload(query))
          return
        }

        // 写入配置
        if (sub === '/config' && method === 'POST') {
          const text = await readBody(req)
          let payload = {}
          try {
            payload = text ? JSON.parse(text) : {}
          } catch (err) {
            sendJson(res, 400, { ok: false, error: 'invalid json' })
            return
          }
          if (payload && payload.action === 'reset') {
            writeConfig(DEFAULTS)
          } else {
            const current = loadConfig()
            const patch = payload && typeof payload.patch === 'object' && payload.patch ? payload.patch : payload
            writeConfig({ ...current, ...patch })
          }
          sendJson(res, 200, statePayload({}))
          return
        }

        // 新增 / 编辑 / 删除记忆
        if (sub === '/memory' && method === 'POST') {
          const text = await readBody(req)
          let payload = {}
          try {
            payload = text ? JSON.parse(text) : {}
          } catch (err) {
            sendJson(res, 400, { ok: false, error: 'invalid json' })
            return
          }
          const { store } = currentStore()
          const action = String(payload.action || 'add')
          if (action === 'add') {
            const body = String(payload.text || '').trim()
            if (!body) {
              sendJson(res, 400, { ok: false, error: '记忆内容不能为空' })
              return
            }
            const { memory, created } = store.add({
              text: body,
              tags: Array.isArray(payload.tags) ? payload.tags : [],
              project: payload.project ? String(payload.project) : ''
            })
            sendJson(res, 200, { ok: true, created, memory, ...statePayload({}) })
            return
          }
          if (action === 'update') {
            const updated = store.update(String(payload.id || ''), {
              text: payload.text,
              tags: payload.tags,
              project: payload.project
            })
            if (!updated) {
              sendJson(res, 404, { ok: false, error: '没找到这条记忆' })
              return
            }
            sendJson(res, 200, { ok: true, memory: updated, ...statePayload({}) })
            return
          }
          if (action === 'delete') {
            const removed = store.remove(String(payload.id || ''))
            sendJson(res, 200, { ok: true, removed, ...statePayload({}) })
            return
          }
          sendJson(res, 400, { ok: false, error: `unknown action: ${action}` })
          return
        }

        sendJson(res, 404, { ok: false, error: `unknown route ${method} ${sub}` })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    }
  }))
}

export { defaultStoreFile }
export const name = NS
export const inject = ['tools', 'systemPrompt', 'webServer']
