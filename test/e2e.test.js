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
  cleanup,
  commitAll,
  handoff,
  initRepo,
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

test('0.3.3 end-to-end: dispatch -> handoff -> bundle -> verdict -> fix dry-run', async () => {
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
    assert.match(dispatch, /只运行 \*\*安全（security）\*\*/u)
    assert.match(dispatch, /collect\.mjs/u)
    assert.match(dispatch, /bundle\.mjs/u)
    assert.match(dispatch, /verdict\.mjs/u)

    const runDir = latestRun(root)
    const scope = JSON.parse(readFileSync(join(runDir, 'scope.json'), 'utf8'))
    assert.deepEqual(scope.experts, ['security'])

    const missing = loadHandoffs({ root, scope })
    assert.equal(missing.complete, false)
    assert.deepEqual(missing.missing, ['security'])

    write(runDir, 'handoff/security.json', JSON.stringify(handoff('security', [securityFinding()]), null, 2))
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

    const verdictPath = join(runDir, 'verdict.json')
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
    const validated = runCli(pluginRoot, 'verdict.mjs', ['--run', runDir])
    assert.equal(validated.code, 0, validated.output)
    assert.match(validated.output, /findings: 1/u)
    assert.equal(validateVerdict({ root, scope, verdict }).ok, true)
    assert.ok(readRunLog(runDir).some((entry) => entry.event === 'verdict.validated' && entry.ok === true))

    const id = bundle.findings[0].id
    const fix = createCommands({ pluginRoot }).find((command) => command.name === 'logi-fix')
    const listed = invocation(root)
    const listedResult = await fix.handler(listed.invocation)
    assert.equal(listedResult.kind, 'success', listedResult.text)
    assert.match(listedResult.text, new RegExp(id, 'u'))

    const dry = invocation(root, `--dry-run ${id}`)
    const dryResult = await fix.handler(dry.invocation)
    assert.equal(dryResult.kind, 'success', dryResult.text)
    assert.match(dryResult.text, /修复计划/u)
    assert.equal(dry.messages.length, 0)
    assert.throws(() => readdirSync(join(root, '.logistics', 'fixes')), /ENOENT/u)
    assert.ok(verdictPath.endsWith('verdict.json'))

    const apply = invocation(root, id)
    const applyResult = await fix.handler(apply.invocation)
    assert.equal(applyResult.kind, 'success', applyResult.text)
    assert.equal(apply.messages.length, 1)
    const fixDispatch = apply.messages[0].content[0].text
    assert.match(fixDispatch, /selection\.json/u)
    assert.match(fixDispatch, /verdict\.json/u)
    assert.match(fixDispatch, /fix\.json/u)
    const fixDirs = readdirSync(join(root, '.logistics', 'fixes'))
    const selection = JSON.parse(readFileSync(join(root, '.logistics', 'fixes', fixDirs[0], 'selection.json'), 'utf8'))
    assert.equal(selection.verdictRunId, scope.runId)
    assert.match(selection.head, /^[a-f0-9]{40}$/u)
    assert.deepEqual(selection.ids, [id])
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

    const broken = handoff('security', [])
    delete broken.sections.auth
    write(runDir, 'handoff/security.json', JSON.stringify(broken, null, 2))
    const inventory = loadHandoffs({ root, scope })
    assert.equal(inventory.complete, false)
    assert.match(inventory.handoffs.find((item) => item.expert === 'security').error, /sections 缺少/u)

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
