import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EXPERT_BY_KEY, DEFAULT_CONFIG, SEVERITIES } from '../lib/constants.js'
import { handoffMarkdownPath, handoffRelPath } from '../lib/handoff-paths.js'
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

function withReportLength(text, minimum) {
  if (text.length >= minimum) return text
  const filler = '本报告覆盖全部审查单元，发现项均标注 file:line；抽样与未验证已在正文说明。\n'
  return `${text}\n\n## 说明\n${filler.repeat(Math.ceil((minimum - text.length) / filler.length))}`
}

function expertReportText(expert, scope, findings) {
  const units = scope.project?.units ?? []
  const lines = [
    `# ${EXPERT_BY_KEY[expert]?.title ?? expert}审查报告`,
    '',
    '## 范围与覆盖',
    `- 全项目 ${scope.stats?.analyzedFiles ?? 0} 个文件 / ${units.length} 个审查单元。`,
    ...units.map((unit) => `- ${unit.id} ${unit.label}：reviewed，读过 ${unit.stats?.files ?? 0} 个文件。`),
    '',
    '## 发现',
    findings.length === 0
      ? '- 已查区域未发现问题。'
      : findings.map((finding) => `- ${finding.title}：\`${finding.file}:${finding.line}\`；${finding.evidence}`).join('\n'),
    '',
    '## 未验证与抽样',
    '- 本测试报告覆盖全部单元；生产运行必须如实标注 sampled/skipped。',
    '',
    '## 建议修复顺序',
    '- 先处理 high 及其以上，再处理同文件的低风险项。',
    '',
  ]
  return withReportLength(lines.join('\n'), 600)
}

export function projectHandoff(expert, scope, findings = [], extra = {}) {
  const units = Object.fromEntries(
    (scope.project?.units ?? []).map((unit) => [
      unit.id,
      { status: 'reviewed', filesRead: unit.stats?.files ?? 0, notes: 'test coverage' },
    ]),
  )
  const reportPath = handoffMarkdownPath(scope, expert)
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, expertReportText(expert, scope, findings))
  const tests = {
    commands: (scope.testCommands?.length ? scope.testCommands : scope.testCommand ? [scope.testCommand] : [])
      .map((item) => ({ command: item.command, status: 'not-run', note: '测试夹具未执行' })),
    summary: '测试夹具：仅验证 contract',
  }
  return handoff(expert, findings, { units, tests, ...extra })
}

export function aggregateReport(scope, findings = []) {
  const units = scope.project?.units ?? []
  const unitOf = (file) => units.find((unit) => (unit.files ?? []).some((item) => item.path === file))?.id ?? ''
  const ordered = [...findings].sort((a, b) =>
    (SEVERITIES[a.severity]?.rank ?? 9) - (SEVERITIES[b.severity]?.rank ?? 9)
    || String(a.id ?? '').localeCompare(String(b.id ?? '')))
  const lines = [
    '# 项目审查报告',
    '',
    '## 一句话结论',
    '全项目审查完成，发现项见下文。',
    '',
    '## 覆盖情况',
    '| 单元 | 标签 | 专家 | 状态 |',
    '| --- | --- | --- | --- |',
    ...units.map((unit) => `| ${unit.id} | ${unit.label} | ${(scope.experts ?? []).join('、')} | reviewed |`),
    '',
    '## 发现',
    ordered.length === 0
      ? '- 已查区域未发现问题。'
      : ordered.map((finding) => `- [${finding.severity}] [${unitOf(finding.file)}] [${finding.kind}] ${finding.id} — ${finding.title}：\`${finding.file}:${finding.line}\``).join('\n'),
    '',
    '## 修复建议',
    '- 先处理 high 及其以上，再处理同文件的低风险项。',
    '',
    '## 测试证据',
    ...((scope.testCommands?.length ? scope.testCommands : scope.testCommand ? [scope.testCommand] : [])
      .map((item) => `- \`${item.command}\`：not-run（测试夹具）`)),
    '',
    '## 可直接修',
    ...findings.filter((finding) => finding.kind === 'direct').map((finding) => `- [可直接修] ${finding.id ?? finding.title}`),
    '',
    '## 需方案',
    ...findings.filter((finding) => finding.kind === 'plan').map((finding) => `- [需方案] ${finding.id ?? finding.title}`),
    '',
    '## 覆盖缺口',
    '- 无。',
    '',
    '## 专家报告',
    ...(scope.experts ?? []).map((expert) => `- ${handoffRelPath(scope, expert, 'md')}`),
    '',
  ]
  return withReportLength(lines.join('\n'), 1300)
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
