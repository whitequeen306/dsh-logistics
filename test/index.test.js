import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, name } from '../lib/index.js'

test('plugin entry registers all 0.6.4 skills and commands against a DSH-like context', () => {
  const skills = []
  const commands = []
  const logs = []
  const ctx = {
    skills: { register: (skill) => skills.push(skill) },
    commands: { register: (command) => commands.push(command) },
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
  }

  assert.equal(name, 'dsh-logistics')
  assert.deepEqual(inject, ['commands', 'skills'])

  apply(ctx)

  assert.equal(skills.length, 5)
  assert.equal(new Set(skills.map((skill) => skill.name)).size, 5)
  for (const skill of skills) {
    assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    assert.ok(skill.description.length > 0)
    assert.ok(skill.content.length > 100)
    assert.equal(skill.source, 'dsh-logistics')
  }
  assert.deepEqual(
    new Set(skills.map((skill) => skill.name)),
    new Set([
      'logi-correctness',
      'logi-security',
      'logi-reliability',
      'logi-maintainability',
      'logi-perf',
    ]),
  )

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
  assert.equal(new Set(commands.map((command) => command.name)).size, 6)
  assert.ok(logs.some((line) => line.includes('5 个 skill') && line.includes('6 个命令')))
})
