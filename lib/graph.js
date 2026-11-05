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

function renderModulePanel(node, x, y, width, height, headerHeight) {
  const label = clip(node.label, 32)
  const worst = SEVERITIES[node.worst]?.label ?? node.worst
  const color = SEVERITY_COLORS[node.worst] ?? SEVERITY_COLORS.info
  return `<g class="node module" data-id="${escapeXml(node.id)}" data-module="${escapeXml(node.label)}">
  <title>${escapeXml(node.label)}：${node.findingCount} 条 finding</title>
  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" class="module-panel"/>
  <rect x="${x}" y="${y}" width="${width}" height="${headerHeight}" rx="12" class="module-header"/>
  <rect x="${x}" y="${y + 18}" width="4" height="28" rx="2" fill="${color}"/>
  <text x="${x + 16}" y="${y + 27}" class="module-title">${escapeXml(label)}</text>
  <text x="${x + 16}" y="${y + 47}" class="module-meta">${node.findingCount} 个问题 · 最高 ${escapeXml(worst)}</text>
</g>`
}

function renderFindingNode(node, x, y, width, height) {
  const color = SEVERITY_COLORS[node.severity] ?? SEVERITY_COLORS.info
  const title = clip(node.label, 22)
  const file = clip(node.file, 32)
  const unit = node.unit ? `[${node.unit}]` : '[未映射]'
  const kind = node.kind === 'direct' ? '可直接修' : '需方案'
  return `<g class="node finding" data-id="${escapeXml(node.id)}" data-module="${escapeXml(node.module)}" data-severity="${escapeXml(node.severity)}">
  <title>${escapeXml(node.id)} · [${escapeXml(node.severity)}] ${escapeXml(unit)} ${escapeXml(node.label)} · ${escapeXml(node.file)}:${node.line}</title>
  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" class="finding-box"/>
  <rect x="${x}" y="${y}" width="5" height="${height}" rx="2" fill="${color}"/>
  <text x="${x + 14}" y="${y + 19}" class="finding-id">${escapeXml(node.id)} · ${escapeXml(unit)}</text>
  <text x="${x + 14}" y="${y + 39}" class="finding-title">${escapeXml(title)}</text>
  <text x="${x + 14}" y="${y + 58}" class="finding-meta">${escapeXml(file)}:${node.line} · ${escapeXml(kind)}</text>
</g>`
}

function renderRelationEdge(edge, positions) {
  const from = positions.get(edge.from)
  const to = positions.get(edge.to)
  if (!from || !to) return ''
  const color = RELATION_COLORS[edge.type] ?? RELATION_COLORS.related
  const label = RELATION_LABELS[edge.type] ?? edge.type
  const x1 = from.x + from.w
  const y1 = from.cy
  const x2 = to.x
  const y2 = to.cy
  let path
  if (Math.abs(from.colX - to.colX) < 1) {
    const right = from.colX + from.colW + 28
    path = `M ${x1} ${y1} C ${right} ${y1}, ${right} ${y2}, ${x2} ${y2}`
  } else {
    const mid = (x1 + x2) / 2
    path = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
  }
  return `<path d="${path}" class="relation-edge" stroke="${color}" marker-end="url(#arrow-${escapeXml(edge.type)})"><title>${escapeXml(label)}${edge.label ? `：${escapeXml(edge.label)}` : ''}</title></path>`
}

/**
 * Render a self-contained HTML document with inline SVG grouped by module:
 * every module is a column, its findings are cards inside that column, and
 * model-declared finding relations are colored curves between cards. The
 * one-to-many module→finding relation is expressed by containment, not by a
 * fan of edges. No CDN, framework, or network access is required.
 */
