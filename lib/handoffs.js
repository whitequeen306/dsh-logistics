import { readFileSync } from 'node:fs'
import { EXPERT_BY_KEY, EXPERT_ORDER, SEVERITIES } from './constants.js'
import { assignFindingIds, moduleOf, normalizeFinding } from './findings.js'
import { resolveHandoffJsonPath, resolveHandoffMarkdownPath } from './handoff-paths.js'
import { testCommandLines } from './test-command.js'
import { isFile, readJsonFile, toPosix } from './util.js'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fileExpert(path) {
  const match = /([^/\\]+)\.json$/u.exec(path)
  return match ? match[1] : ''
}

function normalizeSections(raw, info, warnings) {
  const source = isObject(raw) ? raw : {}
  const sections = {}
  const missing = []
  for (const section of info.sections) {
    if (!Object.hasOwn(source, section)) {
      missing.push(section)
      continue
    }
    const value = Number(source[section])
    if (!Number.isInteger(value) || value < 0) {
      warnings.push(`${info.key}: sections.${section} 必须是非负整数`)
      sections[section] = 0
    } else {
      sections[section] = value
    }
  }
  return { sections, missing }
}

function normalizeProjectUnits(raw, projectUnits, warnings) {
  const source = isObject(raw) ? raw : {}
  const units = {}
  const missing = []
  let skipped = false
  for (const unit of projectUnits) {
    const entry = source[unit.id]
    if (!isObject(entry)) {
      missing.push(unit.id)
      continue
    }
    const status = typeof entry.status === 'string' ? entry.status.trim() : ''
    if (!['reviewed', 'sampled', 'skipped'].includes(status)) {
      warnings.push(`${unit.id}: units.${unit.id}.status 必须是 reviewed/sampled/skipped`)
      missing.push(unit.id)
      continue
    }
    const filesRead = Number(entry.filesRead)
    if (status !== 'skipped' && (!Number.isInteger(filesRead) || filesRead <= 0)) {
      warnings.push(`${unit.id}: ${status} 单元必须声明至少读过 1 个文件`)
      missing.push(unit.id)
      continue
    }
    units[unit.id] = {
      status,
      filesRead: Number.isInteger(filesRead) && filesRead >= 0 ? filesRead : 0,
      notes: typeof entry.notes === 'string' ? entry.notes.slice(0, 500) : '',
    }
    if (status === 'skipped') skipped = true
  }
  return { units, missing, skipped }
}

function normalizeDeferred(raw, info, warnings) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warnings.push(`${info.key}: deferred 必须是数组`)
    return []
  }
  const out = []
  raw.forEach((item, index) => {
    if (typeof item === 'string') {
      const summary = item.trim()
      if (!summary) {
        warnings.push(`${info.key}: deferred[${index}] 为空，已忽略`)
        return
      }
      out.push({ from: info.key, expert: '', file: '', lines: '', summary })
      return
    }
    if (!isObject(item)) {
      warnings.push(`${info.key}: deferred[${index}] 必须是对象或字符串`)
      return
    }
    const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
    if (!summary) {
      warnings.push(`${info.key}: deferred[${index}] 缺少非空 summary，已忽略`)
      return
    }
    const target = typeof item.expert === 'string' ? item.expert.trim() : ''
    if (target && !EXPERT_BY_KEY[target]) {
      warnings.push(`${info.key}: deferred[${index}] 的目标专家未知：${target}`)
    }
    const file = typeof item.file === 'string' ? toPosix(item.file.trim()) : ''
    const lines = typeof item.lines === 'string' ? item.lines.trim() : ''
    out.push({ from: info.key, expert: target && EXPERT_BY_KEY[target] ? target : '', file, lines, summary })
  })
  return out
}

/**
 * Read and lightly validate handoffs. This function never decides whether a
 * finding is good, merged, or final: it only gives the editor an accurate
 * inventory. A structurally broken handoff is marked invalid, not "no issues".
 */
