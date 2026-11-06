import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ensureDir, isDirectory, nowIso, readJsonFile, toPosix } from './util.js'
import { appendRunLog } from './runlog.js'

export const PROGRESS_FILE = 'progress.json'
export const CHILDREN_FILE = 'children.json'

const TERMINAL = new Set(['done', 'completed', 'failed', 'cancelled'])
const WAVE_SIZE = 4
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000

export function progressPath(runDir) {
  return resolve(runDir, PROGRESS_FILE)
}

export function childrenPath(runDir) {
  return resolve(runDir, CHILDREN_FILE)
}

function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  ensureDir(resolve(file, '..'))
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return file
}

function asPositiveInt(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback
}

function elapsedMs(progress, now = Date.now()) {
  const started = Date.parse(progress.startedAt ?? '')
  return Number.isFinite(started) ? Math.max(0, now - started) : 0
}

/** Static, deliberately range-based estimate; no fake precision. */
export function estimateEta(scope, progress = {}) {
  const experts = Array.isArray(scope.experts) ? scope.experts.length : 0
  const units = Array.isArray(scope.project?.units) ? scope.project.units.length : 0
  const files = asPositiveInt(scope.stats?.analyzedFiles)
  const elapsedMinutes = elapsedMs(progress) / 60000
  const wavesDone = asPositiveInt(progress.waves?.done)
  const totalWaves = Math.max(1, Math.ceil(experts / WAVE_SIZE))

  if (TERMINAL.has(progress.status)) return { lowMinutes: 0, highMinutes: 0, basis: 'done' }
  if (wavesDone >= totalWaves && wavesDone > 0) return { lowMinutes: 0, highMinutes: 0, basis: 'done' }

  if (wavesDone > 0 && elapsedMinutes > 0) {
    const perWave = elapsedMinutes / wavesDone
    const remainingWaves = Math.max(0, totalWaves - wavesDone)
    if (remainingWaves === 0) return { lowMinutes: 0, highMinutes: 0, basis: 'done' }
    const low = Math.max(2, Math.ceil(perWave * remainingWaves * 0.8))
    const high = Math.max(low + 2, Math.ceil(perWave * remainingWaves * 1.4))
    return { lowMinutes: low, highMinutes: high, basis: 'wave' }
  }

  const low = Math.max(3, Math.ceil(4 + experts * 3 + units * 0.35 + files / 2500))
  const high = Math.max(low + 4, Math.ceil(low * 1.5))
  return { lowMinutes: low, highMinutes: high, basis: 'static' }
}

function recompute(scope, progress) {
  const experts = Array.isArray(scope.experts) ? scope.experts : []
  const buckets = []
  for (let index = 0; index < experts.length; index += WAVE_SIZE) {
    buckets.push(experts.slice(index, index + WAVE_SIZE))
  }
  const startedWaves = buckets.filter((bucket) =>
    bucket.some((key) => progress.experts[key]?.status !== 'queued'),
  ).length
  progress.waves = {
    total: buckets.length,
    dispatched: Math.max(asPositiveInt(progress.waves?.dispatched), startedWaves),
    done: buckets.filter((bucket) => bucket.every((key) => TERMINAL.has(progress.experts[key]?.status))).length,
  }
  progress.findings = Object.values(progress.experts).reduce(
    (sum, item) => sum + asPositiveInt(item?.findings),
    0,
  )
  progress.elapsedMs = elapsedMs(progress)
  progress.eta = estimateEta(scope, progress)
  return progress
}

export function initialProgress(scope) {
  const now = nowIso()
  const experts = Object.fromEntries(
    (scope.experts ?? []).map((key) => [
      key,
      { status: 'queued', findings: 0, childId: null, startedAt: null, finishedAt: null },
    ]),
  )
  const progress = {
    schemaVersion: 1,
    runId: scope.runId,
    status: 'running',
    phase: 'dispatch',
    startedAt: scope.createdAt ?? now,
    updatedAt: now,
    elapsedMs: 0,
    experts,
    waves: { total: 0, dispatched: 0, done: 0 },
    units: {
      total: Array.isArray(scope.project?.units) ? scope.project.units.length : 0,
      covered: 0,
    },
    findings: 0,
    eta: { lowMinutes: 0, highMinutes: 0, basis: 'static' },
    cancelRequested: false,
  }
  return recompute(scope, progress)
}

export function writeProgress(runDir, progress) {
  progress.updatedAt = nowIso()
  progress.elapsedMs = elapsedMs(progress)
  return writeJson(progressPath(runDir), progress)
}

export function readProgress(runDir) {
  return readJson(progressPath(runDir), null)
}

