import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_EXPERTS } from '../lib/constants.js'
import { validateReport } from '../lib/report-check.js'
import { validateVerdict } from '../lib/verdict.js'
import {
  aggregateReport,
  cleanup,
  handoff,
  initRepo,
  makeProjectScope,
  makeScope,
  projectHandoff,
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

test('project verdict requires a non-developer brief for 0.6.5 findings', () => {
  const root = initRepo()
  try {
    const created = makeProjectScope(root, ['security'])
    const finding = { ...sampleFinding('security') }
    delete finding.brief
    write(
      created.runDir,
      'handoff/security.json',
      JSON.stringify(projectHandoff('security', created.scope, [finding]), null, 2),
    )
    write(created.runDir, 'report.md', aggregateReport(created.scope, [finding]))
    const result = validateVerdict({
      root,
      scope: created.scope,
      verdict: {
        schemaVersion: 2,
        runId: created.scope.runId,
        coverage: { expected: ['security'], received: ['security'], missing: [], complete: true },
        findings: [finding],
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /brief 不能为空/u)
  } finally {
    cleanup(root)
  }
})

test('collect reports missing required experts and invents no optional perf', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, ['security'])
    const result = runCli(pluginRoot, 'collect.mjs', ['--run', created.runDir])
    assert.equal(result.code, 0)
    assert.match(result.output, /security: missing/u)
    assert.doesNotMatch(result.output, /perf:/u)
  } finally {
    cleanup(root)
  }
})

test('bundle carries deferred and the packet tells the editor not to drop it', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, ['security'])
    const deferred = [
      {
        expert: 'correctness',
        file: 'src/a.js',
        lines: '2',
        summary: '迁移绕过事件日志',
      },
    ]
    write(
      created.runDir,
      'handoff/security.json',
      JSON.stringify(handoff('security', [], { deferred }), null, 2),
    )
    const result = runCli(pluginRoot, 'bundle.mjs', ['--run', created.runDir])
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /deferred: 1/u)

    const bundle = JSON.parse(readFileSync(join(created.runDir, 'handoffs.json'), 'utf8'))
    assert.equal(bundle.deferred.length, 1)
    assert.equal(bundle.deferred[0].from, 'security')
    assert.equal(bundle.deferred[0].expert, 'correctness')

    const packet = readFileSync(join(created.runDir, 'packet.md'), 'utf8')
    assert.match(packet, /security → correctness/u)
    assert.match(packet, /不能静默丢弃/u)
  } finally {
    cleanup(root)
  }
})


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

test('verdict validates and normalizes structured deferred items', () => {
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
        received: [...DEFAULT_EXPERTS],
        missing: [],
        complete: true,
      },
      findings: [finding],
      deferred: [
        { from: 'security', expert: 'correctness', file: 'src/a.js', lines: '2', summary: '交给 correctness 的迁移问题' },
      ],
    }
    const ok = validateVerdict({ root, scope: created.scope, verdict: base })
    assert.equal(ok.ok, true, ok.errors.join('\\n'))
    assert.equal(ok.verdict.deferred.length, 1)
    assert.equal(ok.verdict.deferred[0].from, 'security')

    const bad = { ...base, deferred: [{ expert: 'correctness', summary: '缺少来源' }] }
    const invalid = validateVerdict({ root, scope: created.scope, verdict: bad })
    assert.equal(invalid.ok, false)
    assert.match(invalid.errors.join('\n'), /deferred\[0\]\.from/u)
  } finally {
    cleanup(root)
  }
})

test('verdict accepts an explicitly covered optional perf handoff', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, [...DEFAULT_EXPERTS])
    for (const expert of DEFAULT_EXPERTS) {
      write(created.runDir, `handoff/${expert}.json`, JSON.stringify(handoff(expert, []), null, 2))
    }
    write(created.runDir, 'handoff/perf.json', JSON.stringify(handoff('perf', []), null, 2))
    const verdict = {
      schemaVersion: 2,
      runId: created.scope.runId,
      coverage: {
        expected: [...DEFAULT_EXPERTS, 'perf'],
        received: [...DEFAULT_EXPERTS, 'perf'],
        missing: [],
        complete: true,
      },
      findings: [],
    }
    const result = validateVerdict({ root, scope: created.scope, verdict })
    assert.equal(result.ok, true, result.errors.join('\n'))
  } finally {
    cleanup(root)
  }
})

