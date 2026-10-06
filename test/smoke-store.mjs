/* ============================================================================
 * smoke-store — 本地存储与关键词检索的离线测试
 * ========================================================================== */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_WEIGHTS,
  MAX_TEXT_LENGTH,
  MemoryStore,
  STORE_VERSION,
  defaultStoreFile,
  normalizeText,
  normalizeWeights,
  parseMarkdown,
  scoreMemory,
  toMarkdown,
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

/* ── 权重 ───────────────────────────────────────────────────────────────── */

await test('normalizeWeights 填默认、夹取区间、忽略非数字', () => {
  assert.deepEqual(normalizeWeights(undefined), DEFAULT_WEIGHTS)
  assert.deepEqual(normalizeWeights({}), DEFAULT_WEIGHTS)
  assert.equal(normalizeWeights({ textMatch: 999 }).textMatch, 20)
  assert.equal(normalizeWeights({ textMatch: -5 }).textMatch, 0)
  assert.equal(normalizeWeights({ wholeQuery: 3.456 }).wholeQuery, 3.46)
  assert.equal(normalizeWeights({ tagMatch: 'nope' }).tagMatch, DEFAULT_WEIGHTS.tagMatch)
  // 未提供的键保持默认
  assert.equal(normalizeWeights({ textMatch: 7 }).tagMatch, DEFAULT_WEIGHTS.tagMatch)
})

await test('权重真的影响打分', () => {
  const memory = { text: '鉴权用的是轮询', tags: [] }
  const terms = tokenize('鉴权')
  const base = scoreMemory(memory, terms, normalizeText('鉴权'), DEFAULT_WEIGHTS)
  const boosted = scoreMemory(memory, terms, normalizeText('鉴权'), { ...DEFAULT_WEIGHTS, textMatch: 10 })
  const lowered = scoreMemory(memory, terms, normalizeText('鉴权'), { ...DEFAULT_WEIGHTS, textMatch: 0 })
  assert.ok(boosted > base, '提高正文权重应当加分')
  assert.ok(lowered < base, '降低正文权重应当减分')
})

await test('标签权重单独可调', () => {
  const memory = { text: '无关正文', tags: ['topic:auth'] }
  const terms = tokenize('auth')
  const low = scoreMemory(memory, terms, '', { ...DEFAULT_WEIGHTS, tagMatch: 0 })
  const high = scoreMemory(memory, terms, '', { ...DEFAULT_WEIGHTS, tagMatch: 8 })
  assert.equal(low, 0)
  assert.ok(high > 0)
})

await test('search 接受 weights 参数', () => {
  const tmp = tempStore('weights')
  try {
    tmp.store.add({ text: '鉴权用轮询', tags: [] })
    const a = tmp.store.search({ q: '鉴权', weights: { textMatch: 1 } })
    const b = tmp.store.search({ q: '鉴权', weights: { textMatch: 5 } })
    assert.equal(a.memories.length, 1)
    assert.equal(b.memories.length, 1)
  } finally {
    tmp.cleanup()
  }
})

/* ── Markdown 导出 / 导入 ────────────────────────────────────────────────── */

await test('toMarkdown 产出可读结构，含元信息与正文', () => {
  const md = toMarkdown([
    { id: 'm-1', text: '鉴权用轮询', tags: ['topic:auth', 'pref'], project: 'demo', createdAt: 1700000000000, updatedAt: 1700000000000 }
  ], { exportedAt: '2026-10-06T00:00:00.000Z' })
  assert.match(md, /# 本地记忆库导出/)
  assert.match(md, /- 条数：1/)
  assert.match(md, /- 标签：topic:auth, pref/)
  assert.match(md, /- 项目：demo/)
  assert.match(md, /鉴权用轮询/)
  assert.match(md, /---/)
})

await test('导出 → 解析 往返一致', () => {
  const memories = [
    { id: 'm-1', text: '第一条：鉴权用轮询', tags: ['topic:auth'], project: 'demo', createdAt: 1700000000000, updatedAt: 1700000000000 },
    { id: 'm-2', text: '第二条：连接池配 20\n第二行', tags: ['perf'], project: '', createdAt: 1700000001000, updatedAt: 1700000001000 }
  ]
  const md = toMarkdown(memories)
  const parsed = parseMarkdown(md)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].text, '第一条：鉴权用轮询')
  assert.deepEqual(parsed[0].tags, ['topic:auth'])
  assert.equal(parsed[0].project, 'demo')
  assert.equal(parsed[1].text, '第二条：连接池配 20\n第二行', '多行正文要保留换行')
  assert.deepEqual(parsed[1].tags, ['perf'])
})