export function startProgress(scope) {
  const progress = initialProgress(scope)
  writeProgress(scope.output.runDir, progress)
  appendRunLog(scope.output.runDir, 'run.started', {
    runId: scope.runId,
    experts: scope.experts,
    units: progress.units.total,
    eta: progress.eta,
  })
  return progress
}

export function setPhase(scope, phase) {
  const progress = readProgress(scope.output.runDir) ?? initialProgress(scope)
  // A late contract re-check must not drag a finished run back to "verdict".
  if (TERMINAL.has(progress.status)) return progress
  progress.phase = String(phase || 'experts')
  if (!TERMINAL.has(progress.status) && progress.status !== 'cancelling') progress.status = 'running'
  recompute(scope, progress)
  writeProgress(scope.output.runDir, progress)
  appendRunLog(scope.output.runDir, 'progress.phase', { phase: progress.phase })
  return progress
}

export function waveDispatched(scope, experts = []) {
  const progress = readProgress(scope.output.runDir) ?? initialProgress(scope)
  progress.waves.dispatched = asPositiveInt(progress.waves?.dispatched) + 1
  for (const expert of experts) {
    if (progress.experts[expert] && progress.experts[expert].status === 'queued') {
      progress.experts[expert].status = 'dispatched'
    }
  }
  if (!TERMINAL.has(progress.status) && progress.status !== 'cancelling') progress.status = 'running'
  progress.phase = 'experts'
  recompute(scope, progress)
  writeProgress(scope.output.runDir, progress)
  appendRunLog(scope.output.runDir, 'wave.dispatched', { experts })
  return progress
}

export function expertStarted(scope, expert, childId = null) {
  const progress = readProgress(scope.output.runDir) ?? initialProgress(scope)
  if (!progress.experts[expert]) throw new Error(`未知专家：${expert}`)
  progress.experts[expert].status = 'running'
  progress.experts[expert].startedAt = progress.experts[expert].startedAt ?? nowIso()
  if (childId) {
    progress.experts[expert].childId = String(childId)
    setChild(scope.output.runDir, expert, childId, scope.runId)
  }
  progress.phase = 'experts'
  recompute(scope, progress)
  writeProgress(scope.output.runDir, progress)
  appendRunLog(scope.output.runDir, 'expert.started', { expert, childId: childId ?? null })
  return progress
}

export function expertFinished(scope, expert, { findings = 0, status = 'done' } = {}) {
  const progress = readProgress(scope.output.runDir) ?? initialProgress(scope)
  if (!progress.experts[expert]) throw new Error(`未知专家：${expert}`)
  progress.experts[expert].status = status === 'failed' ? 'failed' : 'done'
  progress.experts[expert].findings = asPositiveInt(findings)
  progress.experts[expert].finishedAt = nowIso()
  recompute(scope, progress)
  if (Object.values(progress.experts).every((item) => TERMINAL.has(item.status))) {
    progress.phase = 'collect'
  }
  writeProgress(scope.output.runDir, progress)
  appendRunLog(scope.output.runDir, 'expert.finished', {
    expert,
    findings: progress.experts[expert].findings,
    status: progress.experts[expert].status,
  })
  return progress
}

export function requestCancel(scope, reason = 'user') {
  const progress = readProgress(scope.output.runDir) ?? initialProgress(scope)
  progress.cancelRequested = true
  progress.status = 'cancelling'
  progress.cancelReason = String(reason || 'user')
  recompute(scope, progress)
  writeProgress(scope.output.runDir, progress)
  appendRunLog(scope.output.runDir, 'run.cancel.requested', { reason: progress.cancelReason })
  return progress
}

export function markCompleted(scope) {
  const progress = readProgress(scope.output.runDir) ?? initialProgress(scope)
  if (progress.status === 'cancelling' || progress.cancelRequested) return progress
  progress.status = 'completed'
  progress.phase = 'done'
  progress.units.covered = progress.units.total
  recompute(scope, progress)
  writeProgress(scope.output.runDir, progress)
  appendRunLog(scope.output.runDir, 'run.completed', { elapsedMs: progress.elapsedMs })
  return progress
}

export function isStaleProgress(progress, now = Date.now()) {
  if (!progress || !['running', 'cancelling'].includes(progress.status)) return false
  const updated = Date.parse(progress.updatedAt ?? progress.startedAt ?? '')
  return Number.isFinite(updated) && now - updated > STALE_AFTER_MS
}

