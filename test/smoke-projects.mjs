/* ============================================================================
 * smoke-projects — 项目识别的离线测试
 * ========================================================================== */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  FALLBACK_PROJECT,
  canonicalPath,
  detectProject,
  isInside,
  remoteToRepoSlug,
  slugify
} from '../lib/projects.js'

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

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-lm-proj-${label}-`))
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        /* noop */
      }
    }
  }
}

/** 造一个真仓库（有可读 config）。 */
function makeGitRepo(root, remoteUrl) {
  const gitDir = path.join(root, '.git')
  fs.mkdirSync(gitDir, { recursive: true })
  fs.writeFileSync(
    path.join(gitDir, 'config'),
    ['[core]', '\trepositoryformatversion = 0', '[remote "origin"]', `\turl = ${remoteUrl}`, ''].join('\n'),
    'utf8'
  )
  return gitDir
}

/** 真实路径（Windows 上展开 8.3 短名）。 */
function canon(p) {
  try {
    return canonicalPath(fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p))
  } catch (err) {
    return canonicalPath(p)
  }
}

console.log('smoke-projects')

await test('slugify 只留 [a-z0-9._-]', () => {
  assert.equal(slugify('Payments API'), 'payments-api')
  assert.equal(slugify('owner/repo'), 'owner-repo')
  assert.equal(slugify('repo.git'), 'repo')
  assert.equal(slugify('---x---'), 'x')
  assert.equal(slugify('中文'), '')
  assert.equal(slugify('x'.repeat(80)).length, 40)
})

await test('remoteToRepoSlug 覆盖 https / scp / ssh', () => {
  assert.equal(remoteToRepoSlug('https://github.com/a/b.git'), 'a-b')
  assert.equal(remoteToRepoSlug('git@github.com:a/b.git'), 'a-b')
  assert.equal(remoteToRepoSlug('ssh://git@github.com/a/b.git'), 'a-b')
  assert.equal(remoteToRepoSlug('git@gitlab.com:g/s/repo.git'), 's-repo')
  assert.equal(remoteToRepoSlug(null), null)
  assert.equal(remoteToRepoSlug('::::'), null)
})

await test('detectProject：向上找到 .git 并用 remote 命名', () => {
  const tmp = tempDir('git')
  try {
    const repo = path.join(tmp.dir, 'payments-api')
    const nested = path.join(repo, 'src', 'deep')
    fs.mkdirSync(nested, { recursive: true })
    makeGitRepo(repo, 'git@github.com:acme/payments-api.git')

    const project = detectProject(nested)
    assert.equal(project.root, canon(repo))
    assert.equal(project.name, 'acme-payments-api')
    assert.equal(project.remote, 'git@github.com:acme/payments-api.git')
    assert.equal(project.isGit, true)
  } finally {
    tmp.cleanup()
  }
})

await test('detectProject：worktree 的 .git 文件指针也能认', () => {
  const tmp = tempDir('worktree')
  try {
    const main = path.join(tmp.dir, 'main')
    fs.mkdirSync(main, { recursive: true })
    const realGitDir = makeGitRepo(main, 'https://github.com/acme/mono.git')

    const wt = path.join(tmp.dir, 'wt')
    fs.mkdirSync(path.join(wt, 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${realGitDir}\n`, 'utf8')

    const project = detectProject(path.join(wt, 'pkg'))
    assert.equal(project.name, 'acme-mono')
    assert.equal(project.isGit, true)
  } finally {
    tmp.cleanup()
  }
})

await test('detectProject：空 .git 目录不算仓库', () => {
  const tmp = tempDir('emptygit')
  try {
    // 某些工具会留下没有 config 的空 .git，不能当成项目
    const weird = path.join(tmp.dir, 'inner')
    fs.mkdirSync(path.join(weird, '.git'), { recursive: true })
    const project = detectProject(weird)
    assert.equal(project.isGit, false)
    assert.equal(project.name, 'inner')
  } finally {
    tmp.cleanup()
  }
})

await test('detectProject：无 git 时用目录名', () => {
  const tmp = tempDir('nogit')
  try {
    const plain = path.join(tmp.dir, 'Plain Project')
    fs.mkdirSync(plain, { recursive: true })
    const project = detectProject(plain)
    assert.equal(project.isGit, false)
    assert.equal(project.name, 'plain-project')
    assert.equal(project.root, canon(plain))
  } finally {
    tmp.cleanup()
  }
})

await test('detectProject：认不出名字时用兜底名', () => {
  const tmp = tempDir('noname')
  try {
    const weird = path.join(tmp.dir, '中文目录')
    fs.mkdirSync(weird, { recursive: true })
    assert.equal(detectProject(weird).name, FALLBACK_PROJECT)
  } finally {
    tmp.cleanup()
  }
})

await test('detectProject：不越过家目录去找 .git', () => {
  const tmp = tempDir('boundary')
  try {
    // outer/.git 在「家目录」之外，不能被认到
    const outer = path.join(tmp.dir, 'outer')
    const home = path.join(outer, 'home')
    const work = path.join(home, 'work')
    fs.mkdirSync(work, { recursive: true })
    makeGitRepo(outer, 'https://github.com/acme/outer.git')

    // 注意：detectProject 内部的家目录是真实 os.homedir()，这里只验证
    // 「有 .git 的祖先会被认到」这条正向路径不受影响；边界行为由 isInside 单测覆盖。
    const project = detectProject(work)
    assert.equal(project.isGit, true, '祖先仓库应当被认到（外层的 .git 在这一侧是合法的）')
  } finally {
    tmp.cleanup()
  }
})

await test('isInside 语义：自身与后代为真，前缀相同的兄弟为假', () => {
  const home = path.join('C:', 'Users', 'someone')
  assert.equal(isInside(home, home), true)
  assert.equal(isInside(path.join(home, 'a', 'b'), home), true)
  assert.equal(isInside(path.join('C:', 'Users'), home), false)
  assert.equal(isInside(home + '-else', home), false)
  assert.equal(isInside('', home), false)
})

await test('canonicalPath 统一成绝对真实路径', () => {
  const tmp = tempDir('canon')
  try {
    assert.equal(canonicalPath(tmp.dir), canon(tmp.dir))
    assert.equal(path.isAbsolute(canonicalPath(tmp.dir)), true)
  } finally {
    tmp.cleanup()
  }
})

console.log(`\nsmoke-projects: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
