import { resolve } from 'node:path'
import {
  PASS_BY_KEY,
  PASS_LIST,
  REPORT_SCHEMA_VERSION,
  SEVERITIES,
  SEVERITY_ORDER,
  SINGLE_TIER,
  TIERS,
  TOOL_NAME,
  TOOL_VERSION,
} from './constants.js'
import {
  compareToBaseline,
  fingerprint,
  normalizeFindingPath,
  normalizeTitle,
} from './baseline.js'
import {
  isFile,
  nowIso,
  oneLine,
  readJsonFile,
  resolveFrom,
  toPosix,
  truncate,
  writeJsonFile,
  writeTextFile,
} from './util.js'

const SEVERITY_ALIASES = {
  严重: 'critical',
  高: 'high',
  中: 'medium',
  低: 'low',
  提示: 'info',
  blocker: 'critical',
  error: 'high',
  warning: 'medium',
  note: 'low',
}

const CONFIDENCE_ALIASES = { 高: 'high', 中: 'medium', 低: 'low', high: 'high', medium: 'medium', low: 'low' }

const GRADE_LABELS = {
  A: '优秀',
  B: '良好',
  C: '需关注',
  D: '较差',
  F: '危险',
}

const STATUS_LABELS = { ok: '完成', partial: '部分完成', failed: '失败', missing: '未完成' }

function toText(value, max = 1600) {
  if (Array.isArray(value)) return truncate(value.filter(Boolean).join('\n'), max)
  if (value === null || value === undefined) return ''
  return truncate(String(value), max)
}

function normalizeSeverity(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (SEVERITIES[raw]) return raw
  if (SEVERITY_ALIASES[raw]) return SEVERITY_ALIASES[raw]
  return undefined
}

function normalizeConfidence(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  return CONFIDENCE_ALIASES[raw] ?? undefined
}

function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'general'
}