export function loadHandoffs({ root, scope }) {
  const projectUnits = scope?.mode === 'project' && Array.isArray(scope.project?.units)
    ? scope.project.units
    : []
  const expected = [...scope.experts]
  const optional = Array.isArray(scope.optionalExperts) ? scope.optionalExperts : []
  const order = new Map(EXPERT_ORDER.map((key, index) => [key, index]))
  const handoffs = []
  const warnings = []

  for (const expert of [...expected, ...optional]) {
    const info = EXPERT_BY_KEY[expert]
    if (!info) continue
    const path = resolveHandoffJsonPath(scope, expert)
    const reportPath = resolveHandoffMarkdownPath(scope, expert)
    let reportText = ''
    try {
      if (isFile(reportPath)) reportText = readFileSync(reportPath, 'utf8')
    } catch {
      reportText = ''
    }
    const item = {
      expert,
      title: info.title,
      path: toPosix(path),
      reportPath: toPosix(reportPath),
      reportExists: reportText.trim().length > 0,
      reportChars: reportText.trim().length,
      expected: expected.includes(expert),
      exists: isFile(path),
      valid: false,
      status: 'missing',
      summary: '',
      sections: {},
      findings: [],
      deferred: [],
      units: {},
      notes: '',
      error: '',
    }
    if (!item.exists) {
      handoffs.push(item)
      continue
    }
    const raw = readJsonFile(path, undefined)
    if (!isObject(raw)) {
      item.status = 'invalid'
      item.error = 'JSON 解析失败'
      handoffs.push(item)
      continue
    }
    if (raw.schemaVersion !== 2) {
      item.status = 'invalid'
      item.error = `schemaVersion 必须是 2，收到 ${raw.schemaVersion ?? '?'}`
      handoffs.push(item)
      continue
    }
    if (raw.expert !== expert) {
      item.status = 'invalid'
      item.error = `expert 字段与文件名不一致：${raw.expert ?? '?'}`
      handoffs.push(item)
      continue
    }
    if (!Array.isArray(raw.findings)) {
      item.status = 'invalid'
      item.error = 'findings 必须是数组'
      handoffs.push(item)
      continue
    }
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
    if (!summary) {
      item.status = 'invalid'
      item.error = 'summary 不能为空'
      handoffs.push(item)
      continue
    }
    item.summary = summary
    item.status = ['ok', 'partial', 'failed'].includes(raw.status) ? raw.status : 'ok'
    const sectionResult = normalizeSections(raw.sections, info, warnings)
    item.sections = sectionResult.sections
    if (sectionResult.missing.length > 0) {
      item.status = 'invalid'
      item.error = `sections 缺少：${sectionResult.missing.join('、')}`
      handoffs.push(item)
      continue
    }
    if (projectUnits.length > 0) {
      const unitResult = normalizeProjectUnits(raw.units, projectUnits, warnings)
      item.units = unitResult.units
      if (unitResult.missing.length > 0) {
        item.valid = false
        item.status = 'invalid'
        item.error = `units 缺少或非法：${unitResult.missing.join('、')}`
        handoffs.push(item)
        continue
      }
      if (unitResult.skipped) item.status = 'partial'
    }
    item.notes = typeof raw.notes === 'string' ? raw.notes : ''
    item.deferred = normalizeDeferred(raw.deferred, info, warnings)
    item.error = typeof raw.error === 'string' ? raw.error : ''

    const localWarnings = []
    let badSection
    for (let index = 0; index < raw.findings.length; index += 1) {
      const sectionRaw = isObject(raw.findings[index]) ? String(raw.findings[index].section ?? '').trim() : ''
      if (sectionRaw && !info.sections.includes(sectionRaw)) {
        badSection = `findings[${index}].section 不属于 ${expert}：${sectionRaw}`
        break
      }
      const finding = normalizeFinding({
        root,
        expert,
        raw: raw.findings[index],
        index,
        warnings: localWarnings,
      })
      if (finding) item.findings.push(finding)
    }
    if (badSection) {
      item.valid = false
      item.status = 'invalid'
      item.error = badSection
      handoffs.push(item)
      continue
    }
    warnings.push(...localWarnings)
    const maxFindings = Number.isInteger(scope.maxFindings) ? scope.maxFindings : 12
    if (item.findings.length > maxFindings) {
      item.valid = false
      item.status = 'invalid'
      item.error = `findings 数量 ${item.findings.length} 超过上限 ${maxFindings}`
      handoffs.push(item)
      continue
    }
    const actual = Object.fromEntries(info.sections.map((section) => [section, 0]))
    for (const finding of item.findings) actual[finding.section] += 1
    const mismatch = info.sections.find((section) => actual[section] !== item.sections[section])
    if (mismatch) {
      item.valid = false
      item.status = 'invalid'
      item.error = `sections.${mismatch} 计数不一致（声明 ${item.sections[mismatch]} / 实际 ${actual[mismatch]}）`
      handoffs.push(item)
      continue
    }
    item.valid = true
    handoffs.push(item)
  }

  handoffs.sort((a, b) => (order.get(a.expert) ?? 99) - (order.get(b.expert) ?? 99))

  const missing = handoffs.filter((item) => item.expected && !item.exists).map((item) => item.expert)
  const invalid = handoffs.filter((item) => item.exists && !item.valid).map((item) => item.expert)
  const failed = handoffs.filter((item) => item.valid && item.status === 'failed').map((item) => item.expert)
  const partial = handoffs.filter((item) => item.valid && item.status === 'partial').map((item) => item.expert)
  const received = handoffs.filter((item) => item.valid).map((item) => item.expert)
  const complete = missing.length === 0 && invalid.length === 0 && failed.length === 0 && partial.length === 0

  return {
    mode: scope.mode ?? 'changes',
    runId: scope.runId,
    root: toPosix(root),
    runDir: scope.output.runDir,
    handoffDir: scope.output.handoffDir,
    handoffLayout: scope.output.handoffLayout ?? 'flat',
    expected,
    optional,
    projectUnits: projectUnits.map((unit) => ({ id: unit.id, label: unit.label })),
    handoffs,
    missing,
    invalid,
    failed,
    partial,
    received,
    complete,
    warnings,
  }
}

