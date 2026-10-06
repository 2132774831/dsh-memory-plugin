/* ============================================================================
 * smoke-client — 浏览器半侧的契约测试
 * ----------------------------------------------------------------------------
 * client.js 是手写的 ModuleLoader bundle（无构建步骤），用一个假 DOM 把它真跑一遍。
 * ========================================================================== */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

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

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SOURCE = fs.readFileSync(path.join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))

function makeFakeDom() {
  const created = []
  const document = {
    head: {
      appendChild(node) {
        created.push(node)
        return node
      }
    },
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        dataset: {},
        style: {},
        children: [],
        textContent: '',
        className: '',
        appendChild(child) {
          this.children.push(child)
          return child
        }
      }
    },
    querySelector() {
      return null
    }
  }
  return { document, created }
}

/** 在沙箱里跑 bundle，返回注册信息与导出。 */
function runBundle() {
  const dom = makeFakeDom()
  const registered = { call: null }
  const required = []

  const fakeReact = {
    createElement(tag, props, ...children) {
      return { tag, props: props || {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useMemo(fn) {
      return fn()
    },
    useCallback(fn) {
      return fn
    }
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Object,
    Array,
    String,
    Number,
    Date,
    Math,
    JSON,
    isFinite,
    Error,
    Symbol,
    document: dom.document,
    window: {
      __ModuleLoader__: {
        load(spec) {
          registered.call = spec
        }
      },
      location: { reload() {} },
      fetch: async () => ({ ok: false, json: async () => ({}) })
    },
    fetch: async () => ({ ok: false, json: async () => ({}) })
  }
  sandbox.window.document = dom.document

  const context = vm.createContext(sandbox)
  vm.runInContext(CLIENT_SOURCE, context, { filename: 'client.js' })

  assert.ok(registered.call, 'bundle 没有调用 window.__ModuleLoader__.load')
  const moduleExports = registered.call.factory((name) => {
    required.push(name)
    if (name === 'react') return fakeReact
    throw new Error(`client bundle 请求了未声明的依赖：${name}`)
  })

  return { registered: registered.call, exports: moduleExports, dom, required }
}

console.log('smoke-client')

await test('注册 id 与 package.json 的插件名一致', () => {
  const { registered } = runBundle()
  assert.equal(registered.id, 'dsh-local-memory')
  assert.equal(registered.id, PACKAGE_JSON.name)
})

await test('bundle 只 require react', () => {
  const { required } = runBundle()
  assert.deepEqual([...new Set(required)], ['react'])
})

await test('导出 apply / inject，inject 只声明 slots', () => {
  const { exports } = runBundle()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(Array.from(exports.inject), ['slots'])
})

await test('apply 注册三个槽位：设置页 + 会话菜单项 + 弹窗', () => {
  const { exports } = runBundle()

  const injections = []
  const registrations = []
  const ctx = {
    slots: {
      inject(key, callback) {
        injections.push(key)
        return callback()
      },
      register(registration, renderFactory) {
        registrations.push({ registration, renderFactory })
        return () => {}
      }
    }
  }

  exports.apply(ctx)

  assert.deepEqual(injections, [
    'settings.section',
    'sidebar.workspaces.session.menu.item',
    'shell.overlay'
  ])

  const settings = registrations.find((r) => r.registration.name === 'settings.section')
  assert.ok(settings, '没有注册 settings.section')
  assert.equal(settings.registration.id, 'local-memory')
  assert.equal(settings.registration.label, '本地记忆')
  assert.equal(typeof settings.registration.order, 'number')
  assert.notEqual(settings.registration.id, 'startup-screen')
  assert.notEqual(settings.registration.id, 'hindsight-memory')
  assert.ok(settings.renderFactory(), '设置页工厂没返回元素')

  const menuItem = registrations.find((r) => r.registration.name === 'sidebar.workspaces.session.menu.item')
  assert.ok(menuItem, '没有注册会话菜单项')
  assert.equal(menuItem.registration.id, 'local-memory-organize')
  // 必须夹在 fork(300) 与 archive(400) 之间
  assert.ok(menuItem.registration.order > 300 && menuItem.registration.order < 400, String(menuItem.registration.order))
  // 菜单项会收到壳注入的 props，工厂要能吃下
  assert.ok(menuItem.renderFactory({ sessionId: 's-1', displayTitle: '标题' }) !== undefined)

  const overlay = registrations.find((r) => r.registration.name === 'shell.overlay')
  assert.ok(overlay, '没有注册弹窗')
  assert.ok(overlay.renderFactory() !== undefined)
})

await test('面板只调用 /dsh-local-memory/* 五个接口', () => {
  const urls = [...CLIENT_SOURCE.matchAll(/['"](\/[^'"]+)['"]/g)].map((m) => m[1])
  const apiUrls = [...new Set(urls)].filter((u) => u.startsWith('/'))
  assert.deepEqual(apiUrls.sort(), [
    '/dsh-local-memory/config',
    '/dsh-local-memory/export',
    '/dsh-local-memory/import',
    '/dsh-local-memory/memory',
    '/dsh-local-memory/state'
  ])
})

await test('设置页带有「查看记忆」「写设置」「导入导出」「权重」能力', () => {
  // 记忆浏览
  assert.match(CLIENT_SOURCE, /新增记忆/)
  assert.match(CLIENT_SOURCE, /编辑/)
  assert.match(CLIENT_SOURCE, /删除/)
  assert.match(CLIENT_SOURCE, /筛选/)
  // 设置
  assert.match(CLIENT_SOURCE, /保存设置/)
  assert.match(CLIENT_SOURCE, /恢复默认/)
  assert.match(CLIENT_SOURCE, /启用本地记忆/)
  assert.match(CLIENT_SOURCE, /每轮自动回忆/)
  // 导入 / 导出
  assert.match(CLIENT_SOURCE, /导出 Markdown/)
  assert.match(CLIENT_SOURCE, /导入 Markdown/)
  // 权重
  assert.match(CLIENT_SOURCE, /检索权重/)
  assert.match(CLIENT_SOURCE, /正文命中/)
  assert.match(CLIENT_SOURCE, /长词加成/)
  // 删除前整理记忆
  assert.match(CLIENT_SOURCE, /删除对话前提醒整理记忆/)
})

await test('样式注入带 data-plugin 标记，避免重复插入', () => {
  const { dom } = runBundle()
  const style = dom.created.find((node) => node.tagName === 'STYLE')
  assert.ok(style, '没有插入 style 标签')
  assert.equal(style.dataset.plugin, 'dsh-local-memory')
  assert.equal(style.dataset.pluginCss, 'dsh-local-memory/main.css')
  assert.match(style.textContent, /__lm_root/)
})

await test('package.json 声明了 web profile 的 client 装配且零依赖', () => {
  assert.equal(PACKAGE_JSON.dsh.client.platform, 'web')
  assert.deepEqual(PACKAGE_JSON.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings'])
  assert.equal(PACKAGE_JSON.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(PACKAGE_JSON.main, 'lib/index.js')
  assert.equal(PACKAGE_JSON.type, 'module')
  assert.deepEqual(PACKAGE_JSON.dependencies || {}, {}, '必须零运行时依赖')
})

console.log(`\nsmoke-client: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
