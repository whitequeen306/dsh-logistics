import { resolve } from 'node:path'
import {
  DEFAULT_EXPERTS,
  EXPERT_BY_KEY,
  EXPERT_LIST,
  REPORT_SCHEMA_VERSION,
  TOOL_NAME,
  TOOL_VERSION,
} from './constants.js'
import { redactValue, scanSecrets } from './redact.js'
import {
  assignFindingIds,
  compareFindings,
  countSeverities,
  dedupeFindings,
  groupByModule,
  moduleOf,
  normalizeFinding,
  findingRef,
  fingerprint,
} from './findings.js'
import {
  isFile,
  nowIso,
  oneLine,
  readJsonFile,
  toPosix,
  writeJsonFile,
  writeTextFile,
} from './util.js'

const STATUS_LABELS = {
  ok: '完成',
  partial: '部分完成',
  failed: '失败',
  invalid: '无效',
  missing: '未完成',
}

function countByExpert(findings, expected) {
  return Object.fromEntries(expected.map((expert) => [
    expert,
    findings.filter((finding) => (finding.experts ?? [finding.expert]).includes(expert)).length,
  ]))
}

function readSections({ raw, info, warnings }) {
  const value = raw.sections
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'handoff 缺少 sections 声明', sections: undefined }
  }
  const sections = {}
  for (const section of info.sections) {
    const count = value[section]
    if (!Number.isInteger(count) || count < 0) {
      return { error: `handoff sections.${section} 必须是非负整数`, sections: undefined }
    }
    sections[section] = count
  }
  for (const key of Object.keys(value)) {
    if (!info.sections.includes(key)) warnings.push(`${info.key}: 未知 section "${key}"，已忽略`)
  }
  return { sections }
}

function readHandoff({ root, runDir, expert, maxFindings, warnings }) {
  const info = EXPERT_BY_KEY[expert]
  const flat = resolve(runDir, 'handoff', `${expert}.json`)
  const nested = resolve(runDir, 'handoff', expert, `${expert}.json`)
  const file = isFile(flat) ? flat : nested
  const base = {
    expert,
    title: info.title,
    status: 'missing',
    findings: [],
    summary: '',
    sections: {},
    error: undefined,
    file: toPosix(file),
  }
  if (!isFile(file)) return base

  const rawFile = readJsonFile(file, undefined)
  if (rawFile === undefined) {
    return { ...base, status: 'invalid', error: 'handoff JSON 无法解析' }
  }
  const raw = rawFile && typeof rawFile === 'object' && rawFile.handoff && typeof rawFile.handoff === 'object'
    ? rawFile.handoff
    : rawFile
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...base, status: 'invalid', error: 'handoff 必须是 JSON 对象' }
  }
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 2) {
    warnings.push(`${expert}: handoff schemaVersion=${raw.schemaVersion}，按 2 处理`)
  }
  if (raw.pass && raw.pass !== expert) {
    warnings.push(`${expert}: handoff 内的 pass="${raw.pass}" 与文件名不一致，已按 ${expert} 处理`)
  }
  const summary = oneLine(raw.summary ?? raw.notes ?? '', 800)
  if (!summary) {
    return { ...base, status: 'invalid', error: 'handoff 缺少非空 summary' }
  }
  const statusRaw = String(raw.status ?? '').toLowerCase()
  if (statusRaw === 'failed' || raw.error) {
    return {
      ...base,
      status: 'failed',
      summary,
      error: oneLine(raw.error ?? '子代理报告失败', 500),
    }
  }
  if (!Array.isArray(raw.findings)) {
    return { ...base, status: 'invalid', summary, error: 'handoff 缺少 findings 数组' }
  }
  for (let index = 0; index < raw.findings.length; index += 1) {
    const entry = raw.findings[index]
    const section = entry && typeof entry === 'object' ? String(entry.section ?? '').trim() : ''
    if (!info.sections.includes(section)) {
      return {
        ...base,
        status: 'invalid',
        summary,
        error: `第 ${index + 1} 条发现缺少合法 section（只能是 ${info.sections.join(' / ')}）`,
      }
    }
  }
  const sectionCheck = readSections({ raw, info, warnings })
  if (sectionCheck.error) {
    return { ...base, status: 'invalid', summary, error: sectionCheck.error }
  }

  const findings = []
  const seen = new Set()
  for (let index = 0; index < raw.findings.length; index += 1) {
    const finding = normalizeFinding({ root, expert, raw: raw.findings[index], index, warnings })
    if (!finding) continue
    if (seen.has(finding.fingerprint)) continue
    seen.add(finding.fingerprint)
    findings.push(finding)
  }
  const actualSections = Object.fromEntries(
    info.sections.map((section) => [
      section,
      findings.filter((finding) => finding.section === section).length,
    ]),
  )
  const mismatched = info.sections.filter((section) => sectionCheck.sections[section] !== actualSections[section])
  if (mismatched.length > 0) {
    const detail = mismatched
      .map((section) => `${section}: 声明 ${sectionCheck.sections[section]} / 实际 ${actualSections[section]}`)
      .join('；')
    return {
      ...base,
      status: 'invalid',
      summary,
      error: `sections 计数与 findings 不一致（${detail}）`,
    }
  }
  let capped = findings
  if (findings.length > maxFindings) {
    capped = findings.slice(0, maxFindings)
    warnings.push(`${expert}: 发现数 ${findings.length} 超过 maxFindingsPerPass=${maxFindings}，已截断`)
  }
  return {
    ...base,
    status: statusRaw === 'partial' ? 'partial' : 'ok',
    findings: capped,
    summary,
    sections: sectionCheck.sections,
  }
}

