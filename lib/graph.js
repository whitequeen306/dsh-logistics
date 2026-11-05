import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { SEVERITIES } from './constants.js'
import { moduleOf } from './findings.js'
import { unitIndex } from './project.js'
import { toPosix } from './util.js'

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']
const SEVERITY_COLORS = {
  critical: '#b42318',
  high: '#d92d20',
  medium: '#dc6803',
  low: '#475467',
  info: '#667085',
}
const RELATION_COLORS = {
  'shared-root-cause': '#7f56d9',
  'same-file': '#0e9384',
  'depends-on': '#175cd3',
  contradicts: '#c01048',
  related: '#667085',
}
const RELATION_LABELS = {
  'shared-root-cause': '同一根因',
  'same-file': '同一文件',
  'depends-on': '修复依赖',
  contradicts: '结论冲突',
  related: '相关',
}

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity)
  return index < 0 ? SEVERITY_ORDER.length : index
}

function compareFindings(a, b) {
  return severityRank(a.severity) - severityRank(b.severity)
    || String(a.id ?? '').localeCompare(String(b.id ?? ''))
}

export function buildGraph({ scope, verdict }) {
  const findings = Array.isArray(verdict?.findings) ? [...verdict.findings].sort(compareFindings) : []
  const units = unitIndex(scope)
  const modules = new Map()
  for (const finding of findings) {
    const module = moduleOf(finding.file) || String(finding.module || '(root)')
    const entry = modules.get(module) ?? { module, count: 0, worst: 'info', findings: [] }
    entry.count += 1
    entry.findings.push(finding.id)
    if (severityRank(finding.severity) < severityRank(entry.worst)) entry.worst = finding.severity
    modules.set(module, entry)
  }

  const nodes = [...modules.values()]
    .sort((a, b) => severityRank(a.worst) - severityRank(b.worst) || b.count - a.count || a.module.localeCompare(b.module))
    .map((entry) => ({
      id: `module:${entry.module}`,
      type: 'module',
      label: entry.module,
      findingCount: entry.count,
      worst: entry.worst,
    }))

  for (const finding of findings) {
    nodes.push({
      id: finding.id,
      type: 'finding',
      label: finding.title,
      severity: finding.severity,
      severityLabel: SEVERITIES[finding.severity]?.label ?? finding.severity,
      kind: finding.kind,
      unit: units.get(toPosix(finding.file ?? '')) ?? '',
      module: moduleOf(finding.file) || finding.module || '(root)',
      file: toPosix(finding.file ?? ''),
      line: finding.line,
    })
  }

  const edges = findings.map((finding) => ({
    from: finding.id,
    to: `module:${moduleOf(finding.file) || finding.module || '(root)'}`,
    type: 'located-in',
  }))
  const knownFindings = new Set(findings.map((finding) => finding.id))
  const relations = []
  for (const relation of Array.isArray(verdict?.relations) ? verdict.relations : []) {
    if (!knownFindings.has(relation?.from) || !knownFindings.has(relation?.to)) continue
    if (relation.from === relation.to) continue
    relations.push({
      from: relation.from,
      to: relation.to,
      type: relation.type || 'related',
      label: relation.reason || '',
    })
  }
  edges.push(...relations)

  return {
    schemaVersion: 1,
    runId: scope?.runId ?? '',
    title: `项目关系图 · ${scope?.runId ?? ''}`.trim(),
    summary: {
      findings: findings.length,
      modules: modules.size,
      relations: relations.length,
      bySeverity: Object.fromEntries(SEVERITY_ORDER.map((severity) => [
        severity,
        findings.filter((finding) => finding.severity === severity).length,
      ])),
    },
    nodes,
    edges,
  }
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}