function normalizeFinding({ root, pass, raw, index, warnings }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${pass}: 第 ${index + 1} 条发现不是对象，已跳过`)
    return undefined
  }
  const passInfo = PASS_BY_KEY[pass]
  const title = oneLine(raw.title ?? raw.message ?? '', 180)
  if (!title) {
    warnings.push(`${pass}: 第 ${index + 1} 条发现缺少 title，已跳过`)
    return undefined
  }
  let severity = normalizeSeverity(raw.severity)
  if (!severity) {
    severity = 'medium'
    warnings.push(`${pass}: "${title}" 的 severity 无效，按 medium 处理`)
  }
  let confidence = normalizeConfidence(raw.confidence) ?? 'medium'
  const evidence = toText(raw.evidence ?? raw.proof ?? raw.reason, 2000)
  if ((severity === 'critical' || severity === 'high') && !evidence) {
    confidence = 'low'
    warnings.push(`${pass}: "${title}" 是 ${severity} 但缺少证据，已降为低置信度`)
  }

  let file = typeof raw.file === 'string' ? raw.file.trim() : ''
  let lineValue = Number(raw.line)
  if (!file && typeof raw.location === 'string') {
    const match = /^(.*?):(\d+)$/.exec(raw.location.trim())
    if (match) {
      file = match[1]
      lineValue = Number(match[2])
    } else {
      file = raw.location.trim()
    }
  }
  if (file && !Number.isFinite(lineValue)) {
    const match = /^(.*?):(\d+)$/.exec(file)
    if (match) {
      file = match[1]
      lineValue = Number(match[2])
    }
  }
  const normalizedPath = normalizeFindingPath(root, file)
  if (normalizedPath.warning) warnings.push(`${pass}: ${normalizedPath.warning}`)
  file = normalizedPath.file
  const line = Number.isInteger(lineValue) && lineValue > 0 ? lineValue : file ? 1 : 0

  const category = slug(raw.category ?? passInfo.domain)
  const ruleIdRaw = typeof raw.ruleId === 'string' ? raw.ruleId.trim() : ''
  const ruleId = /^[A-Za-z][A-Za-z0-9_-]*$/.test(ruleIdRaw)
    ? ruleIdRaw.toUpperCase()
    : `${passInfo.prefix}-${category}`

  return {
    pass,
    passTitle: passInfo.title,
    expert: passInfo.expert,
    category,
    severity,
    severityLabel: SEVERITIES[severity].label,
    confidence,
    counted: confidence !== 'low',
    title,
    file,
    line,
    evidence,
    impact: toText(raw.impact, 1600),
    recommendation: toText(raw.recommendation ?? raw.fix, 1600),
    ruleId,
    autoFixable: raw.autoFixable === true,
    isNew: false,
    fingerprint: '',
  }
}

function readHandoff({ root, runDir, pass, maxFindings, warnings }) {
  const file = resolve(runDir, 'handoff', `${pass}.json`)
  const passInfo = PASS_BY_KEY[pass]
  if (!isFile(file)) {
    return { pass, status: 'missing', findings: [], summary: '', error: undefined, file: toPosix(file) }
  }
  const rawFile = readJsonFile(file, undefined)
  if (rawFile === undefined) {
    return {
      pass,
      status: 'failed',
      findings: [],
      summary: '',
      error: 'handoff JSON 无法解析',
      file: toPosix(file),
    }
  }
  const raw = rawFile && typeof rawFile === 'object' && rawFile.handoff && typeof rawFile.handoff === 'object'
    ? rawFile.handoff
    : rawFile
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      pass,
      status: 'failed',
      findings: [],
      summary: '',
      error: 'handoff 必须是 JSON 对象',
      file: toPosix(file),
    }
  }
  if (raw.pass && raw.pass !== pass) {
    warnings.push(`${pass}: handoff 内的 pass="${raw.pass}" 与文件名不一致，已按 ${pass} 处理`)
  }
  const summary = oneLine(raw.summary ?? raw.notes ?? '', 500)
  const statusRaw = String(raw.status ?? '').toLowerCase()
  if (statusRaw === 'failed' || raw.error) {
    return {
      pass,
      status: 'failed',
      findings: [],
      summary,
      error: oneLine(raw.error ?? '子代理报告失败', 500),
      file: toPosix(file),
    }
  }
  if (!Array.isArray(raw.findings)) {
    return {
      pass,
      status: 'failed',
      findings: [],
      summary,
      error: 'handoff 缺少 findings 数组',
      file: toPosix(file),
    }
  }

  const findings = []
  const seen = new Set()
  for (let index = 0; index < raw.findings.length; index += 1) {
    const finding = normalizeFinding({ root, pass, raw: raw.findings[index], index, warnings })
    if (!finding) continue
    finding.fingerprint = fingerprint(finding)
    if (seen.has(finding.fingerprint)) continue
    seen.add(finding.fingerprint)
    findings.push(finding)
  }
  let capped = findings
  if (findings.length > maxFindings) {
    capped = findings.slice(0, maxFindings)
    warnings.push(`${pass}: 发现数 ${findings.length} 超过 maxFindingsPerPass=${maxFindings}，已截断`)
  }
  const status = statusRaw === 'partial' ? 'partial' : 'ok'
  return {
    pass,
    status,
    findings: capped,
    summary,
    error: undefined,
    file: toPosix(file),
  }
}

/**
 * Build the normalized report from the seven handoff files. Missing or invalid
 * handoffs are represented explicitly so a partial run cannot masquerade as a
 * clean bill of health.
 */
export function buildReport({ root, runDir, scope, config }) {
  const warnings = [...(scope.warnings ?? [])]
  const expected = scope.passes.filter((pass) => PASS_BY_KEY[pass])
  for (const pass of scope.passes) {
    if (!PASS_BY_KEY[pass]) warnings.push(`未知专家 "${pass}"，已跳过`)
  }

  const passReports = []
  const findings = []
  for (const pass of expected) {
    const handoff = readHandoff({ root, runDir, pass, maxFindings: config.maxFindingsPerPass, warnings })
    findings.push(...handoff.findings)
    const summary = handoff.summary
    passReports.push({
      pass,
      title: PASS_BY_KEY[pass].title,
      expert: PASS_BY_KEY[pass].expert,
      status: handoff.status,
      summary,
      findingCount: handoff.findings.length,
      severityCounts: countSeverities(handoff.findings),
      error: handoff.error,
      file: handoff.file,
    })
    if (handoff.status === 'missing') {
      warnings.push(`${pass}: 缺少 handoff 文件（${handoff.file}）`)
    } else if (handoff.status === 'failed') {
      warnings.push(`${pass}: handoff 失败（${handoff.error ?? '未知原因'}）`)
    }
  }

  const completed = passReports.filter((pass) => pass.status === 'ok' || pass.status === 'partial').map((pass) => pass.pass)
  const failed = passReports.filter((pass) => pass.status === 'failed').map((pass) => pass.pass)
  const missing = passReports.filter((pass) => pass.status === 'missing').map((pass) => pass.pass)
  const coverage = {
    expected,
    completed,
    failed,
    missing,
    valid: completed.length,
    percent: expected.length === 0 ? 0 : Math.round((completed.length / expected.length) * 100),
    complete: expected.length > 0 && failed.length === 0 && missing.length === 0,
    full: expected.length === PASS_LIST.length && failed.length === 0 && missing.length === 0,
  }

  const score = computeScore(findings)
  const comparison = compareToBaseline({
    root,
    findings,
    passes: expected,
    score: score.value,
    complete: coverage.full,
  })
  warnings.push(...comparison.warnings)
  findings.sort(compareFindings)
  const gate = evaluateGate({ comparison, coverage, config })

  const tierKey = scope.mode === 'single' ? 'single' : scope.tier
  const tierInfo = tierKey === 'single' ? SINGLE_TIER : TIERS[tierKey] ?? TIERS.standard

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    runId: scope.runId,
    createdAt: nowIso(),
    command: scope.command,
    mode: scope.mode,
    tier: tierKey,
    tierLabel: tierInfo.label,
    summary: buildVerdict({ score, comparison, coverage, gate }),
    scope: {
      root: scope.root,
      isGit: scope.isGit,
      git: scope.git,
      source: scope.source,
      createdAt: scope.createdAt,
      notes: scope.notes,
      stats: scope.stats,
      summary: scope.summary,
      risk: scope.risk,
      testCommand: scope.testCommand,
      files: scope.files,
      output: scope.output,
    },
    passes: passReports,
    findings,
    counts: {
      total: findings.length,
      counted: findings.filter((finding) => finding.counted).length,
      lowConfidence: findings.filter((finding) => !finding.counted).length,
      bySeverity: countSeverities(findings),
      byPass: Object.fromEntries(expected.map((pass) => [
        pass,
        findings.filter((finding) => finding.pass === pass).length,
      ])),
    },
    score,
    coverage,
    baseline: {
      hasBaseline: comparison.hasBaseline,
      path: comparison.path,
      acceptedAt: comparison.acceptedAt,
      baselineScore: comparison.baselineScore,
      baselineComplete: comparison.baselineComplete,
      scoreDrop: comparison.scoreDrop,
      existingCount: comparison.existingCount,
      totalBaselineEntries: comparison.totalBaselineEntries,
      newCounts: comparison.newCounts,
      fixedCounts: comparison.fixedCounts,
      newFindings: comparison.newFindings.map(toFindingRef),
      fixedFindings: comparison.fixedFindings.map(toFindingRef),
    },
    gate,
    warnings: [...new Set(warnings)].slice(0, 80),
  }

  const reportJsonPath = resolve(runDir, 'report.json')
  const reportMarkdownPath = resolve(runDir, 'report.md')
  const docsDir = resolve(root, 'docs', 'logistics')
  const latestMarkdownPath = resolve(docsDir, 'latest.md')
  writeJsonFile(reportJsonPath, report)
  const markdown = renderMarkdown(report)
  writeTextFile(reportMarkdownPath, markdown)
  writeTextFile(latestMarkdownPath, markdown)
  writeJsonFile(resolve(root, '.logistics', 'latest.json'), {
    runId: report.runId,
    createdAt: report.createdAt,
    reportPath: toPosix(reportJsonPath),
    markdownPath: toPosix(latestMarkdownPath),
    coverageComplete: report.coverage.complete,
    gate: report.gate.status,
    score: report.score.value,
  })
  return { report, reportJsonPath, reportMarkdownPath, latestMarkdownPath }
}

function toFindingRef(finding) {
  return {
    fingerprint: finding.fingerprint,
    pass: finding.pass,
    severity: finding.severity,
    title: finding.title,
    file: finding.file,
    line: finding.line,
    confidence: finding.confidence,
    counted: finding.counted,
  }
}

function countSeverities(findings) {
  const counts = Object.fromEntries(SEVERITY_ORDER.map((severity) => [severity, 0]))
  for (const finding of findings) {
    if (counts[finding.severity] !== undefined) counts[finding.severity] += 1
  }
  return counts
}

function compareFindings(a, b) {
  const severity = SEVERITIES[a.severity].rank - SEVERITIES[b.severity].rank
  if (severity !== 0) return severity
  return String(a.file ?? '').localeCompare(String(b.file ?? ''))
    || Number(a.line ?? 0) - Number(b.line ?? 0)
}

/**
 * Score once per distinct issue. Two experts may describe the same defect from
 * different angles; dedupe by file + normalized title and keep the worst
 * severity so the report does not double-charge for one problem.
 */
export function computeScore(findings) {
  const groups = new Map()
  for (const finding of findings) {
    if (!finding.counted) continue
    const key = `${finding.file || '-'}|${normalizeTitle(finding.title)}`
    const existing = groups.get(key)
    if (!existing || SEVERITIES[finding.severity].rank < SEVERITIES[existing.severity].rank) {
      groups.set(key, finding)
    }
  }
  const deductions = [...groups.values()]
    .map((finding) => ({
      key: `${finding.file || '-'}|${normalizeTitle(finding.title)}`,
      title: finding.title,
      pass: finding.pass,
      file: finding.file,
      line: finding.line,
      severity: finding.severity,
      points: SEVERITIES[finding.severity].weight,
    }))
    .sort((a, b) => SEVERITIES[a.severity].rank - SEVERITIES[b.severity].rank)
  const total = deductions.reduce((sum, item) => sum + item.points, 0)
  const value = Math.max(0, Math.min(100, 100 - total))
  const grade = value >= 90 ? 'A' : value >= 80 ? 'B' : value >= 70 ? 'C' : value >= 60 ? 'D' : 'F'
  return {
    value,
    grade,
    label: GRADE_LABELS[grade],
    deductions,
    formula: '100 - Σ(严重:25 / 高:10 / 中:4 / 低:1)',
  }
}

export function evaluateGate({ comparison, coverage, config }) {
  const countedNew = comparison.newFindings.filter((finding) => finding.counted)
  const newCritical = countedNew.filter((finding) => finding.severity === 'critical').length
  const newHigh = countedNew.filter((finding) => finding.severity === 'high').length
  const reasons = []
  let status = 'pass'
  let code = 0

  if (!coverage.full) {
    status = 'warn'
    code = 3
    reasons.push(coverage.complete
      ? `非全量报告（${coverage.valid}/${PASS_LIST.length}），门禁仅作参考`
      : `覆盖不完整（${coverage.valid}/${coverage.expected.length}），门禁结论不可作为通过依据`)
  } else {
    if (!comparison.hasBaseline) {
      reasons.push('未找到基线：本次所有问题按新增计算；运行 /logi-gate accept 建立基线')
    }
    if (newCritical > 0) {
      status = 'fail'
      code = 1
      reasons.push(`新增严重问题 ${newCritical} 项`)
    } else if (newHigh > 0 && config.gate.failOnNewHigh) {
      status = 'fail'
      code = 2
      reasons.push(`新增高优先级问题 ${newHigh} 项（已开启 failOnNewHigh）`)
    } else if (comparison.scoreDrop > config.gate.maxScoreDrop) {
      status = 'fail'
      code = 2
      reasons.push(`健康分下降 ${comparison.scoreDrop} 分，超过阈值 ${config.gate.maxScoreDrop}`)
    } else {
      reasons.push('没有新增严重问题，门禁通过')
    }
  }

  return {
    status,
    code,
    newCritical,
    newHigh,
    scoreDrop: comparison.scoreDrop,
    maxScoreDrop: config.gate.maxScoreDrop,
    failOnNewHigh: config.gate.failOnNewHigh,
    hasBaseline: comparison.hasBaseline,
    reasons,
  }
}

function buildVerdict({ score, comparison, coverage, gate }) {
  const parts = [`健康分 ${score.value}/100（${score.grade}）`]
  if (!coverage.full) parts.push(`覆盖 ${coverage.valid}/${PASS_LIST.length}，结论不完整`)
  const newCount = comparison.newFindings.length
  if (newCount > 0) parts.push(`新增 ${newCount} 项`)
  if (comparison.fixedFindings.length > 0) parts.push(`修复 ${comparison.fixedFindings.length} 项`)
  parts.push(gate.status === 'pass' ? '门禁通过' : gate.status === 'warn' ? '门禁不确定' : '门禁未通过')
  return parts.join('；')
}

function formatLocation(finding) {
  return finding.file ? `${finding.file}:${finding.line}` : '仓库级'
}

function tableCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function renderMarkdown(report) {
  const lines = []
  const scope = report.scope
  lines.push(`# 项目后勤报告 · ${report.command}`)
  lines.push('')
  lines.push(`> ${report.summary}`)
  lines.push('')
  lines.push(`- 运行：\`${report.runId}\` · ${report.createdAt}`)
  lines.push(`- 档位：${report.tierLabel}${report.mode === 'single' ? '（单专家）' : ''}`)
  lines.push(`- 工作区：\`${scope.root}\``)

  lines.push('')
  lines.push('## 概览')
  lines.push('')
  lines.push('| 指标 | 值 |')
  lines.push('| --- | --- |')
  const counts = report.counts.bySeverity
  lines.push(`| 健康分 | ${report.score.value}/100（${report.score.grade} · ${report.score.label}） |`)
  lines.push(`| 发现 | 严重 ${counts.critical} · 高 ${counts.high} · 中 ${counts.medium} · 低 ${counts.low} · 提示 ${counts.info} |`)
  lines.push(`| 新增 / 存量 | ${report.baseline.newFindings.length} / ${report.baseline.existingCount} |`)
  lines.push(`| 覆盖 | ${report.coverage.valid}/${report.coverage.expected.length}（${report.coverage.percent}%） |`)
  lines.push(`| 门禁 | ${report.gate.status}（exit ${report.gate.code}） |`)
  if (report.counts.lowConfidence > 0) {
    lines.push(`| 低置信度 | ${report.counts.lowConfidence} 项（不计分） |`)
  }

  lines.push('')
  lines.push('## 本次范围')
  lines.push('')
  if (scope.git?.available) {
    const branch = scope.git.branch ? `\`${scope.git.branch}\`` : '（未知分支）'
    const head = scope.git.head ? `\`${scope.git.head}\`` : ''
    lines.push(`- 分支：${branch} ${head}`)
    if (scope.git.headSubject) lines.push(`- 提交：${scope.git.headSubject}`)
    lines.push(`- 来源：${scope.source === 'working-tree' ? '未提交改动' : scope.source === 'last-commit' ? '最近一次提交' : '工作区扫描'}`)
  } else {
    lines.push('- 非 Git 工作区，按文件扫描分析')
  }
  const stats = scope.stats
  lines.push(`- 文件：${stats.analyzedFiles} 个（+${stats.additions} / -${stats.deletions} 行）${stats.truncated ? `，另有 ${stats.omittedFiles} 个未分析` : ''}`)
  if (scope.summary?.languages?.length) {
    lines.push(`- 语言：${scope.summary.languages.map((item) => `${item.name} ${item.count}`).join(' · ')}`)
  }
  const risk = scope.risk
  lines.push(`- 风险：${risk.level}（建议 ${TIERS[risk.recommendTier]?.label ?? '快速'}档）${risk.reasons.length ? ` — ${risk.reasons.map((reason) => reason.label).join('；')}` : ''}`)
  if (scope.testCommand?.command) lines.push(`- 测试命令：\`${scope.testCommand.command}\`（来自 ${scope.testCommand.source}）`)
  if (scope.notes) lines.push(`- 备注：${scope.notes}`)
  if (scope.files.length > 0) {
    lines.push('')
    lines.push('<details><summary>改动文件</summary>')
    lines.push('')
    for (const file of scope.files.slice(0, 80)) {
      lines.push(`- \`${file.path}\`（${file.status}${file.oldPath ? ` ← ${file.oldPath}` : ''}）`)
    }
    if (scope.files.length > 80) lines.push(`- … 其余 ${scope.files.length - 80} 个文件见 JSON`)
    lines.push('')
    lines.push('</details>')
  }

  lines.push('')
  lines.push('## 专家结果')
  lines.push('')
  lines.push('| 专家 | 状态 | 发现 | 摘要 |')
  lines.push('| --- | --- | --- | --- |')
  for (const pass of report.passes) {
    lines.push(`| ${pass.title}（${pass.expert}） | ${STATUS_LABELS[pass.status] ?? pass.status} | ${pass.findingCount} | ${tableCell(pass.summary || pass.error || '')} |`)
  }

  lines.push('')
  lines.push('## 发现')
  lines.push('')
  if (report.findings.length === 0) {
    lines.push(report.coverage.complete
      ? '未发现需要报告的问题。'
      : '未发现已报告的问题，但覆盖不完整，不能视为通过。')
  } else {
    for (const severity of SEVERITY_ORDER) {
      const group = report.findings.filter((finding) => finding.severity === severity)
      if (group.length === 0) continue
      lines.push(`### ${SEVERITIES[severity].label}（${group.length}）`)
      lines.push('')
      for (const finding of group) {
        const tags = [
          finding.ruleId,
          finding.isNew ? '新增' : '存量',
          finding.confidence === 'low' ? '低置信度·不计分' : `${finding.confidence} confidence`,
          finding.autoFixable ? '可自动修复' : '',
        ].filter(Boolean)
        lines.push(`#### ${finding.title}`)
        lines.push('')
        lines.push(`- 位置：\`${formatLocation(finding)}\` ｜ 专家：${finding.expert} ｜ ${tags.join(' ｜ ')}`)
        if (finding.evidence) lines.push(`- 证据：${truncate(finding.evidence, 700)}`)
        if (finding.impact) lines.push(`- 影响：${truncate(finding.impact, 500)}`)
        if (finding.recommendation) lines.push(`- 建议：${truncate(finding.recommendation, 500)}`)
        lines.push('')
      }
    }
  }

  lines.push('')
  lines.push('## 基线与门禁')
  lines.push('')
  if (report.baseline.hasBaseline) {
    lines.push(`- 基线：\`${report.baseline.path}\`（${report.baseline.totalBaselineEntries} 项，接受于 ${report.baseline.acceptedAt ?? '未知'}）`)
    lines.push(`- 新增：${report.baseline.newFindings.length} 项；修复：${report.baseline.fixedFindings.length} 项；存量：${report.baseline.existingCount} 项`)
    if (report.baseline.fixedFindings.length > 0) {
      lines.push(`- 已修复：${report.baseline.fixedFindings.slice(0, 8).map((item) => `\`${item.file || '仓库级'}\` ${item.title}`).join('；')}`)
    }
  } else {
    lines.push('- 尚未建立基线；所有发现按新增计算。')
  }
  lines.push('')
  lines.push(`门禁结果：**${report.gate.status}**（exit ${report.gate.code}）`)
  for (const reason of report.gate.reasons) lines.push(`- ${reason}`)
  lines.push('')
  lines.push('建立/更新基线：在 DSH 中运行 `/logi-gate accept`（仅接受完整覆盖的报告）。')
  lines.push('')
  lines.push('## 计分说明')
  lines.push('')
  lines.push(`- 公式：${report.score.formula}；同一文件下标题相同的发现只计一次。`)
  lines.push('- 低置信度发现保留在报告中，但不计分、不参与门禁。')
  lines.push(`- 报告 JSON：\`${scope.output.reportJson}\``)
  lines.push('')
  return `${lines.join('\n')}\n`
}

/** Read the pointer written by the most recent aggregation. */
export function readLatestReport(root) {
  const pointerPath = resolve(root, '.logistics', 'latest.json')
  if (!isFile(pointerPath)) return undefined
  const pointer = readJsonFile(pointerPath, undefined)
  if (!pointer || typeof pointer.reportPath !== 'string') return undefined
  const reportPath = resolveFrom(root, pointer.reportPath)
  if (!isFile(reportPath)) return undefined
  const report = readJsonFile(reportPath, undefined)
  if (!report || typeof report !== 'object') return undefined
  return { pointer, report, reportPath, pointerPath }
}
