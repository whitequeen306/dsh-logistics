import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EXPERT_BY_KEY, DEFAULT_CONFIG } from '../lib/constants.js'
import { createScope } from '../lib/scope.js'

export function tempDir(prefix = 'dsh-logi-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function write(root, relative, content) {
  const file = join(root, relative)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

export function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function initRepo({ commit = true } = {}) {
  const root = tempDir()
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'logi@example.com')
  git(root, 'config', 'user.name', 'Logi Test')
  git(root, 'config', 'core.autocrlf', 'false')
  write(root, 'package.json', JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }, null, 2))
  write(root, 'src/a.js', 'export function add(a, b) {\n  return a + b\n}\n')
  write(root, 'src/b.js', 'export function sub(a, b) {\n  return a - b\n}\n')
  if (commit) commitAll(root, 'initial')
  return root
}

export function commitAll(root, message = 'update') {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
}

export function cleanup(root) {
  if (root) rmSync(root, { recursive: true, force: true })
}

export function scopeOptions(root, experts = ['correctness', 'security'], overrides = {}) {
  return {
    cwd: root,
    command: '/logi',
    experts,
    notes: '',
    config: DEFAULT_CONFIG,
    ...overrides,
  }
}

export function makeScope(root, experts = ['correctness', 'security']) {
  return createScope(scopeOptions(root, experts))
}

export function makeProjectScope(root, experts = ['correctness', 'security'], overrides = {}) {
  return createScope(scopeOptions(root, experts, { mode: 'project', ...overrides }))
}

export function projectHandoff(expert, scope, findings = [], extra = {}) {
  const units = Object.fromEntries(
    (scope.project?.units ?? []).map((unit) => [
      unit.id,
      { status: 'reviewed', filesRead: unit.stats?.files ?? 0, notes: 'test coverage' },
    ]),
  )
  return handoff(expert, findings, { units, ...extra })
}

export function handoff(expert, findings = [], extra = {}) {
  const info = EXPERT_BY_KEY[expert]
  const sections = Object.fromEntries(
    info.sections.map((section) => [section, findings.filter((finding) => finding.section === section).length]),
  )
  return {
    schemaVersion: 2,
    expert,
    status: 'ok',
    summary: findings.length > 0 ? `${expert} 发现 ${findings.length} 项` : `${expert} 已查无问题`,
    sections,
    findings,
    deferred: [],
    notes: '',
    ...extra,
  }
}

export function sampleFinding(expert = 'correctness', overrides = {}) {
  const info = EXPERT_BY_KEY[expert]
  const section = overrides.section ?? info.sections[0]
  return {
    section,
    category: info.domain,
    severity: 'high',
    confidence: 'high',
    title: '示例问题',
    file: 'src/a.js',
    line: 2,
    evidence: '2: return a + b',
    impact: '会返回错误结果。',
    fix: {
      summary: '修正计算。',
      steps: ['定位错误分支', '改为正确计算', '补充回归测试'],
      files: ['src/a.js'],
      tests: ['src/a.test.js: 覆盖错误输入'],
    },
    kind: 'direct',
    ...overrides,
  }
}

export function runCli(pluginRoot, script, args) {
  const result = spawnSync(process.execPath, [join(pluginRoot, 'lib', 'cli', script), ...args], {
    encoding: 'utf8',
  })
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}
