import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_CONFIG, PASS_LIST } from '../lib/constants.js'
import { acceptBaseline } from '../lib/baseline.js'
import { buildReport, computeScore } from '../lib/report.js'
import { cleanup, handoff, sampleFinding, tempDir } from './helpers.js'

function makeScope(root, passes) {
  const runId = 'run-test'
  const runDir = join(root, '.logistics', 'runs', runId)
  return {
    runId,
    runDir,
    scope: {
      schemaVersion: 1,
      runId,
      command: '/logi-full',
      mode: 'full',
      tier: 'full',
      passes,
      notes: '',
      root,
      cwd: root,
      isGit: false,
      source: 'filesystem',
      createdAt: new Date().toISOString(),
      git: {},
      stats: { analyzedFiles: 3, filesChanged: 3, additions: 10, deletions: 2 },
      summary: {
        byStatus: {},
        languages: [{ name: 'js', count: 3 }],
        sourceFiles: 3,
        testFiles: 0,
        docsFiles: 0,
        sensitiveFiles: 0,
        dependencyFiles: 0,
      },
      risk: { level: 'medium', score: 2, reasons: [], recommendTier: 'standard', docsOnly: false },
      testCommand: { command: 'node --test', source: 'package.json' },
      files: [],
      output: {},
      warnings: [],
    },
  }
}

function writeHandoff(runDir, pass, findings) {
  mkdirSync(join(runDir, 'handoff'), { recursive: true })
  writeFileSync(join(runDir, 'handoff', `${pass}.json`), handoff(pass, findings))
}

const critical = {
  ...sampleFinding,
  category: 'authz',
  severity: 'critical',
  title: '缺少对象级鉴权',
  file: 'src/auth.js',
  line: 10,
  ruleId: 'SEC-authz',
  evidence: '10: router.delete("/:id", handler) // 未校验资源归属',
}

test('buildReport normalizes, scores, and gates a full run', (t) => {
  const root = tempDir()
  t.after(() => cleanup(root))
  const passes = PASS_LIST.map((pass) => pass.key)
  const { runDir, scope } = makeScope(root, passes)
  for (const pass of passes) writeHandoff(runDir, pass, [])
  writeHandoff(runDir, 'review', [
    sampleFinding,
    { ...sampleFinding, title: '缺少证据的严重项', severity: 'critical', evidence: '' },
  ])
  writeHandoff(runDir, 'safety', [critical])

  const { report, reportJsonPath, latestMarkdownPath } = buildReport({
    root,
    runDir,
    scope,
    config: DEFAULT_CONFIG,
  })

  assert.equal(report.coverage.full, true)
  assert.equal(report.coverage.valid, 7)
  assert.equal(report.findings.length, 3)
  assert.equal(report.counts.bySeverity.critical, 2)
  assert.equal(report.counts.lowConfidence, 1)
  // 10 (high) + 25 (critical) = 35; the evidence-free critical is uncounted.
  assert.equal(report.score.value, 65)
  assert.equal(report.score.grade, 'D')
  assert.equal(report.gate.status, 'fail')
  assert.equal(report.gate.code, 1)
  assert.equal(report.gate.newCritical, 1)
  assert.equal(reportJsonPath, join(runDir, 'report.json'))
  assert.match(report.summary, /严重|高风险|65/)
  assert.match(reportJsonPath, /report\.json$/)
  assert.match(latestMarkdownPath, /latest\.md$/)
})

test('acceptBaseline makes existing findings non-new and clears the gate', (t) => {
  const root = tempDir()
  t.after(() => cleanup(root))
  const passes = PASS_LIST.map((pass) => pass.key)
  const { runDir, scope } = makeScope(root, passes)
  for (const pass of passes) writeHandoff(runDir, pass, [])
  writeHandoff(runDir, 'safety', [critical])

  const first = buildReport({ root, runDir, scope, config: DEFAULT_CONFIG })
  assert.equal(first.report.gate.code, 1)
  acceptBaseline({ root, report: first.report })

  const second = buildReport({ root, runDir, scope, config: DEFAULT_CONFIG })
  assert.equal(second.report.baseline.hasBaseline, true)
  assert.equal(second.report.baseline.newCounts.critical, 0)
  assert.equal(second.report.baseline.existingCount, 1)
  assert.equal(second.report.gate.code, 0)
  assert.equal(second.report.gate.status, 'pass')
})

test('single-pass and missing-handoff runs cannot pass the gate', (t) => {
  const root = tempDir()
  t.after(() => cleanup(root))
  const { runDir, scope } = makeScope(root, ['review'])
  writeHandoff(runDir, 'review', [sampleFinding])

  const { report } = buildReport({ root, runDir, scope, config: DEFAULT_CONFIG })
  assert.equal(report.coverage.complete, true)
  assert.equal(report.coverage.full, false)
  assert.equal(report.gate.code, 3)
  assert.equal(report.gate.status, 'warn')

  const partialRoot = tempDir()
  t.after(() => cleanup(partialRoot))
  const partial = makeScope(partialRoot, PASS_LIST.map((pass) => pass.key))
  writeHandoff(partial.runDir, 'review', [])
  const missing = buildReport({ root: partialRoot, runDir: partial.runDir, scope: partial.scope, config: DEFAULT_CONFIG })
  assert.equal(missing.report.coverage.missing.length, 6)
  assert.equal(missing.report.coverage.complete, false)
  assert.equal(missing.report.gate.code, 3)
  assert.match(missing.report.warnings.join('\n'), /缺少/)
})

test('computeScore keeps the worst finding per file and title', () => {
  const low = { ...sampleFinding, severity: 'low', confidence: 'high', counted: true }
  const high = { ...sampleFinding, severity: 'high', confidence: 'high', counted: true, pass: 'safety' }
  const score = computeScore([low, high])
  assert.equal(score.deductions.length, 1)
  assert.equal(score.deductions[0].severity, 'high')
  assert.equal(score.value, 90)
})

test('invalid handoff JSON is reported as failed, not silently clean', (t) => {
  const root = tempDir()
  t.after(() => cleanup(root))
  const info = makeScope(root, ['review'])
  mkdirSync(join(info.runDir, 'handoff'), { recursive: true })
  writeFileSync(join(info.runDir, 'handoff', 'review.json'), '{ not json')

  const { report } = buildReport({ root, runDir: info.runDir, scope: info.scope, config: DEFAULT_CONFIG })
  assert.equal(report.passes[0].status, 'failed')
  assert.equal(report.coverage.complete, false)
  assert.match(report.passes[0].error, /JSON|解析/)
})
