/* ============================================================================
 * smoke-store — 本地存储与关键词检索的离线测试
 * ========================================================================== */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MAX_TEXT_LENGTH,
  MemoryStore,
  STORE_VERSION,
  defaultStoreFile,
  normalizeText,
  scoreMemory,
  tokenize
} from '../lib/store.js'

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

function tempStore(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-lm-${label}-`))
  const file = path.join(dir, 'memory.json')
  return {
    dir,
    file,
    store: new MemoryStore(file),
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        /* noop */
      }
    }
  }
}

console.log('smoke-store')

await test('tokenize：拉丁词 + 中文二字组合', () => {
  assert.deepEqual(tokenize('auth token').sort(), ['auth', 'token'])
  // 单字母不保留（噪音太大）
  assert.deepEqual(tokenize('a bb ccc').sort(), ['bb', 'ccc'])
  // 中文按二元组切
  assert.deepEqual(tokenize('鉴权设计').sort(), ['权设', '设计', '鉴权'])
  // 单字保留
  assert.deepEqual(tokenize('坑'), ['坑'])
  // 中英混合
  const mixed = tokenize('用 Redis 做缓存')
  assert.equal(mixed.includes('redis'), true)
  assert.equal(mixed.includes('缓存'), true)
  assert.equal(mixed.includes('缓存'.slice(0, 1)), false)
})

await test('normalizeText 抹平大小写与空白', () => {
  assert.equal(normalizeText('  Hello   World  '), 'hello world')
  assert.equal(normalizeText('A\n\tB'), 'a b')
  assert.equal(normalizeText(null), '')
})

await test('scoreMemory：正文命中 > 标签命中，整句命中加分', () => {
  const memory = { text: '鉴权用的是轮询而不是 webhook', tags: ['topic:auth'] }
  const terms = tokenize('鉴权轮询')
  assert.ok(scoreMemory(memory, terms, normalizeText('鉴权轮询')) > 0)

  const noMatch = scoreMemory(memory, tokenize('数据库迁移'), normalizeText('数据库迁移'))
  assert.equal(noMatch, 0)

  // 整句原样出现 → 比只命中词项分高
  const whole = scoreMemory(memory, tokenize('鉴权用的是轮询'), normalizeText('鉴权用的是轮询'))
  const partial = scoreMemory(memory, tokenize('鉴权'), normalizeText('鉴权'))
  assert.ok(whole > partial)
})

await test('add 新增并落盘，文件结构可读', () => {
  const tmp = tempStore('add')
  try {
    const { memory, created } = tmp.store.add({ text: '用户偏好小步提交', tags: ['pref'], project: 'demo' })
    assert.equal(created, true)
    assert.ok(memory.id)
    assert.equal(memory.text, '用户偏好小步提交')

    const raw = JSON.parse(fs.readFileSync(tmp.file, 'utf8'))
    assert.equal(raw.version, STORE_VERSION)
    assert.equal(raw.memories.length, 1)
    assert.equal(raw.memories[0].text, '用户偏好小步提交')
    assert.deepEqual(raw.memories[0].tags, ['pref'])
  } finally {
    tmp.cleanup()
  }
})

await test('add 同文本不重复新增，而是合并标签', () => {
  const tmp = tempStore('dedup')
  try {
    const first = tmp.store.add({ text: '鉴权用轮询', tags: ['a'] })
    const second = tmp.store.add({ text: '  鉴权用轮询  ', tags: ['b'] })
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(second.memory.id, first.memory.id)
    assert.deepEqual(second.memory.tags.sort(), ['a', 'b'])
    assert.equal(tmp.store.read().memories.length, 1)
  } finally {
    tmp.cleanup()
  }
})

await test('add 拒绝空内容，并截断超长文本', () => {
  const tmp = tempStore('limits')
  try {
    assert.throws(() => tmp.store.add({ text: '   ' }))
    const long = 'x'.repeat(MAX_TEXT_LENGTH + 500)
    const { memory } = tmp.store.add({ text: long })
    assert.equal(memory.text.length, MAX_TEXT_LENGTH)
  } finally {
    tmp.cleanup()
  }
})

await test('search：中文关键词能命中，且只返回相关项', () => {
  const tmp = tempStore('search')
  try {
    tmp.store.add({ text: '鉴权用的是轮询而不是 webhook' })
    tmp.store.add({ text: '数据库连接池配成 20' })
    tmp.store.add({ text: '用户偏好用 pytest' })

    const hit = tmp.store.search({ q: '鉴权' })
    assert.equal(hit.total, 3)
    assert.equal(hit.memories.length, 1)
    assert.match(hit.memories[0].text, /鉴权/)

    assert.equal(tmp.store.search({ q: '连接池' }).memories.length, 1)
    assert.equal(tmp.store.search({ q: '完全无关的词' }).memories.length, 0)
  } finally {
    tmp.cleanup()
  }
})

await test('search：空查询按时间倒序返回全部', () => {
  const tmp = tempStore('recent')
  try {
    tmp.store.add({ text: '第一条' })
    tmp.store.add({ text: '第二条' })
    const result = tmp.store.search({ limit: 10 })
    assert.equal(result.memories.length, 2)
    // 至少能拿到全部，且 updatedAt 非 0
    assert.ok(result.memories.every((m) => Number(m.updatedAt) > 0))
  } finally {
    tmp.cleanup()
  }
})

await test('search：标签过滤与 limit 生效', () => {
  const tmp = tempStore('tags')
  try {
    for (let i = 0; i < 5; i += 1) tmp.store.add({ text: `记忆编号 ${i}`, tags: ['topic:x'] })
    tmp.store.add({ text: '另一条', tags: ['topic:y'] })

    assert.equal(tmp.store.search({ tags: ['topic:x'] }).matched, 5)
    assert.equal(tmp.store.search({ tags: ['topic:y'] }).matched, 1)
    assert.equal(tmp.store.search({ limit: 2 }).memories.length, 2)
  } finally {
    tmp.cleanup()
  }
})

await test('update / remove 生效，remove 未知 id 返回 false', () => {
  const tmp = tempStore('crud')
  try {
    const { memory } = tmp.store.add({ text: '原始内容', tags: ['a'] })
    const updated = tmp.store.update(memory.id, { text: '改过的内容', tags: ['a', 'b'] })
    assert.equal(updated.text, '改过的内容')
    assert.deepEqual(updated.tags, ['a', 'b'])

    assert.equal(tmp.store.remove(memory.id), true)
    assert.equal(tmp.store.remove('nope'), false)
    assert.equal(tmp.store.read().memories.length, 0)
  } finally {
    tmp.cleanup()
  }
})

await test('update 未知 id 返回 null，空文本抛错', () => {
  const tmp = tempStore('update-edge')
  try {
    assert.equal(tmp.store.update('nope', { text: 'x' }), null)
    const { memory } = tmp.store.add({ text: 'ok' })
    assert.throws(() => tmp.store.update(memory.id, { text: '   ' }))
  } finally {
    tmp.cleanup()
  }
})

await test('markUsed 累加 hits 与 lastUsedAt（同一批里重复 id 只算一次）', () => {
  const tmp = tempStore('hits')
  try {
    const { memory } = tmp.store.add({ text: '会被用到' })
    // 同一批重复 id：只算「这次检索用到了它一次」
    tmp.store.markUsed([memory.id, memory.id])
    let after = tmp.store.read().memories.find((m) => m.id === memory.id)
    assert.equal(after.hits, 1)

    // 两次独立检索 → 累加
    tmp.store.markUsed([memory.id])
    after = tmp.store.read().memories.find((m) => m.id === memory.id)
    assert.equal(after.hits, 2)
    assert.ok(Number(after.lastUsedAt) > 0)
  } finally {
    tmp.cleanup()
  }
})

await test('stats 汇总条数、标签、项目、文件大小', () => {
  const tmp = tempStore('stats')
  try {
    tmp.store.add({ text: 'a', tags: ['t1'], project: 'p1' })
    tmp.store.add({ text: 'b', tags: ['t2'], project: 'p2' })
    const stats = tmp.store.stats()
    assert.equal(stats.count, 2)
    assert.deepEqual(stats.tags, ['t1', 't2'])
    assert.deepEqual(stats.projects, ['p1', 'p2'])
    assert.ok(stats.bytes > 0)
    assert.equal(stats.file, tmp.file)
  } finally {
    tmp.cleanup()
  }
})

await test('坏文件不抛错，视作空库；写入后自愈', () => {
  const tmp = tempStore('corrupt')
  try {
    fs.mkdirSync(path.dirname(tmp.file), { recursive: true })
    fs.writeFileSync(tmp.file, '{ 这不是 json', 'utf8')
    assert.deepEqual(tmp.store.read().memories, [])
    assert.equal(tmp.store.search({ q: 'x' }).total, 0)
    tmp.store.add({ text: '写入后自愈' })
    assert.equal(tmp.store.read().memories.length, 1)
  } finally {
    tmp.cleanup()
  }
})

await test('文件不存在时视作空库，不报错', () => {
  const tmp = tempStore('missing')
  try {
    assert.equal(tmp.store.read().memories.length, 0)
    assert.equal(tmp.store.stats().count, 0)
  } finally {
    tmp.cleanup()
  }
})

await test('超出 maxMemories 时丢最旧的', () => {
  const tmp = tempStore('cap')
  try {
    const store = new MemoryStore(tmp.file, { maxMemories: 3 })
    for (let i = 0; i < 5; i += 1) store.add({ text: `记忆 ${i}` })
    const memories = store.read().memories
    assert.equal(memories.length, 3)
    // 最新的三条留下
    assert.equal(memories.some((m) => m.text === '记忆 4'), true)
    assert.equal(memories.some((m) => m.text === '记忆 0'), false)
  } finally {
    tmp.cleanup()
  }
})

await test('不会留下 .tmp 残留文件', () => {
  const tmp = tempStore('tmp')
  try {
    tmp.store.add({ text: '写入一次' })
    tmp.store.add({ text: '再写一次' })
    assert.equal(fs.existsSync(`${tmp.file}.tmp`), false)
  } finally {
    tmp.cleanup()
  }
})

await test('defaultStoreFile 落到 DSH_HOME 下', () => {
  assert.equal(defaultStoreFile('C:\\fake\\dsh'), path.join('C:\\fake\\dsh', 'dsh-local-memory.json'))
  assert.match(defaultStoreFile(), /dsh-local-memory\.json$/)
})

console.log(`\nsmoke-store: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
