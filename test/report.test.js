import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_EXPERTS } from '../lib/constants.js'
import { buildReport, readLatestReport } from '../lib/report.js'
import {
  cleanup,
  handoff,
  initRepo,
  makeScope,
  sampleFinding,
  write,
} from './helpers.js'

function writeHandoffs(created, byExpert) {
  for (const [expert, findings] of Object.entries(byExpert)) {
    write(created.runDir, `handoff/${expert}.json`, JSON.stringify(handoff(expert, findings), null, 2))
  }
}

test('builds a complete module report with no score or gate', () => {
  const root = initRepo()
  try {
    write(root, 'src/a.js', 'export function add(a, b) {\n  return a - b\n}\n')
    const created = makeScope(root, [...DEFAULT_EXPERTS])
    writeHandoffs(created, {
      correctness: [sampleFinding('correctness', { title: '加法写成了减法' })],
      security: [sampleFinding('security', {
        section: 'injection',
        category: 'injection',
        severity: 'critical',
        title: '查询字符串拼接',
      })],
      reliability: [],
      maintainability: [sampleFinding('maintainability', {
        section: 'simplify',
        category: 'complexity',
        severity: 'medium',
        title: '重复分支',
        kind: 'plan',
      })],
      perf: [],
    })

    const { report, reportJsonPath, latestMarkdownPath } = buildReport({
      root,
      runDir: created.runDir,
      scope: created.scope,
      config: { maxFindingsPerPass: 12 },
    })

    assert.equal(report.schemaVersion, 2)
    assert.equal(report.coverage.complete, true)
    assert.equal(report.coverage.full, true)
    assert.deepEqual(report.coverage.expected, [...DEFAULT_EXPERTS])
    assert.equal(report.counts.total, 3)
    assert.equal(report.counts.direct, 2)
    assert.equal(report.counts.plan, 1)
    assert.equal(report.counts.bySeverity.critical, 1)
    assert.equal(report.executive, undefined)
    assert.equal(report.score, undefined)
    assert.equal(report.gate, undefined)
    assert.ok(report.findings.every((finding) => /^(COR|SEC|MNT)-[A-F0-9]{5}$/u.test(finding.id)))
    assert.ok(report.modules.some((module) => module.module === 'src'))
    assert.ok(report.fixOrder.length >= 1)
    assert.ok(existsSync(reportJsonPath))
    assert.ok(existsSync(latestMarkdownPath))
    assert.ok(existsSync(join(root, '.logistics', 'latest.json')))
    assert.ok(readLatestReport(root))
  } finally {
    cleanup(root)
  }
})

test('missing and invalid handoffs make coverage incomplete and do not update latest', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, ['correctness', 'security'])
    write(created.runDir, 'handoff/correctness.json', JSON.stringify(handoff('correctness', []), null, 2))
    write(created.runDir, 'handoff/security.json', JSON.stringify({
      schemaVersion: 2,
      expert: 'security',
      status: 'ok',
      summary: '',
      sections: {},
      findings: [],
    }, null, 2))

    const { report, latestMarkdownPath } = buildReport({
      root,
      runDir: created.runDir,
      scope: created.scope,
      config: { maxFindingsPerPass: 12 },
    })

    assert.equal(report.coverage.complete, false)
    assert.deepEqual(report.coverage.invalid, ['security'])
    assert.equal(latestMarkdownPath, undefined)
    assert.equal(existsSync(join(root, 'docs', 'logistics', 'latest.md')), false)
    assert.ok(report.warnings.some((warning) => warning.includes('security')))
  } finally {
    cleanup(root)
  }
})

test('partial handoff is reported but never treated as complete', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, ['correctness', 'security'])
    write(created.runDir, 'handoff/correctness.json', JSON.stringify(
      handoff('correctness', [], { status: 'partial', notes: '只看了 src/a.js' }),
      null,
      2,
    ))
    write(created.runDir, 'handoff/security.json', JSON.stringify(handoff('security', []), null, 2))

    const { report, latestMarkdownPath } = buildReport({
      root,
      runDir: created.runDir,
      scope: created.scope,
      config: { maxFindingsPerPass: 12 },
    })

    assert.equal(report.coverage.complete, false)
    assert.deepEqual(report.coverage.partial, ['correctness'])
    assert.equal(latestMarkdownPath, undefined)
  } finally {
    cleanup(root)
  }
})

test('merges the same root cause reported by two experts', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, ['correctness', 'security'])
    const base = {
      title: '同一个空指针',
      file: 'src/a.js',
      line: 2,
      evidence: '2: return a.b',
      impact: '会崩溃。',
      fix: { summary: '判空。', steps: ['加判空', '补测试', '验证'], files: ['src/a.js'], tests: [] },
    }
    writeHandoffs(created, {
      correctness: [{ ...sampleFinding('correctness'), ...base, category: 'logic', section: 'logic' }],
      security: [{ ...sampleFinding('security'), ...base, category: 'logic', section: 'exposure' }],
    })

    const { report } = buildReport({
      root,
      runDir: created.runDir,
      scope: created.scope,
      config: { maxFindingsPerPass: 12 },
    })

    assert.equal(report.findings.length, 1)
    assert.equal(report.findings[0].experts.length, 2)
  } finally {
    cleanup(root)
  }
})

test('assigns stable line-independent IDs and keeps the worst severity', () => {
  const root = initRepo()
  try {
    const one = makeScope(root, ['correctness'])
    writeHandoffs(one, {
      correctness: [sampleFinding('correctness', { title: '同一问题', severity: 'medium', line: 2 })],
    })
    const first = buildReport({ root, runDir: one.runDir, scope: one.scope, config: {} }).report

    const two = makeScope(root, ['correctness'])
    writeHandoffs(two, {
      correctness: [sampleFinding('correctness', { title: '同一问题', severity: 'high', line: 20 })],
    })
    const second = buildReport({ root, runDir: two.runDir, scope: two.scope, config: {} }).report

    assert.equal(first.findings[0].id, second.findings[0].id)
    assert.equal(second.findings[0].severity, 'high')
  } finally {
    cleanup(root)
  }
})

test('rejects a handoff whose section counts do not match findings', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, ['correctness'])
    const declared = handoff('correctness', [])
    declared.sections.logic = 1
    write(created.runDir, 'handoff/correctness.json', JSON.stringify(declared, null, 2))

    const { report, latestMarkdownPath } = buildReport({
      root,
      runDir: created.runDir,
      scope: created.scope,
      config: {},
    })

    assert.deepEqual(report.coverage.invalid, ['correctness'])
    assert.equal(report.coverage.complete, false)
    assert.equal(latestMarkdownPath, undefined)
    assert.ok(report.warnings.some((warning) => warning.includes('sections 计数')))
  } finally {
    cleanup(root)
  }
})

test('single-expert runs are complete but never publishable latest', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, ['correctness'])
    writeHandoffs(created, { correctness: [] })

    const { report, latestMarkdownPath } = buildReport({
      root,
      runDir: created.runDir,
      scope: created.scope,
      config: {},
    })

    assert.equal(report.coverage.complete, true)
    assert.equal(report.coverage.publishable, false)
    assert.equal(latestMarkdownPath, undefined)
    assert.equal(existsSync(join(root, '.logistics', 'latest.json')), false)
  } finally {
    cleanup(root)
  }
})
