import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildReport } from '../lib/report.js'
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

function writeHandoffs(created, byExpert) {
  for (const [expert, findings] of Object.entries(byExpert)) {
    write(created.runDir, `handoff/${expert}.json`, JSON.stringify(handoff(expert, findings), null, 2))
  }
}

test('status reports missing handoffs, then ready after all experts finish', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, ['correctness', 'security'])
    const before = runCli(pluginRoot, 'status.mjs', ['--run', created.runDir])
    assert.equal(before.code, 1)
    assert.match(before.output, /missing: correctness,security/u)
    assert.match(before.output, /ready: false/u)

    writeHandoffs(created, {
      correctness: [sampleFinding('correctness')],
      security: [],
    })
    const after = runCli(pluginRoot, 'status.mjs', ['--run', created.runDir])
    assert.equal(after.code, 0)
    assert.match(after.output, /correctness \[正确性\]: ok/u)
    assert.match(after.output, /ready: true/u)
  } finally {
    cleanup(root)
  }
})

test('aggregate writes a module report and exits 0 only for complete coverage', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, ['correctness', 'security', 'reliability', 'maintainability'])
    writeHandoffs(created, {
      correctness: [sampleFinding('correctness', { title: '边界判断错误' })],
      security: [],
      reliability: [],
      maintainability: [],
    })

    const result = runCli(pluginRoot, 'aggregate.mjs', ['--run', created.runDir])
    assert.equal(result.code, 0)
    assert.match(result.output, /report: .*report\.json/u)
    assert.match(result.output, /coverage: 4\/4 \(complete=true, publishable=true\)/u)
    assert.match(result.output, /findings: total=1/u)
    assert.match(result.output, /direct: 1/u)
    assert.doesNotMatch(result.output, /score|gate|baseline/u)
  } finally {
    cleanup(root)
  }
})

test('partial or invalid handoffs keep latest unchanged and aggregate exits 3', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, ['correctness', 'security'])
    writeHandoffs(created, {
      correctness: [sampleFinding('correctness')],
      security: [],
    })
    const first = runCli(pluginRoot, 'aggregate.mjs', ['--run', created.runDir])
    assert.equal(first.code, 0)

    const partial = makeScope(root, ['correctness', 'security'])
    writeHandoffs(partial, {
      correctness: [sampleFinding('correctness')],
      security: [],
    })
    write(partial.runDir, 'handoff/security.json', JSON.stringify(
      handoff('security', [], { status: 'partial', notes: 'only a.js' }),
      null,
      2,
    ))
    const second = runCli(pluginRoot, 'aggregate.mjs', ['--run', partial.runDir])
    assert.equal(second.code, 3)
    assert.match(second.output, /latest: 未更新/u)
    assert.match(second.output, /partial: security/u)

    const invalid = makeScope(root, ['correctness'])
    write(invalid.runDir, 'handoff/correctness.json', JSON.stringify({
      schemaVersion: 2,
      expert: 'correctness',
      status: 'ok',
      summary: '',
      sections: {},
      findings: [],
    }, null, 2))
    const third = runCli(pluginRoot, 'status.mjs', ['--run', invalid.runDir])
    assert.equal(third.code, 1)
    assert.match(third.output, /invalid: correctness/u)

    const fourth = runCli(pluginRoot, 'aggregate.mjs', ['--run', invalid.runDir])
    assert.equal(fourth.code, 3)
    assert.match(fourth.output, /invalid: correctness/u)
  } finally {
    cleanup(root)
  }
})

test('aggregate report contains modules, coverage, and fix order', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, ['correctness', 'security'])
    writeHandoffs(created, {
      correctness: [sampleFinding('correctness', { title: '空值分支' })],
      security: [],
    })
    const { report } = buildReport({
      root,
      runDir: created.runDir,
      scope: created.scope,
      config: { maxFindingsPerPass: 12 },
    })

    assert.equal(report.schemaVersion, 2)
    assert.equal(report.coverage.complete, true)
    assert.equal(report.coverage.full, false)
    assert.ok(report.modules.length > 0)
    assert.ok(report.fixOrder.length > 0)
    assert.equal(report.score, undefined)
    assert.equal(report.gate, undefined)
    assert.equal(report.baseline, undefined)
  } finally {
    cleanup(root)
  }
})
