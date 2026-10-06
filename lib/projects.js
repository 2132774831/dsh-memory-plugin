/* ============================================================================
 * dsh-local-memory — 项目识别（精简版）
 * ----------------------------------------------------------------------------
 * 记忆存在一个统一的本地文件里，项目名只作为**标签**（方便按项目筛选），
 * 不再像 hindsight 版那样按项目分库。所以这里只需要「从会话目录认出项目名」。
 *
 * 做法和上一版一致（已在上一版验证过）：
 *   - 逐级向上找有可读 config 的 .git（空 .git 目录不算，worktree 的
 *     `.git` 文件指针算）；
 *   - 家目录是硬边界，绝不越过；
 *   - 有 remote 用 owner/repo（跨 clone 稳定），否则用目录名。
 * ========================================================================== */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 找不到线索时的兜底项目名。 */
export const FALLBACK_PROJECT = 'unknown-project'

/** 向上查找 `.git` 的最大层数。 */
const MAX_ASCEND = 24

/** 读文件，失败返回 null。 */
function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    return null
  }
}

/**
 * 规范化成真实路径。Windows 上 tmpdir 常返回 8.3 短名，不展开会让边界比较失效。
 * @param {string} target 路径。
 * @returns {string} 规范化后的绝对路径。
 */
export function canonicalPath(target) {
  const absolute = path.resolve(target)
  try {
    const real = typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(absolute)
      : fs.realpathSync(absolute)
    return path.resolve(real)
  } catch (err) {
    return absolute
  }
}

/** 判断 child 是否就是 parent 或在 parent 之下（Windows 大小写不敏感）。 */
export function isInside(child, parent) {
  if (!child || !parent) return false
  const a = process.platform === 'win32' ? child.toLowerCase() : child
  const b = process.platform === 'win32' ? parent.toLowerCase() : parent
  if (a === b) return true
  const prefix = b.endsWith(path.sep) ? b : b + path.sep
  return a.startsWith(prefix)
}

/** 把任意文本压成 slug。 */
export function slugify(value, maxLength = 40) {
  const raw = String(value == null ? '' : value).trim().toLowerCase().replace(/\.git$/i, '')
  const slug = raw
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
  if (!slug) return ''
  return slug.length > maxLength ? slug.slice(0, maxLength).replace(/[-_.]+$/, '') : slug
}

/**
 * 找一个目录里「看起来像真的」git 标记。
 * 真仓库一定有可读的 config；某些工具会留下空 `.git` 目录，那种不算。
 * @param {string} dir 候选目录。
 * @returns {string|null} 真实 git 目录；没有则 null。
 */
function gitMarkerAt(dir) {
  const dotGit = path.join(dir, '.git')
  let stat
  try {
    stat = fs.statSync(dotGit)
  } catch (err) {
    return null
  }
  if (stat.isDirectory()) {
    return readFileOrNull(path.join(dotGit, 'config')) === null ? null : dotGit
  }
  if (stat.isFile()) {
    const pointer = readFileOrNull(dotGit) || ''
    const match = /^gitdir:\s*(.+)\s*$/im.exec(pointer)
    if (!match) return null
    const target = match[1].trim()
    const gitDir = path.isAbsolute(target) ? target : path.resolve(dir, target)
    return readFileOrNull(path.join(gitDir, 'config')) === null ? null : gitDir
  }
  return null
}

/** 从 git 目录读 remote url。 */
function readGitRemote(gitDir) {
  const config = readFileOrNull(path.join(gitDir, 'config'))
  if (!config) return null
  const blocks = config.split(/^\[remote\s+"([^"]+)"\]\s*$/im)
  /** @type {Record<string,string>} */
  const remotes = {}
  for (let i = 1; i + 1 < blocks.length; i += 2) {
    const urlMatch = /^\s*url\s*=\s*(.+)$/im.exec(blocks[i + 1] || '')
    if (urlMatch) remotes[blocks[i].trim()] = urlMatch[1].trim()
  }
  if (remotes.origin) return remotes.origin
  const first = Object.keys(remotes)[0]
  return first ? remotes[first] : null
}

/**
 * 把 git remote url 归一化成 `owner/repo`。
 * @param {string|null} remoteUrl remote url。
 * @returns {string|null} 归一化结果。
 */
export function remoteToRepoSlug(remoteUrl) {
  if (!remoteUrl) return null
  let text = String(remoteUrl).trim()
  if (!text) return null
  const scp = /^[^/@\s]+@[^/:\s]+:(.+)$/.exec(text)
  if (scp) text = scp[1]
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      text = new URL(text).pathname
    } catch (err) {
      return null
    }
  }
  text = text.replace(/^\/+/, '').replace(/\.git$/i, '')
  const parts = text.split('/').filter(Boolean)
  if (!parts.length) return null
  const tail = parts.length >= 2 ? parts.slice(-2).join('/') : parts[0]
  return slugify(tail) || null
}

/**
 * 从会话工作目录识别项目。
 * @param {string} [cwd] 会话工作目录，默认 `process.cwd()`。
 * @returns {{name: string, root: string, remote: string|null, isGit: boolean}} 项目信息。
 */
export function detectProject(cwd) {
  const start = canonicalPath(cwd || process.cwd())
  const home = canonicalPath(os.homedir())

  let cursor = start
  let gitRoot = null
  let gitDir = null
  for (let depth = 0; depth <= MAX_ASCEND; depth += 1) {
    if (!cursor) break
    const marker = gitMarkerAt(cursor)
    if (marker) {
      gitRoot = cursor
      gitDir = marker
      break
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    // 找到家目录就停（越过它就是爬出了用户自己的地盘）
    if (cursor === home) break
    cursor = parent
  }

  const root = gitRoot || start
  const remote = gitDir ? readGitRemote(gitDir) : null
  const name = remoteToRepoSlug(remote) || slugify(path.basename(root)) || FALLBACK_PROJECT
  return { name, root, remote, isGit: Boolean(gitRoot) }
}