function buildSummary({ expected, findings, modules, coverage }) {
  if (findings.length === 0) {
    if (!coverage.complete) return '本次没有发现需要报告的问题，但覆盖不完整，不能视为通过。'
    return '本次未发现需要报告的问题。'
  }
  const top = modules.slice(0, 2).map((module) => module.module)
  const where = top.length > 0 ? `，集中在 ${top.join('、')} 模块` : ''
  const high = findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical').length
  const prefix = high > 0 ? `本次发现 ${findings.length} 项问题（${high} 项高优先级）` : `本次发现 ${findings.length} 项问题`
  const perf = expected.includes('perf') ? '' : '；性能维度未运行'
  return `${prefix}${where}${perf}。`
}

/**
 * Build the normalized module report from the requested handoff files.
 * Missing, failed, and invalid handoffs are explicit so a partial run cannot
 * masquerade as a clean bill of health.
 */
export function buildReport({ root, runDir, scope, config }) {
  const warnings = [...(scope.warnings ?? [])]
  const expected = (scope.experts ?? []).filter((expert) => EXPERT_BY_KEY[expert])
  for (const expert of scope.experts ?? []) {
    if (!EXPERT_BY_KEY[expert]) warnings.push(`未知专家 "${expert}"，已跳过`)
  }
  if (expected.length === 0) throw new Error('报告至少需要一位专家')

  const expertReports = []
  const findings = []
  for (const expert of expected) {
    const handoff = readHandoff({
      root,
      runDir,
      expert,
      maxFindings: config.maxFindingsPerPass,
      warnings,
    })
    findings.push(...handoff.findings)
    expertReports.push({
      key: expert,
      title: handoff.title,
      status: handoff.status,
      statusLabel: STATUS_LABELS[handoff.status] ?? handoff.status,
      summary: handoff.summary,
      sections: handoff.sections,
      findingCount: handoff.findings.length,
      severityCounts: countSeverities(handoff.findings),
      error: handoff.error,
      file: handoff.file,
    })
    if (handoff.status === 'missing') {
      warnings.push(`${expert}: 缺少 handoff 文件（${handoff.file}）`)
    } else if (handoff.status === 'invalid') {
      warnings.push(`${expert}: handoff 无效（${handoff.error ?? '未知原因'}）`)
    } else if (handoff.status === 'failed') {
      warnings.push(`${expert}: handoff 失败（${handoff.error ?? '未知原因'}）`)
    } else if (handoff.status === 'partial') {
      warnings.push(`${expert}: 子代理只完成了部分检查`)
    }
  }

  const completed = expertReports.filter((report) => report.status === 'ok')
  const partial = expertReports.filter((report) => report.status === 'partial')
  const failed = expertReports.filter((report) => report.status === 'failed')
  const missing = expertReports.filter((report) => report.status === 'missing')
  const invalid = expertReports.filter((report) => report.status === 'invalid')
  const complete = expected.length > 0 && partial.length === 0 && failed.length === 0 && missing.length === 0 && invalid.length === 0
  const publishable = complete && DEFAULT_EXPERTS.every((expert) => expected.includes(expert))

  let normalized = dedupeFindings(findings)
  normalized = normalized
    .map((finding) => ({ ...finding, module: moduleOf(finding.file, config) }))
    .sort(compareFindings)
  normalized = assignFindingIds(normalized)
  const modules = groupByModule(normalized, config)
  const counts = {
    total: normalized.length,
    direct: normalized.filter((finding) => finding.kind === 'direct').length,
    plan: normalized.filter((finding) => finding.kind === 'plan').length,
    lowConfidence: normalized.filter((finding) => !finding.counted).length,
    bySeverity: countSeverities(normalized),
    byExpert: countByExpert(normalized, expected),
    byModule: Object.fromEntries(modules.map((module) => [module.module, module.findings.length])),
  }
  const coverage = {
    expected,
    completed: completed.map((report) => report.key),
    partial: partial.map((report) => report.key),
    failed: failed.map((report) => report.key),
    missing: missing.map((report) => report.key),
    invalid: invalid.map((report) => report.key),
    complete,
    publishable,
    full: expected.length === EXPERT_LIST.length && complete,
  }

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    runId: scope.runId,
    createdAt: nowIso(),
    command: scope.command,
    summary: buildSummary({ expected, findings: normalized, modules, coverage }),
    scope: {
      root: scope.root,
      isGit: scope.isGit,
      git: scope.git,
      source: scope.source,
      createdAt: scope.createdAt,
      notes: scope.notes,
      stats: scope.stats,
      summary: scope.summary,
      testCommand: scope.testCommand,
      files: scope.files,
      output: scope.output,
    },
    experts: expertReports,
    modules: modules.map((module) => ({
      module: module.module,
      counts: module.counts,
      experts: module.experts,
      findings: module.findings.map(findingRef),
    })),
    findings: normalized,
    counts,
    coverage,
    fixOrder: normalized
      .filter((finding) => finding.kind === 'direct')
      .slice(0, 20)
      .map(findingRef),
    warnings: [...new Set(warnings)].slice(0, 100),
  }

  const reportJsonPath = resolve(runDir, 'report.json')
  const reportMarkdownPath = resolve(runDir, 'report.md')
  const leakCount = scanSecrets(JSON.stringify(report)).total
  if (leakCount > 0) {
    report.warnings = [...new Set([...report.warnings, `报告中发现 ${leakCount} 处疑似凭据，已在写入前脱敏。`])].slice(0, 100)
  }
  const safeReport = redactValue(report)
  writeJsonFile(reportJsonPath, safeReport)
  const markdown = renderMarkdown(safeReport)
  writeTextFile(reportMarkdownPath, markdown)

  // Never let a partial or single-expert report replace the shared latest
  // report. Only a complete run of the default review set is publishable.
  let latestMarkdownPath
  if (publishable) {
    latestMarkdownPath = resolve(root, 'docs', 'logistics', 'latest.md')
    const latestJsonPath = resolve(root, '.logistics', 'latest.json')
    writeTextFile(latestMarkdownPath, markdown)
    writeJsonFile(latestJsonPath, {
      runId: report.runId,
      createdAt: report.createdAt,
      reportPath: toPosix(reportJsonPath),
      markdownPath: toPosix(latestMarkdownPath),
      coverageComplete: true,
      publishable: true,
      experts: expected,
      command: report.command,
    })
  }

  return { report: safeReport, reportJsonPath, reportMarkdownPath, latestMarkdownPath }
}

