import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { buildGraph, renderGraphHtml, writeGraph } from '../lib/graph.js'
import { cleanup, initRepo, makeProjectScope } from './helpers.js'

function finding(overrides = {}) {
  return {
    id: 'SEC-ABC12',
    title: '可被绕过的会话校验',
    severity: 'high',
    kind: 'direct',
    module: 'src',
    file: 'src/a.js',
    line: 2,
    ...overrides,
  }
}

test('builds a module-grouped graph with model relations', () => {
  const root = initRepo()
  try {
    const scope = makeProjectScope(root, ['correctness', 'security']).scope
    const verdict = {
      findings: [
        finding(),
        finding({ id: 'COR-DEF34', title: '返回值未校验', severity: 'critical', kind: 'plan' }),
      ],
      relations: [
        {
          from: 'SEC-ABC12',
          to: 'COR-DEF34',
          type: 'shared-root-cause',
          reason: '同一个入口缺少校验',
        },
      ],
    }
    const graph = buildGraph({ scope, verdict })
    assert.equal(graph.summary.findings, 2)
    assert.equal(graph.summary.relations, 1)
    assert.ok(graph.nodes.some((node) => node.type === 'module' && node.id === 'module:src'))
    assert.ok(graph.nodes.some((node) => node.type === 'finding' && node.id === 'COR-DEF34'))
    assert.ok(graph.edges.some((edge) => edge.type === 'located-in' && edge.from === 'SEC-ABC12'))
    assert.ok(graph.edges.some((edge) => edge.type === 'shared-root-cause'))
    // severity order is critical first inside the module column
    const findingNodes = graph.nodes.filter((node) => node.type === 'finding')
    assert.equal(findingNodes[0].id, 'COR-DEF34')
    assert.equal(findingNodes[0].unit, 'u01')
    const html = renderGraphHtml(graph)
    assert.match(html, /relation-edge/u)
    assert.match(html, /同一根因|shared-root-cause/u)
  } finally {
    cleanup(root)
  }
})

test('renderGraphHtml is self-contained and escapes finding titles', () => {
  const root = initRepo()
  try {
    const scope = makeProjectScope(root, ['security']).scope
    const graph = buildGraph({
      scope,
      verdict: { findings: [finding({ title: '</text><script>alert(1)</script>' })], relations: [] },
    })
    const html = renderGraphHtml(graph)
    assert.match(html, /<!doctype html>/u)
    assert.match(html, /<svg/u)
    assert.match(html, /模块分栏/u)
    assert.match(html, /data-module="src"/u)
    assert.doesNotMatch(html, /module-edge/u)
    assert.match(html, /&lt;\/text&gt;&lt;script&gt;/u)
    assert.doesNotMatch(html, /<script>alert/u)
    assert.doesNotMatch(html, /https?:\/\//u)
  } finally {
    cleanup(root)
  }
})

test('writeGraph writes graph.json and graph.html under the run directory', () => {
  const root = initRepo()
  try {
    const scope = makeProjectScope(root, ['security']).scope
    const result = writeGraph({ scope, verdict: { findings: [finding()], relations: [] } })
    assert.ok(existsSync(scope.output.graphJson))
    assert.ok(existsSync(scope.output.graphHtml))
    assert.equal(JSON.parse(readFileSync(scope.output.graphJson, 'utf8')).runId, scope.runId)
    assert.match(readFileSync(scope.output.graphHtml, 'utf8'), /项目关系图/u)
    assert.equal(result.paths.html, scope.output.graphHtml)
  } finally {
    cleanup(root)
  }
})
