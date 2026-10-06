/* ============================================================================
 * dsh-local-memory — 本地记忆存储 + 关键词检索
 * ----------------------------------------------------------------------------
 * 全部数据放在一个本地 JSON 文件里（默认 ~/.dsh/dsh-local-memory.json）。
 * 不联网、不调大模型、不需要任何 key —— 检索靠关键词打分。
 *
 * 文件格式（可以直接用记事本打开改）：
 * {
 *   "version": 1,
 *   "memories": [
 *     { "id": "m-...", "text": "...", "tags": ["topic:auth"],
 *       "project": "my-repo", "createdAt": 1700000000000, "updatedAt": 1700000000000 }
 *   ]
 * }
 * ========================================================================== */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 存储格式版本。将来结构变了靠它做迁移。 */
export const STORE_VERSION = 1

/** 单条记忆的文本长度上限，避免误贴长文把文件撑爆。 */
export const MAX_TEXT_LENGTH = 4000

/** 记忆条数上限（超出时丢最旧的），防止无界增长。 */
export const DEFAULT_MAX_MEMORIES = 5000

/**
 * 检索评分权重（可在设置页调整）。
 * 含义：命中一个查询词项拿多少分；整句/标签精确命中再额外加多少。
 */
export const DEFAULT_WEIGHTS = {
  /** 正文命中一个词项的基准分 */
  textMatch: 2,
  /** 只在标签里命中的基准分 */
  tagMatch: 1,
  /** 整条查询原样出现在正文里的额外分 */
  wholeQuery: 5,
  /** 标签与整条查询完全相同时的额外分 */
  exactTag: 3,
  /** 长词（>=3 字符）的权重倍率：长词更具体，默认给一点加成 */
  longTermBonus: 1.5
}

/** 权重的合法区间，供设置页与归一化共用。 */
export const WEIGHT_RANGES = {
  textMatch: [0, 20],
  tagMatch: [0, 20],
  wholeQuery: [0, 50],
  exactTag: [0, 50],
  longTermBonus: [0, 5]
}

/**
 * 归一化权重：填默认值、夹取区间、忽略非数字。
 * @param {unknown} input 用户给的权重。
 * @returns {typeof DEFAULT_WEIGHTS} 归一化后的权重。
 */
export function normalizeWeights(input) {
  const out = { ...DEFAULT_WEIGHTS }
  const src = input && typeof input === 'object' ? input : {}
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    if (!(key in src) || src[key] === undefined || src[key] === null) continue
    const n = Number(src[key])
    if (!Number.isFinite(n)) continue
    const [lo, hi] = WEIGHT_RANGES[key]
    out[key] = Math.min(hi, Math.max(lo, Math.round(n * 100) / 100))
  }
  return out
}

/** 汉字 / 日文汉字 / 扩展 A 区，用来切 bigram。 */
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/** 记忆 id：时间戳 + 随机后缀，稳定且不重复。 */
function newId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 把文本切成检索用的词项。
 * 拉丁文按词切（长度 >= 2），中文按「二元组」切（"鉴权设计" → 鉴权/权设/设计）。
 * 二元组比单字精确得多，又不需要分词器。
 * @param {unknown} text 输入文本。
 * @returns {string[]} 词项数组。
 */
export function tokenize(text) {
  const raw = String(text == null ? '' : text).toLowerCase()
  const terms = new Set()
  for (const word of raw.match(/[a-z0-9][a-z0-9._-]*/g) || []) {
    if (word.length >= 2) terms.add(word)
  }
  for (const run of raw.match(CJK_RUN_RE) || []) {
    if (run.length === 1) terms.add(run)
    else {
      for (let i = 0; i + 2 <= run.length; i += 1) terms.add(run.slice(i, i + 2))
    }
  }
  return [...terms]
}

