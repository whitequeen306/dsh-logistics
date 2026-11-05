import { readFileSync } from 'node:fs'
import { SEVERITIES } from './constants.js'
import { handoffRelPath, resolveHandoffMarkdownPath } from './handoff-paths.js'
import { unitIndex } from './project.js'
import { scanSecrets } from './redact.js'
import { isFile, toPosix } from './util.js'

const MIN_REPORT_CHARS = 1200
const MIN_EXPERT_REPORT_CHARS = 500

const REQUIRED_SECTIONS = [
  { label: '一句话结论', pattern: /一句话结论/u },
  { label: '覆盖情况', pattern: /覆盖/u },
  { label: '发现', pattern: /发现|问题/u },
  { label: '修复建议', pattern: /修复/u },
  { label: '测试证据', pattern: /测试/u },
  { label: '覆盖缺口', pattern: /缺口|未验证/u },
]

function sectionText(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => /^#{2,4}\s+/u.test(line))
    .join('\n')
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function versionAtLeast(version, minimum) {
  const parse = (value) => String(value ?? '').split('.').map((part) => Number(part) || 0)
  const [major, minor, patch] = parse(version)
  const [minMajor, minMinor, minPatch] = parse(minimum)
  if (major !== minMajor) return major > minMajor
  if (minor !== minMinor) return minor > minMinor
  return patch >= minPatch
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Return the body of a level-2 section, excluding its heading. */
function sectionBody(text, title) {
  const lines = text.split(/\r?\n/u)
  const heading = new RegExp(
    `^##\\s*(?:[一二三四五六七八九十百]+[、.．]\\s*|\\d+[、.．]\\s*)?${escapeRegExp(title)}(?:\\s|$|[（(：:])`,
    'u',
  )
  const start = lines.findIndex((line) => heading.test(line))
  if (start < 0) return ''
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/u.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

/**
 * 0.6.4: the findings section is ordered by severity, not by unit. Every
 * finding line must carry its severity and owning unit, and the order must be
 * critical -> high -> medium -> low -> info.
 */
function checkSeverityReport({ scope, text, findings, errors }) {
  if (!versionAtLeast(scope.version, '0.6.4') || findings.length === 0) return
  const body = sectionBody(text, '发现')
  if (!body) {
    errors.push('report.md 缺少“## 发现”章节，无法校验严重度排序')
    return
  }
  const lines = body.split(/\r?\n/u)
  const units = unitIndex(scope)
  const ranks = []
  const missingLines = []
  for (const finding of findings) {
    if (typeof finding?.id !== 'string' || !finding.id) continue
    const index = lines.findIndex((line) => line.includes(finding.id))
    if (index < 0) {
      missingLines.push(finding.id)
      continue
    }
    const line = lines[index]
    const unit = units.get(toPosix(finding.file ?? '')) ?? ''
    if (!line.includes(`[${finding.severity}]`)) {
      errors.push(`发现 ${finding.id} 未标注严重度 [${finding.severity}]`)
    }
    if (unit && !line.includes(`[${unit}]`)) {
      errors.push(`发现 ${finding.id} 未标注所属单元 [${unit}]`)
    }
    const rank = SEVERITIES[finding.severity]?.rank
    if (Number.isFinite(rank)) ranks.push({ id: finding.id, rank, index })
  }
  if (missingLines.length > 0) {
    errors.push(`“## 发现”缺少 finding：${missingLines.join('、')}`)
  }
  const ordered = [...ranks].sort((a, b) => a.index - b.index)
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].rank < ordered[i - 1].rank) {
      errors.push(`发现未按严重度排序：${ordered[i - 1].id} 之后出现了更严重的 ${ordered[i].id}`)
      break
    }
  }
}

/**
 * 0.6.5: each finding must be readable by non-developers: a plain-language
 * brief first, then the original detailed problem, evidence, impact and fix.
 */
function checkBriefReport({ scope, text, findings, errors }) {
  if (!versionAtLeast(scope.version, '0.6.5') || findings.length === 0) return
  const body = sectionBody(text, '发现')
  if (!body) return
  const lines = body.split(/\r?\n/u)
  for (const finding of findings) {
    if (typeof finding?.id !== 'string' || !finding.id) continue
    const index = lines.findIndex((line) => line.includes(finding.id))
    if (index < 0) continue
    const block = lines.slice(index, index + 8).join('\n')
    for (const label of ['简述', '详细问题', '证据', '影响', '修复']) {
      if (!block.includes(label)) {
        errors.push(`发现 ${finding.id} 缺少“${label}”内容；应按 简述 → 详细问题 → 证据 → 影响 → 修复 展示`)
      }
    }
    if (finding.brief && !block.includes(finding.brief)) {
      errors.push(`发现 ${finding.id} 的“简述”与 verdict.brief 不一致：${finding.brief}`)
    }
  }
}

