import { resolve } from 'node:path'
import {
  EXPERT_BY_KEY,
  EXPERT_PRIORITY,
  SEVERITIES,
  SEVERITY_ORDER,
} from './constants.js'
import { oneLine, relativePosix, sha1, toPosix, truncate } from './util.js'

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

const CONFIDENCE_ALIASES = {
  高: 'high',
  中: 'medium',
  低: 'low',
  high: 'high',
  medium: 'medium',
  low: 'low',
}

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 }

const DEPENDENCY_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'requirements.txt',
  'requirements-dev.txt',
  'pyproject.toml',
  'poetry.lock',
  'Pipfile',
  'Pipfile.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'composer.lock',
  'Gemfile',
  'Gemfile.lock',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeSeverity(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  return SEVERITIES[raw] ? raw : SEVERITY_ALIASES[raw]
}

export function normalizeConfidence(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  return CONFIDENCE_ALIASES[raw]
}

export function toText(value, max = 1600) {
  if (Array.isArray(value)) return truncate(value.filter(Boolean).join('\n'), max)
  if (value === null || value === undefined) return ''
  return truncate(String(value), max)
}

/** Lowercase, strip punctuation/whitespace variance, keep CJK characters. */
export function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
}

/**
 * Line-independent identity. Line numbers move when code is inserted above a
 * finding; including them would make the same defect look different after any
 * edit. The report uses this to merge findings from different experts.
 */
