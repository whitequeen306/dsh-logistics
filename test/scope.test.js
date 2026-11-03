import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_CONFIG, TIERS } from '../lib/constants.js'
import { createScope } from '../lib/scope.js'
import { cleanup, commitAll, initRepo, tempDir, write } from './helpers.js'

const scopeOptions = (root, overrides = {}) => ({
  cwd: root,
  command: '/logi-quick',
  mode: 'quick',
  tier: 'quick',
  passes: TIERS.quick.passes,
  notes: '只关注鉴权路径',
  config: DEFAULT_CONFIG,
  ...overrides,
})

test('createScope captures working-tree changes and resolves the tier', (t) => {
  const root = initRepo()
  t.after(() => cleanup(root))
  write(root, 'src/a.js', 'export const a = 2\nexport const b = 3\n')
  write(root, 'src/new.js', 'export const n = 1\n')

  const { scope, runDir, handoffDir } = createScope(scopeOptions(root))
  assert.equal(scope.isGit, true)
  assert.equal(scope.source, 'working-tree')
  assert.equal(scope.tier, 'quick')
  assert.deepEqual(scope.passes, TIERS.quick.passes)
  assert.equal(scope.notes, '只关注鉴权路径')
  assert.equal(scope.output.runDir, runDir.replaceAll('\\', '/'))
  assert.ok(existsSync(join(runDir, 'scope.json')))
  assert.ok(existsSync(handoffDir))

  const modified = scope.files.find((file) => file.path === 'src/a.js')
  assert.equal(modified?.status, 'modified')
  assert.ok(scope.files.some((file) => file.path === 'src/new.js' && file.status === 'untracked'))
  assert.equal(scope.stats.analyzedFiles, scope.files.length)
  assert.ok(scope.stats.additions >= 1)
  assert.equal(scope.testCommand.command, 'npm test')
  assert.equal(scope.risk.recommendTier, 'quick')

  const onDisk = JSON.parse(readFileSync(join(runDir, 'scope.json'), 'utf8'))
  assert.equal(onDisk.runId, scope.runId)
})

test('createScope falls back to the last commit when the tree is clean', (t) => {
  const root = initRepo()
  t.after(() => cleanup(root))
  write(root, 'src/a.js', 'export const a = 9\n')
  commitAll(root, 'change a')

  const { scope } = createScope(scopeOptions(root))
  assert.equal(scope.isGit, true)
  assert.equal(scope.source, 'last-commit')
  assert.ok(scope.files.some((file) => file.path === 'src/a.js'))
  assert.ok(scope.git.head)
  assert.equal(scope.git.dirty, false)
})

test('generated logistics files do not count as worktree changes', (t) => {
  const root = initRepo()
  t.after(() => cleanup(root))
  write(root, '.logistics/runs/demo/scope.json', '{}')
  write(root, 'docs/logistics/latest.md', '# demo report\n')

  const { scope } = createScope(scopeOptions(root))
  assert.equal(scope.source, 'last-commit')
  assert.equal(scope.git.dirty, false)
  assert.ok(scope.files.every((file) => !file.path.startsWith('.logistics/')))
})

test('auto mode expands the recommended tier and its passes', (t) => {
  const root = initRepo()
  t.after(() => cleanup(root))
  // Sensitive file plus many changed lines pushes risk to at least medium.
  write(root, 'src/auth/session.js', 'export function login() {}\n')
  write(root, 'src/a.js', Array.from({ length: 210 }, (_, index) => `export const v${index} = ${index}`).join('\n'))
  const { scope } = createScope(scopeOptions(root, {
    mode: 'auto',
    tier: 'auto',
    passes: [],
    command: '/logi',
  }))
  assert.equal(scope.risk.level, 'high')
  assert.equal(scope.tier, 'full')
  assert.deepEqual(scope.passes, TIERS.full.passes)
})

test('non-git directories degrade to a filesystem scan', (t) => {
  const root = tempDir()
  t.after(() => cleanup(root))
  write(root, 'index.js', 'export const ok = true\n')
  write(root, 'README.md', '# fixture\n')

  const { scope } = createScope(scopeOptions(root, { mode: 'single', tier: 'single', passes: ['review'] }))
  assert.equal(scope.isGit, false)
  assert.equal(scope.source, 'filesystem')
  assert.ok(scope.files.some((file) => file.path === 'index.js'))
  assert.equal(scope.tier, 'single')
  assert.deepEqual(scope.passes, ['review'])
})