export function readLatestReport(root) {
  const path = resolve(root, '.logistics', 'latest.json')
  if (!isFile(path)) return undefined
  const pointer = readJsonFile(path, undefined)
  if (!pointer || typeof pointer.reportPath !== 'string') return undefined
  const report = readJsonFile(pointer.reportPath, undefined)
  if (!report || typeof report !== 'object') return undefined
  return { pointer, report, reportPath: pointer.reportPath, markdownPath: pointer.markdownPath }
}

function formatLocation(finding) {
  return finding.file ? `${finding.file}:${finding.line}` : '仓库级'
}

function tableCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function severityLabel(finding) {
  return finding.severityLabel ?? finding.severity
}

export function renderMarkdown(report) {
  const scope = report.scope
  const lines = []
  lines.push(`# 项目后勤报告 · ${report.command}`)
  lines.push('')
  lines.push(`> ${report.summary}`)
  lines.push('')
  lines.push(`- 运行：\`${report.runId}\` · ${report.createdAt}`)
  lines.push(`- 工作区：\`${scope.root}\``)
  lines.push(`- 覆盖：${report.coverage.completed.length}/${report.coverage.expected.length} 位专家${report.coverage.complete ? (report.coverage.publishable ? '' : '（单模块或非默认组合，不更新 latest）') : '（不完整）'}`)
  if (scope.notes) lines.push(`- 备注：${scope.notes}`)

  lines.push('')
  lines.push('## 模块总览')
  lines.push('')
  if (report.modules.length === 0) {
    lines.push('本次未发现需要报告的问题。')
  } else {
    lines.push('| 模块 | 严重 | 高 | 中 | 低 | 提示 | 专家 |')
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |')
    for (const module of report.modules) {
      const counts = module.counts
      lines.push(`| ${tableCell(module.module)} | ${counts.critical} | ${counts.high} | ${counts.medium} | ${counts.low} | ${counts.info} | ${tableCell(module.experts.join(', '))} |`)
    }
  }

  for (const module of report.modules) {
    lines.push('')
    lines.push(`## 模块 ${module.module}`)
    for (const finding of module.findings) {
      lines.push('')
      lines.push(`### [${severityLabel(finding)}] ${finding.title}`)
      lines.push(`- ID：\`${finding.id}\``)
      lines.push(`- 专家：${(finding.experts ?? [finding.expert]).join('、')}（${finding.section}）`)
      lines.push(`- 位置：\`${formatLocation(finding)}\``)
      lines.push(`- 置信度：${finding.confidence}`)
      if (finding.evidence) lines.push(`- 证据：${finding.evidence}`)
      if (finding.impact) lines.push(`- 影响：${finding.impact}`)
      if (finding.fix?.summary) lines.push(`- 修复建议：${finding.fix.summary}`)
      if (finding.fix?.steps?.length > 0) {
        lines.push('- 修复步骤：')
        finding.fix.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`))
      }
      if (finding.fix?.files?.length > 0) lines.push(`- 涉及文件：${finding.fix.files.join('、')}`)
      if (finding.fix?.tests?.length > 0) lines.push(`- 建议测试：${finding.fix.tests.join('；')}`)
      lines.push(`- 类型：${finding.kind === 'direct' ? 'direct（可直接修）' : 'plan（需要方案确认）'}`)
    }
  }

  lines.push('')
  lines.push('## 未覆盖维度')
  const uncovered = []
  if (!report.coverage.expected.includes('perf')) uncovered.push('性能：本次未运行，需要时执行 `/logi-perf`。')
  for (const key of report.coverage.partial) uncovered.push(`${key}：只完成了部分检查，结论不完整。`)
  for (const key of report.coverage.missing) uncovered.push(`${key}：缺少 handoff，未完成。`)
  for (const key of report.coverage.invalid) uncovered.push(`${key}：handoff 无效，未完成。`)
  for (const key of report.coverage.failed) uncovered.push(`${key}：handoff 失败。`)
  if (uncovered.length === 0) lines.push('- 无；本次请求的专家均已完成。')
  else for (const item of uncovered) lines.push(`- ${item}`)

  lines.push('')
  lines.push('## 建议修复顺序')
  if (report.fixOrder.length === 0) {
    lines.push('没有可执行的 direct 修复项。')
  } else {
    report.fixOrder.forEach((finding, index) => {
      lines.push(`${index + 1}. \`${finding.id}\`（${finding.severity}，${finding.title}）`)
    })
  }

  lines.push('')
  lines.push('> 本报告只描述问题和修复方案，不会修改源码。需要修复时，把报告或指定 finding 交给主模型处理。')
  return `${lines.join('\n')}\n`
}

export { STATUS_LABELS, fingerprint }
