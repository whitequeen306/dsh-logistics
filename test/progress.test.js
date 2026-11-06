import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_EXPERTS } from '../lib/constants.js'
import { shouldPublishLatest } from '../lib/latest.js'
import {
  STALE_AFTER_MS,
  estimateEta,
  expertFinished,
  expertStarted,
  findRunWithScope,
  initialProgress,
  isStaleProgress,
  markCancelled,
  markCompleted,
  markStale,
  progressPath,
  readChildren,
  readProgress,
  renderProgress,
  requestCancel,
  setPhase,
  startProgress,
  waveDispatched,
} from '../lib/progress.js'
import { readRunLog } from '../lib/runlog.js'
import { cleanup, initRepo, makeProjectScope } from './helpers.js'

test('progress starts with every default expert queued and a range ETA', () => {
  const root = initRepo()
  try {
    const { scope } = makeProjectScope(root, DEFAULT_EXPERTS)
    const progress = startProgress(scope)
    assert.equal(progress.status, 'running')
    assert.equal(progress.phase, 'dispatch')
    assert.deepEqual(Object.keys(progress.experts), DEFAULT_EXPERTS)
    assert.equal(progress.experts.perf.status, 'queued')
    assert.equal(progress.waves.total, 2)
    assert.ok(progress.eta.lowMinutes >= 3)
    assert.ok(progress.eta.highMinutes > progress.eta.lowMinutes)
    assert.equal(progress.eta.basis, 'static')

    const persisted = readProgress(scope.output.runDir)
    assert.equal(persisted.runId, scope.runId)
    assert.deepEqual(
      readRunLog(scope.output.runDir).map((entry) => entry.event),
      ['run.started'],
    )
  } finally {
    cleanup(root)
  }
})

test('wave and expert events update completion and findings', () => {
  const root = initRepo()
  try {
    const { scope } = makeProjectScope(root, DEFAULT_EXPERTS)
    startProgress(scope)

    let progress = waveDispatched(scope, DEFAULT_EXPERTS.slice(0, 4))
    for (const expert of DEFAULT_EXPERTS.slice(0, 4)) {
      progress = expertStarted(scope, expert, `child-${expert}`)
    }
    assert.equal(readChildren(scope.output.runDir).runId, scope.runId)
    for (const expert of DEFAULT_EXPERTS.slice(0, 4)) {
      progress = expertFinished(scope, expert, { findings: 2 })
    }
    assert.equal(progress.waves.done, 1)
    assert.equal(progress.phase, 'experts')

    progress = expertStarted(scope, 'perf', 'child-perf')
    assert.equal(progress.waves.dispatched, 2)
    progress = expertFinished(scope, 'perf', { findings: 3 })
    assert.equal(progress.waves.done, 2)
    assert.equal(progress.phase, 'collect')
    assert.equal(progress.findings, 11)
    assert.ok(progress.elapsedMs >= 0)

    const text = renderProgress(scope, progress)
    assert.match(text, /专家 5\/5/u)
    assert.match(text, /findings 11/u)
    assert.doesNotMatch(text, /预计剩余/u)
    const completed = markCompleted(scope)
    assert.equal(completed.units.covered, completed.units.total)
    assert.equal(completed.eta.lowMinutes, 0)
    assert.equal(completed.phase, 'done')
    assert.equal(setPhase(scope, 'verdict').phase, 'done')
    assert.doesNotMatch(renderProgress(scope, completed), /预计剩余/u)
    assert.doesNotMatch(
      renderProgress(scope, { ...completed, eta: { lowMinutes: 2, highMinutes: 4, basis: 'wave' } }),
      /预计剩余/u,
    )
    assert.equal(findRunWithScope(root)?.scope.runId, scope.runId)
  } finally {
    cleanup(root)
  }
})

test('cancellation blocks next progress and latest publication', () => {
  const root = initRepo()
  try {
    const { scope } = makeProjectScope(root, DEFAULT_EXPERTS)
    startProgress(scope)
    const cancelled = requestCancel(scope, 'test')
    assert.equal(cancelled.status, 'cancelling')
    assert.equal(cancelled.cancelRequested, true)
    assert.match(renderProgress(scope, cancelled), /已请求取消/u)
    assert.equal(shouldPublishLatest(scope), false)

    const done = markCancelled(scope, 'test')
    assert.equal(done.status, 'cancelled')
    assert.equal(markCompleted(scope).status, 'cancelled')
  } finally {
    cleanup(root)
  }
})

test('eta has a wave basis after the first wave', () => {
  const root = initRepo()
  try {
    const { scope } = makeProjectScope(root, DEFAULT_EXPERTS)
    startProgress(scope)
    const progress = waveDispatched(scope, DEFAULT_EXPERTS.slice(0, 4))
    const eta = estimateEta(scope, progress)
    assert.equal(eta.basis, 'static')
    assert.ok(eta.lowMinutes >= 3)
    assert.equal(initialProgress(scope).units.total, scope.project.units.length)
  } finally {
    cleanup(root)
  }
})

test('stale running progress is not active and is marked failed', () => {
  const root = initRepo()
  try {
    const { scope } = makeProjectScope(root, DEFAULT_EXPERTS)
    startProgress(scope)
    const file = progressPath(scope.output.runDir)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.updatedAt = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString()
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`)
    assert.equal(findRunWithScope(root, { activeOnly: true }), null)
    const stale = readProgress(scope.output.runDir)
    assert.equal(isStaleProgress(stale), true)
    const marked = markStale(scope, stale)
    assert.equal(marked.status, 'failed')
    assert.equal(marked.phase, 'stale')
    assert.match(marked.error, /过期/u)
  } finally {
    cleanup(root)
  }
})
