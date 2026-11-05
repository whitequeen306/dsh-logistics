import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_EXPERTS } from '../lib/constants.js'
import { shouldPublishLatest } from '../lib/latest.js'
import {
  estimateEta,
  expertFinished,
  expertStarted,
  findRunWithScope,
  initialProgress,
  markCancelled,
  markCompleted,
  readProgress,
  renderProgress,
  requestCancel,
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
    for (const expert of DEFAULT_EXPERTS.slice(0, 4)) {
      progress = expertFinished(scope, expert, { findings: 2 })
    }
    assert.equal(progress.waves.done, 1)
    assert.equal(progress.phase, 'experts')

    progress = waveDispatched(scope, ['perf'])
    progress = expertStarted(scope, 'perf', 'child-perf')
    progress = expertFinished(scope, 'perf', { findings: 3 })
    assert.equal(progress.waves.done, 2)
    assert.equal(progress.phase, 'collect')
    assert.equal(progress.findings, 11)
    assert.ok(progress.elapsedMs >= 0)

    const text = renderProgress(scope, progress)
    assert.match(text, /专家 5\/5/u)
    assert.match(text, /findings 11/u)
    assert.match(text, /预计剩余/u)
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