test('verdict rejects complete coverage when handoffs are missing or findings are unsafe', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, [...DEFAULT_EXPERTS])
    write(created.runDir, 'handoff/correctness.json', JSON.stringify(handoff('correctness', []), null, 2))
    const fabricated = {
      schemaVersion: 2,
      runId: created.scope.runId,
      coverage: {
        expected: [...DEFAULT_EXPERTS],
        received: [...DEFAULT_EXPERTS],
        missing: [],
        complete: true,
      },
      findings: [],
    }
    const coverageResult = validateVerdict({ root, scope: created.scope, verdict: fabricated })
    assert.equal(coverageResult.ok, false)
    assert.match(coverageResult.errors.join('\n'), /没有有效 handoff/u)
    assert.match(coverageResult.errors.join('\n'), /handoff 不完整/u)

    const complete = completeRun(root)
    const bundle = runCli(pluginRoot, 'bundle.mjs', ['--run', complete.runDir])
    assert.equal(bundle.code, 0, bundle.output)
    const finding = {
      ...JSON.parse(readFileSync(join(complete.runDir, 'handoffs.json'), 'utf8')).findings[0],
      module: 'src',
      evidence: '',
      id: 'SEC-00000',
    }
    const unsafe = {
      ...fabricated,
      runId: complete.scope.runId,
      findings: [finding],
    }
    const unsafeResult = validateVerdict({ root, scope: complete.scope, verdict: unsafe })
    assert.equal(unsafeResult.ok, false)
    assert.match(unsafeResult.errors.join('\n'), /必须有 evidence/u)
    assert.match(unsafeResult.errors.join('\n'), /前缀与 expert 不一致/u)
  } finally {
    cleanup(root)
  }
})