/**
 * Per-unit status counts across valid handoffs. The editor uses this to see
 * which units are genuinely covered and which are only sampled or missing.
 */
export function unitCoverage(inventory) {
  const units = Array.isArray(inventory.projectUnits) ? inventory.projectUnits : []
  return units.map((unit) => {
    const counts = { reviewed: 0, sampled: 0, skipped: 0, missing: 0 }
    for (const handoff of inventory.handoffs) {
      if (!handoff.valid) {
        if (handoff.expected) counts.missing += 1
        continue
      }
      const status = handoff.units?.[unit.id]?.status
      if (status && Object.hasOwn(counts, status)) counts[status] += 1
      else counts.missing += 1
    }
    return { id: unit.id, label: unit.label, counts }
  })
}

export function flattenFindings(inventory) {
  const findings = []
  for (const handoff of inventory.handoffs) {
    if (!handoff.valid) continue
    for (const finding of handoff.findings) {
      findings.push({
        ...finding,
        experts: [finding.expert],
        module: finding.module || moduleOf(finding.file),
      })
    }
  }
  return assignFindingIds(findings)
}

export function flattenDeferred(inventory) {
  const deferred = []
  for (const handoff of inventory.handoffs) {
    if (!handoff.valid) continue
    for (const item of handoff.deferred) deferred.push({ ...item })
  }
  return deferred
}

function findingLine(finding) {
  return [
    `### ${finding.id} · [${SEVERITIES[finding.severity]?.label ?? finding.severity}] ${finding.title}`,
    `- 专家 / section：${finding.expert} / ${finding.section}`,
    `- 位置：\`${finding.file}:${finding.line}\``,
    `- 置信度：${finding.confidence} · kind：${finding.kind}`,
    `- 证据：${finding.evidence || '（无）'}`,
    `- 影响：${finding.impact || '（无）'}`,
    `- 修复摘要：${finding.fix?.summary || '（无）'}`,
    `- 修复文件：${(finding.fix?.files ?? []).join('、') || '（无）'}`,
    `- 建议测试：${(finding.fix?.tests ?? []).join('；') || '（无）'}`,
  ].join('\n')
}

