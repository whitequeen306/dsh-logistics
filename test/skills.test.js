import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { EXPERT_LIST } from '../lib/constants.js'
import { parseSkillFile } from '../lib/util.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const skillsDir = join(root, 'skills')

function readSkill(name) {
  return parseSkillFile(readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8'), name)
}

test('ships exactly the five 0.8.1 skills', () => {
  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(dirs, [
    'logi-correctness',
    'logi-maintainability',
    'logi-perf',
    'logi-reliability',
    'logi-security',
  ])
})

test('every skill has matching frontmatter and substantial content', () => {
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const parsed = readSkill(entry.name)
    assert.equal(parsed.name, entry.name)
    assert.ok(parsed.description.length > 20, entry.name)
    assert.ok(parsed.content.length > 500, entry.name)
  }
})

test('specialist skills match the five expert keys and declare sections', () => {
  for (const expert of EXPERT_LIST) {
    const parsed = readSkill(expert.skill)
    assert.equal(parsed.name, expert.skill)
    assert.match(parsed.content, new RegExp(`section`, 'iu'))
    for (const section of expert.sections) {
      assert.match(parsed.content, new RegExp(section, 'iu'), `${expert.skill}: ${section}`)
    }
  }
})

test('audit-expanded section coverage is declared', () => {
  const sections = Object.fromEntries(EXPERT_LIST.map((expert) => [expert.key, expert.sections]))
  assert.deepEqual(sections.correctness, [
    'logic',
    'state',
    'concurrency',
    'data-integrity',
    'contracts',
    'architecture',
    'edge-cases',
  ])
  assert.deepEqual(sections.security, [
    'auth',
    'authz',
    'injection',
    'browser',
    'uploads',
    'secrets',
    'crypto',
    'exposure',
    'business-logic',
    'supply-chain',
  ])
  assert.deepEqual(sections.reliability, [
    'error-handling',
    'resilience',
    'observability',
    'tests',
  ])
  assert.deepEqual(sections.maintainability, [
    'simplify',
    'coupling',
    'cleanup',
  ])
  assert.deepEqual(sections.perf, ['hot-path', 'data-access', 'runtime', 'frontend', 'memory-startup'])
})

test('every specialist carries the shared handoff contract inline', () => {
  for (const expert of EXPERT_LIST) {
    const parsed = readSkill(expert.skill)
    for (const token of ['schemaVersion', 'sections', 'handoff', 'direct', 'plan', 'fix', 'kind']) {
      assert.match(parsed.content, new RegExp(token, 'iu'), `${expert.skill}: ${token}`)
    }
    assert.match(parsed.content, /kind[^\n]*direct/iu)
    assert.match(parsed.content, /summary/iu)
    assert.doesNotMatch(parsed.content, /logi-core/u)
  }
})
