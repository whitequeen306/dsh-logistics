import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createScope } from '../lib/scope.js'
import {
  cleanup,
  commitAll,
  initRepo,
  tempDir,
  write,
} from './helpers.js'

test('uses modified and untracked files when the worktree is dirty', () => {
  const root = initRepo()
  try {
    write(root, 'src/a.js', 'export function add(a, b) {\n  return a * b\n}\n')
    write(root, 'src/new.js', 'export const value = 1\n')

    const created = createScope({
      cwd: root,
      command: '/logi-correctness',
      experts: ['correctness'],
      config: { ignore: [], maxFiles: 400, maxFindingsPerPass: 12, includeLastCommitWhenClean: true },
    })

    assert.equal(created.scope.source, 'working-tree')
    assert.equal(created.scope.isGit, true)
    assert.equal(created.scope.git.dirty, true)
    assert.ok(created.scope.files.some((file) => file.path === 'src/a.js'))
    assert.ok(created.scope.files.some((file) => file.path === 'src/new.js'))
    assert.ok(created.scope.stats.additions >= 1)
    assert.ok(existsSync(created.scopePath))
    assert.ok(existsSync(join(created.runDir, 'handoff')))
    assert.deepEqual(created.scope.experts, ['correctness'])
    assert.equal(created.scope.expertDetails[0].skill, 'logi-correctness')
  } finally {
    cleanup(root)
  }
})

test('falls back to the last commit when the worktree is clean', () => {
  const root = initRepo()
  try {
    const created = createScope({
      cwd: root,
      command: '/logi',
      experts: ['correctness', 'security'],
      config: { ignore: [], maxFiles: 400, maxFindingsPerPass: 12, includeLastCommitWhenClean: true },
    })

    assert.equal(created.scope.source, 'last-commit')
    assert.equal(created.scope.git.dirty, false)
    assert.ok(created.scope.files.some((file) => file.path === 'src/a.js'))
    assert.ok(created.scope.files.some((file) => file.path === 'src/b.js'))
  } finally {
    cleanup(root)
  }
})

test('generated logistics files do not count as worktree changes', () => {
  const root = initRepo()
  try {
    write(root, '.logistics/runs/demo/scope.json', '{}')
    write(root, 'docs/logistics/latest.md', '# report\n')

    const created = createScope({
      cwd: root,
      command: '/logi',
      experts: ['correctness'],
      config: { ignore: [], maxFiles: 400, maxFindingsPerPass: 12, includeLastCommitWhenClean: true },
    })

    assert.equal(created.scope.source, 'last-commit')
    assert.equal(created.scope.git.dirty, false)
    assert.equal(created.scope.git.sourceDirty, false)
    assert.ok(created.scope.files.every((file) => !file.path.startsWith('.logistics/')))
    assert.ok(created.scope.files.every((file) => !file.path.startsWith('docs/logistics/')))
  } finally {
    cleanup(root)
  }
})

test('expands an untracked directory into individual files', () => {
  const root = initRepo()
  try {
    write(root, 'src/newdir/x.js', 'export const x = 1\n')
    write(root, 'src/newdir/y.js', 'export const y = 2\n')

    const created = createScope({
      cwd: root,
      command: '/logi',
      experts: ['correctness'],
      config: { ignore: [], maxFiles: 400, maxFindingsPerPass: 12, includeLastCommitWhenClean: true },
    })

    assert.equal(created.scope.source, 'working-tree')
    assert.ok(created.scope.files.some((file) => file.path === 'src/newdir/x.js'))
    assert.ok(created.scope.files.some((file) => file.path === 'src/newdir/y.js'))
  } finally {
    cleanup(root)
  }
})

test('walks a non-git workspace and detects the test command', () => {
  const root = tempDir('dsh-logi-nogit-')
  try {
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }, null, 2))
    write(root, 'src/a.js', 'export const a = 1\n')

    const created = createScope({
      cwd: root,
      command: '/logi',
      experts: ['correctness'],
      config: { ignore: [], maxFiles: 400, maxFindingsPerPass: 12, includeLastCommitWhenClean: true },
    })

    assert.equal(created.scope.isGit, false)
    assert.equal(created.scope.source, 'filesystem')
    assert.ok(created.scope.files.some((file) => file.path === 'src/a.js'))
    assert.deepEqual(created.scope.testCommand, { command: 'npm test', source: 'package.json' })
  } finally {
    cleanup(root)
  }
})

test('deduplicates known experts and warns about unknown ones', () => {
  const root = initRepo()
  try {
    const created = createScope({
      cwd: root,
      command: '/logi',
      experts: ['correctness', 'bogus', 'correctness', 'security'],
      config: { ignore: [], maxFiles: 400, maxFindingsPerPass: 12, includeLastCommitWhenClean: true },
    })

    assert.deepEqual(created.scope.experts, ['correctness', 'security'])
    assert.ok(created.scope.warnings.some((warning) => warning.includes('bogus')))
  } finally {
    cleanup(root)
  }
})

test('rejects a scope with no known expert', () => {
  const root = initRepo()
  try {
    assert.throws(
      () => createScope({
        cwd: root,
        command: '/logi',
        experts: ['bogus'],
        config: { ignore: [], maxFiles: 400, maxFindingsPerPass: 12, includeLastCommitWhenClean: true },
      }),
      /至少需要选择一位专家/u,
    )
  } finally {
    cleanup(root)
  }
})

test('uses the configured test command and maxFiles cap', () => {
  const root = initRepo()
  try {
    write(root, 'src/b.js', 'export const b = 2\n')
    commitAll(root)
    write(root, 'src/c.js', 'export const c = 3\n')
    write(root, 'src/d.js', 'export const d = 4\n')

    const created = createScope({
      cwd: root,
      command: '/logi',
      experts: ['correctness'],
      config: {
        ignore: [],
        maxFiles: 1,
        maxFindingsPerPass: 12,
        includeLastCommitWhenClean: true,
        testCommand: 'pnpm test -- --run',
      },
    })

    assert.deepEqual(created.scope.testCommand, { command: 'pnpm test -- --run', source: 'config' })
    assert.equal(created.scope.stats.analyzedFiles, 1)
    assert.equal(created.scope.stats.truncated, true)
    assert.ok(created.scope.warnings.some((warning) => warning.includes('maxFiles=1')))
  } finally {
    cleanup(root)
  }
})
