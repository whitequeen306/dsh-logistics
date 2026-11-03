import assert from 'node:assert/strict'
import test from 'node:test'
import { dedupeFindings, normalizeFinding } from '../lib/findings.js'

function rawFinding(overrides = {}) {
  return {
    section: 'logic',
    category: 'shared',
    severity: 'high',
    confidence: 'high',
    title: '同一个根因',
    file: 'src/a.js',
    line: 2,
    evidence: '2: return value',
    impact: '会返回错误结果。',
    kind: 'direct',
    fix: {
      summary: '修正。',
      steps: ['定位', '修正', '补测试'],
      files: ['src/a.js'],
      tests: [],
    },
    ...overrides,
  }
}

test('maintainability never reports above medium', () => {
  const warnings = []
  const finding = normalizeFinding({
    root: process.cwd(),
    expert: 'maintainability',
    raw: rawFinding({ section: 'simplify', severity: 'critical' }),
    index: 0,
    warnings,
  })
  assert.equal(finding.severity, 'medium')
  assert.ok(warnings.some((warning) => warning.includes('最高只报 medium')))
})

test('performance findings are always plan', () => {
  const warnings = []
  const finding = normalizeFinding({
    root: process.cwd(),
    expert: 'perf',
    raw: rawFinding({ section: 'performance', kind: 'direct' }),
    index: 0,
    warnings,
  })
  assert.equal(finding.kind, 'plan')
  assert.ok(warnings.some((warning) => warning.includes('必须由人确认')))
})

test('dedupe prefers the higher-priority expert on a tie', () => {
  const correctness = normalizeFinding({
    root: process.cwd(),
    expert: 'correctness',
    raw: rawFinding(),
    index: 0,
    warnings: [],
  })
  const security = normalizeFinding({
    root: process.cwd(),
    expert: 'security',
    raw: rawFinding({ section: 'auth' }),
    index: 0,
    warnings: [],
  })

  const merged = dedupeFindings([correctness, security])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].expert, 'security')
  assert.deepEqual(merged[0].experts.sort(), ['correctness', 'security'])
})
