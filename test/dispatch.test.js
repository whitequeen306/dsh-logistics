import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildChildPrompt,
  buildPipelineDispatch,
  buildSingleDispatch,
} from '../lib/dispatch.js'

const scope = {
  root: 'C:/tmp/project',
  isGit: true,
  git: { branch: 'main', head: 'abc123', headSubject: 'test' },
  source: 'working-tree',
  stats: { analyzedFiles: 2, additions: 3, deletions: 0, truncated: false, omittedFiles: 0 },
  summary: { languages: [{ name: 'JavaScript', count: 2 }] },
  files: [{ path: 'src/a.js', status: 'modified' }],
  notes: '',
  testCommand: { command: 'npm test' },
  experts: ['correctness', 'security'],
  output: {
    runDir: 'C:/tmp/run',
    handoffDir: 'C:/tmp/run/handoff',
  },
}

test('child prompt is self-contained and names one expert', () => {
  const prompt = buildChildPrompt({ expertKey: 'security', scope })
  assert.match(prompt, /security/)
  assert.match(prompt, /logi-security/)
  assert.match(prompt, /C:\/tmp\/run\/handoff\/security\.json/)
  assert.match(prompt, /sections/)
  assert.match(prompt, /不要调用其他 subagent/)
  assert.doesNotMatch(prompt, /provider/)
})

test('single dispatch embeds the exact child prompt once', () => {
  const text = buildSingleDispatch({
    command: '/logi-correctness',
    expertKey: 'correctness',
    scope: { ...scope, experts: ['correctness'] },
    pluginRoot: 'C:/plugin',
  })
  assert.equal((text.match(/\n```text/gu) ?? []).length, 0)
  assert.equal((text.match(/\n````text/gu) ?? []).length, 1)
  assert.match(text, /"expert":"correctness"/)
  assert.doesNotMatch(text, /"pass":"correctness"/)
  assert.doesNotMatch(text, /Child task template/)
})

test('pipeline dispatch embeds one prompt per expert', () => {
  const text = buildPipelineDispatch({
    command: '/logi',
    scope,
    pluginRoot: 'C:/plugin',
  })
  assert.match(text, /### correctness/)
  assert.match(text, /### security/)
  assert.match(text, /```json/u)
  assert.match(text, /最多同时发 4 个 subagent/)
  assert.doesNotMatch(text, /provider"s*:/)
})