export function renderGraphHtml(graph) {
  const modules = graph.nodes.filter((node) => node.type === 'module')
  const findings = graph.nodes.filter((node) => node.type === 'finding')
  const byModule = new Map()
  for (const finding of findings) {
    const key = finding.module || '(root)'
    if (!byModule.has(key)) byModule.set(key, [])
    byModule.get(key).push(finding)
  }

  const columnWidth = 324
  const columnGap = 24
  const left = 36
  const top = 142
  const headerHeight = 64
  const cardHeight = 74
  const cardGap = 8
  const columns = modules.map((node, index) => {
    const items = byModule.get(node.label) ?? []
    const bodyHeight = Math.max(cardHeight, items.length * (cardHeight + cardGap) - cardGap)
    return {
      node,
      x: left + index * (columnWidth + columnGap),
      items,
      height: headerHeight + 14 + bodyHeight + 16,
    }
  })
  const maxColumnHeight = Math.max(220, ...columns.map((column) => column.height))
  const width = Math.max(1180, left * 2 + columns.length * (columnWidth + columnGap) - columnGap)
  const height = Math.max(720, top + maxColumnHeight + 44)
  const positions = new Map()

  for (const column of columns) {
    positions.set(column.node.id, { x: column.x, y: top, w: columnWidth, h: column.height })
    column.items.forEach((item, index) => {
      const y = top + headerHeight + 14 + index * (cardHeight + cardGap)
      positions.set(item.id, {
        x: column.x + 12,
        y,
        w: columnWidth - 24,
        h: cardHeight,
        cy: y + cardHeight / 2,
        colX: column.x,
        colW: columnWidth,
      })
    })
  }

  const relationTypes = [...new Set(graph.edges
    .filter((edge) => edge.type !== 'located-in')
    .map((edge) => edge.type))]
  const relationEdges = graph.edges
    .filter((edge) => edge.type !== 'located-in')
    .map((edge) => renderRelationEdge(edge, positions))
    .join('\n')
  const moduleNodes = columns
    .map((column) => renderModulePanel(column.node, column.x, top, columnWidth, column.height, headerHeight))
    .join('\n')
  const findingNodes = columns
    .flatMap((column) => column.items.map((item) => {
      const position = positions.get(item.id)
      return renderFindingNode(item, position.x, position.y, position.w, position.h)
    }))
    .join('\n')
  const markers = ['shared-root-cause', 'same-file', 'depends-on', 'contradicts', 'related']
    .map((type) => `<marker id="arrow-${type}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${RELATION_COLORS[type] ?? RELATION_COLORS.related}"/></marker>`)
    .join('\n')
  const legend = SEVERITY_ORDER
    .filter((severity) => (graph.summary?.bySeverity?.[severity] ?? 0) > 0)
    .map((severity) => `<span class="legend-item"><i style="background:${SEVERITY_COLORS[severity]}"></i>${escapeXml(SEVERITIES[severity]?.label ?? severity)} ${graph.summary.bySeverity[severity]}</span>`)
    .join('')
  const relationLegend = relationTypes
    .map((type) => `<span class="legend-item"><i class="legend-line" style="background:${RELATION_COLORS[type] ?? RELATION_COLORS.related}"></i>${escapeXml(RELATION_LABELS[type] ?? type)}</span>`)
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
  header { padding: 28px 36px 6px; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  p { margin: 0; color: #667085; font-size: 13px; line-height: 1.7; }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 12px; font-size: 12px; color: #475467; }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .legend-item i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .legend-item i.legend-line { width: 18px; height: 2px; border-radius: 1px; }
  .canvas { margin: 8px 20px 32px; background: #fff; border: 1px solid #eaecf0; border-radius: 12px; overflow: auto; }
  svg { display: block; min-width: ${width}px; width: 100%; height: auto; }
  .module-panel { fill: #fbfcfe; stroke: #d0d5dd; }
  .module-header { fill: #eef2f6; }
  .module-title { font-size: 13px; font-weight: 650; fill: #344054; }
  .module-meta { font-size: 11px; fill: #667085; }
  .finding-box { fill: #fff; stroke: #d0d5dd; }
  .finding-id { font-size: 11.5px; font-weight: 650; fill: #475467; }
  .finding-title { font-size: 12px; font-weight: 550; fill: #1d2939; }
  .finding-meta { font-size: 10px; fill: #667085; }
  .node:hover .module-panel, .node:hover .finding-box { stroke: #7f56d9; stroke-width: 2; }
  .relation-edge { fill: none; stroke-width: 2; opacity: .9; }
</style>
</head>
<body>
<header>
  <h1>${escapeXml(graph.title)}</h1>
  <p>按模块分栏：每一栏是一个模块，栏内是它的问题，问题按严重度排列。彩色曲线表示模型在 verdict.relations 中声明的问题间关系；模块归属由分栏直接表达，不再画满屏的定位线。${graph.summary?.relations ? ` 共 ${graph.summary.relations} 条关系。` : ' 本次没有声明问题间关系。'}</p>
  <div class="legend">${legend}${relationLegend}</div>
</header>
<div class="canvas">
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="项目审查关系图">
<defs>${markers}</defs>
<text x="36" y="34" class="module-title">模块分栏（${modules.length}）</text>
<text x="36" y="56" class="module-meta">每栏内问题按严重度排序，共 ${findings.length} 条</text>
${moduleNodes}
${findingNodes}
${relationEdges}
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