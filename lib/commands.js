import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { PASS_BY_KEY, PASS_LIST, TIERS } from './constants.js'
import { loadConfig } from './config.js'
import { createScope, isGeneratedPath, parseStatusZ } from './scope.js'
import { acceptBaseline, compareToBaseline, fingerprint } from './baseline.js'
import { evaluateGate, readLatestReport } from './report.js'
import { buildPipelineDispatch, buildSingleDispatch } from './dispatch.js'
import { git, gitRoot } from './util.js'

const RISK_LABELS = { low: '低', medium: '中', high: '高' }

function errorResult(text) {
  return { kind: 'error', text }
}

function successResult(text) {
  return { kind: 'success', text }
}

function resolveCwd(invocation) {
  const cwd = invocation?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim().length > 0) return resolve(cwd)
  return process.cwd()
}

function userMessage(text) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function tierLabel(scope) {
  if (scope.mode === 'single') return '单点'
  return TIERS[scope.tier]?.label ?? scope.tier
}

function scopeLine(scope) {
  return `${scope.stats.analyzedFiles} 个文件（+${scope.stats.additions}/-${scope.stats.deletions}），风险 ${RISK_LABELS[scope.risk.level] ?? scope.risk.level}`
}

function appendWarnings(lines, warnings) {
  if (warnings.length === 0) return
  lines.push('')
  lines.push(`配置提示：${warnings.slice(0, 3).join('；')}${warnings.length > 3 ? ` 等 ${warnings.length} 条` : ''}`)
}

function queueDispatch(invocation, text) {
  const agent = invocation?.agent
  if (!agent || typeof agent.followup !== 'function') {
    return errorResult('当前会话不支持注入后续任务（agent.followup 不可用）。')
  }
  agent.followup(userMessage(text))
  return undefined
}

function runPipeline(invocation, spec) {
  if (invocation.signal?.aborted) return errorResult('命令已取消。')
  const cwd = resolveCwd(invocation)
  const root = gitRoot(cwd) ?? cwd
  const { config, warnings } = loadConfig(root)
  const mode = spec.mode
  const passes = mode === 'auto' ? [] : [...TIERS[mode].passes]
  const notes = typeof invocation.rawInput === 'string' ? invocation.rawInput : ''

  let created
  try {
    created = createScope({
      cwd,
      command: spec.command,
      passes,
      mode,
      tier: mode === 'auto' ? undefined : mode,
      notes,
      config,
    })
  } catch (error) {
    return errorResult(`无法准备工作区：${error instanceof Error ? error.message : String(error)}`)
  }

  const { scope } = created
  if (scope.stats.analyzedFiles === 0) {
    return errorResult(
      '没有检测到可分析的改动。请先修改或暂存文件；如果希望分析最近一次提交，请确认 includeLastCommitWhenClean 为 true（默认）。',
    )
  }

  const lines = [
    `已派发 ${spec.command} · ${tierLabel(scope)}档${mode === 'auto' ? '（自动推荐）' : ''}`,
    `- 运行：${scope.runId}`,
    `- 范围：${scopeLine(scope)}`,
    `- 专家：${scope.passes.map((key) => PASS_BY_KEY[key].title).join('、')}`,
    `- 报告：docs/logistics/latest.md（子代理完成后生成）`,
  ]
  appendWarnings(lines, warnings)
  lines.push('')
  lines.push('子代理完成后我会继续汇总。')

  const failure = queueDispatch(invocation, buildPipelineDispatch({
    command: spec.command,
    scope,
    pluginRoot: spec.pluginRoot,
  }))
  return failure ?? successResult(lines.join('\n'))
}

