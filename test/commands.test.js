import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createCommands } from '../lib/commands.js'
import { buildReport } from '../lib/report.js'
import {
  cleanup,
  git,
  handoff,
  initRepo,
  makeScope,
  sampleFinding,
  tempDir,
  write,
} from './helpers.js'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

function invocation(cwd, { rawInput = '', aborted = false } = {}) {
  const messages = []
  const controller = new AbortController()
  if (aborted) controller.abort()
  return {
    messages,
    invocation: {
      commandId: 'test',
      rawInput,
      attachments: [],
      signal: controller.signal,
      agent: {
        session: { header: { cwd } },
        followup: (message) => messages.push(message),
      },
    },
  }
}

function writeHandoffs(created, findingsByExpert) {
  for (const [expert, findings] of Object.entries(findingsByExpert)) {
    write(created.runDir, `handoff/${expert}.json`, JSON.stringify(handoff(expert, findings), null, 2))
  }
}

function latestRunDir(root) {
  const runs = join(root, '.logistics', 'runs')
  const entries = readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runs, entry.name))
    .sort()
  return entries.at(-1)
}

function makeCompleteReport(root) {
  const created = makeScope(root, ['correctness', 'security', 'reliability', 'maintainability'])
  writeHandoffs(created, {
    correctness: [sampleFinding('correctness', { title: '边界判断错误' })],
    security: [],
    reliability: [],
    maintainability: [],
  })
  const { report } = buildReport({
    root,
    runDir: created.runDir,
    scope: created.scope,
    config: { maxFindingsPerPass: 12 },
  })
  return report
}

test('registers exactly seven 0.2.0 commands', () => {
  const commands = createCommands({ pluginRoot })
  assert.deepEqual(
    commands.map((command) => command.name),
    [
      'logi',
      'logi-correctness',
      'logi-security',
      'logi-reliability',
      'logi-maintainability',
      'logi-perf',
      'logi-fix',
    ],
  )
  for (const command of commands) {
    assert.equal(typeof command.description, 'string')
    assert.ok(command.description.length > 0)
    assert.equal(command.input.attachments, false)
  }
})

test('/logi creates a four-expert pipeline scope and queues one dispatch', async () => {
  const root = initRepo()
  try {
    const { invocation: inv, messages } = invocation(root)
    const command = createCommands({ pluginRoot }).find((item) => item.name === 'logi')
    const result = await command.handler(inv)

    assert.equal(result.kind, 'success')
    assert.match(result.text, /4 位专家/u)
    assert.equal(messages.length, 1)
    assert.match(messages[0].content[0].text, /后勤派发 · \/logi/u)
    assert.match(messages[0].content[0].text, /logi-pipeline/u)

    const scope = JSON.parse(readFileSync(join(latestRunDir(root), 'scope.json'), 'utf8'))
    assert.deepEqual(scope.experts, ['correctness', 'security', 'reliability', 'maintainability'])
    assert.equal(scope.schemaVersion, 2)
  } finally {
    cleanup(root)
  }
})

test('a single-expert command creates one-expert scope and dispatch', async () => {
  const root = initRepo()
  try {
    const { invocation: inv, messages } = invocation(root)
    const command = createCommands({ pluginRoot }).find((item) => item.name === 'logi-correctness')
    const result = await command.handler(inv)

    assert.equal(result.kind, 'success')
    assert.match(result.text, /正确性/u)
    assert.equal(messages.length, 1)
    assert.match(messages[0].content[0].text, /只运行 \*\*正确性（correctness）\*\*/u)

    const scope = JSON.parse(readFileSync(join(latestRunDir(root), 'scope.json'), 'utf8'))
    assert.deepEqual(scope.experts, ['correctness'])
  } finally {
    cleanup(root)
  }
})

test('aborted and no-file runs return errors without queues', async () => {
  const root = initRepo()
  try {
    const aborted = invocation(root, { aborted: true })
    const command = createCommands({ pluginRoot }).find((item) => item.name === 'logi')
    const result = await command.handler(aborted.invocation)
    assert.equal(result.kind, 'error')
    assert.equal(aborted.messages.length, 0)

    const empty = tempDir('dsh-logi-empty-')
    try {
      git(empty, 'init', '-q')
      git(empty, 'config', 'user.email', 'logi@example.com')
      git(empty, 'config', 'user.name', 'Logi Test')
      git(empty, 'commit', '--allow-empty', '-q', '-m', 'empty')
      const emptyInvocation = invocation(empty)
      const emptyResult = await command.handler(emptyInvocation.invocation)
      assert.equal(emptyResult.kind, 'error')
      assert.match(emptyResult.text, /没有检测到可分析的改动/u)
      assert.equal(emptyInvocation.messages.length, 0)
    } finally {
      cleanup(empty)
    }
  } finally {
    cleanup(root)
  }
})

test('/logi-fix without a report and with unsupported flags returns errors', async () => {
  const root = initRepo()
  try {
    const command = createCommands({ pluginRoot }).find((item) => item.name === 'logi-fix')
    const missing = invocation(root)
    const missingResult = await command.handler(missing.invocation)
    assert.equal(missingResult.kind, 'error')
    assert.match(missingResult.text, /还没有完整报告/u)

    makeCompleteReport(root)
    const unsupported = invocation(root, { rawInput: '--all' })
    const unsupportedResult = await command.handler(unsupported.invocation)
    assert.equal(unsupportedResult.kind, 'error')
    assert.match(unsupportedResult.text, /不支持 --all/u)
  } finally {
    cleanup(root)
  }
})

test('/logi-fix lists direct IDs and dry-run never dispatches', async () => {
  const root = initRepo()
  try {
    const report = makeCompleteReport(root)
    const id = report.findings[0].id
    const command = createCommands({ pluginRoot }).find((item) => item.name === 'logi-fix')

    const list = invocation(root)
    const listResult = await command.handler(list.invocation)
    assert.equal(listResult.kind, 'success')
    assert.match(listResult.text, new RegExp(id, 'u'))
    assert.equal(list.messages.length, 0)

    const dry = invocation(root, { rawInput: `--dry-run ${id}` })
    const dryResult = await command.handler(dry.invocation)
    assert.equal(dryResult.kind, 'success')
    assert.match(dryResult.text, /修复计划/u)
    assert.match(dryResult.text, /dry-run/u)
    assert.equal(dry.messages.length, 0)
    assert.equal(existsSync(join(root, '.logistics', 'fixes')), false)
  } finally {
    cleanup(root)
  }
})

test('/logi-fix applies a direct ID by writing selection and dispatching once', async () => {
  const root = initRepo()
  try {
    const report = makeCompleteReport(root)
    const id = report.findings[0].id
    const command = createCommands({ pluginRoot }).find((item) => item.name === 'logi-fix')
    const { invocation: inv, messages } = invocation(root, { rawInput: id })

    const result = await command.handler(inv)
    assert.equal(result.kind, 'success')
    assert.match(result.text, /已派发修复/u)
    assert.equal(messages.length, 1)
    assert.match(messages[0].content[0].text, /写操作/u)

    const fixes = join(root, '.logistics', 'fixes')
    const fixDir = join(fixes, readdirSync(fixes)[0])
    const selection = JSON.parse(readFileSync(join(fixDir, 'selection.json'), 'utf8'))
    assert.equal(selection.schemaVersion, 2)
    assert.deepEqual(selection.ids, [id])
    assert.ok(selection.allowedFiles.includes('src/a.js'))
  } finally {
    cleanup(root)
  }
})
