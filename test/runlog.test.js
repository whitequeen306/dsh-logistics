import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { appendRunLog, readRunLog, RUN_LOG_FILE, writeRunText } from '../lib/runlog.js'
import { cleanup, tempDir } from './helpers.js'

test('appendRunLog writes one JSON object per line with timestamp and event', () => {
  const root = tempDir('logi-runlog-')
  try {
    appendRunLog(root, 'scope.created', { runId: 'r1', experts: ['security'] })
    appendRunLog(root, 'collect.completed', { complete: true })
    const lines = readFileSync(join(root, RUN_LOG_FILE), 'utf8').trim().split(/\r?\n/u)
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0])
    assert.equal(first.event, 'scope.created')
    assert.equal(first.runId, 'r1')
    assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/u)
    assert.deepEqual(readRunLog(root).map((entry) => entry.event), ['scope.created', 'collect.completed'])
  } finally {
    cleanup(root)
  }
})

test('readRunLog tolerates malformed lines and writeRunText creates nested artifacts', () => {
  const root = tempDir('logi-runlog-')
  try {
    appendRunLog(root, 'ok', {})
    const path = join(root, RUN_LOG_FILE)
    const content = readFileSync(path, 'utf8')
    writeFileSync(path, `${content}{not json}\n`, 'utf8')
    const entries = readRunLog(root)
    assert.equal(entries.length, 2)
    assert.equal(entries[1].event, 'log.malformed')
    writeRunText(root, 'prompts/security.md', '# prompt\n')
    assert.equal(readFileSync(join(root, 'prompts', 'security.md'), 'utf8'), '# prompt\n')
  } finally {
    cleanup(root)
  }
})