/** 归一化文本，用于判重（大小写、空白、标点差异都视为同一条）。 */
export function normalizeText(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 给一条记忆按查询打分。
 * @param {object} memory 记忆条目。
 * @param {string[]} queryTerms 查询词项（{@link tokenize} 的结果）。
 * @param {string} queryLower 归一化后的整条查询。
 * @param {object} [weights] 评分权重，缺省用 {@link DEFAULT_WEIGHTS}。
 * @returns {number} 得分，0 表示不相关。
 */
export function scoreMemory(memory, queryTerms, queryLower, weights) {
  const w = normalizeWeights(weights)
  const text = String(memory && memory.text ? memory.text : '').toLowerCase()
  if (!text) return 0
  const tags = (memory && Array.isArray(memory.tags) ? memory.tags : []).map((tag) => String(tag).toLowerCase())

  let score = 0
  for (const term of queryTerms) {
    // 长词更具体，按 longTermBonus 加成
    const bonus = term.length >= 3 ? w.longTermBonus : 1
    if (text.includes(term)) score += w.textMatch * bonus
    else if (tags.some((tag) => tag.includes(term))) score += w.tagMatch * bonus
  }

  // 整条查询原样出现在正文里 → 强相关
  const whole = String(queryLower || '').trim()
  if (whole.length >= 2 && text.includes(whole)) score += w.wholeQuery
  // 标签原样命中
  if (whole && tags.includes(whole)) score += w.exactTag

  return score
}

/**
 * 本地记忆库。所有读写都走这里，文件不存在时视作空库。
 */
export class MemoryStore {
  /**
   * @param {string} file 存储文件路径。
   * @param {object} [options] 选项。
   * @param {number} [options.maxMemories] 条数上限，默认 {@link DEFAULT_MAX_MEMORIES}。
   */
  constructor(file, options = {}) {
    this.file = file
    this.maxMemories = Number(options.maxMemories) > 0 ? Number(options.maxMemories) : DEFAULT_MAX_MEMORIES
  }

  /** 读文件；坏文件 / 缺失都返回空库，绝不抛。 */
  read() {
    let text = null
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (err) {
      return { version: STORE_VERSION, memories: [] }
    }
    if (!text) return { version: STORE_VERSION, memories: [] }
    try {
      const parsed = JSON.parse(text)
      const memories = parsed && Array.isArray(parsed.memories) ? parsed.memories : []
      return {
        version: STORE_VERSION,
        memories: memories.filter((m) => m && typeof m.text === 'string' && m.text.trim())
      }
    } catch (err) {
      return { version: STORE_VERSION, memories: [] }
    }
  }

  /** 原子写回（先写 .tmp 再 rename），避免写一半断电把文件弄坏。 */
  write(data) {
    const payload = { version: STORE_VERSION, memories: Array.isArray(data.memories) ? data.memories : [] }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
    return payload
  }

  /**
   * 检索记忆。
   * @param {object} [query] 查询条件。
   * @param {string} [query.q] 查询文本；为空则按时间倒序返回全部。
   * @param {string|string[]} [query.tags] 标签过滤（全部命中才算）。
   * @param {string} [query.project] 项目过滤。
   * @param {number} [query.limit] 返回条数上限，默认 20。
   * @param {object} [query.weights] 评分权重，缺省用 {@link DEFAULT_WEIGHTS}。
   * @returns {{total: number, matched: number, memories: object[]}} 结果。
   */
  search(query = {}) {
    const all = this.read().memories
    const tags = Array.isArray(query.tags) ? query.tags : query.tags ? [query.tags] : []
    const limit = Number(query.limit) > 0 ? Number(query.limit) : 20
    const q = String(query.q == null ? '' : query.q).trim()
    const weights = normalizeWeights(query.weights)

    let candidates = all
    if (tags.length) {
      const wanted = tags.map((tag) => String(tag).toLowerCase())
      candidates = candidates.filter((memory) => {
        const own = Array.isArray(memory.tags) ? memory.tags.map((tag) => String(tag).toLowerCase()) : []
        return wanted.every((tag) => own.includes(tag))
      })
    }
    if (query.project) {
      const project = String(query.project).toLowerCase()
      candidates = candidates.filter((memory) => String(memory.project || '').toLowerCase() === project)
    }

    // 无查询词：按最近更新倒序
    if (!q) {
      const sorted = [...candidates].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      return { total: all.length, matched: sorted.length, memories: sorted.slice(0, limit) }
    }

    const terms = tokenize(q)
    const queryLower = normalizeText(q)
    const scored = []
    for (const memory of candidates) {
      const score = scoreMemory(memory, terms, queryLower, weights)
      // 查询非空时，没命中的不返回；这样模型看到的就是"相关的那几条"
      if (score > 0) scored.push({ memory, score })
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return Number(b.memory.updatedAt || 0) - Number(a.memory.updatedAt || 0)
    })
    return {
      total: all.length,
      matched: scored.length,
      memories: scored.slice(0, limit).map((entry) => entry.memory)
    }
  }

  /**
   * 新增一条记忆。文本与已有记忆重复时**不新增**，而是合并标签并刷新时间。
   * @param {object} input 记忆内容。
   * @param {string} input.text 正文。
   * @param {string[]} [input.tags] 标签。
   * @param {string} [input.project] 所属项目名。
   * @returns {{memory: object, created: boolean}} 结果条目与是否新建。
   */
  add(input) {
    const text = String(input && input.text ? input.text : '').trim().slice(0, MAX_TEXT_LENGTH)
    if (!text) throw new Error('记忆内容不能为空')
    const tags = Array.isArray(input.tags)
      ? [...new Set(input.tags.map((tag) => String(tag).trim()).filter(Boolean))]
      : []
    const project = input.project ? String(input.project).trim() : ''
    const now = Date.now()

    const data = this.read()
    const normalized = normalizeText(text)
    const existing = data.memories.find((memory) => normalizeText(memory.text) === normalized)
    if (existing) {
      existing.tags = [...new Set([...(existing.tags || []), ...tags])]
      if (project) existing.project = project
      existing.updatedAt = now
      existing.hits = Number(existing.hits || 0) + 1
      this.write(data)
      return { memory: existing, created: false }
    }

    const memory = {
      id: newId(),
      text,
      tags,
      project,
      createdAt: now,
      updatedAt: now,
      hits: 0
    }
    data.memories.push(memory)

    // 超出上限时丢最旧的
    if (data.memories.length > this.maxMemories) {
      data.memories.sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
      data.memories = data.memories.slice(data.memories.length - this.maxMemories)
    }

    this.write(data)
    return { memory, created: true }
  }

  /**
   * 按 id 更新一条记忆。
   * @param {string} id 记忆 id。
   * @param {object} patch 要改的字段（text / tags / project）。
   * @returns {object|null} 更新后的条目；找不到返回 null。
   */
  update(id, patch = {}) {
    const data = this.read()
    const memory = data.memories.find((entry) => entry.id === id)
    if (!memory) return null
    if (patch.text !== undefined) {
      const text = String(patch.text).trim().slice(0, MAX_TEXT_LENGTH)
      if (!text) throw new Error('记忆内容不能为空')
      memory.text = text
    }
    if (patch.tags !== undefined) {
      memory.tags = Array.isArray(patch.tags)
        ? [...new Set(patch.tags.map((tag) => String(tag).trim()).filter(Boolean))]
        : []
    }
    if (patch.project !== undefined) memory.project = String(patch.project || '').trim()
    memory.updatedAt = Date.now()
    this.write(data)
    return memory
  }

  /**
   * 按 id 删除一条记忆。
   * @param {string} id 记忆 id。
   * @returns {boolean} 是否删掉了。
   */
  remove(id) {
    const data = this.read()
    const before = data.memories.length
    data.memories = data.memories.filter((entry) => entry.id !== id)
    if (data.memories.length === before) return false
    this.write(data)
    return true
  }

  /**
   * 把某条记忆标记为「刚被检索到」（用于排序参考，也让 UI 能看到使用频率）。
   * @param {string[]} ids 记忆 id 列表。
   */
  markUsed(ids) {
    if (!Array.isArray(ids) || !ids.length) return
    const wanted = new Set(ids)
    const data = this.read()
    let changed = false
    for (const memory of data.memories) {
      if (wanted.has(memory.id)) {
        memory.hits = Number(memory.hits || 0) + 1
        memory.lastUsedAt = Date.now()
        changed = true
      }
    }
    if (changed) {
      try {
        this.write(data)
      } catch (err) {
        // 统计写失败不影响检索结果
      }
    }
  }

  /** 概览：条数、标签、项目、文件大小。 */
  stats() {
    const data = this.read()
    const tags = new Set()
    const projects = new Set()
    for (const memory of data.memories) {
      for (const tag of memory.tags || []) tags.add(String(tag))
      if (memory.project) projects.add(String(memory.project))
    }
    let bytes = 0
    try {
      bytes = fs.statSync(this.file).size
    } catch (err) {
      bytes = 0
    }
    return {
      file: this.file,
      count: data.memories.length,
      tags: [...tags].sort(),
      projects: [...projects].sort(),
      bytes
    }
  }
  /**
   * 导入一批记忆（来自 Markdown 或别处）。
   *
   * 合并策略：正文归一化后相同的视为同一条 —— 已存在则合并标签、补项目、刷新时间；
   * 不存在则新增。所以重复导入同一个文件是幂等的。
   *
   * @param {Array<{text: string, tags?: string[], project?: string, createdAt?: number}>} incoming 待导入条目。
   * @param {object} [options] 选项。
   * @param {boolean} [options.dryRun] 只统计不写入。
   * @returns {{added: number, merged: number, skipped: number, total: number}} 结果统计。
   */
  importMemories(incoming, options = {}) {
    const list = Array.isArray(incoming) ? incoming : []
    const data = this.read()
    const byNormalized = new Map()
    for (const memory of data.memories) byNormalized.set(normalizeText(memory.text), memory)

    let added = 0
    let merged = 0
    let skipped = 0
    const now = Date.now()

    for (const raw of list) {
      const text = String(raw && raw.text ? raw.text : '').trim().slice(0, MAX_TEXT_LENGTH)
      if (!text) {
        skipped += 1
        continue
      }
      const tags = Array.isArray(raw.tags)
        ? [...new Set(raw.tags.map((tag) => String(tag).trim()).filter(Boolean))]
        : []
      const key = normalizeText(text)
      const existing = byNormalized.get(key)
      if (existing) {
        existing.tags = [...new Set([...(existing.tags || []), ...tags])]
        if (raw.project) existing.project = String(raw.project).trim()
        existing.updatedAt = now
        merged += 1
        continue
      }
      const memory = {
        id: newId(),
        text,
        tags,
        project: raw.project ? String(raw.project).trim() : '',
        createdAt: Number(raw.createdAt) || now,
        updatedAt: Number(raw.updatedAt) || now,
        hits: 0
      }
      data.memories.push(memory)
      byNormalized.set(key, memory)
      added += 1
    }

    // 与 add 相同的上限策略
    if (data.memories.length > this.maxMemories) {
      data.memories.sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
      data.memories = data.memories.slice(data.memories.length - this.maxMemories)
    }

    if (!options.dryRun && (added > 0 || merged > 0)) this.write(data)
    return { added, merged, skipped, total: data.memories.length }
  }
}

