import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { handoffJsonPath, handoffMarkdownPath } from '../lib/handoff-paths.js'
import { redactArtifacts, redactFile, redactReportArtifacts, redactSecrets, scanArtifacts, scanSecrets } from '../lib/redact.js'
import { validateReport } from '../lib/report-check.js'
import {
  aggregateReport,
  cleanup,
  initRepo,
  makeProjectScope,
  projectHandoff,
  sampleFinding,
  tempDir,
  write,
} from './helpers.js'

test('redacts high-confidence credentials without touching safe placeholders', () => {
  const cases = [
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'private-key'],
    ['AKIAABCDEFGHIJKLMNOP', 'aws-access-key'],
    [`ghp_${'a'.repeat(36)}`, 'github-token'],
    [`npm_${'b'.repeat(36)}`, 'npm-token'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'bearer-token'],
    ['https://user:pass@example.com/path', 'url-password'],
    ['PASSWORD="hunter2"', 'secret'],
    ['DB_PASSWORD: s3cr3t', 'secret'],
    ['USERNAME=admin', 'username'],
  ]
  for (const [input, kind] of cases) {
    const result = redactSecrets(input)
    assert.equal(result.total, 1, input)
    assert.equal(result.redactions[0].kind, kind, input)
    assert.match(result.text, /\[REDACTED:/u)
    assert.doesNotMatch(result.text, /hunter2|s3cr3t|abcdefghijklmnopqrstuvwxyz/u)
    assert.equal(redactSecrets(result.text).total, 0, `${input} is not idempotent`)
  }
})

test('skips environment references, placeholders, and existing redaction markers', () => {
  const safe = [
    'PASSWORD=process.env.PASSWORD',
    'SECRET=${APP_SECRET}',
    'TOKEN=<token>',
    'API_KEY=***',
    'PASSWORD=[REDACTED:secret]',
    'USERNAME=your_username',
    'PASSWORD=changeme',
  ].join('\n')
  const result = redactSecrets(safe)
  assert.equal(result.total, 0, result.text)
  assert.equal(result.text, safe)
})

test('scanSecrets reports counts without mutating input', () => {
  const input = 'PASSWORD=secret-value\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz'
  const result = scanSecrets(input)
  assert.equal(result.total, 2)
  assert.deepEqual(
    result.redactions.sort((a, b) => a.kind.localeCompare(b.kind)),
    [{ kind: 'bearer-token', count: 1 }, { kind: 'secret', count: 1 }],
  )
  assert.equal(input, 'PASSWORD=secret-value\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz')
})

test('redactFile rewrites only when a secret is present', () => {
  const root = tempDir()
  try {
    const path = join(root, 'report.md')
    writeFileSync(path, 'PASSWORD=hunter2\n')
    const result = redactFile(path)
    assert.equal(result.changed, true)
    assert.match(readFileSync(path, 'utf8'), /\[REDACTED:secret\]/u)

    const cleanPath = join(root, 'clean.md')
    writeFileSync(cleanPath, 'no secrets here\n')
    const clean = redactFile(cleanPath)
    assert.equal(clean.changed, false)
    assert.equal(readFileSync(cleanPath, 'utf8'), 'no secrets here\n')
  } finally {
    cleanup(root)
  }
})

test('redactArtifacts sanitizes JSON, logs, and nested expert artifacts too', () => {
  const root = initRepo()
  try {
    const { scope } = makeProjectScope(root, ['security', 'correctness'])
    const leak = 'PASSWORD="hunter2"'
    const finding = sampleFinding('security', { file: 'src/a.js', line: 1, evidence: leak })
    const handoff = projectHandoff('security', scope, [finding])
    writeFileSync(handoffJsonPath(scope, 'security'), JSON.stringify(handoff))
    write(scope.output.runDir, 'handoffs.json', JSON.stringify({ findings: [{ id: 'SEC-00001', evidence: leak }] }))
    write(scope.output.runDir, 'verdict.json', JSON.stringify({ note: leak }))
    write(scope.output.runDir, 'packet.md', `# packet\n\n${leak}\n`)
    write(scope.output.runDir, 'run.jsonl', `${JSON.stringify({ event: 'probe', detail: leak })}\n`)
    writeFileSync(scope.output.reportMarkdown, `${aggregateReport(scope, [finding])}\n## 配置\n${leak}\n`)
    write(root, 'docs/logistics/latest.md', `# latest\n\n${leak}\n`)

    assert.ok(scanArtifacts(scope).total >= 5)
    const result = redactArtifacts(scope)
    assert.ok(result.files.length >= 5, result.files)
    assert.ok(result.total >= 5, result.total)
    assert.equal(scanArtifacts(scope).total, 0)

    for (const path of [
      handoffJsonPath(scope, 'security'),
      join(scope.output.runDir, 'handoffs.json'),
      join(scope.output.runDir, 'verdict.json'),
      join(scope.output.runDir, 'packet.md'),
      join(scope.output.runDir, 'run.jsonl'),
      scope.output.reportMarkdown,
      scope.output.latestMarkdown,
    ]) {
      assert.doesNotMatch(readFileSync(path, 'utf8'), /hunter2/u, path)
    }
  } finally {
    cleanup(root)
  }
})

