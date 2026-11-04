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
    verdictJson: 'C:/tmp/run/verdict.json',
    packetMarkdown: 'C:/tmp/run/packet.md',
    handoffsJson: 'C:/tmp/run/handoffs.json',
    reportMarkdown: 'C:/tmp/run/report.md',
    latestMarkdown: 'C:/tmp/run/latest.md',
    latestJson: 'C:/tmp/run/latest.json',
  },
  optionalExperts: ['perf'],
  models: {},
}

test('child prompt is self-contained and names one expert', () => {
  const prompt = buildChildPrompt({ expertKey: 'security', scope })
  assert.match(prompt, /security/)
  assert.match(prompt, /logi-security/)
  assert.match(prompt, /C:\/tmp\/run\/handoff\/security\.json/)
  assert.match(prompt, /sections/)
  assert.match(prompt, /关注面/)
  assert.match(prompt, /认证、授权\/租户隔离/)
  assert.match(prompt, /不要调用其他 subagent/)
  assert.doesNotMatch(prompt, /provider/)
  assert.doesNotMatch(prompt, /logi-core/u)
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

test('pipeline dispatch is model-first and uses collect/bundle/verdict, not a quality gate', () => {
  const text = buildPipelineDispatch({
    command: '/logi',
    scope,
    pluginRoot: 'C:/plugin',
  })
  assert.match(text, /主编/u)
  assert.match(text, /collect\.mjs/u)
  assert.match(text, /bundle\.mjs/u)
  assert.match(text, /verdict\.mjs/u)
  assert.match(text, /packet\.md/u)
  assert.match(text, /性能未覆盖/u)
  assert.match(text, /不是质量门禁/u)
  assert.doesNotMatch(text, /status\.mjs|aggregate\.mjs/u)
})

test('single dispatch uses the editor protocol and never updates latest', () => {
  const text = buildSingleDispatch({
    command: '/logi-correctness',
    expertKey: 'correctness',
    scope: { ...scope, experts: ['correctness'] },
    pluginRoot: 'C:/plugin',
  })
  assert.match(text, /单模块/u)
  assert.match(text, /不要\*\*更新/u)
  assert.match(text, /verdict\.json/u)
  assert.doesNotMatch(text, /status\.mjs|aggregate\.mjs/u)
})

test('model routes are rendered only when configured', () => {
  const withRoute = buildPipelineDispatch({
    command: '/logi',
    scope: { ...scope, models: { security: { provider: 'wb', model: 'glm-5.3' } } },
    pluginRoot: 'C:/plugin',
  })
  assert.match(withRoute, /provider/u)
  assert.match(withRoute, /wb/u)
  assert.match(withRoute, /glm-5\.3/u)

  const withoutRoute = buildPipelineDispatch({ command: '/logi', scope, pluginRoot: 'C:/plugin' })
  assert.match(withoutRoute, /父会话当前模型/u)
})
