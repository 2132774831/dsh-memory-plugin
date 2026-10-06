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
 * @returns {number} 得分，0 表示不相关。
 */
export function scoreMemory(memory, queryTerms, queryLower) {
  const text = String(memory && memory.text ? memory.text : '').toLowerCase()
  if (!text) return 0
  const tags = (memory && Array.isArray(memory.tags) ? memory.tags : []).map((tag) => String(tag).toLowerCase())

  let score = 0
  for (const term of queryTerms) {
    // 命中正文 +2；只命中标签 +1。长词更具体，给一点额外权重。
    const weight = term.length >= 3 ? 1.5 : 1
    if (text.includes(term)) score += 2 * weight
    else if (tags.some((tag) => tag.includes(term))) score += 1 * weight
  }

  // 整条查询原样出现在正文里 → 强相关
  const whole = String(queryLower || '').trim()
  if (whole.length >= 2 && text.includes(whole)) score += 5
  // 标签原样命中
  if (whole && tags.includes(whole)) score += 3

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
   * @returns {{total: number, matched: number, memories: object[]}} 结果。
   */
  search(query = {}) {
    const all = this.read().memories
    const tags = Array.isArray(query.tags) ? query.tags : query.tags ? [query.tags] : []
    const limit = Number(query.limit) > 0 ? Number(query.limit) : 20
    const q = String(query.q == null ? '' : query.q).trim()

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
      const score = scoreMemory(memory, terms, queryLower)
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
}

/** 默认存储文件路径：$DSH_HOME/dsh-local-memory.json */
export function defaultStoreFile(dshHome) {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-local-memory.json')
}
