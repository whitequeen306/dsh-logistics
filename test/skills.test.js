import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { PASS_LIST } from '../lib/constants.js'
import { parseSkillFile } from '../lib/util.js'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const skillsDir = join(root, 'skills')

const expected = [
  'logi-core',
  'logi-pipeline',
  ...PASS_LIST.map((pass) => pass.skill),
  'logi-gate',
].sort()

test('all expected skills exist with valid frontmatter', () => {
  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(dirs, expected)

  for (const name of dirs) {
    const file = join(skillsDir, name, 'SKILL.md')
    const parsed = parseSkillFile(readFileSync(file, 'utf8'), name)
    assert.equal(parsed.name, name, `${name} frontmatter name`)
    assert.ok(parsed.description.length > 20, `${name} description should be meaningful`)
    assert.ok(parsed.description.length <= 1024, `${name} description is too long`)
    assert.ok(parsed.content.length > 500, `${name} content is too short`)
    assert.match(parsed.content, /^# /m, `${name} needs a heading`)
  }
})

test('specialist skills are referenced by PASS_LIST', () => {
  for (const pass of PASS_LIST) {
    assert.ok(pass.skill.startsWith('logi-'))
    assert.ok(expected.includes(pass.skill))
  }
})

test('core skill contains the handoff contract and child template', () => {
  const content = readFileSync(join(skillsDir, 'logi-core', 'SKILL.md'), 'utf8')
  for (const token of ['schemaVersion', 'findings', '"status": "failed"', 'Child task template', 'deferred']) {
    assert.ok(content.includes(token), `logi-core should mention ${token}`)
  }
})

test('pipeline skill enforces waves, retry, and aggregate', () => {
  const content = readFileSync(join(skillsDir, 'logi-pipeline', 'SKILL.md'), 'utf8')
  for (const token of ['4 subagents', 'retry', 'aggregate', 'coverage.full', 'status']) {
    assert.ok(content.includes(token), `logi-pipeline should mention ${token}`)
  }
})
