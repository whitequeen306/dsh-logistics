import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, name } from '../lib/index.js'

test('plugin entry registers all skills and commands against a DSH-like context', () => {
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

  assert.equal(skills.length, 10)
  assert.equal(commands.length, 12)
  assert.equal(new Set(skills.map((skill) => skill.name)).size, 10)
  assert.equal(new Set(commands.map((command) => command.name)).size, 12)
  for (const skill of skills) {
    assert.equal(skill.source, 'dsh-logistics')
    assert.ok(skill.content.length > 500)
  }
  for (const command of commands) {
    assert.match(command.name, /^[a-z][a-z0-9_-]*$/)
    assert.ok(command.description.length > 4)
  }
  assert.match(logs.join('\n'), /10 个 skill、12 个命令/)
})