export function duplicateHints(findings) {
  const groups = new Map()
  for (const finding of findings) {
    const key = [
      finding.category,
      String(finding.file ?? '').replace(/^\.\//u, ''),
      String(finding.title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''),
    ].join('|')
    const list = groups.get(key) ?? []
    list.push(finding.id)
    groups.set(key, list)
  }
  return [...groups.values()].filter((ids) => ids.length > 1)
}

export function renderPacket({ root, scope, inventory, findings }) {
  const rangeLine = scope.mode === 'project'
    ? `${scope.stats.analyzedFiles} 个文件 / ${scope.project?.units?.length ?? 0} 个审查单元 / ${scope.stats.additions} 行`
    : `${scope.stats.analyzedFiles} 个文件，+${scope.stats.additions}/-${scope.stats.deletions} 行`
  const lines = [
    `# 后勤主编材料 · ${scope.runId}`,
    '',
    '> 这是给主会话模型（主编）的候选材料，不是最终报告。',
    '> 去重、定级、取舍、模块组织由主编决定；机器只负责收集与校验。',
    '',
    '## 运行',
    `- 根目录：\`${scope.root}\``,
    `- 范围：${rangeLine}`,
    ...testCommandLines(scope, { empty: '（未检测到）' }),
    '',
    '## 覆盖',
    `- ${inventory.mode === 'project' ? '预期单元 / 专家' : '预期专家'}：${inventory.expected.join('、') || '（无）'}`,
    `- 已收到：${inventory.received.join('、') || '（无）'}`,
    `- 缺失：${inventory.missing.join('、') || '（无）'}`,
    `- 无效：${inventory.invalid.join('、') || '（无）'}`,
    `- 失败：${inventory.failed.join('、') || '（无）'}`,
    `- partial：${inventory.partial.join('、') || '（无）'}`,
  ]
  if (inventory.optional.length > 0) {
    lines.push(`- 可选未选：${inventory.optional.filter((expert) => !inventory.received.includes(expert)).join('、') || '（无）'}`)
  }
  if (inventory.mode === 'project' && Array.isArray(inventory.projectUnits) && inventory.projectUnits.length > 0) {
    const experts = inventory.handoffs.map((handoff) => handoff.expert)
    lines.push('', '## 单元覆盖矩阵', '', `| 单元 | 标签 | ${experts.join(' | ')} |`, `| --- | --- | ${experts.map(() => '---').join(' | ')} |`)
    for (const unit of inventory.projectUnits) {
      const cells = inventory.handoffs.map((handoff) => (handoff.valid ? handoff.units?.[unit.id]?.status ?? 'missing' : 'missing'))
      lines.push(`| ${unit.id} | ${unit.label} | ${cells.join(' | ')} |`)
    }
  }
  lines.push('', '## 专家摘要')
  for (const handoff of inventory.handoffs) {
    const state = handoff.valid ? handoff.status : handoff.exists ? 'invalid' : handoff.expected ? 'missing' : 'not-selected'
    lines.push(`### ${handoff.expert}${handoff.unit ? ` · ${handoff.unit}` : ''} · ${state}`)
    if (!handoff.exists) {
      lines.push(
        handoff.expected
          ? '- 没有 handoff 文件。不要把缺失当成“没有问题”。'
          : '- 可选专家，本次未选择（不是缺失）。',
      )
    } else if (!handoff.valid) {
      lines.push(`- 无效：${handoff.error}`)
    } else {
      lines.push(`- 摘要：${handoff.summary}`)
      lines.push(handoff.reportExists
        ? `- 专家报告：\`${handoff.reportPath}\`（${handoff.reportChars} 字符）`
        : `- 专家报告：缺失（应写 \`${handoff.reportPath}\`）`)
      const sections = Object.entries(handoff.sections).map(([key, value]) => `${key}=${value}`).join(' · ')
      if (sections) lines.push(`- sections：${sections}`)
      if (handoff.notes) lines.push(`- notes：${handoff.notes}`)
      lines.push(`- 发现数：${handoff.findings.length}`)
      if (handoff.deferred.length > 0) {
        lines.push(`- 转交其他专家：${handoff.deferred.length} 条`)
        for (const item of handoff.deferred) {
          const target = item.expert || '未指定'
          const where = item.file ? ` · ${item.file}${item.lines ? `:${item.lines}` : ''}` : ''
          lines.push(`  - → ${target}${where} · ${item.summary}`)
        }
      }
    }
    lines.push('')
  }

  lines.push('## 候选 findings')
  if (findings.length === 0) {
    lines.push('- 没有有效发现。')
  } else {
    for (const finding of findings) {
      lines.push(findingLine(finding))
      lines.push('')
    }
  }

  const hints = duplicateHints(findings)
  const allDeferred = flattenDeferred(inventory)
  lines.push('## 转交 deferred')
  if (allDeferred.length === 0) {
    lines.push('- 没有跨专家转交项。')
  } else {
    for (const item of allDeferred) {
      const target = item.expert || '未指定'
      const where = item.file ? ` · ${item.file}${item.lines ? `:${item.lines}` : ''}` : ''
      lines.push(`- ${item.from} → ${target}${where} · ${item.summary}`)
    }
    lines.push('')
    lines.push('> 这些不是当前专家的 finding，但必须写入 verdict.deferred，不能静默丢弃。')
  }
  lines.push('')
  lines.push('## 机器提示（仅供参考）')
  if (hints.length === 0) {
    lines.push('- 没有检测到明显的跨专家重复候选。')
  } else {
    for (const ids of hints) lines.push(`- 可能是同一问题：${ids.join('、')}；请主编读证据后决定是否合并。`)
  }
  lines.push('')
  lines.push('## 交给主编')
  lines.push('1. 读本文件与原始 handoff；不要只依赖机器提示。')
  lines.push('2. 合并重复项，保留最可信的证据；被合并的 ID 记入 verdict.dropped。')
  lines.push('3. 写 `verdict.json`（schemaVersion 2、findings、coverage、dropped），再写 `report.md`。')
  lines.push('4. 只有完整覆盖默认四模块时，才更新 `docs/logistics/latest.md` 与 `.logistics/latest.json`。')
  lines.push(`5. 工作区根目录：\`${root}\`；运行目录：\`${scope.output.runDir}\`。`)
  return lines.join('\n')
}
