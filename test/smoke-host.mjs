/* ============================================================================
 * smoke-host — Host 半侧的离线测试
 * ----------------------------------------------------------------------------
 * 用假 ctx 把插件 apply() 起来，断言：
 *   - 注册了哪些工具 / 提示词段 / 路由 / 事件监听
 *   - 四个工具真的能读写本地记忆
 *   - 会话 cwd 从 sessions store 取（真实 harness 里 agent 只有 id）
 *   - 自动回忆注入的是新消息，不改写原消息
 *   - 设置页要用的路由：读配置、存配置、新增/编辑/删除记忆
 *
 * DSH_HOME 必须在 import 之前指向临时目录（配置路径是模块加载期算出来的）。
 * ========================================================================== */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lm-host-home-'))
process.env.DSH_HOME = DSH_HOME

const { DEFAULTS, apply, normalizeConfig } = await import('../lib/index.js')

let passed = 0
let failed = 0

async function test(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (err) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${(err && err.stack) || err}`)
  }
}

const CONFIG_FILE = path.join(DSH_HOME, 'dsh-local-memory-config.json')
const STORE_FILE = path.join(DSH_HOME, 'dsh-local-memory.json')

function clearAll() {
  for (const file of [CONFIG_FILE, STORE_FILE]) {
    try {
      fs.rmSync(file, { force: true })
    } catch (err) {
      /* noop */
    }
  }
}

function writeConfig(patch) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...DEFAULTS, ...patch }, null, 2), 'utf8')
}

/** 造一个带 git remote 的项目目录。 */
function makeProject(name, remoteUrl) {
  const root = path.join(DSH_HOME, 'projects', name)
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.writeFileSync(path.join(root, '.git', 'config'), `[remote "origin"]\n\turl = ${remoteUrl}\n`, 'utf8')
  return root
}

/* ── 假 ctx ─────────────────────────────────────────────────────────────── */
function makeCtx(options = {}) {
  const sessions = new Map(Object.entries(options.sessions || {}))
  const state = { tools: [], sections: [], routes: [], listeners: [], effects: [] }
  const ctx = {
    tools: {
      register(definition) {
        state.tools.push(definition)
        return () => {}
      }
    },
    systemPrompt: {
      section(section) {
        state.sections.push(section)
        return () => {}
      }
    },
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => {}
      }
    },
    connection: { requestRejection: () => undefined },
    get(name) {
      if (name === 'connection') return ctx.connection
      if (name === 'sessions') {
        return {
          get(id) {
            const cwd = sessions.get(id)
            return cwd ? { header: { cwd } } : undefined
          }
        }
      }
      return undefined
    },
    on(event, listener) {
      state.listeners.push({ event, listener })
      return () => {}
    },
    effect(fn) {
      state.effects.push(fn)
      return () => {}
    }
  }
  return { ctx, state }
}

function toolByName(state, name) {
  const found = state.tools.find((tool) => tool.name === name)
  assert.ok(found, `没找到工具 ${name}（已注册：${state.tools.map((t) => t.name).join(', ')}）`)
  return found
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      res.statusCode = code
      res.headers = headers
    },
    end(chunk) {
      if (chunk) res.body += String(chunk)
    }
  }
  return res
}

function makeReq(method, url, body) {
  const handlers = new Map()
  const req = {
    method,
    url,
    on(event, handler) {
      handlers.set(event, handler)
      return req
    },
    destroy() {},
    async emit() {
      if (body !== undefined && handlers.has('data')) handlers.get('data')(Buffer.from(body, 'utf8'))
      if (handlers.has('end')) await handlers.get('end')()
    }
  }
  return req
}

/** 调一次路由：自动处理 body。 */
async function callRoute(state, method, url, body) {
  const route = state.routes[0]
  const req = makeReq(method, url, body === undefined ? undefined : JSON.stringify(body))
  const res = makeRes()
  const pending = route.handler(req, res)
  await req.emit()
  await pending
  return { res, json: res.body ? JSON.parse(res.body) : null }
}

console.log('smoke-host')

/* ── 配置 ───────────────────────────────────────────────────────────────── */

await test('normalizeConfig 填默认值、夹取区间', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.autoRecallMaxItems, DEFAULTS.autoRecallMaxItems)
  assert.match(cfg.storeFile, /dsh-local-memory\.json$/)

  assert.equal(normalizeConfig({ autoRecallMaxItems: 999 }).autoRecallMaxItems, 20)
  assert.equal(normalizeConfig({ autoRecallMaxItems: 0 }).autoRecallMaxItems, 1)
  assert.equal(normalizeConfig({ autoRecall: 'false' }).autoRecall, false)
  assert.equal(normalizeConfig({ storeFile: '   ' }).storeFile, DEFAULTS.storeFile)
})

/* ── 注册面 ─────────────────────────────────────────────────────────────── */

await test('apply 注册四个工具、一个提示词段、一条路由、一个事件监听', () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)

  assert.deepEqual(
    state.tools.map((tool) => tool.name).sort(),
    ['memory_forget', 'memory_list', 'memory_save', 'memory_search']
  )
  assert.equal(state.sections.length, 1)
  assert.equal(state.sections[0].name, 'dsh-local-memory:brief')
  assert.equal(state.routes.length, 1)
  assert.equal(state.routes[0].path, '/dsh-local-memory')
  assert.equal(state.routes[0].kind, 'prefix')
  assert.deepEqual(state.listeners.map((e) => e.event), ['agent/pre-step'])
  assert.equal(state.effects.length, 1)
})

await test('每个工具都有 output.render 与 isConcurrencySafe', () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)
  for (const tool of state.tools) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.execute, 'function')
    const blocks = tool.output.render({}, 'hi')
    assert.deepEqual(blocks, [{ type: 'text', text: 'hi' }])
    assert.equal(typeof tool.isConcurrencySafe, 'function')
  }
})

await test('提示词段能给出说明，enabled=false 时为空', () => {
  clearAll()
  let ctxPair = makeCtx()
  apply(ctxPair.ctx)
  assert.match(ctxPair.state.sections[0].text({}), /本地长期记忆/)

  writeConfig({ enabled: false })
  ctxPair = makeCtx()
  apply(ctxPair.ctx)
  assert.equal(ctxPair.state.sections[0].text({}), '')
  clearAll()
})

/* ── 工具 ───────────────────────────────────────────────────────────────── */

await test('memory_save 写入本地文件，并按会话 cwd 打项目标签', async () => {
  clearAll()
  const root = makeProject('payments-api', 'git@github.com:acme/payments-api.git')
  const { ctx, state } = makeCtx({ sessions: { s1: root } })
  apply(ctx)
  const tool = toolByName(state, 'memory_save')

  const result = await tool.execute(
    { text: '鉴权用的是轮询而不是 webhook', tags: ['topic:auth'] },
    { agent: { id: 's1' } }
  )
  assert.match(String(result), /已记住/)

  const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
  assert.equal(raw.memories.length, 1)
  assert.equal(raw.memories[0].text, '鉴权用的是轮询而不是 webhook')
  assert.equal(raw.memories[0].project, 'acme-payments-api', '项目名取自 sessions store 的 cwd')
  assert.deepEqual(raw.memories[0].tags, ['topic:auth'])
})

await test('memory_save 重复文本不新增，提示已记过', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)
  const tool = toolByName(state, 'memory_save')

  await tool.execute({ text: '同一条内容' }, {})
  const again = await tool.execute({ text: '同一条内容' }, {})
  assert.match(String(again), /已经记过了?/)
  assert.equal(JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')).memories.length, 1)
})

await test('memory_save 空文本给出提示，不写文件', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)
  const result = await toolByName(state, 'memory_save').execute({ text: '   ' }, {})
  assert.match(String(result), /没有传入要记住的内容/)
  assert.equal(fs.existsSync(STORE_FILE), false)
})

await test('memory_search 能检索到中文记忆', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)
  await toolByName(state, 'memory_save').execute({ text: '鉴权用的是轮询' }, {})
  await toolByName(state, 'memory_save').execute({ text: '数据库连接池配成 20' }, {})

  const result = await toolByName(state, 'memory_search').execute({ query: '鉴权' }, {})
  assert.match(String(result), /找到 1 条相关记忆/)
  assert.match(String(result), /鉴权用的是轮询/)
  assert.equal(String(result).includes('连接池'), false)
})

await test('memory_search 空库 / 无命中给出可操作提示', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)
  const search = toolByName(state, 'memory_search')

  assert.match(String(await search.execute({ query: '任何' }, {})), /还是空的/)
  await toolByName(state, 'memory_save').execute({ text: '已有内容' }, {})
  assert.match(String(await search.execute({ query: '完全不相干' }, {})), /没有匹配/)
})

await test('memory_list 按时间列出，memory_forget 删除', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)
  await toolByName(state, 'memory_save').execute({ text: '第一条' }, {})
  await toolByName(state, 'memory_save').execute({ text: '第二条' }, {})

  const listed = String(await toolByName(state, 'memory_list').execute({}, {}))
  assert.match(listed, /第一条/)
  assert.match(listed, /第二条/)

  const id = /id=(m-[^ ]+)/.exec(listed)[1]
  assert.match(String(await toolByName(state, 'memory_forget').execute({ id }, {})), /已删除/)
  assert.equal(JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')).memories.length, 1)
  assert.match(String(await toolByName(state, 'memory_forget').execute({ id }, {})), /没找到/)
})

await test('enabled=false 时工具退化为提示，不写文件', async () => {
  clearAll()
  writeConfig({ enabled: false })
  const { ctx, state } = makeCtx()
  apply(ctx)
  const result = await toolByName(state, 'memory_save').execute({ text: '不该写入' }, {})
  assert.match(String(result), /记忆库已关闭/)
  assert.equal(fs.existsSync(STORE_FILE), false)
  clearAll()
})

/* ── 自动回忆 ───────────────────────────────────────────────────────────── */

await test('agent/pre-step 命中时注入新消息，不改写原消息', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)
  await toolByName(state, 'memory_save').execute({ text: '鉴权用的是轮询而不是 webhook' }, {})

  const entry = state.listeners.find((item) => item.event === 'agent/pre-step')
  const original = { role: 'user', content: [{ type: 'text', text: '我们鉴权怎么设计的？' }] }
  const before = JSON.stringify(original)
  const decision = { kind: 'enter', messages: [original], startsRequestSeries: true }

  const result = await entry.listener(
    { agent: { id: 's1' }, messages: [original], turn: 1, step: 0 },
    async () => decision
  )

  assert.equal(JSON.stringify(original), before, '原消息对象必须原封不动')
  assert.equal(result.kind, 'enter')
  assert.equal(result.startsRequestSeries, true)
  assert.equal(result.messages.length, 2)
  assert.match(result.messages[0].content[0].text, /本地记忆自动回忆/)
  assert.match(result.messages[0].content[0].text, /鉴权用的是轮询/)
  assert.equal(result.messages[1], original)
})

await test('agent/pre-step 无命中 / 短输入 / 斜杠命令时不注入', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)
  await toolByName(state, 'memory_save').execute({ text: '鉴权用的是轮询' }, {})
  const entry = state.listeners.find((item) => item.event === 'agent/pre-step')

  for (const text of ['hi', '/help', '完全不相干的问题']) {
    const message = { role: 'user', content: [{ type: 'text', text }] }
    const decision = { kind: 'enter', messages: [message] }
    const result = await entry.listener(
      { agent: { id: 's1' }, messages: [message], turn: 1, step: 0 },
      async () => decision
    )
    assert.equal(result.messages.length, 1, `「${text}」不该注入`)
  }
})

await test('autoRecall=false 时不注入', async () => {
  clearAll()
  writeConfig({ autoRecall: false })
  const { ctx, state } = makeCtx()
  apply(ctx)
  await toolByName(state, 'memory_save').execute({ text: '鉴权用的是轮询' }, {})
  const entry = state.listeners.find((item) => item.event === 'agent/pre-step')

  const message = { role: 'user', content: [{ type: 'text', text: '鉴权怎么设计的？' }] }
  const decision = { kind: 'enter', messages: [message] }
  const result = await entry.listener(
    { agent: { id: 's1' }, messages: [message], turn: 1, step: 0 },
    async () => decision
  )
  assert.equal(result.messages.length, 1)
  clearAll()
})

await test('agent/pre-step 尊重 reject 决策', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)
  const entry = state.listeners.find((item) => item.event === 'agent/pre-step')
  const rejected = { kind: 'reject' }
  const result = await entry.listener({ agent: { id: 's1' }, messages: [], turn: 1, step: 0 }, async () => rejected)
  assert.deepEqual(result, rejected)
})

/* ── 路由（设置页用） ───────────────────────────────────────────────────── */

await test('GET /state 返回配置、统计与记忆列表', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)
  await toolByName(state, 'memory_save').execute({ text: '一条记忆', tags: ['t1'] }, {})

  const { res, json } = await callRoute(state, 'GET', '/dsh-local-memory/state?limit=50')
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.config.enabled, true)
  assert.equal(json.defaults.enabled, true)
  assert.equal(json.stats.count, 1)
  assert.equal(json.memories.length, 1)
  assert.equal(json.memories[0].text, '一条记忆')
  assert.equal(json.configFile, CONFIG_FILE)
})

await test('GET /state?q= 支持筛选', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)
  await toolByName(state, 'memory_save').execute({ text: '鉴权用轮询' }, {})
  await toolByName(state, 'memory_save').execute({ text: '连接池 20' }, {})

  const { json } = await callRoute(state, 'GET', '/dsh-local-memory/state?q=' + encodeURIComponent('鉴权'))
  assert.equal(json.memories.length, 1)
  assert.match(json.memories[0].text, /鉴权/)
})

await test('POST /config 保存设置并即时生效', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)

  const { res, json } = await callRoute(state, 'POST', '/dsh-local-memory/config', {
    patch: { autoRecallMaxItems: 99, enabled: false }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(json.config.autoRecallMaxItems, 20, '越界被夹取')
  assert.equal(json.config.enabled, false)
  assert.equal(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).enabled, false)
  clearAll()
})

await test('POST /config action=reset 恢复默认', async () => {
  clearAll()
  writeConfig({ enabled: false })
  const { ctx, state } = makeCtx()
  apply(ctx)
  const { json } = await callRoute(state, 'POST', '/dsh-local-memory/config', { action: 'reset' })
  assert.equal(json.config.enabled, true)
  clearAll()
})

await test('POST /memory add / update / delete 全链路', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)

  // 新增
  const added = await callRoute(state, 'POST', '/dsh-local-memory/memory', {
    action: 'add', text: '设置页新增的记忆', tags: ['ui']
  })
  assert.equal(added.json.ok, true)
  assert.equal(added.json.created, true)
  const id = added.json.memory.id
  assert.equal(added.json.stats.count, 1)

  // 编辑
  const updated = await callRoute(state, 'POST', '/dsh-local-memory/memory', {
    action: 'update', id, text: '改过的内容', tags: ['ui', 'edited']
  })
  assert.equal(updated.json.memory.text, '改过的内容')
  assert.deepEqual(updated.json.memory.tags, ['ui', 'edited'])

  // 删除
  const removed = await callRoute(state, 'POST', '/dsh-local-memory/memory', { action: 'delete', id })
  assert.equal(removed.json.removed, true)
  assert.equal(removed.json.stats.count, 0)
})

await test('POST /memory 空内容 / 未知 action / 未知路由都给出明确错误', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)

  const empty = await callRoute(state, 'POST', '/dsh-local-memory/memory', { action: 'add', text: '  ' })
  assert.equal(empty.res.statusCode, 400)
  assert.match(empty.json.error, /不能为空/)

  const unknown = await callRoute(state, 'POST', '/dsh-local-memory/memory', { action: 'nope' })
  assert.equal(unknown.res.statusCode, 400)

  const missing = await callRoute(state, 'GET', '/dsh-local-memory/nope')
  assert.equal(missing.res.statusCode, 404)

  const badJson = await (async () => {
    const route = state.routes[0]
    const req = makeReq('POST', '/dsh-local-memory/config', '{ not json')
    const res = makeRes()
    const pending = route.handler(req, res)
    await req.emit()
    await pending
    return { res, json: JSON.parse(res.body) }
  })()
  assert.equal(badJson.res.statusCode, 400)
  assert.equal(badJson.json.error, 'invalid json')
})

await test('信任栅栏：connection 拒绝时立刻结束响应', async () => {
  clearAll()
  const { ctx, state } = makeCtx()
  ctx.connection.requestRejection = () => 401
  apply(ctx)
  const res = makeRes()
  await state.routes[0].handler(makeReq('GET', '/dsh-local-memory/state'), res)
  assert.equal(res.statusCode, 401)
  assert.equal(res.body, '')
})

await test('effect 清理不抛错', () => {
  clearAll()
  const { ctx, state } = makeCtx()
  apply(ctx)
  const cleanup = state.effects[0]()
  assert.equal(typeof cleanup, 'function')
  assert.doesNotThrow(() => cleanup())
})

clearAll()
try {
  fs.rmSync(DSH_HOME, { recursive: true, force: true })
} catch (err) {
  /* noop */
}

console.log(`\nsmoke-host: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