function runSingle(invocation, spec) {
  if (invocation.signal?.aborted) return errorResult('命令已取消。')
  const cwd = resolveCwd(invocation)
  const root = gitRoot(cwd) ?? cwd
  const { config, warnings } = loadConfig(root)
  const pass = PASS_BY_KEY[spec.pass]
  if (!pass) return errorResult(`未知专家：${spec.pass}`)
  const notes = typeof invocation.rawInput === 'string' ? invocation.rawInput : ''

  let created
  try {
    created = createScope({
      cwd,
      command: spec.command,
      passes: [spec.pass],
      mode: 'single',
      tier: 'single',
      notes,
      config,
    })
  } catch (error) {
    return errorResult(`无法准备工作区：${error instanceof Error ? error.message : String(error)}`)
  }

  const { scope } = created
  if (scope.stats.analyzedFiles === 0) {
    return errorResult(
      '没有检测到可分析的改动。请先修改或暂存文件；如果希望分析最近一次提交，请确认 includeLastCommitWhenClean 为 true（默认）。',
    )
  }

  const lines = [
    `已派发 ${spec.command} · ${pass.title}`,
    `- 运行：${scope.runId}`,
    `- 范围：${scopeLine(scope)}`,
    `- 专家：${pass.expert}`,
    `- 报告：docs/logistics/latest.md（单专家报告，覆盖不完整）`,
  ]
  appendWarnings(lines, warnings)
  lines.push('')
  lines.push('子代理完成后我会继续汇总。')

  const failure = queueDispatch(invocation, buildSingleDispatch({
    command: spec.command,
    passKey: spec.pass,
    scope,
    pluginRoot: spec.pluginRoot,
  }))
  return failure ?? successResult(lines.join('\n'))
}

const STALE_LABELS = {
  head: 'HEAD 已变化',
  dirty: '工作区状态已变化',
}

function staleReason(root, report) {
  const gitScope = report?.scope?.git
  if (!report?.scope?.isGit || !gitScope) return undefined
  const head = git(['rev-parse', '--short', 'HEAD'], root)
  if (head.ok && gitScope.head && head.stdout.trim() !== gitScope.head) return STALE_LABELS.head
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], root)
  if (status.ok) {
    const dirty = parseStatusZ(status.stdout).some((file) => !isGeneratedPath(file.path))
    if (Boolean(gitScope.sourceDirty ?? gitScope.dirty) !== dirty) return STALE_LABELS.dirty
  }
  return undefined
}

function gateText({ gate, comparison, report, stale }) {
  const statusLabel = gate.status === 'pass' ? '通过' : gate.status === 'fail' ? '未通过' : '不确定'
  const lines = [
    `后勤门禁：${statusLabel}（exit ${gate.code}）`,
    `- 新增：严重 ${gate.newCritical}、高 ${gate.newHigh}；存量 ${comparison.existingCount}；修复 ${comparison.fixedFindings.length}`,
    `- 健康分：${report.score.value}${comparison.baselineScore !== undefined ? `（基线 ${comparison.baselineScore}${comparison.scoreDrop > 0 ? `，下降 ${comparison.scoreDrop}` : ''}）` : '（无基线）'}`,
    `- 覆盖：${report.coverage.valid}/${report.coverage.expected.length}${report.coverage.full ? '（全量）' : '（非全量）'}`,
    `- 报告：${report.scope?.output?.reportJson ?? report.runId}`,
  ]
  for (const reason of gate.reasons) lines.push(`- ${reason}`)
  if (stale) {
    lines.push('')
    lines.push(`提示：报告生成后${stale}，建议重新运行 /logi-full 后再判断。`)
  }
  if (!comparison.hasBaseline && gate.status !== 'warn') {
    lines.push('')
    lines.push('提示：运行 /logi-gate accept 可将最近一次全量报告接受为基线。')
  }
  return lines.join('\n')
}

