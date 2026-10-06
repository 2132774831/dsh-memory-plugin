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

await test('apply 注册 settings.section 且面板可渲染', () => {
  const { exports } = runBundle()

  let injectionKey = null
  let meta = null
  let factory = null
  const ctx = {
    slots: {
      inject(key, callback) {
        injectionKey = key
        return callback()
      },
      register(registration, renderFactory) {
        meta = registration
        factory = renderFactory
        return () => {}
      }
    }
  }

  exports.apply(ctx)

  assert.equal(injectionKey, 'settings.section')
  assert.equal(meta.name, 'settings.section')
  assert.equal(meta.id, 'local-memory')
  assert.equal(meta.label, '本地记忆')
  assert.equal(typeof meta.order, 'number')
  assert.notEqual(meta.id, 'startup-screen')
  assert.notEqual(meta.id, 'hindsight-memory')
  assert.ok(factory(), '工厂没返回元素')
})

await test('面板只调用 /dsh-local-memory/* 三个接口', () => {
  const urls = [...CLIENT_SOURCE.matchAll(/['"](\/[^'"]+)['"]/g)].map((m) => m[1])
  const apiUrls = [...new Set(urls)].filter((u) => u.startsWith('/'))
  assert.deepEqual(apiUrls.sort(), [
    '/dsh-local-memory/config',
    '/dsh-local-memory/memory',
    '/dsh-local-memory/state'
  ])
})

await test('设置页确实带有「查看记忆」与「写设置」的能力', () => {
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
