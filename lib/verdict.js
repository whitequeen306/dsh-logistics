import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  EXPERT_BY_KEY,
  SEVERITIES,
  VERDICT_SCHEMA_VERSION,
} from './constants.js'
import { normalizeFindingPath } from './findings.js'
import { isDirectory, isFile, readJsonFile, toPosix } from './util.js'

const ID_RE = /^(COR|SEC|REL|MNT|PRF)-[A-F0-9]{5,8}$/u
const CONFIDENCE = new Set(['high', 'medium', 'low'])
const KINDS = new Set(['direct', 'plan'])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function validateFinding(finding, index, root, errors) {
  const label = `findings[${index}]`
  if (!isObject(finding)) {
    errors.push(`${label} 必须是对象`)
    return
  }
  const id = asString(finding.id).toUpperCase()
  if (!ID_RE.test(id)) errors.push(`${label}.id 非法（应形如 COR-4F2A1）：${finding.id ?? '?'}`)
  else finding.id = id

  if (!EXPERT_BY_KEY[finding.expert]) errors.push(`${label}.expert 非法：${finding.expert ?? '?'}`)
  else {
    const info = EXPERT_BY_KEY[finding.expert]
    if (!info.sections.includes(finding.section)) {
      errors.push(`${label}.section 非法（${finding.expert} 允许 ${info.sections.join('/')}）：${finding.section ?? '?'}`)
    }
  }
  if (!SEVERITIES[finding.severity]) errors.push(`${label}.severity 非法：${finding.severity ?? '?'}`)
  if (!CONFIDENCE.has(finding.confidence)) errors.push(`${label}.confidence 非法：${finding.confidence ?? '?'}`)
  if (!KINDS.has(finding.kind)) errors.push(`${label}.kind 非法：${finding.kind ?? '?'}`)
  if (!asString(finding.title)) errors.push(`${label}.title 不能为空`)
  if (!asString(finding.module)) errors.push(`${label}.module 不能为空`)
  if (!Number.isInteger(finding.line) || finding.line < 1) errors.push(`${label}.line 必须是正整数`)

  const file = asString(finding.file)
  if (!file) {
    errors.push(`${label}.file 不能为空`)
  } else {
    const normalized = normalizeFindingPath(root, file)
    if (normalized.warning) errors.push(`${label}.file ${normalized.warning}`)
    else finding.file = normalized.file
  }

  if (!isObject(finding.fix)) {
    errors.push(`${label}.fix 必须是对象`)
  } else {
    if (!asString(finding.fix.summary)) errors.push(`${label}.fix.summary 不能为空`)
    if (!Array.isArray(finding.fix.steps) || finding.fix.steps.length === 0) {
      errors.push(`${label}.fix.steps 必须是非空数组`)
    }
    if (!Array.isArray(finding.fix.files) || finding.fix.files.length === 0) {
      errors.push(`${label}.fix.files 必须是非空数组`)
    } else {
      const files = []
      for (const item of finding.fix.files) {
        const normalized = normalizeFindingPath(root, item)
        if (normalized.warning) errors.push(`${label}.fix.files ${normalized.warning}`)
        else if (normalized.file && !files.includes(normalized.file)) files.push(normalized.file)
      }
      if (files.length === 0) errors.push(`${label}.fix.files 必须包含至少一个工作区内文件`)
      else finding.fix.files = files
    }
    if (!Array.isArray(finding.fix.tests)) errors.push(`${label}.fix.tests 必须是数组`)
  }

  if (finding.kind === 'plan' && finding.expert === 'perf') {
    // performance findings must stay plan-only; this is a hard rule
  } else if (finding.kind === 'direct' && finding.expert === 'perf') {
    errors.push(`${label}: 性能发现必须是 plan，不能 direct`)
  }
}

/**
 * Validate a model-authored verdict. This is a *safety* contract, not a
 * quality gate: it checks that the editor produced fixable, well-formed
 * findings and kept coverage honest. It never decides which findings to keep.
 */