/* ── Markdown 导入 / 导出 ────────────────────────────────────────────────────
 * 导出格式刻意做得「人也能读、机器也能解析」，并且对**外来文件**尽量宽容：
 * 只要是个 Markdown，块与块之间用 `---` 分隔（或 `##` 标题分节），
 * 每块里的正文就当一条记忆；带 `- 标签：xxx` 这类元信息的会被识别。
 * 这样从别的 Agent / 别的电脑导出的笔记也能直接导进来。
 * ────────────────────────────────────────────────────────────────────────── */

const MD_META_KEYS = {
  标签: 'tags',
  tags: 'tags',
  tag: 'tags',
  项目: 'project',
  project: 'project',
  创建: 'createdAt',
  created: 'createdAt',
  更新: 'updatedAt',
  updated: 'updatedAt',
  id: 'id',
  来源: 'id',
  source: 'id'
}

/**
 * 这些键只出现在导出文件的头部（导出时间/条数/格式版本…）。
 * 识别到就整行丢弃，免得空导出文件被误当成一条记忆。
 */
const MD_IGNORED_KEYS = new Set([
  '导出时间', 'exportedat', 'exported', 'exporttime',
  '条数', 'count', 'total',
  '格式版本', 'format', 'version',
  '来源', 'source'
])

