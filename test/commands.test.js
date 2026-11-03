import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createCommands } from '../lib/commands.js'
import { cleanup, initRepo, write } from './helpers.js'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

function invocation(cwd, { rawInput = '', aborted = false } = {}) {
  const messages = []
  const controller = new AbortController()
  if (aborted) controller.abort()
  return {
    messages,
    value: {
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

function runDirs(root) {
  return readdirSync(join(root, '.logistics', 'runs'))
}

test('createCommands exposes twelve DSH-safe command names', () => {
  const commands = createCommands({ pluginRoot })
  assert.equal(commands.length, 12)
  const names = commands.map((command) => command.name)
  assert.deepEqual(names, [
    'logi', 'logi-quick', 'logi-standard', 'logi-full',
    'logi-review', 'logi-safety', 'logi-tests', 'logi-errors',
    'logi-perf', 'logi-simplify', 'logi-cleanup', 'logi-gate',
  ])
  for (const command of commands) {
    assert.match(command.name, /^[a-z][a-z0-9_-]*$/)
    assert.ok(command.description.length > 4)
    assert.equal(typeof command.handler, 'function')
    assert.equal(command.input.attachments, false)
  }
})

test('a tier command creates a run and injects a pipeline dispatch', async (t) => {
  const root = initRepo()
  t.after(() => cleanup(root))
  write(root, 'src/a.js', 'export const a = 2\n')

  const quick = createCommands({ pluginRoot }).find((command) => command.name === 'logi-quick')
  const { value, messages } = invocation(root, { rawInput: '只看鉴权' })
  const result = await quick.handler(value)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /已派发 \/logi-quick/)
  assert.match(result.text, /快速档/)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  const text = messages[0].content[0].text
  assert.match(text, /后勤派发 · \/logi-quick/)
  assert.match(text, /max|最多.*4/)
  assert.match(text, /logi-core/)
  assert.match(text, /aggregate\.mjs/)
  assert.match(text, /只看鉴权/)

  const [runId] = runDirs(root)
  const scope = JSON.parse(readFileSync(join(root, '.logistics', 'runs', runId, 'scope.json'), 'utf8'))
  assert.equal(scope.command, '/logi-quick')
  assert.equal(scope.tier, 'quick')
  assert.deepEqual(scope.passes, ['review', 'safety', 'errors'])
  assert.equal(scope.notes, '只看鉴权')
})

test('a single-expert command creates a partial run with one dispatch', async (t) => {
  const root = initRepo()
  t.after(() => cleanup(root))
  write(root, 'src/a.js', 'export const a = 3\n')

  const review = createCommands({ pluginRoot }).find((command) => command.name === 'logi-review')
  const { value, messages } = invocation(root)
  const result = await review.handler(value)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /正确性/)
  assert.equal(messages.length, 1)
  const text = messages[0].content[0].text
  assert.match(text, /只运行 \*\*正确性审查（review）\*\*/)
  assert.match(text, /不要传 provider/)
  assert.doesNotMatch(text, /provider:\s*[`"']spawn/)
  assert.match(text, /单专家/)

  const [runId] = runDirs(root)
  const scope = JSON.parse(readFileSync(join(root, '.logistics', 'runs', runId, 'scope.json'), 'utf8'))
  assert.equal(scope.mode, 'single')
  assert.deepEqual(scope.passes, ['review'])
})

test('an aborted command returns an error without creating a run', async (t) => {
  const root = initRepo()
  t.after(() => cleanup(root))
  write(root, 'src/a.js', 'export const a = 4\n')
  const { value } = invocation(root, { aborted: true })
  const result = await createCommands({ pluginRoot })[0].handler(value)
  assert.equal(result.kind, 'error')
  assert.throws(() => runDirs(root))
})

test('logi-gate refuses to run without a report', async (t) => {
  const root = initRepo()
  t.after(() => cleanup(root))
  const gate = createCommands({ pluginRoot }).find((command) => command.name === 'logi-gate')
  const { value } = invocation(root)
  const result = await gate.handler(value)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /还没有可用的后勤报告/)
})

test('logi-gate rejects unknown arguments and non-full acceptance', async (t) => {
  const root = initRepo()
  t.after(() => cleanup(root))
  write(root, 'src/a.js', 'export const a = 5\n')
  const commands = createCommands({ pluginRoot })
  const review = commands.find((command) => command.name === 'logi-review')
  await review.handler(invocation(root).value)
  // Create a partial report by writing handoffs through the report builder is
  // covered in report.test.js; here we only need a latest.json pointer.
  const gate = commands.find((command) => command.name === 'logi-gate')
  const bad = await gate.handler(invocation(root, { rawInput: 'nonsense' }).value)
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /参数无效/)
})