function checkFindingSection({ text, findings, kind, title, errors }) {
  const selected = findings.filter((finding) => finding?.kind === kind && typeof finding.id === 'string' && finding.id)
  if (selected.length === 0) return
  const body = sectionBody(text, title)
  if (!body) {
    errors.push(`report.md 缺少“## ${title}”章节，无法区分 ${kind} 项`)
    return
  }
  const missing = selected.filter((finding) => !body.includes(finding.id))
  if (missing.length > 0) {
    errors.push(`“## ${title}”缺少 finding：${missing.map((finding) => finding.id).join('、')}`)
  }
}

/**
 * 0.4.x runs predate the per-expert Markdown contract. Keep them readable:
 * validate the aggregate report, but do not reject them for missing expert md.
 */
function isLegacyProjectScope(scope) {
  const [major, minor] = String(scope?.version ?? '').split('.').map(Number)
  return major === 0 && Number.isInteger(minor) && minor < 5
}

/**
 * Validate the human-facing deliverables. `report.md` is the primary product;
 * `verdict.json` is the machine decision. A project run is not complete when
 * either the aggregate report or an expert report is missing or too thin.
 */
export function validateReport({ scope, verdict }) {
  const errors = []
  const warnings = []
  if (scope?.mode !== 'project') return { errors, warnings }

  const reportPath = scope.output?.reportMarkdown
  if (!reportPath || !isFile(reportPath)) {
    errors.push(`缺少总报告 report.md：${reportPath ?? '（未配置路径）'}`)
    return { errors, warnings }
  }

  const text = readText(reportPath).trim()
  if (text.length < MIN_REPORT_CHARS) {
    errors.push(`report.md 过短（${text.length} 字符，至少需要 ${MIN_REPORT_CHARS}）`)
  }
  const reportSecrets = scanSecrets(text)
  if (reportSecrets.total > 0) {
    errors.push(`report.md 仍包含 ${reportSecrets.total} 处疑似凭据，拒绝通过；请先脱敏（${reportSecrets.redactions.map((item) => `${item.kind}×${item.count}`).join(', ')}）`)
  }
  const headings = sectionText(text)
  for (const section of REQUIRED_SECTIONS) {
    if (!section.pattern.test(headings)) errors.push(`report.md 缺少“${section.label}”章节`)
  }

  const findings = Array.isArray(verdict?.findings) ? verdict.findings : []
  if (versionAtLeast(scope.version, '0.6.3')) {
    checkFindingSection({ text, findings, kind: 'direct', title: '可直接修', errors })
    checkFindingSection({ text, findings, kind: 'plan', title: '需方案', errors })
    if (findings.length > 0 && !/\[可直接修\]|\[需方案\]/u.test(text)) {
      errors.push('report.md 有 findings，但没有 [可直接修] / [需方案] 标记')
    }
    const commands = (Array.isArray(scope.testCommands) && scope.testCommands.length > 0
      ? scope.testCommands
      : scope.testCommand ? [scope.testCommand] : []).map((item) => item.command)
    const missingCommands = commands.filter((command) => !text.includes(command))
    if (missingCommands.length > 0) {
      errors.push(`report.md 的测试证据缺少命令：${missingCommands.join('、')}`)
    }
  }
  checkSeverityReport({ scope, text, findings, errors })
  checkBriefReport({ scope, text, findings, errors })

  const units = Array.isArray(scope.project?.units) ? scope.project.units : []
  const missingUnits = units.filter((unit) => !new RegExp(`(^|[^\\w-])${unit.id}([^\\w-]|$)`, 'u').test(text))
  if (missingUnits.length > 0) {
    errors.push(`report.md 缺少覆盖矩阵单元：${missingUnits.map((unit) => unit.id).join('、')}`)
  }

  if (Array.isArray(verdict?.findings) && verdict.findings.length > 0 && !/[\w./\\-]+:\d+/u.test(text)) {
    errors.push('report.md 有 findings，但没有出现任何 file:line 定位')
  }

  const handoffDir = scope.output?.handoffDir
  const legacy = isLegacyProjectScope(scope)
  if (legacy) {
    warnings.push('旧版 0.4.x 运行没有专家报告，按兼容模式只校验总报告')
  } else {
    for (const expert of scope.experts ?? []) {
      const expertPath = handoffDir ? resolveHandoffMarkdownPath(scope, expert) : ''
      const relPath = handoffRelPath(scope, expert, 'md')
      if (!expertPath || !isFile(expertPath)) {
        errors.push(`缺少专家报告 ${relPath}：${toPosix(expertPath || '（未配置路径）')}`)
        continue
      }
      const expertText = readText(expertPath).trim()
      if (expertText.length < MIN_EXPERT_REPORT_CHARS) {
        errors.push(`${expert}.md 过短（${expertText.length} 字符，至少需要 ${MIN_EXPERT_REPORT_CHARS}）`)
      }
      const expertSecrets = scanSecrets(expertText)
      if (expertSecrets.total > 0) {
        errors.push(`${expert}.md 仍包含 ${expertSecrets.total} 处疑似凭据，拒绝通过；请先脱敏`)
      }
      if (!/^#{1,3}\s+/mu.test(expertText)) errors.push(`${expert}.md 缺少 Markdown 标题`)
      if (!text.includes(relPath)) {
        errors.push(`report.md 缺少专家报告索引：${relPath}`)
      }
    }
  }

  return { errors, warnings }
}
