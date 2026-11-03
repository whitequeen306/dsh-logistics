import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, name } from '../lib/index.js'

test('plugin entry registers all 0.2.0 skills and commands against a DSH-like context', () => {
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

  assert.equal(skills.length, 8)
  assert.equal(new Set(skills.map((skill) => skill.name)).size, 8)
  for (const skill of skills) {
    assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    assert.ok(skill.description.length > 0)
    assert.ok(skill.content.length > 100)
    assert.equal(skill.source, 'dsh-logistics')
  }
  assert.deepEqual(
    new Set(skills.map((skill) => skill.name)),
    new Set([
      'logi-core',
      'logi-pipeline',
      'logi-correctness',
      'logi-security',
      'logi-reliability',
      'logi-maintainability',
      'logi-perf',
      'logi-fix',
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
      'logi-fix',
    ],
  )
  assert.equal(new Set(commands.map((command) => command.name)).size, 7)
  assert.ok(logs.some((line) => line.includes('8 个 skill') && line.includes('7 个命令')))
})