export function fingerprint(finding) {
  return sha1([
    finding.expert ?? finding.pass,
    finding.category,
    String(finding.file ?? '').replace(/^\.\//, ''),
    normalizeTitle(finding.title),
  ].join('|'))
}

export function shortId(finding, length = 5) {
  const prefix = EXPERT_BY_KEY[finding.expert]?.prefix ?? 'LOG'
  return `${prefix}-${fingerprint(finding).slice(0, length).toUpperCase()}`
}

/** Assign stable, collision-free IDs within one report. */
export function assignFindingIds(findings) {
  const used = new Set()
  const result = []
  for (const finding of findings) {
    const baseLength = 5
    let length = baseLength
    let id = shortId(finding, length)
    while (used.has(id) && length < 12) {
      length += 1
      id = shortId(finding, length)
    }
    while (used.has(id)) id = `${id}${used.size}`
    used.add(id)
    result.push({ ...finding, id })
  }
  return result
}

/** Normalize a path reported by a child agent; reject paths outside the root. */
export function normalizeFindingPath(root, file) {
  if (typeof file !== 'string' || !file.trim()) return { file: '' }
  const value = file.trim().replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(value) || value.startsWith('/')) {
    const absolute = resolve(value)
    const relative = relativePosix(root, absolute)
    if (relative.startsWith('../') || relative === '..') {
      return { file: '', warning: `忽略工作区外的文件路径：${file}` }
    }
    return { file: relative }
  }
  return { file: value.replace(/^\.\//, '') }
}

function normalizeFileList(root, files, fallback) {
  const source = Array.isArray(files) ? files : []
  const result = []
  for (const item of source) {
    const normalized = normalizeFindingPath(root, item)
    if (normalized.file && !result.includes(normalized.file)) result.push(normalized.file)
  }
  if (result.length === 0 && fallback) result.push(fallback)
  return result
}

function normalizeFix({ root, raw, file, warnings, label }) {
  const source = isPlainObject(raw.fix)
    ? raw.fix
    : typeof raw.recommendation === 'string'
      ? { summary: raw.recommendation }
      : undefined
  if (!source) {
    warnings.push(`${label}: 缺少 fix 对象，无法进入修复流程`)
    return { summary: '', steps: [], files: file ? [file] : [], tests: [] }
  }
  const steps = Array.isArray(source.steps)
    ? source.steps.map((step) => oneLine(step, 400)).filter(Boolean)
    : []
  if (steps.length < 3) {
    warnings.push(`${label}: fix.steps 少于 3 步，报告可读性可能不足`)
  }
  return {
    summary: toText(source.summary ?? source.description ?? '', 800),
    steps: steps.slice(0, 8),
    files: normalizeFileList(root, source.files, file),
    tests: Array.isArray(source.tests)
      ? source.tests.map((test) => oneLine(test, 400)).filter(Boolean).slice(0, 8)
      : [],
  }
}

/**
 * Normalize one raw finding from a handoff. Returns undefined only when there
 * is no usable title; every other problem is recorded as a warning so the
 * report shows what was repaired rather than silently dropping evidence.
 */
export function normalizeFinding({ root, expert, raw, index, warnings }) {
  if (!isPlainObject(raw)) {
    warnings.push(`${expert}: 第 ${index + 1} 条发现不是对象，已跳过`)
    return undefined
  }
  const info = EXPERT_BY_KEY[expert]
  if (!info) return undefined
  const title = oneLine(raw.title ?? raw.message ?? '', 180)
  if (!title) {
    warnings.push(`${expert}: 第 ${index + 1} 条发现缺少 title，已跳过`)
    return undefined
  }

  let severity = normalizeSeverity(raw.severity)
  if (!severity) {
    severity = 'medium'
    warnings.push(`${expert}: "${title}" 的 severity 无效，按 medium 处理`)
  }
  let confidence = normalizeConfidence(raw.confidence) ?? 'medium'
  const evidence = toText(raw.evidence ?? raw.proof ?? raw.reason, 2000)
  if ((severity === 'critical' || severity === 'high') && !evidence) {
    confidence = 'low'
    warnings.push(`${expert}: "${title}" 是 ${severity} 但缺少证据，已降为低置信度`)
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
  if (normalizedPath.warning) warnings.push(`${expert}: ${normalizedPath.warning}`)
  file = normalizedPath.file
  const line = Number.isInteger(lineValue) && lineValue > 0 ? lineValue : file ? 1 : 0

  const sectionRaw = String(raw.section ?? '').trim()
  const section = info.sections.includes(sectionRaw)
    ? sectionRaw
    : info.sections[0]
  if (sectionRaw && section !== sectionRaw) {
    warnings.push(`${expert}: "${title}" 的 section="${sectionRaw}" 不属于该模块，已归入 ${section}`)
  }
  const category = oneLine(raw.category ?? section, 80).toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || section
  const fix = normalizeFix({ root, raw, file, warnings, label: `${expert}: "${title}"` })
  const explicitKind = String(raw.kind ?? '').toLowerCase()
  let kind = explicitKind === 'direct' ? 'direct' : 'plan'
  if (kind === 'direct' && (!file || fix.steps.length === 0 || fix.files.length === 0)) {
    kind = 'plan'
    warnings.push(`${expert}: "${title}" 标为 direct 但缺少文件或修复步骤，已改为 plan`)
  }

  const finding = {
    expert,
    expertTitle: info.title,
    section,
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
    kind,
    fix,
    isNew: false,
    fingerprint: '',
    id: '',
  }
  finding.fingerprint = fingerprint(finding)
  return finding
}

function dedupeKey(finding) {
  return [
    finding.category,
    String(finding.file ?? '').replace(/^\.\//, ''),
    normalizeTitle(finding.title),
  ].join('|')
}

/**
 * Merge the same defect reported by multiple experts. The dedupe key deliberately
 * excludes the expert: two experts describing the same root cause should become one
 * report entry, with the highest-priority owner as the primary. Keep the worst
 * severity, prefer the higher-confidence description, and retain who else saw it.
 */
export function dedupeFindings(findings) {
  const groups = new Map()
  for (const finding of findings) {
    const key = dedupeKey(finding)
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { ...finding, experts: [finding.expert] })
      continue
    }
    const experts = [...new Set([...existing.experts, finding.expert])]
    const severity = SEVERITIES[finding.severity].rank < SEVERITIES[existing.severity].rank
    const sameSeverity = finding.severity === existing.severity
    const betterConfidence = sameSeverity
      && (CONFIDENCE_RANK[finding.confidence] ?? 9) < (CONFIDENCE_RANK[existing.confidence] ?? 9)
    if (severity || betterConfidence) {
      groups.set(key, { ...finding, experts })
    } else {
      existing.experts = experts
    }
  }
  return [...groups.values()].map((finding) => ({ ...finding, fingerprint: fingerprint(finding) }))
}

export function compareFindings(a, b) {
  const severity = SEVERITIES[a.severity].rank - SEVERITIES[b.severity].rank
  if (severity !== 0) return severity
  const expert = (EXPERT_PRIORITY[a.expert] ?? 9) - (EXPERT_PRIORITY[b.expert] ?? 9)
  if (expert !== 0) return expert
  return String(a.file ?? '').localeCompare(String(b.file ?? ''))
    || Number(a.line ?? 0) - Number(b.line ?? 0)
    || String(a.title).localeCompare(String(b.title))
}

export function countSeverities(findings) {
  const counts = Object.fromEntries(SEVERITY_ORDER.map((severity) => [severity, 0]))
  for (const finding of findings) {
    if (counts[finding.severity] !== undefined) counts[finding.severity] += 1
  }
  return counts
}

/** Deterministic module name. Child agents never choose this. */
export function moduleOf(file, config = {}) {
  const path = toPosix(file ?? '').replace(/^\.\//, '')
  if (!path) return '(repo)'
  const explicit = config.modules && typeof config.modules === 'object' ? config.modules : {}
  if (typeof explicit[path] === 'string') return explicit[path]
  const parts = path.split('/')
  if (parts[0] === 'packages' && parts[1]) return `packages/${parts[1]}`
  if (parts[0] === 'apps' && parts[1]) return `apps/${parts[1]}`
  if (DEPENDENCY_FILES.has(parts[parts.length - 1])) return 'dependencies'
  let rest = parts
  if (['src', 'lib', 'app', 'apps'].includes(parts[0])) rest = parts.slice(1)
  if (rest.length <= 1) return parts.length > 1 ? parts[0] : '(root)'
  const first = rest[0]
  return typeof explicit[first] === 'string' ? explicit[first] : first
}

export function groupByModule(findings, config = {}) {
  const groups = new Map()
  for (const finding of findings) {
    const module = finding.module ?? moduleOf(finding.file, config)
    if (!groups.has(module)) {
      groups.set(module, { module, findings: [], experts: new Set(), counts: {} })
    }
    const group = groups.get(module)
    group.findings.push(finding)
    group.experts.add(finding.expert)
  }
  return [...groups.values()]
    .map((group) => {
      group.findings.sort(compareFindings)
      group.experts = [...group.experts].sort(
        (a, b) => (EXPERT_PRIORITY[a] ?? 9) - (EXPERT_PRIORITY[b] ?? 9),
      )
      group.counts = countSeverities(group.findings)
      group.worst = group.findings[0]?.severity
      return group
    })
    .sort((a, b) => {
      const severity = (SEVERITIES[a.worst]?.rank ?? 9) - (SEVERITIES[b.worst]?.rank ?? 9)
      if (severity !== 0) return severity
      const count = b.findings.length - a.findings.length
      if (count !== 0) return count
      return a.module.localeCompare(b.module)
    })
}

export function findingRef(finding) {
  return {
    id: finding.id,
    expert: finding.expert,
    section: finding.section,
    severity: finding.severity,
    confidence: finding.confidence,
    title: finding.title,
    file: finding.file,
    line: finding.line,
    kind: finding.kind,
  }
}