/**
 * 把时间戳格式化成 ISO 字符串（解析用）。
 * @param {unknown} ts 时间戳。
 * @returns {string} ISO 字符串。
 */
function toIso(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  try {
    return new Date(n).toISOString()
  } catch (err) {
    return ''
  }
}

/**
 * 把记忆导出成 Markdown 文本。
 * @param {object[]} memories 记忆列表。
 * @param {object} [meta] 附加元信息。
 * @param {string} [meta.exportedAt] 导出时间（ISO）。
 * @param {string} [meta.source] 来源标识（如 dsh-local-memory@1.1.0）。
 * @returns {string} Markdown 文本。
 */
export function toMarkdown(memories, meta = {}) {
  const list = Array.isArray(memories) ? memories : []
  const exportedAt = meta.exportedAt || new Date().toISOString()
  const source = meta.source || 'dsh-local-memory'
  const lines = [
    '# 本地记忆库导出',
    '',
    `- 导出时间：${exportedAt}`,
    `- 条数：${list.length}`,
    `- 来源：${source}`,
    ''
  ]
  for (const memory of list) {
    lines.push('---', '')
    const tags = Array.isArray(memory.tags) && memory.tags.length ? memory.tags.join(', ') : ''
    lines.push(`- 标签：${tags}`)
    lines.push(`- 项目：${memory.project || ''}`)
    const created = toIso(memory.createdAt)
    const updated = toIso(memory.updatedAt)
    if (created) lines.push(`- 创建：${created}`)
    if (updated) lines.push(`- 更新：${updated}`)
    if (memory.id) lines.push(`- id：${memory.id}`)
    lines.push('', String(memory.text || '').trim(), '')
  }
  return lines.join('\n')
}