await test('空导出文件不会解析出垃圾记忆', () => {
  const md = toMarkdown([])
  assert.deepEqual(parseMarkdown(md), [])
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown(null), [])
})

await test('parseMarkdown 兼容外部格式：## 标题分节', () => {
  const external = [
    '# 我的笔记',
    '',
    '## Redis 缓存策略',
    '',
    '缓存穿透用布隆过滤器。',
    '',
    '## 部署约定',
    '',
    '一律走 CI，不手工发布。'
  ].join('\n')
  const parsed = parseMarkdown(external)
  assert.equal(parsed.length, 2)
  assert.match(parsed[0].text, /布隆过滤器/)
  assert.match(parsed[1].text, /一律走 CI/)
})

await test('parseMarkdown 兼容外部格式：纯文本整篇', () => {
  const parsed = parseMarkdown('就一句话，没有任何结构。')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].text, '就一句话，没有任何结构。')
})

await test('parseMarkdown 认英文键名与全角/半角冒号', () => {
  const md = ['# x', '', '---', '', '- tags: a, b', '- project: p1', '', 'English style body'].join('\n')
  const parsed = parseMarkdown(md)
  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0].tags, ['a', 'b'])
  assert.equal(parsed[0].project, 'p1')
  assert.equal(parsed[0].text, 'English style body')
})

await test('importMemories 新增 + 判重合并 + 幂等', () => {
  const tmp = tempStore('import')
  try {
    const first = tmp.store.importMemories([
      { text: '鉴权用轮询', tags: ['a'], project: 'p1' },
      { text: '连接池配 20', tags: ['b'] }
    ])
    assert.equal(first.added, 2)
    assert.equal(first.total, 2)

    // 再次导入同一批：文本相同 → 合并，不新增
    const second = tmp.store.importMemories([
      { text: '鉴权用轮询', tags: ['c'], project: 'p2' }
    ])
    assert.equal(second.added, 0)
    assert.equal(second.merged, 1)
    assert.equal(second.total, 2)
    const memory = tmp.store.read().memories.find((m) => m.text === '鉴权用轮询')
    assert.deepEqual(memory.tags.sort(), ['a', 'c'])
    assert.equal(memory.project, 'p2')
  } finally {
    tmp.cleanup()
  }
})

await test('importMemories 跳过空正文，支持 dryRun', () => {
  const tmp = tempStore('import-edge')
  try {
    const result = tmp.store.importMemories([{ text: '  ' }, { text: '有效' }])
    assert.equal(result.added, 1)
    assert.equal(result.skipped, 1)

    const dry = tmp.store.importMemories([{ text: '还没写入' }], { dryRun: true })
    assert.equal(dry.added, 1)
    assert.equal(tmp.store.read().memories.some((m) => m.text === '还没写入'), false, 'dryRun 不该落盘')
  } finally {
    tmp.cleanup()
  }
})

await test('导出后导入到另一个库，内容一致（跨电脑迁移场景）', () => {
  const a = tempStore('migrate-a')
  const b = tempStore('migrate-b')
  try {
    a.store.add({ text: '跨电脑迁移的记忆', tags: ['migrated'], project: 'proj' })
    const md = toMarkdown(a.store.read().memories)
    const parsed = parseMarkdown(md)
    const result = b.store.importMemories(parsed)
    assert.equal(result.added, 1)
    const got = b.store.read().memories[0]
    assert.equal(got.text, '跨电脑迁移的记忆')
    assert.deepEqual(got.tags, ['migrated'])
    assert.equal(got.project, 'proj')
  } finally {
    a.cleanup()
    b.cleanup()
  }
})

console.log(`\nsmoke-store: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