function runGate(invocation) {
  if (invocation.signal?.aborted) return errorResult('命令已取消。')
  const cwd = resolveCwd(invocation)
  const root = gitRoot(cwd) ?? cwd
  const input = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
  const accept = /^accept(?:\s|$)/i.test(input)
  if (input && !accept) {
    return errorResult('参数无效。用法：/logi-gate（检查最近报告）或 /logi-gate accept（接受最近全量报告为基线）。')
  }

  const latest = readLatestReport(root)
  if (!latest) {
    return errorResult('还没有可用的后勤报告。请先运行 /logi-full（或 /logi）。')
  }
  const { report } = latest
  const stale = staleReason(root, report)
  if (accept) {
    if (!report.coverage?.full) {
      return errorResult(`最近报告不是完整覆盖（${report.coverage?.valid ?? '?'}/${PASS_LIST.length}），不能接受为基线。请先运行 /logi-full。`)
    }
    if (stale) {
      return errorResult(`报告生成后${stale}，不能接受过期基线。请先重新运行 /logi-full。`)
    }
    const accepted = acceptBaseline({ root, report })
    return successResult([
      `已接受基线：${accepted.path}`,
      `- 条目：${accepted.count}`,
      `- 健康分：${accepted.score}`,
      `- 运行：${report.runId}`,
    ].join('\n'))
  }

  const { config } = loadConfig(root)
  const findings = report.findings.map((finding) => ({
    ...finding,
    fingerprint: finding.fingerprint || fingerprint(finding),
  }))
  const coverage = {
    ...report.coverage,
    full: report.coverage?.full === true
      || Boolean(report.coverage?.complete && report.coverage?.expected?.length === PASS_LIST.length),
  }
  const comparison = compareToBaseline({
    root,
    findings,
    passes: report.coverage?.expected ?? PASS_LIST.map((pass) => pass.key),
    score: report.score.value,
    complete: coverage.full,
  })
  const gate = evaluateGate({ comparison, coverage, config })
  return successResult(gateText({ gate, comparison, report, stale }))
}

function pipelineSpec(pluginRoot, command, mode) {
  return {
    pluginRoot,
    command,
    mode,
    handler: (invocation) => runPipeline(invocation, { pluginRoot, command, mode }),
  }
}

function singleSpec(pluginRoot, pass) {
  const command = `/logi-${pass.key}`
  return {
    pluginRoot,
    command,
    pass: pass.key,
    handler: (invocation) => runSingle(invocation, { pluginRoot, command, pass: pass.key }),
  }
}

/**
 * Build the twelve DSH command definitions. Keeping them as data makes the
 * registration loop in lib/index.js trivial and lets tests assert names,
 * descriptions, and input hints without a live DSH context.
 */
export function createCommands({ pluginRoot }) {
  const specs = [
    pipelineSpec(pluginRoot, '/logi', 'auto'),
    pipelineSpec(pluginRoot, '/logi-quick', 'quick'),
    pipelineSpec(pluginRoot, '/logi-standard', 'standard'),
    pipelineSpec(pluginRoot, '/logi-full', 'full'),
    ...PASS_LIST.map((pass) => singleSpec(pluginRoot, pass)),
    {
      pluginRoot,
      command: '/logi-gate',
      handler: runGate,
    },
  ]

  return specs.map((spec) => {
    if (spec.command === '/logi-gate') {
      return {
        name: 'logi-gate',
        description: '基线门禁：检查最近报告；accept 接受最近一次全量报告为基线',
        input: {
          hint: 'accept = 接受最近全量报告为基线；留空 = 检查门禁',
          attachments: false,
        },
        handler: spec.handler,
      }
    }
    if (spec.pass) {
      const pass = PASS_BY_KEY[spec.pass]
      return {
        name: spec.command.slice(1),
        description: `${pass.title}：由 ${pass.expert} 单专家执行`,
        input: {
          hint: '可选：补充本次审查重点，例如“只关注支付流程”',
          attachments: false,
        },
        handler: spec.handler,
      }
    }
    const tier = spec.mode === 'auto' ? undefined : TIERS[spec.mode]
    return {
      name: spec.command.slice(1),
      description: tier
        ? `${tier.label}档后勤：${tier.passes.map((key) => PASS_BY_KEY[key].title).join('、')}`
        : '自动后勤：评估改动风险，选择快速/标准/全量档并调度专家',
      input: {
        hint: '可选：补充本次审查重点，例如“只关注支付流程”',
        attachments: false,
      },
      handler: spec.handler,
    }
  })
}
