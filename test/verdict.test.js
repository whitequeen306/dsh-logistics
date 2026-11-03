import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_EXPERTS } from '../lib/constants.js'
import { validateVerdict } from '../lib/verdict.js'
import {
  cleanup,
  handoff,
  initRepo,
  makeScope,
  runCli,
  sampleFinding,
  write,
} from './helpers.js'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

function completeRun(root) {
  const created = makeScope(root, [...DEFAULT_EXPERTS])
  for (const expert of DEFAULT_EXPERTS) {
    const findings = expert === 'correctness' ? [sampleFinding(expert)] : []
    write(created.runDir, `handoff/${expert}.json`, JSON.stringify(handoff(expert, findings), null, 2))
  }
  return created
}

test('collect is advisory and reports missing handoffs without failing', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, [...DEFAULT_EXPERTS])
    const missing = runCli(pluginRoot, 'collect.mjs', ['--run', created.runDir])
    assert.equal(missing.code, 0)
    assert.match(missing.output, /missing: correctness,security,reliability,maintainability/u)
    assert.match(missing.output, /不是质量裁决/u)

    for (const expert of DEFAULT_EXPERTS) {
      write(created.runDir, `handoff/${expert}.json`, JSON.stringify(handoff(expert, []), null, 2))
    }
    const complete = runCli(pluginRoot, 'collect.mjs', ['--run', created.runDir])
    assert.equal(complete.code, 0)
    assert.match(complete.output, /complete: true/u)
  } finally {
    cleanup(root)
  }
})

test('bundle assigns stable IDs and writes the editor packet', () => {
  const root = initRepo()
  try {
    const created = completeRun(root)
    const result = runCli(pluginRoot, 'bundle.mjs', ['--run', created.runDir])
    assert.equal(result.code, 0, result.output)

    const bundle = JSON.parse(readFileSync(join(created.runDir, 'handoffs.json'), 'utf8'))
    assert.equal(bundle.coverage.complete, true)
    assert.equal(bundle.findings.length, 1)
    assert.match(bundle.findings[0].id, /^COR-[A-F0-9]{5,8}$/u)
    assert.deepEqual(bundle.findings[0].fix.files, ['src/a.js'])

    const packet = readFileSync(join(created.runDir, 'packet.md'), 'utf8')
    assert.match(packet, /COR-[A-F0-9]{5,8}/u)
    assert.match(packet, /correctness/u)
  } finally {
    cleanup(root)
  }
})

test('verdict validates a complete editor decision and normalizes fix files', () => {
  const root = initRepo()
  try {
    const created = completeRun(root)
    const bundle = runCli(pluginRoot, 'bundle.mjs', ['--run', created.runDir])
    assert.equal(bundle.code, 0, bundle.output)
    const parsed = JSON.parse(readFileSync(join(created.runDir, 'handoffs.json'), 'utf8'))
    const finding = { ...parsed.findings[0], module: 'src' }

    const verdict = {
      schemaVersion: 2,
      runId: created.scope.runId,
      generatedAt: new Date().toISOString(),
      coverage: {
        expected: [...DEFAULT_EXPERTS],
        received: [...DEFAULT_EXPERTS],
        missing: [],
        complete: true,
      },
      findings: [finding],
      dropped: [],
    }
    write(created.runDir, 'verdict.json', JSON.stringify(verdict, null, 2))
    const result = runCli(pluginRoot, 'verdict.mjs', ['--run', created.runDir])
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /findings: 1/u)

    const invalid = { ...verdict, findings: [{ ...finding, fix: { ...finding.fix, files: [{ file: 'src/a.js' }] } }] }
    const validated = validateVerdict({ root, scope: created.scope, verdict: invalid })
    assert.equal(validated.ok, false)
    assert.match(validated.errors.join('\n'), /fix\.files/u)
  } finally {
    cleanup(root)
  }
})

test('verdict rejects missing coverage and duplicate IDs', () => {
  const root = initRepo()
  try {
    const created = completeRun(root)
    const bundle = runCli(pluginRoot, 'bundle.mjs', ['--run', created.runDir])
    assert.equal(bundle.code, 0, bundle.output)
    const finding = { ...JSON.parse(readFileSync(join(created.runDir, 'handoffs.json'), 'utf8')).findings[0], module: 'src' }
    const base = {
      schemaVersion: 2,
      runId: created.scope.runId,
      coverage: {
        expected: [...DEFAULT_EXPERTS],
        received: ['correctness'],
        missing: ['security', 'reliability', 'maintainability'],
        complete: true,
      },
      findings: [finding, { ...finding }],
    }
    const result = validateVerdict({ root, scope: created.scope, verdict: base })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /重复 id/u)
    assert.equal(result.verdict.coverage.complete, false)
  } finally {
    cleanup(root)
  }
})
