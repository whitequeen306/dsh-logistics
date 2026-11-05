import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { publishLatest, shouldPublishLatest } from '../lib/latest.js'
import { cleanup, initRepo, makeProjectScope, write } from './helpers.js'

test('publishes latest only for a complete default /logi run', () => {
  const root = initRepo()
  try {
    const { scope } = makeProjectScope(root, ['correctness', 'security', 'reliability', 'maintainability'])
    write(scope.output.runDir, 'report.md', '# Final report\n\ncoverage complete\n')
    assert.equal(shouldPublishLatest(scope), true)

    const result = publishLatest(scope)
    assert.ok(result)
    assert.equal(readFileSync(scope.output.latestMarkdown, 'utf8'), '# Final report\n\ncoverage complete\n')
    const pointer = JSON.parse(readFileSync(scope.output.latestJson, 'utf8'))
    assert.equal(pointer.runId, scope.runId)
    assert.equal(pointer.marker, 'final-validated-report')
    assert.equal(pointer.coverageComplete, true)
    assert.equal(pointer.reportPath, scope.output.reportMarkdown)
    assert.equal(pointer.markdownPath, scope.output.latestMarkdown)
  } finally {
    cleanup(root)
  }
})

test('does not publish single-expert or non-default runs', () => {
  const root = initRepo()
  try {
    const single = makeProjectScope(root, ['security']).scope
    write(single.output.runDir, 'report.md', '# single\n')
    assert.equal(shouldPublishLatest(single), false)
    assert.equal(publishLatest(single), undefined)

    const partial = makeProjectScope(root, ['correctness', 'security']).scope
    write(partial.output.runDir, 'report.md', '# partial\n')
    assert.equal(publishLatest(partial), undefined)
  } finally {
    cleanup(root)
  }
})

test('fails closed when the final report is missing', () => {
  const root = initRepo()
  try {
    const { scope } = makeProjectScope(root, ['correctness', 'security', 'reliability', 'maintainability'])
    assert.throws(() => publishLatest(scope), /缺少最终 report\.md/u)
  } finally {
    cleanup(root)
  }
})