export function validateVerdict({ root, scope, verdict }) {
  const errors = []
  const warnings = []
  if (!isObject(verdict)) {
    return { ok: false, errors: ['verdict 必须是 JSON 对象'], warnings, verdict: undefined, scope }
  }
  if (verdict.schemaVersion !== VERDICT_SCHEMA_VERSION) {
    errors.push(`verdict.schemaVersion 必须是 ${VERDICT_SCHEMA_VERSION}，收到 ${verdict.schemaVersion ?? '?'}`)
  }
  if (scope?.runId && verdict.runId !== scope.runId) {
    errors.push(`verdict.runId 与 scope.runId 不一致：${verdict.runId ?? '?'} / ${scope.runId}`)
  }
  if (!Array.isArray(verdict.findings)) {
    errors.push('verdict.findings 必须是数组')
    return { ok: false, errors, warnings, verdict, scope }
  }

  const seen = new Set()
  verdict.findings.forEach((finding, index) => {
    validateFinding(finding, index, root, errors)
    if (finding?.id) {
      const id = String(finding.id).toUpperCase()
      if (seen.has(id)) errors.push(`findings 出现重复 id：${id}`)
      seen.add(id)
    }
  })

  const coverage = isObject(verdict.coverage) ? verdict.coverage : {}
  const expected = Array.isArray(coverage.expected) ? coverage.expected : []
  const received = Array.isArray(coverage.received) ? coverage.received : []
  const scopeExperts = Array.isArray(scope?.experts) ? scope.experts : []
  for (const key of [...expected, ...received]) {
    if (!EXPERT_BY_KEY[key]) errors.push(`coverage 中出现未知专家：${key}`)
  }
  for (const key of scopeExperts) {
    if (!expected.includes(key)) errors.push(`coverage.expected 缺少本次运行专家：${key}`)
  }
  for (const key of expected) {
    if (!scopeExperts.includes(key)) errors.push(`coverage.expected 包含未运行专家：${key}`)
  }
  const missing = expected.filter((key) => !received.includes(key))
  if (missing.length > 0) warnings.push(`覆盖不完整：缺少 ${missing.join('、')} 的 handoff`)
  verdict.coverage = {
    ...coverage,
    expected,
    received,
    missing: Array.isArray(coverage.missing) ? coverage.missing : missing,
    complete: coverage.complete === true && missing.length === 0,
  }

  if (!Array.isArray(verdict.dropped)) verdict.dropped = []
  verdict.dropped = verdict.dropped.filter((item) => isObject(item) && asString(item.id))
  verdict.generatedAt = asString(verdict.generatedAt) || new Date().toISOString()
  verdict.editor = asString(verdict.editor) || 'main-session'
  verdict.verdictPath = toPosix(resolve(scope?.output?.runDir ?? root, 'verdict.json'))

  return { ok: errors.length === 0, errors, warnings, verdict, scope }
}

export function readVerdict(runDir, root) {
  const path = resolve(runDir, 'verdict.json')
  const verdict = readJsonFile(path, undefined)
  if (verdict === undefined) throw new Error(`找不到 verdict.json：${path}`)
  const scope = readJsonFile(resolve(runDir, 'scope.json'), undefined)
  if (scope === undefined) throw new Error(`找不到 scope.json：${runDir}`)
  return { path, verdict, scope }
}

function mtime(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Find the newest model-authored verdict under `.logistics/runs`.
 * Falls back to `.logistics/latest.json` when it points at a verdict.
 */
export function findLatestVerdict(root) {
  const runsDir = resolve(root, '.logistics', 'runs')
  const candidates = []
  if (isDirectory(runsDir)) {
    for (const entry of readdirSync(runsDir)) {
      const runDir = resolve(runsDir, entry)
      const path = resolve(runDir, 'verdict.json')
      if (isFile(path)) candidates.push({ runDir, path, mtime: mtime(path) })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  if (candidates.length > 0) return candidates[0]

  const pointer = readJsonFile(resolve(root, '.logistics', 'latest.json'), undefined)
  const verdictPath = pointer?.verdictPath ? resolve(root, pointer.verdictPath) : undefined
  if (verdictPath && isFile(verdictPath)) {
    return { runDir: resolve(verdictPath, '..'), path: verdictPath, mtime: mtime(verdictPath) }
  }
  return undefined
}

export function readLatestVerdict(root) {
  const found = findLatestVerdict(root)
  if (!found) return undefined
  const { verdict, scope } = readVerdict(found.runDir, root)
  return validateVerdict({ root, scope, verdict })
}

export function summarizeVerdict(result) {
  const lines = []
  if (!result.ok) {
    lines.push('verdict 校验失败：')
    for (const error of result.errors) lines.push(`- ${error}`)
    return lines.join('\n')
  }
  const { verdict } = result
  lines.push(`verdict: ${verdict.verdictPath}`)
  lines.push(`findings: ${verdict.findings.length}（direct ${verdict.findings.filter((f) => f.kind === 'direct').length} / plan ${verdict.findings.filter((f) => f.kind === 'plan').length}）`)
  lines.push(`coverage: ${verdict.coverage.received.length}/${verdict.coverage.expected.length}${verdict.coverage.complete ? '（完整）' : '（不完整）'}`)
  if (result.warnings.length > 0) {
    lines.push('warnings:')
    for (const warning of result.warnings) lines.push(`- ${warning}`)
  }
  return lines.join('\n')
}

export { ID_RE }
