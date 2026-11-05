import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildChildPrompt,
  buildProjectDispatch,
} from '../lib/dispatch.js'

const scope = {
  runId: 'run-test',
  root: 'C:/tmp/project',
  isGit: true,
  git: { branch: 'main', head: 'abc123', headSubject: 'test' },
  source: 'project',
  mode: 'project',
  stats: { analyzedFiles: 2, additions: 30, deletions: 0, truncated: false, omittedFiles: 0 },
  summary: { languages: [{ name: 'JavaScript', count: 2 }] },
  files: [{ path: 'src/a.js', status: 'present', lines: 10 }],
  project: {
    units: [
      { id: 'u01', label: 'src', stats: { files: 2, lines: 30 }, files: [] },
    ],
    totals: { units: 1, reviewedFiles: 2, lines: 30 },
  },
  notes: '',
  testCommand: { command: 'npm test' },
  experts: ['correctness', 'security'],
  maxFindings: 12,
  optionalExperts: ['perf'],
  models: {},
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
}

test('project child prompt requires every unit and one expert scope', () => {
  const prompt = buildChildPrompt({ expertKey: 'security', scope })
  assert.match(prompt, /security/)
  assert.match(prompt, /logi-security/)
  assert.match(prompt, /C:\/tmp\/run\/handoff\/security\.json/)
  assert.match(prompt, /整个项目/)
  assert.match(prompt, /project\.units/)
  assert.match(prompt, /u01/)
  assert.match(prompt, /reviewed \/ sampled \/ skipped/)
  assert.match(prompt, /不要调用其他 subagent/)
  assert.match(prompt, /临时文件/)
  assert.match(prompt, /\*\.bak/)
  assert.doesNotMatch(prompt, /provider/)
  assert.doesNotMatch(prompt, /logi-core/u)
})

test('project dispatch is editorial, project-scoped, and uses collect/bundle/verdict', () => {
  const text = buildProjectDispatch({
    command: '/logi',
    scope,
    pluginRoot: 'C:/plugin',
  })
  assert.match(text, /项目后勤派发 · \/logi/u)
  assert.match(text, /主编/u)
  assert.match(text, /全项目审查/u)
  assert.match(text, /u01/)
  assert.match(text, /单元 × 专家覆盖矩阵/u)
  assert.match(text, /collect\.mjs/u)
  assert.match(text, /bundle\.mjs/u)
  assert.match(text, /verdict\.mjs/u)
  assert.doesNotMatch(text, /status\.mjs|aggregate\.mjs/u)
})

test('a single-expert project dispatch still covers every unit and never updates latest', () => {
  const text = buildProjectDispatch({
    command: '/logi-correctness',
    scope: { ...scope, experts: ['correctness'] },
    pluginRoot: 'C:/plugin',
  })
  assert.match(text, /correctness/u)
  assert.match(text, /u01/)
  assert.match(text, /单专家/u)
  assert.match(text, /latest\.md/u)
  assert.match(text, /不发布/u)
  assert.match(text, /verdict\.json/u)
})

test('model routes are rendered only when configured', () => {
  const withRoute = buildProjectDispatch({
    command: '/logi',
    scope: { ...scope, models: { security: { provider: 'wb', model: 'glm-5.3' } } },
    pluginRoot: 'C:/plugin',
  })
  assert.match(withRoute, /provider/u)
  assert.match(withRoute, /wb/u)
  assert.match(withRoute, /glm-5\.3/u)

  const withoutRoute = buildProjectDispatch({ command: '/logi', scope, pluginRoot: 'C:/plugin' })
  assert.match(withoutRoute, /父会话当前模型/u)
})

test('a perf run does not claim the performance dimension was unrun', () => {
  const text = buildProjectDispatch({
    command: '/logi-perf',
    scope: { ...scope, experts: ['perf'] },
    pluginRoot: 'C:/plugin',
  })
  assert.match(text, /本次已运行性能专家/u)
  assert.doesNotMatch(text, /性能维度未运行/u)
})
