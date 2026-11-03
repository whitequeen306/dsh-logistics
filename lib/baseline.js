import { resolve } from 'node:path'
import { SEVERITIES, SEVERITY_ORDER } from './constants.js'
import {
  isFile,
  nowIso,
  readJsonFile,
  relativePosix,
  sha1,
  toPosix,
  writeJsonFile,
} from './util.js'

export const BASELINE_SCHEMA_VERSION = 1
export const BASELINE_RELATIVE_PATH = '.logistics/baseline.json'

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
 * finding; including them would make old debt look brand new on every rebase.
 */
export function fingerprint(finding) {
  return sha1([
    finding.pass,
    finding.category,
    String(finding.file ?? '').replace(/^\.\//, ''),
    finding.ruleId ?? '',
    normalizeTitle(finding.title),
  ].join('|'))
}

export function baselinePath(root) {
  return resolve(root, BASELINE_RELATIVE_PATH)
}

export function loadBaseline(root) {
  const path = baselinePath(root)
  if (!isFile(path)) return { exists: false, path, baseline: undefined }
  const baseline = readJsonFile(path, undefined)
  if (!baseline || typeof baseline !== 'object' || !Array.isArray(baseline.entries)) {
    return { exists: false, path, baseline: undefined, warning: '基线文件格式无效，已忽略' }
  }
  return { exists: true, path, baseline }
}

function countBySeverity(findings) {
  const counts = Object.fromEntries(SEVERITY_ORDER.map((severity) => [severity, 0]))
  for (const finding of findings) {
    if (counts[finding.severity] !== undefined) counts[finding.severity] += 1
  }
  return counts
}

/**
 * Compare current findings against the accepted baseline. Only passes that are
 * part of this run can produce "fixed" entries; a single-pass run must never
 * mark the other six passes' debt as fixed.
 */
export function compareToBaseline({ root, findings, passes, score, complete }) {
  const loaded = loadBaseline(root)
  const analyzed = new Set(passes)
  const warnings = loaded.warning ? [loaded.warning] : []
  const currentByFingerprint = new Map()
  for (const finding of findings) {
    const existing = currentByFingerprint.get(finding.fingerprint)
    if (!existing || SEVERITIES[finding.severity].rank < SEVERITIES[existing.severity].rank) {
      currentByFingerprint.set(finding.fingerprint, finding)
    }
  }

  const baselineEntries = loaded.exists ? loaded.baseline.entries : []
  const baselineByFingerprint = new Map(
    baselineEntries.filter((entry) => entry && typeof entry.fingerprint === 'string')
      .map((entry) => [entry.fingerprint, entry]),
  )

  const newFindings = []
  const existingFindings = []
  for (const finding of currentByFingerprint.values()) {
    if (baselineByFingerprint.has(finding.fingerprint)) {
      finding.isNew = false
      existingFindings.push(finding)
    } else {
      finding.isNew = true
      newFindings.push(finding)
    }
  }

  const fixedEntries = loaded.exists
    ? baselineEntries.filter((entry) =>
      analyzed.has(entry.pass) && !currentByFingerprint.has(entry.fingerprint))
    : []

  const baselineScore = loaded.exists && Number.isFinite(loaded.baseline.score)
    ? loaded.baseline.score
    : undefined
  const baselineComplete = loaded.exists && loaded.baseline.coverage?.complete !== false
  const scoreDrop = baselineComplete && complete && baselineScore !== undefined
    ? Math.max(0, baselineScore - score)
    : 0

  return {
    hasBaseline: loaded.exists,
    path: toPosix(loaded.path),
    acceptedAt: loaded.exists ? loaded.baseline.updatedAt ?? loaded.baseline.createdAt : undefined,
    baselineScore,
    baselineComplete,
    scoreDrop,
    newFindings: newFindings.sort(compareFindings),
    fixedFindings: fixedEntries.sort((a, b) =>
      (SEVERITIES[a.severity]?.rank ?? 9) - (SEVERITIES[b.severity]?.rank ?? 9)),
    existingCount: existingFindings.length,
    newCounts: countBySeverity(newFindings),
    fixedCounts: countBySeverity(fixedEntries),
    totalBaselineEntries: baselineEntries.length,
    warnings,
  }
}

function compareFindings(a, b) {
  const severity = (SEVERITIES[a.severity]?.rank ?? 9) - (SEVERITIES[b.severity]?.rank ?? 9)
  if (severity !== 0) return severity
  return String(a.file ?? '').localeCompare(String(b.file ?? ''))
}

/** Merge current findings into a fresh baseline snapshot and write it. */
export function acceptBaseline({ root, report, now = nowIso() }) {
  const path = baselinePath(root)
  const previous = loadBaseline(root)
  const previousByFingerprint = new Map(
    (previous.exists ? previous.baseline.entries : [])
      .filter((entry) => entry && entry.fingerprint)
      .map((entry) => [entry.fingerprint, entry]),
  )
  const entries = []
  for (const finding of report.findings) {
    const existing = previousByFingerprint.get(finding.fingerprint)
    entries.push({
      fingerprint: finding.fingerprint,
      pass: finding.pass,
      category: finding.category,
      severity: finding.severity,
      confidence: finding.confidence,
      title: finding.title,
      file: finding.file,
      line: finding.line,
      ruleId: finding.ruleId,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    })
  }
  entries.sort((a, b) =>
    (SEVERITIES[a.severity]?.rank ?? 9) - (SEVERITIES[b.severity]?.rank ?? 9)
    || String(a.file).localeCompare(String(b.file)))

  const baseline = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    tool: report.tool,
    version: report.version,
    createdAt: previous.exists ? previous.baseline.createdAt ?? now : now,
    updatedAt: now,
    score: report.score.value,
    coverage: {
      complete: report.coverage.complete,
      full: report.coverage.full,
      expected: report.coverage.expected,
      completed: report.coverage.completed,
      tier: report.tier,
    },
    entries,
  }
  writeJsonFile(path, baseline)
  return { path, count: entries.length, score: report.score.value, baseline }
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