test('verdict rejects a handoff that exceeds the configured finding cap', () => {
  const root = initRepo()
  try {
    const created = makeScope(root, ['security'])
    created.scope.maxFindings = 1
    write(created.runDir, 'handoff/security.json', JSON.stringify(handoff('security', [
      sampleFinding('security', { title: '问题一' }),
      sampleFinding('security', { title: '问题二' }),
    ]), null, 2))
    const verdict = {
      schemaVersion: 2,
      runId: created.scope.runId,
      coverage: { expected: ['security'], received: ['security'], missing: [], complete: true },
      findings: [],
    }
    const result = validateVerdict({ root, scope: created.scope, verdict })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /超过上限 1/u)
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

test('project verdict requires an aggregate report and every expert report', () => {
  const root = initRepo()
  try {
    const created = makeProjectScope(root, ['security'])
    write(created.runDir, 'handoff/security.json', JSON.stringify(projectHandoff('security', created.scope), null, 2))
    const verdict = {
      schemaVersion: 2,
      runId: created.scope.runId,
      coverage: { expected: ['security'], received: ['security'], missing: [], complete: true },
      findings: [],
    }

    const missing = validateVerdict({ root, scope: created.scope, verdict })
    assert.equal(missing.ok, false)
    assert.match(missing.errors.join('\n'), /缺少总报告/u)

    write(created.runDir, 'report.md', aggregateReport(created.scope))
    const valid = validateVerdict({ root, scope: created.scope, verdict })
    assert.equal(valid.ok, true, valid.errors.join('\n'))

    rmSync(join(created.runDir, 'handoff/security/security.md'))
    const noExpert = validateVerdict({ root, scope: created.scope, verdict })
    assert.equal(noExpert.ok, false)
    assert.match(noExpert.errors.join('\n'), /缺少专家报告/u)

    write(created.runDir, 'handoff/security/security.md', '# 太短')
    const shortExpert = validateVerdict({ root, scope: created.scope, verdict })
    assert.equal(shortExpert.ok, false)
    assert.match(shortExpert.errors.join('\n'), /过短/u)
  } finally {
    cleanup(root)
  }
})

test('project verdict validates model relations for the graph', () => {
  const root = initRepo()
  try {
    const created = makeProjectScope(root, ['security'])
    const finding = { ...sampleFinding('security'), id: 'SEC-ABC12', expert: 'security', module: 'src' }
    write(created.runDir, 'handoff/security.json', JSON.stringify(projectHandoff('security', created.scope, [finding]), null, 2))
    write(created.runDir, 'report.md', aggregateReport(created.scope, [finding]))
    const base = {
      schemaVersion: 2,
      runId: created.scope.runId,
      coverage: { expected: ['security'], received: ['security'], missing: [], complete: true },
      findings: [finding],
    }

    const unknown = validateVerdict({
      root,
      scope: created.scope,
      verdict: { ...base, relations: [{ from: 'SEC-ABC12', to: 'SEC-ZZZZZ', type: 'related', reason: 'x' }] },
    })
    assert.equal(unknown.ok, false)
    assert.match(unknown.errors.join('\n'), /不是本 verdict 的 finding/u)

    const self = validateVerdict({
      root,
      scope: created.scope,
      verdict: { ...base, relations: [{ from: 'SEC-ABC12', to: 'SEC-ABC12', type: 'related', reason: 'x' }] },
    })
    assert.equal(self.ok, false)
    assert.match(self.errors.join('\n'), /不能连接自己/u)

    const valid = validateVerdict({ root, scope: created.scope, verdict: { ...base, relations: [] } })
    assert.equal(valid.ok, true, valid.errors.join('\n'))
    assert.deepEqual(valid.verdict.relations, [])
  } finally {
    cleanup(root)
  }
})

test('project report rejects findings that are not ordered by severity', () => {
  const root = initRepo()
  try {
    const created = makeProjectScope(root, ['security'])
    const high = { ...sampleFinding('security'), id: 'SEC-A1111', severity: 'high', title: '高风险问题', file: 'src/a.js' }
    const low = { ...sampleFinding('security'), id: 'SEC-B2222', severity: 'low', title: '低风险问题', file: 'src/a.js' }
    write(created.runDir, 'handoff/security.json', JSON.stringify(projectHandoff('security', created.scope, [high, low]), null, 2))
    write(created.runDir, 'report.md', aggregateReport(created.scope, [low, high]))
    const verdict = { findings: [low, high] }
    const ok = validateReport({ scope: created.scope, verdict })
    assert.deepEqual(ok.errors, [])

    const reportPath = created.scope.output.reportMarkdown
    const text = readFileSync(reportPath, 'utf8')
    const start = text.indexOf('## 发现')
    const end = text.indexOf('\n## 修复建议', start)
    const lowLine = '- [low] [u01] [direct] SEC-B2222 — 低风险问题：`src/a.js:2`'
    const highLine = '- [high] [u01] [direct] SEC-A1111 — 高风险问题：`src/a.js:2`'
    write(created.runDir, 'report.md', `${text.slice(0, start)}## 发现
${lowLine}
${highLine}
${text.slice(end)}`)
    const bad = validateReport({ scope: created.scope, verdict })
    assert.equal(bad.errors.some((error) => /未按严重度排序/u.test(error)), true, bad.errors.join('\n'))
  } finally {
    cleanup(root)
  }
})

test('project handoffs require structured test evidence on 0.6.4', () => {
  const root = initRepo()
  try {
    const created = makeProjectScope(root, ['security'])
    const handoffValue = projectHandoff('security', created.scope)
    const verdict = {
      schemaVersion: 2,
      runId: created.scope.runId,
      coverage: { expected: ['security'], received: ['security'], missing: [], complete: true },
      findings: [],
    }

    delete handoffValue.tests
    write(created.runDir, 'handoff/security.json', JSON.stringify(handoffValue, null, 2))
    const missing = validateVerdict({ root, scope: created.scope, verdict })
    assert.equal(missing.ok, false)
    assert.match(missing.errors.join('\\n'), /tests 缺少/u)

    write(created.runDir, 'handoff/security.json', JSON.stringify({ ...handoffValue, tests: { commands: [] } }, null, 2))
    const empty = validateVerdict({ root, scope: created.scope, verdict })
    assert.equal(empty.ok, false)
    assert.match(empty.errors.join('\\n'), /tests\.commands 缺少/u)

    write(created.runDir, 'report.md', aggregateReport(created.scope))
    write(created.runDir, 'handoff/security.json', JSON.stringify(projectHandoff('security', created.scope), null, 2))
    const valid = validateVerdict({ root, scope: created.scope, verdict })
    assert.equal(valid.ok, true, valid.errors.join('\\n'))
  } finally {
    cleanup(root)
  }
})

test('legacy 0.4 project verdicts stay readable without expert reports', () => {
  const root = initRepo()
  try {
    const created = makeProjectScope(root, ['security'])
    created.scope.version = '0.4.0'
    write(created.runDir, 'handoff/security.json', JSON.stringify(projectHandoff('security', created.scope), null, 2))
    write(created.runDir, 'report.md', aggregateReport(created.scope))
    const verdict = {
      schemaVersion: 2,
      runId: created.scope.runId,
      coverage: { expected: ['security'], received: ['security'], missing: [], complete: true },
      findings: [],
    }
    const result = validateVerdict({ root, scope: created.scope, verdict })
    assert.equal(result.ok, true, result.errors.join('\n'))
    assert.match(result.warnings.join('\n'), /旧版 0.4\.x 运行没有专家报告/u)
  } finally {
    cleanup(root)
  }
})

test('0.8.1 maintainability expert report requires a coupling section', () => {
  const root = initRepo()
  try {
    const created = makeProjectScope(root, ['maintainability'])
    write(
      created.runDir,
      'handoff/maintainability.json',
      JSON.stringify(projectHandoff('maintainability', created.scope, []), null, 2),
    )
    write(created.runDir, 'report.md', aggregateReport(created.scope, []))
    const expertPath = join(created.scope.output.handoffDir, 'maintainability', 'maintainability.md')
    const withoutCoupling = readFileSync(expertPath, 'utf8').replace(/## 耦合度[\s\S]*?(?=## |$)/u, '')
    writeFileSync(expertPath, withoutCoupling)

    const result = validateReport({ scope: created.scope, verdict: { findings: [] } })
    assert.equal(result.errors.some((error) => /耦合度/u.test(error)), true, result.errors.join('\n'))
  } finally {
    cleanup(root)
  }
})