/**
 * 解析 Markdown 记忆文件（宽容解析）。
 *
 * 识别顺序：
 *   1. 先用 `---` 水平线把文档切块（本插件导出的格式）；
 *   2. 没有水平线就按 `##`/`###` 标题切块（很多笔记工具的导出格式）；
 *   3. 都没有就把整篇当一条记忆。
 * 每块里形如 `- 标签：a, b` 的行会被当元信息，其余行拼成正文。
 *
 * @param {unknown} markdown Markdown 文本。
 * @returns {Array<{text: string, tags: string[], project: string, createdAt?: number, updatedAt?: number}>} 解析出的记忆。
 */
export function parseMarkdown(markdown) {
  const raw = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n')
  if (!raw.trim()) return []

  // 1) 按水平线切块
  let chunks = raw.split(/\n[ \t]*---[ \t]*\n/)
  // 丢掉文档头（第一个 `---` 之前的内容：标题/导出信息）
  if (chunks.length > 1) chunks = chunks.slice(1)
  else {
    // 2) 按二级/三级标题切块
    chunks = raw.split(/\n(?=#{2,3}[ \t])/)
    if (chunks.length <= 1) chunks = [raw]
  }

  const out = []
  for (const chunk of chunks) {
    const lines = String(chunk).split('\n')
    const meta = { tags: [], project: '' }
    const body = []

    for (const line of lines) {
      // 跳过纯标题行
      if (/^\s*#{1,6}\s/.test(line)) continue
      const m = /^\s*[-*]?\s*([A-Za-z\u4e00-\u9fff]+)\s*[:：]\s*(.*)$/.exec(line)
      if (m) {
        const rawKey = m[1].trim()
        const lowerKey = rawKey.toLowerCase()
        // 头部信息行整行丢弃
        if (MD_IGNORED_KEYS.has(rawKey) || MD_IGNORED_KEYS.has(lowerKey)) continue
        const key = MD_META_KEYS[lowerKey] || MD_META_KEYS[rawKey]
        if (key) {
          const value = m[2].trim()
          if (key === 'tags') {
            meta.tags = value
              .split(/[,，、\s]+/)
              .map((tag) => tag.trim())
              .filter(Boolean)
          } else if (key === 'project') {
            meta.project = value
          } else if (key === 'createdAt' || key === 'updatedAt') {
            const t = Date.parse(value)
            if (Number.isFinite(t)) meta[key] = t
          }
          continue // 元信息行不进正文
        }
      }
      body.push(line)
    }

    const text = body.join('\n').trim()
    if (!text) continue
    out.push({
      text,
      tags: meta.tags,
      project: meta.project,
      ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
      ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {})
    })
  }

  return out
}

/** 默认存储文件路径：$DSH_HOME/dsh-local-memory.json */
export function defaultStoreFile(dshHome) {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-local-memory.json')
}
