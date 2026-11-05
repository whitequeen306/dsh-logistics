import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createCommands } from '../lib/commands.js'
import { readRunLog } from '../lib/runlog.js'
import {
  cleanup,
  git,
  initRepo,
  tempDir,
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

function latestRunDir(root) {
  const runs = join(root, '.logistics', 'runs')
  const entries = readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runs, entry.name))
    .sort()
  return entries.at(-1)
}

test('registers exactly six commands', () => {
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
    ],
  )
  for (const command of commands) {
    assert.equal(typeof command.description, 'string')
    assert.ok(command.description.length >= 30, `${command.name} description is too short`)
    assert.match(command.description, /全项目/u)
    assert.equal(command.input.attachments, false)
  }
  assert.equal(new Set(commands.map((command) => command.description)).size, commands.length)
  const security = commands.find((command) => command.name === 'logi-security')
  assert.match(security.description, /认证授权/u)
  assert.match(security.description, /供应链/u)
})

test('/logi creates a four-expert pipeline scope and queues one dispatch', async () => {
  const root = initRepo()
  try {
    const { invocation: inv, messages } = invocation(root)
    const command = createCommands({ pluginRoot }).find((item) => item.name === 'logi')
    const result = await command.handler(inv)

    assert.equal(result.kind, 'success')
    assert.match(result.text, /4 位专家/u)
    assert.match(result.text, /全项目/u)
    assert.equal(messages.length, 1)
    assert.match(messages[0].content[0].text, /项目后勤派发 · \/logi/u)
    assert.match(messages[0].content[0].text, /全项目审查/u)
    assert.match(messages[0].content[0].text, /最多同时发 4 个 subagent/u)
    assert.match(messages[0].content[0].text, /logi-correctness/u)

    const scope = JSON.parse(readFileSync(join(latestRunDir(root), 'scope.json'), 'utf8'))
    assert.deepEqual(scope.experts, ['correctness', 'security', 'reliability', 'maintainability'])
    assert.equal(scope.schemaVersion, 2)
    assert.equal(scope.mode, 'project')
    assert.equal(scope.source, 'project')
    assert.ok(scope.project.units.length >= 1)

    const runDir = latestRunDir(root)
    const events = readRunLog(runDir).map((entry) => entry.event)
    assert.deepEqual(events, ['scope.created', 'dispatch.queued', 'dispatch.accepted'])
    assert.ok(existsSync(join(runDir, 'dispatch.md')))
    for (const expert of scope.experts) {
      assert.ok(existsSync(join(runDir, 'prompts', `${expert}.md`)), expert)
    }
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
    assert.match(result.text, /全项目/u)
    assert.equal(messages.length, 1)
    assert.match(messages[0].content[0].text, /项目后勤派发 · \/logi-correctness/u)
    assert.match(messages[0].content[0].text, /correctness/u)

    const scope = JSON.parse(readFileSync(join(latestRunDir(root), 'scope.json'), 'utf8'))
    assert.deepEqual(scope.experts, ['correctness'])
    assert.equal(scope.mode, 'project')
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
      assert.match(emptyResult.text, /没有检测到可分析的项目文件/u)
      assert.equal(emptyInvocation.messages.length, 0)
    } finally {
      cleanup(empty)
    }
  } finally {
    cleanup(root)
  }
})