test('redacts backups, scripts, extensionless text, and refuses binary artifacts', () => {
  const root = initRepo()
  try {
    const { scope } = makeProjectScope(root, ['security'])
    const leak = 'PASSWORD="hunter2"'
    write(scope.output.runDir, 'handoff/security/security.json.bak', leak)
    write(scope.output.runDir, '_repro_breaker.py', leak)
    write(scope.output.runDir, '_repro_breaker.sh', leak)
    writeFileSync(join(scope.output.runDir, 'notes'), leak)
    writeFileSync(join(scope.output.runDir, 'image.bin'), Buffer.from([0, 1, 2, 0, 3]))

    assert.ok(scanArtifacts(scope).total >= 4)
    redactArtifacts(scope)
    assert.equal(scanArtifacts(scope).total, 0)
    assert.equal(scanSecrets(readFileSync(join(scope.output.runDir, 'handoff/security/security.json.bak'), 'utf8')).total, 0)
    assert.equal(scanSecrets(readFileSync(join(scope.output.runDir, '_repro_breaker.py'), 'utf8')).total, 0)
    assert.equal(scanSecrets(readFileSync(join(scope.output.runDir, '_repro_breaker.sh'), 'utf8')).total, 0)
    assert.equal(scanSecrets(readFileSync(join(scope.output.runDir, 'notes'), 'utf8')).total, 0)
    assert.deepEqual(readFileSync(join(scope.output.runDir, 'image.bin')), Buffer.from([0, 1, 2, 0, 3]))
  } finally {
    cleanup(root)
  }
})

test('0.6.4 report requires direct/plan markers and test evidence', () => {
  const root = initRepo()
  try {
    const { scope } = makeProjectScope(root, ['security'])
    const finding = { ...sampleFinding('security'), id: 'SEC-00001', kind: 'direct' }
    write(scope.output.handoffDir, 'security.json', JSON.stringify(projectHandoff('security', scope, [finding])))
    const report = aggregateReport(scope, [finding])
    writeFileSync(scope.output.reportMarkdown, report)

    const missingMarker = validateReport({ scope, verdict: { findings: [finding] } })
    assert.equal(missingMarker.errors.length, 0, missingMarker.errors.join('\n'))

    writeFileSync(scope.output.reportMarkdown, report.replace('[可直接修]', '[FIX]'))
    const noMarker = validateReport({ scope, verdict: { findings: [finding] } })
    assert.ok(noMarker.errors.some((error) => error.includes('没有 [可直接修]')), noMarker.errors.join('\n'))

    writeFileSync(scope.output.reportMarkdown, report.replace(/## 测试证据[\s\S]*?(?=\n## )/u, ''))
    const noTests = validateReport({ scope, verdict: { findings: [finding] } })
    assert.ok(noTests.errors.some((error) => error.includes('测试证据')), noTests.errors.join('\n'))
  } finally {
    cleanup(root)
  }
})

test('project report contract rejects residual secrets and accepts sanitized artifacts', () => {
  const root = initRepo()
  try {
    const created = makeProjectScope(root, ['correctness', 'security'])
    const scope = created.scope
    const finding = sampleFinding('security', {
      file: 'src/a.js',
      line: 1,
      evidence: 'PASSWORD="hunter2"',
    })
    write(scope.output.handoffDir, 'security.json', JSON.stringify(projectHandoff('security', scope, [finding])))
    write(scope.output.handoffDir, 'correctness.json', JSON.stringify(projectHandoff('correctness', scope, [])))

    const leakyReport = `${aggregateReport(scope, [finding])}\n## 配置示例\nDB_PASSWORD: s3cr3t\n`
    writeFileSync(scope.output.reportMarkdown, leakyReport)
    write(root, 'docs/logistics/latest.md', leakyReport)

    const before = validateReport({ scope, verdict: { findings: [finding] } })
    assert.ok(before.errors.some((error) => error.includes('仍包含')), before.errors.join('\n'))

    const redacted = redactReportArtifacts(scope)
    assert.ok(redacted.total > 0, 'expected redactions')
    assert.equal(scanSecrets(readFileSync(scope.output.reportMarkdown, 'utf8')).total, 0)
    assert.equal(scanSecrets(readFileSync(handoffMarkdownPath(scope, 'security'), 'utf8')).total, 0)
    assert.equal(scanSecrets(readFileSync(scope.output.latestMarkdown, 'utf8')).total, 0)

    const after = validateReport({ scope, verdict: { findings: [finding] } })
    assert.deepEqual(after.errors, [])
  } finally {
    cleanup(root)
  }
})