function clip(value, max) {
  const text = String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function renderModuleNode(node, x, y, width, height) {
  const label = clip(node.label, 30)
  const worst = SEVERITIES[node.worst]?.label ?? node.worst
  return `<g class="node module" data-id="${escapeXml(node.id)}">
  <title>${escapeXml(node.label)}：${node.findingCount} 条 finding</title>
  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" class="module-box"/>
  <text x="${x + 14}" y="${y + 24}" class="module-title">${escapeXml(label)}</text>
  <text x="${x + 14}" y="${y + 44}" class="module-meta">${node.findingCount} 条 · 最高 ${escapeXml(worst)}</text>
</g>`
}

function renderFindingNode(node, x, y, width, height) {
  const color = SEVERITY_COLORS[node.severity] ?? SEVERITY_COLORS.info
  const title = clip(node.label, 48)
  const unit = node.unit ? `[${node.unit}] ` : ''
  const kind = node.kind === 'direct' ? '可直接修' : '需方案'
  return `<g class="node finding" data-id="${escapeXml(node.id)}" data-severity="${escapeXml(node.severity)}">
  <title>${escapeXml(node.id)} · [${escapeXml(node.severity)}] ${escapeXml(node.label)} · ${escapeXml(node.file)}:${node.line}</title>
  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="7" class="finding-box"/>
  <rect x="${x}" y="${y}" width="5" height="${height}" rx="2" fill="${color}"/>
  <text x="${x + 14}" y="${y + 21}" class="finding-id">${escapeXml(node.id)} · ${escapeXml(unit)}${escapeXml(title)}</text>
  <text x="${x + 14}" y="${y + 39}" class="finding-meta">${escapeXml(node.file)}:${node.line} · ${escapeXml(kind)}</text>
</g>`
}

function renderEdge(edge, positions, pathOnly = false) {
  const from = positions.get(edge.from)
  const to = positions.get(edge.to)
  if (!from || !to) return ''
  if (edge.type === 'located-in') {
    const path = `M ${from.x} ${from.cy} C ${from.x - 80} ${from.cy}, ${to.x + 30} ${to.cy}, ${to.x + 22} ${to.cy}`
    return `<path d="${path}" class="module-edge"/>`
  }
  if (pathOnly) return ''
  const color = RELATION_COLORS[edge.type] ?? RELATION_COLORS.related
  const label = RELATION_LABELS[edge.type] ?? edge.type
  const bend = Math.max(from.x, to.x) + 55
  const path = `M ${from.x} ${from.cy} C ${bend} ${from.cy}, ${bend} ${to.cy}, ${to.x} ${to.cy}`
  return `<path d="${path}" class="relation-edge" stroke="${color}" marker-end="url(#arrow-${escapeXml(edge.type)})"><title>${escapeXml(label)}${edge.label ? `：${escapeXml(edge.label)}` : ''}</title></path>`
}

/**
 * Render a self-contained HTML document with an inline SVG bipartite graph:
 * modules on the left, findings on the right, relation edges between findings.
 * No CDN, JavaScript framework, or network access is required.
 */
export function renderGraphHtml(graph) {
  const modules = graph.nodes.filter((node) => node.type === 'module')
  const findings = graph.nodes.filter((node) => node.type === 'finding')
  const width = 1180
  const moduleX = 40
  const moduleW = 250
  const findingX = 610
  const findingW = 520
  const moduleH = 64
  const findingH = 54
  const gap = 12
  const top = 132
  const height = Math.max(720, top + Math.max(modules.length * (moduleH + gap), findings.length * (findingH + gap)) + 80)
  const positions = new Map()
  modules.forEach((node, index) => {
    const y = top + index * (moduleH + gap)
    positions.set(node.id, { x: moduleX + moduleW, y, cy: y + moduleH / 2 })
  })
  findings.forEach((node, index) => {
    const y = top + index * (findingH + gap)
    positions.set(node.id, { x: findingX, y, cy: y + findingH / 2 })
  })

  const moduleEdges = graph.edges
    .filter((edge) => edge.type === 'located-in')
    .map((edge) => renderEdge(edge, positions))
    .join('\n')
  const relationEdges = graph.edges
    .filter((edge) => edge.type !== 'located-in')
    .map((edge) => renderEdge(edge, positions))
    .join('\n')
  const moduleNodes = modules
    .map((node) => renderModuleNode(node, moduleX, positions.get(node.id).y, moduleW, moduleH))
    .join('\n')
  const findingNodes = findings
    .map((node) => renderFindingNode(node, findingX, positions.get(node.id).y, findingW, findingH))
    .join('\n')
  const markers = ['shared-root-cause', 'same-file', 'depends-on', 'contradicts', 'related']
    .map((type) => `<marker id="arrow-${type}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${RELATION_COLORS[type] ?? RELATION_COLORS.related}"/></marker>`)
    .join('\n')
  const legend = SEVERITY_ORDER
    .filter((severity) => (graph.summary?.bySeverity?.[severity] ?? 0) > 0)
    .map((severity) => `<span class="legend-item"><i style="background:${SEVERITY_COLORS[severity]}"></i>${escapeXml(SEVERITIES[severity]?.label ?? severity)} ${graph.summary.bySeverity[severity]}</span>`)
    .join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeXml(graph.title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f7f8fa; color: #1d2939; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
  header { padding: 28px 40px 6px; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  p { margin: 0; color: #667085; font-size: 13px; line-height: 1.7; }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 12px; font-size: 12px; color: #475467; }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .legend-item i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .canvas { margin: 8px 20px 32px; background: #fff; border: 1px solid #eaecf0; border-radius: 12px; overflow: auto; }
  svg { display: block; min-width: 1100px; width: 100%; height: auto; }
  .module-box { fill: #f2f4f7; stroke: #d0d5dd; }
  .module-title { font-size: 13px; font-weight: 650; fill: #344054; }
  .module-meta { font-size: 11px; fill: #667085; }
  .finding-box { fill: #fff; stroke: #d0d5dd; }
  .finding-id { font-size: 12px; font-weight: 600; fill: #344054; }
  .finding-meta { font-size: 10.5px; fill: #667085; }
  .node:hover .module-box, .node:hover .finding-box { stroke: #7f56d9; stroke-width: 2; }
  .module-edge { fill: none; stroke: #d0d5dd; stroke-width: 1; opacity: .55; }
  .relation-edge { fill: none; stroke-width: 1.5; opacity: .8; }
</style>
</head>
<body>
<header>
  <h1>${escapeXml(graph.title)}</h1>
  <p>模块在左，问题在右；灰色线表示问题所属模块，彩色曲线表示问题之间的关系。悬停节点可查看完整标题与位置。${graph.summary?.relations ? ` 共 ${graph.summary.relations} 条关系。` : ' 暂未标注问题间关系。'}</p>
  <div class="legend">${legend}</div>
</header>
<div class="canvas">
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="项目审查关系图">
<defs>${markers}</defs>
<text x="40" y="34" class="module-title">模块（${modules.length}）</text>
<text x="${findingX}" y="34" class="module-title">问题（按严重度排序，${findings.length}）</text>
${moduleEdges}
${relationEdges}
${moduleNodes}
${findingNodes}
</svg>
</div>
</body>
</html>
`
}

export function graphPaths(scope) {
  const runDir = scope?.output?.runDir
  if (!runDir) throw new Error('scope.output.runDir 缺失，无法生成关系图')
  return {
    json: scope.output.graphJson ?? resolve(runDir, 'graph.json'),
    html: scope.output.graphHtml ?? resolve(runDir, 'graph.html'),
  }
}

export function writeGraph({ scope, verdict }) {
  const graph = buildGraph({ scope, verdict })
  const paths = graphPaths(scope)
  const html = renderGraphHtml(graph)
  mkdirSync(dirname(paths.json), { recursive: true })
  writeFileSync(paths.json, `${JSON.stringify(graph, null, 2)}\n`)
  writeFileSync(paths.html, html)
  return { graph, paths }
}