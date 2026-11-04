import { resolve } from 'node:path'
import { EXPERT_BY_KEY, EXPERT_ORDER, SEVERITIES } from './constants.js'
import { assignFindingIds, moduleOf, normalizeFinding } from './findings.js'
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

/**
 * Read and lightly validate handoffs. This function never decides whether a
 * finding is good, merged, or final: it only gives the editor an accurate
 * inventory. A structurally broken handoff is marked invalid, not "no issues".
 */
export function loadHandoffs({ root, scope }) {
  const expected = [...scope.experts]
  const optional = Array.isArray(scope.optionalExperts) ? scope.optionalExperts : []
  const order = new Map(EXPERT_ORDER.map((key, index) => [key, index]))
  const handoffs = []
  const warnings = []

  for (const expert of [...expected, ...optional]) {
    const info = EXPERT_BY_KEY[expert]
    if (!info) continue
    const path = resolve(scope.output.handoffDir, `${expert}.json`)
    const item = {
      expert,
      title: info.title,
      path: toPosix(path),
      expected: expected.includes(expert),
      exists: isFile(path),
      valid: false,
      status: 'missing',
      summary: '',
      sections: {},
      findings: [],
      deferred: [],
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
    item.notes = typeof raw.notes === 'string' ? raw.notes : ''
    item.deferred = Array.isArray(raw.deferred) ? raw.deferred : []
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
    runId: scope.runId,
    root: toPosix(root),
    runDir: scope.output.runDir,
    handoffDir: scope.output.handoffDir,
    expected,
    optional,
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
  const lines = [
    `# 后勤主编材料 · ${scope.runId}`,
    '',
    '> 这是给主会话模型（主编）的候选材料，不是最终报告。',
    '> 去重、定级、取舍、模块组织由主编决定；机器只负责收集与校验。',
    '',
    '## 运行',
    `- 根目录：\`${scope.root}\``,
    `- 范围：${scope.stats.analyzedFiles} 个文件，+${scope.stats.additions}/-${scope.stats.deletions} 行`,
    `- 测试命令：${scope.testCommand?.command ? `\`${scope.testCommand.command}\`` : '（未检测到）'}`,
    '',
    '## 覆盖',
    `- 预期专家：${inventory.expected.join('、') || '（无）'}`,
    `- 已收到：${inventory.received.join('、') || '（无）'}`,
    `- 缺失：${inventory.missing.join('、') || '（无）'}`,
    `- 无效：${inventory.invalid.join('、') || '（无）'}`,
    `- 失败：${inventory.failed.join('、') || '（无）'}`,
    `- partial：${inventory.partial.join('、') || '（无）'}`,
    '',
    '## 专家摘要',
  ]
  for (const handoff of inventory.handoffs) {
    const state = handoff.valid ? handoff.status : handoff.exists ? 'invalid' : 'missing'
    lines.push(`### ${handoff.expert} · ${state}`)
    if (!handoff.exists) {
      lines.push('- 没有 handoff 文件。不要把缺失当成“没有问题”。')
    } else if (!handoff.valid) {
      lines.push(`- 无效：${handoff.error}`)
    } else {
      lines.push(`- 摘要：${handoff.summary}`)
      const sections = Object.entries(handoff.sections).map(([key, value]) => `${key}=${value}`).join(' · ')
      if (sections) lines.push(`- sections：${sections}`)
      if (handoff.notes) lines.push(`- notes：${handoff.notes}`)
      lines.push(`- 发现数：${handoff.findings.length}`)
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