export function markStale(scope, progress) {
  progress.status = 'failed'
  progress.phase = 'stale'
  progress.error = '超过 2 小时没有进度更新；已标记为过期运行'
  progress.eta = { lowMinutes: 0, highMinutes: 0, basis: 'done' }
  recompute(scope, progress)
  writeProgress(scope.output.runDir, progress)
  appendRunLog(scope.output.runDir, 'run.stale', { error: progress.error })
  return progress
}

export function markCancelled(scope, reason = 'user') {
  const progress = readProgress(scope.output.runDir) ?? initialProgress(scope)
  progress.status = 'cancelled'
  progress.cancelRequested = true
  progress.cancelReason = String(reason || 'user')
  recompute(scope, progress)
  writeProgress(scope.output.runDir, progress)
  appendRunLog(scope.output.runDir, 'run.cancelled', { reason: progress.cancelReason })
  return progress
}

export function markFailed(scope, error) {
  const progress = readProgress(scope.output.runDir) ?? initialProgress(scope)
  progress.status = 'failed'
  progress.error = String(error ?? 'unknown')
  recompute(scope, progress)
  writeProgress(scope.output.runDir, progress)
  appendRunLog(scope.output.runDir, 'run.failed', { error: progress.error })
  return progress
}

export function readChildren(runDir) {
  return readJson(childrenPath(runDir), { runId: null, children: {} })
}

export function setChild(runDir, expert, childId, runId = null) {
  const children = readChildren(runDir)
  if (runId) children.runId = String(runId)
  children.children[expert] = String(childId)
  writeJson(childrenPath(runDir), children)
  return children
}

export function listRuns(root) {
  const runsDir = resolve(root, '.logistics', 'runs')
  if (!isDirectory(runsDir)) return []
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runsDir, entry.name))
    .sort((left, right) => right.localeCompare(left))
}

export function findRun(root, { activeOnly = false } = {}) {
  for (const runDir of listRuns(root)) {
    const progress = readProgress(runDir)
    if (!progress) continue
    if (activeOnly && (!['running', 'cancelling'].includes(progress.status) || isStaleProgress(progress))) continue
    return { runDir, progress }
  }
  return null
}

export function findRunWithScope(root, options = {}) {
  for (const runDir of listRuns(root)) {
    const progress = readProgress(runDir)
    if (!progress) continue
    if (options.activeOnly && (!['running', 'cancelling'].includes(progress.status) || isStaleProgress(progress))) continue
    const scopePath = join(runDir, 'scope.json')
    if (!existsSync(scopePath)) continue
    const scope = readJson(scopePath, null)
    if (!scope) continue
    return { runDir, progress, scope }
  }
  return null
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function statusLabel(status) {
  if (status === 'done' || status === 'completed') return '✓'
  if (status === 'running') return '…'
  if (status === 'failed') return '✗'
  if (status === 'cancelled') return '−'
  if (status === 'dispatched') return '→'
  return '·'
}

export function renderProgress(scope, progress) {
  const elapsed = progress.elapsedMs ?? elapsedMs(progress)
  const terminal = ['completed', 'cancelled', 'failed'].includes(progress.status)
  const eta = terminal ? { lowMinutes: 0, highMinutes: 0, basis: 'done' } : progress.eta ?? estimateEta(scope, progress)
  const experts = Object.entries(progress.experts ?? {})
  const done = experts.filter(([, item]) => TERMINAL.has(item.status)).length
  const current = experts.filter(([, item]) => ['running', 'dispatched'].includes(item.status))
  const lines = [
    `run ${progress.runId ?? scope.runId} · ${progress.status} ${formatDuration(elapsed)}`,
    `专家 ${done}/${experts.length}：${experts.map(([key, item]) => `${statusLabel(item.status)}${key}`).join(' ')}`,
    `单元 ${progress.units?.total ?? scope.project?.units?.length ?? 0} 个 · 波次 ${progress.waves?.done ?? 0}/${progress.waves?.total ?? Math.ceil((scope.experts?.length ?? 0) / WAVE_SIZE)} · findings ${progress.findings ?? 0}`,
    `阶段：${progress.phase ?? 'dispatch'}${current.length > 0 ? ` · 当前：${current.map(([key]) => key).join('、')}` : ''}`,
  ]
  if (eta.lowMinutes > 0) lines.push(`预计剩余：${eta.lowMinutes}–${eta.highMinutes} 分钟`)
  if (progress.cancelRequested || progress.status === 'cancelling') {
    lines.push('已请求取消：不再派发下一波；正在运行的子代理可能需要等待完成或由 DSH 停止。')
  } else if (progress.status === 'running') {
    lines.push('取消：/logi-cancel')
  }
  return lines.join('\n')
}

export { formatDuration, statusLabel }
