import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createCommands } from '../lib/commands.js'
import { loadHandoffs } from '../lib/handoffs.js'
import { readRunLog } from '../lib/runlog.js'
import { validateVerdict } from '../lib/verdict.js'
import {
  aggregateReport,
  cleanup,
  commitAll,
  initRepo,
  projectHandoff,
  runCli,
  sampleFinding,
  tempDir,
  write,
} from './helpers.js'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

function invocation(cwd, rawInput = '') {
  const messages = []
  return {
    messages,
    invocation: {
      commandId: 'e2e',
      rawInput,
      attachments: [],
      signal: new AbortController().signal,
      agent: {
        session: { header: { cwd } },
        followup: (message) => messages.push(message),
      },
    },
  }
}

function latestRun(root) {
  const runs = join(root, '.logistics', 'runs')
  const entries = readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runs, entry.name))
    .sort()
  return entries.at(-1)
}

function securityFinding() {
  return sampleFinding('security', {
    title: '角色比较使用赋值而非相等',
    file: 'src/auth.js',
    line: 2,
    evidence: "if (user.role = 'admin') {",
    impact: '任何用户都会被当作管理员。',
    fix: {
      summary: '改为严格相等比较。',
      steps: ['把赋值改为 ===', '补充非管理员回归测试'],
      files: ['src/auth.js'],
      tests: ['src/auth.test.js: 普通用户不得进入管理分支'],
    },
  })
}

test('0.6.2 end-to-end: project dispatch -> handoff -> bundle -> verdict', async () => {
  const root = initRepo()
  try {
    write(root, 'src/auth.js', "export function isAdmin(user) {\n  if (user.role = 'admin') {\n    return true\n  }\n  return false\n}\n")
    commitAll(root, 'add auth bug')

    const security = createCommands({ pluginRoot }).find((command) => command.name === 'logi-security')
    const queued = invocation(root)
    const result = await security.handler(queued.invocation)
    assert.equal(result.kind, 'success', result.text)
    assert.equal(queued.messages.length, 1)
    const dispatch = queued.messages[0].content[0].text
    assert.match(dispatch, /项目后勤派发 · \/logi-security/u)
    assert.match(dispatch, /全项目审查/u)
    assert.match(dispatch, /project\.units/u)
    assert.match(dispatch, /collect\.mjs/u)
    assert.match(dispatch, /bundle\.mjs/u)
    assert.match(dispatch, /verdict\.mjs/u)

    const runDir = latestRun(root)
    const scope = JSON.parse(readFileSync(join(runDir, 'scope.json'), 'utf8'))
    assert.deepEqual(scope.experts, ['security'])
    assert.equal(scope.mode, 'project')
    assert.equal(scope.source, 'project')
    assert.ok(scope.project.units.length >= 1)

    const missing = loadHandoffs({ root, scope })
    assert.equal(missing.complete, false)
    assert.deepEqual(missing.missing, ['security'])

    write(runDir, 'handoff/security.json', JSON.stringify(projectHandoff('security', scope, [securityFinding()]), null, 2))
    const collected = runCli(pluginRoot, 'collect.mjs', ['--run', runDir])
    assert.equal(collected.code, 0, collected.output)
    assert.match(collected.output, /complete: true/u)

    const bundled = runCli(pluginRoot, 'bundle.mjs', ['--run', runDir])
    assert.equal(bundled.code, 0, bundled.output)
    const bundle = JSON.parse(readFileSync(join(runDir, 'handoffs.json'), 'utf8'))
    assert.equal(bundle.findings.length, 1)
    assert.match(bundle.findings[0].id, /^SEC-[A-F0-9]{5,8}$/u)
    assert.ok(existsSync(join(runDir, 'run.jsonl')))
    assert.deepEqual(
      readRunLog(runDir).map((entry) => entry.event),
      ['scope.created', 'dispatch.queued', 'dispatch.accepted', 'collect.completed', 'bundle.completed'],
    )

    const verdict = {
      schemaVersion: 2,
      runId: scope.runId,
      generatedAt: new Date().toISOString(),
      coverage: {
        expected: ['security'],
        received: ['security'],
        missing: [],
        complete: true,
      },
      findings: [bundle.findings[0]],
      dropped: [],
    }
    write(runDir, 'verdict.json', JSON.stringify(verdict, null, 2))
    write(runDir, 'report.md', aggregateReport(scope, [bundle.findings[0]]))
    const validated = runCli(pluginRoot, 'verdict.mjs', ['--run', runDir])
    assert.equal(validated.code, 0, validated.output)
    assert.match(validated.output, /findings: 1/u)
    assert.equal(validateVerdict({ root, scope, verdict }).ok, true)
    assert.ok(readRunLog(runDir).some((entry) => entry.event === 'verdict.validated' && entry.ok === true))

  } finally {
    cleanup(root)
  }
})

test('contract rejects missing sections and self-certified empty coverage', async () => {
  const root = initRepo()
  try {
    write(root, 'src/auth.js', "export function isAdmin(user) {\n  return user.role === 'admin'\n}\n")
    commitAll(root, 'auth')
    const command = createCommands({ pluginRoot }).find((item) => item.name === 'logi-security')
    const queued = invocation(root)
    await command.handler(queued.invocation)
    const runDir = latestRun(root)
    const scope = JSON.parse(readFileSync(join(runDir, 'scope.json'), 'utf8'))

    const broken = projectHandoff('security', scope, [])
    delete broken.sections.auth
    write(runDir, 'handoff/security.json', JSON.stringify(broken, null, 2))
    const inventory = loadHandoffs({ root, scope })
    assert.equal(inventory.complete, false)
    assert.match(inventory.handoffs.find((item) => item.expert === 'security').error, /sections 缺少/u)

    const missingUnit = projectHandoff('security', scope, [])
    delete missingUnit.units[scope.project.units[0].id]
    write(runDir, 'handoff/security.json', JSON.stringify(missingUnit, null, 2))
    const unitInventory = loadHandoffs({ root, scope })
    assert.equal(unitInventory.complete, false)
    assert.match(unitInventory.handoffs.find((item) => item.expert === 'security').error, /units 缺少或非法/u)

    const verdict = {
      schemaVersion: 2,
      runId: scope.runId,
      coverage: { expected: [], received: [], missing: [], complete: true },
      findings: [],
    }
    const result = validateVerdict({ root, scope, verdict })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /coverage\.expected 缺少/u)
  } finally {
    cleanup(root)
  }
})

test('temp dir helper stays isolated', () => {
  const root = tempDir('dsh-logi-e2e-')
  try {
    assert.ok(root.includes('dsh-logi-e2e-'))
  } finally {
    cleanup(root)
  }
})
