import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, PASS_LIST } from '../lib/constants.js'
import { createScope } from '../lib/scope.js'
import { cleanup, handoff, initRepo, sampleFinding, tempDir } from './helpers.js'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

function run(script, args) {
  try {
    const stdout = execFileSync(process.execPath, [join(pluginRoot, 'lib', 'cli', script), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output: stdout }
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    }
  }
}

test('status, aggregate, and gate form a complete offline pipeline', (t) => {
  const root = tempDir()
  t.after(() => cleanup(root))
  const passes = PASS_LIST.map((pass) => pass.key)
  const created = createScope({
    cwd: root,
    command: '/logi-full',
    mode: 'full',
    tier: 'full',
    passes,
    notes: '',
    config: DEFAULT_CONFIG,
  })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'auth.js'), 'export function deleteUser() {}\n')
  writeFileSync(join(created.runDir, 'handoff', 'review.json'), handoff('review', [sampleFinding]))

  const partial = run('status.mjs', ['--run', created.runDir])
  assert.equal(partial.code, 1)
  assert.match(partial.output, /missing:/)
  assert.match(partial.output, /ready: false/)

  for (const pass of passes) {
    writeFileSync(join(created.runDir, 'handoff', `${pass}.json`), handoff(pass, pass === 'safety' ? [{
      ...sampleFinding,
      severity: 'critical',
      title: '缺少鉴权',
      ruleId: 'SEC-authz',
      file: 'src/auth.js',
      line: 1,
      evidence: 'deleteUser 未校验调用者权限',
    }] : []))
  }

  const ready = run('status.mjs', ['--run', created.runDir, '--expect', passes.join(',')])
  assert.equal(ready.code, 0)
  assert.match(ready.output, /ready: true/)

  const aggregate = run('aggregate.mjs', ['--run', created.runDir, '--root', root])
  assert.equal(aggregate.code, 0)
  assert.match(aggregate.output, /score: 75\/100 \(C/)
  assert.match(aggregate.output, /coverage: 7\/7 \(full=true\)/)
  assert.match(aggregate.output, /gate: fail \(exit 1\)/)

  const gate = run('gate.mjs', ['--root', root])
  assert.equal(gate.code, 1)
  assert.match(gate.output, /新增严重问题 1 项/)

  const accept = run('gate.mjs', ['--root', root, '--accept'])
  assert.equal(accept.code, 0)
  assert.match(accept.output, /已接受基线/)

  const after = run('gate.mjs', ['--root', root])
  assert.equal(after.code, 0, after.output)
  assert.match(after.output, /gate: pass \(exit 0\)/)
})

test('gate accept ignores generated report files in a git worktree', (t) => {
  const root = initRepo()
  t.after(() => cleanup(root))
  const passes = PASS_LIST.map((pass) => pass.key)
  const created = createScope({
    cwd: root,
    command: '/logi-full',
    mode: 'full',
    tier: 'full',
    passes,
    notes: '',
    config: DEFAULT_CONFIG,
  })
  assert.equal(created.scope.git.sourceDirty, false)
  for (const pass of passes) {
    writeFileSync(join(created.runDir, 'handoff', `${pass}.json`), handoff(pass, pass === 'safety' ? [{
      ...sampleFinding,
      severity: 'critical',
      title: '缺少鉴权',
      ruleId: 'SEC-authz',
      file: 'src/a.js',
      line: 2,
      evidence: 'deleteUser 未校验调用者权限',
    }] : []))
  }

  const aggregate = run('aggregate.mjs', ['--run', created.runDir, '--root', root])
  assert.equal(aggregate.code, 0, aggregate.output)

  const accept = run('gate.mjs', ['--root', root, '--accept'])
  assert.equal(accept.code, 0, accept.output)
  assert.match(accept.output, /已接受基线/)
})
