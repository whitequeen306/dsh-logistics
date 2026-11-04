import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { DEFAULT_EXPERTS, EXPERT_BY_KEY, EXPERT_LIST } from './constants.js'
import { loadConfig } from './config.js'
import { createScope, expandUntrackedDirs, isGeneratedPath, parseStatusZ } from './scope.js'
import { readLatestCompleteVerdict } from './verdict.js'
import { buildChildPrompt, buildFixDispatch, buildProjectDispatch } from './dispatch.js'
import { handoffPattern } from './handoff-paths.js'
import { appendRunLog, writeRunText } from './runlog.js'
import { testCommandLines, testCommandText } from './test-command.js'
import { ensureDir, git, gitRoot, makeRunId, nowIso, toPosix, writeJsonFile } from './util.js'

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

function scopeLine(scope) {
  if (scope.mode === 'project') {
    return `全项目 ${scope.stats.analyzedFiles} 个文件 / ${scope.project.units.length} 个审查单元 / ${scope.stats.additions} 行`
  }
  return `${scope.stats.analyzedFiles} 个文件（+${scope.stats.additions}/-${scope.stats.deletions}）`
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
  try {
    agent.followup(userMessage(text))
  } catch (error) {
    return errorResult(`派发后续任务失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return undefined
}

function noFilesResult() {
  return errorResult(
    '没有检测到可分析的项目文件。请确认仓库里有受版本控制的源码，并检查 .logistics/config.json 的 ignore 是否排除了整个项目。',
  )
}

function runReport(invocation, spec) {
  if (invocation.signal?.aborted) return errorResult('命令已取消。')
  const cwd = resolveCwd(invocation)
  const root = gitRoot(cwd) ?? cwd
  const { config, warnings } = loadConfig(root)
  const notes = typeof invocation.rawInput === 'string' ? invocation.rawInput : ''
  const experts = spec.experts.filter((key) => EXPERT_BY_KEY[key])
  if (experts.length === 0) return errorResult('未选择专家。')

  let created
  try {
    created = createScope({
      cwd,
      command: spec.command,
      experts,
      notes,
      config,
      mode: 'project',
    })
  } catch (error) {
    return errorResult(`无法准备工作区：${error instanceof Error ? error.message : String(error)}`)
  }

  const { scope } = created
  appendRunLog(scope.output.runDir, 'scope.created', {
    command: scope.command,
    runId: scope.runId,
    root: scope.root,
    experts: scope.experts,
    optionalExperts: scope.optionalExperts,
    source: scope.source,
    mode: scope.mode,
    analyzedFiles: scope.stats.analyzedFiles,
    units: scope.project?.units.length ?? 0,
    additions: scope.stats.additions,
    deletions: scope.stats.deletions,
    testCommand: scope.testCommand?.command ?? null,
    testCommands: scope.testCommands ?? (scope.testCommand ? [scope.testCommand] : []),
  })
  if (scope.stats.analyzedFiles === 0) {
    appendRunLog(scope.output.runDir, 'scope.empty', { message: '没有检测到可分析的项目文件' })
    return noFilesResult()
  }

  for (const expert of scope.experts) {
    writeRunText(
      scope.output.runDir,
      `prompts/${expert}.md`,
      buildChildPrompt({ expertKey: expert, scope }),
    )
  }

  const titles = scope.experts.map((key) => EXPERT_BY_KEY[key].title)
  const lines = [
    `已派发 ${spec.command} · ${scope.experts.length} 位专家 · 全项目`,
    `- 运行：${scope.runId}`,
    `- 范围：${scopeLine(scope)}`,
    `- 专家：${titles.join('、')}`,
    `- 核心报告：${scope.output.reportMarkdown}（本次任务的核心交付物，完成后生成）`,
    `- 专家报告：${toPosix(scope.output.handoffDir)}/${handoffPattern(scope, 'md').replace(/^handoff\//u, '')}（共 ${scope.experts.length} 份，完成后生成）`,
    `- 机器判决：${scope.output.verdictJson}（完成后生成，供 /logi-fix 使用）`,
    ...testCommandLines(scope),
  ]
  if (!scope.experts.includes('perf')) {
    lines.push('- 性能模块本次未运行；需要时执行 `/logi-perf`。')
  }
  appendWarnings(lines, warnings)
  lines.push('')
  lines.push('子代理完成后我会继续汇总。')

  const dispatch = buildProjectDispatch({
    command: spec.command,
    scope,
    pluginRoot: spec.pluginRoot,
  })
  writeRunText(scope.output.runDir, 'dispatch.md', dispatch)
  appendRunLog(scope.output.runDir, 'dispatch.queued', {
    command: spec.command,
    experts: scope.experts,
    promptChars: dispatch.length,
    dispatchPath: toPosix(resolve(scope.output.runDir, 'dispatch.md')),
  })
  const failure = queueDispatch(invocation, dispatch)
  appendRunLog(scope.output.runDir, failure ? 'dispatch.failed' : 'dispatch.accepted', {
    message: failure?.text ?? '已注入后续任务',
  })
  return failure ?? successResult(lines.join('\n'))
}

const STALE_LABELS = {
  head: 'HEAD 已变化',
  dirty: '工作区状态已变化',
}

function currentSourceDirty(root) {
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], root)
  if (!status.ok) return false
  return expandUntrackedDirs(root, parseStatusZ(status.stdout)).some((file) => !isGeneratedPath(file.path))
}

function staleReason(root, report) {
  const gitScope = report?.scope?.git
  if (!report?.scope?.isGit || !gitScope) return undefined
  const head = git(['rev-parse', '--short', 'HEAD'], root)
  if (head.ok && gitScope.head && head.stdout.trim() !== gitScope.head) return STALE_LABELS.head
  const dirty = currentSourceDirty(root)
  if (Boolean(gitScope.sourceDirty ?? gitScope.dirty) !== dirty) return STALE_LABELS.dirty
  return undefined
}

function formatFixPlan(finding) {
  const lines = [
    `- ${finding.id} · [${finding.severityLabel ?? finding.severity}] ${finding.title}`,
    `  - 位置：${finding.file}:${finding.line}`,
    `  - 文件：${(finding.fix?.files ?? [finding.file]).join('、')}`,
    `  - 测试：${(finding.fix?.tests ?? []).join('；') || '（无自动测试）'}`,
  ]
  for (const step of finding.fix?.steps ?? []) lines.push(`  - 步骤：${step}`)
  return lines.join('\n')
}

function parseFixInput(rawInput) {
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  const dryRun = tokens.includes('--dry-run')
  const ids = []
  for (const token of tokens) {
    if (token === '--dry-run') continue
    if (/^--/u.test(token)) return { error: `不支持的参数：${token}。支持 --dry-run；不支持 --all。` }
    ids.push(token.toUpperCase())
  }
  return { dryRun, ids: [...new Set(ids)] }
}

function selectFixFindings(source, ids) {
  const map = new Map((source.findings ?? []).map((finding) => [finding.id, finding]))
  const selected = []
  for (const id of ids) {
    const finding = map.get(id)
    if (!finding) return { error: `判决中没有 finding ${id}。` }
    if (finding.kind !== 'direct') {
      return { error: `${id} 是 plan 类型，需要人工方案，/logi-fix 不执行。` }
    }
    if (finding.expert === 'perf') {
      return { error: `${id} 属于性能模块，不能直接修复；请先确认方案。` }
    }
    selected.push(finding)
  }
  return { selected }
}

function runFix(invocation) {
  if (invocation.signal?.aborted) return errorResult('命令已取消。')
  const cwd = resolveCwd(invocation)
  const root = gitRoot(cwd) ?? cwd
  const latest = readLatestCompleteVerdict(root)
  if (!latest) {
    return errorResult('还没有完整的主编判决。请先运行 `/logi`（默认四位专家）并等 verdict.json 完整覆盖后再使用 `/logi-fix`。')
  }
  if (!latest.ok) {
    return errorResult([
      '最近的主编判决没有通过 contract 校验，修复前请先重新运行 /logi：',
      ...latest.errors.slice(0, 6).map((error) => `- ${error}`),
    ].join('\n'))
  }
  const { verdict, scope } = latest
  if (verdict.schemaVersion !== 2) {
    return errorResult(`判决 schemaVersion=${verdict.schemaVersion ?? '?'}，/logi-fix 需要 0.3.x 判决。请重新运行 /logi。`)
  }
  if (!verdict.coverage?.complete) {
    return errorResult('最近判决的覆盖不完整（有缺失/失败/部分专家），修复前请先重新运行 /logi，避免在不完整证据上改代码。')
  }

  const parsed = parseFixInput(invocation.rawInput)
  if (parsed.error) return errorResult(parsed.error)
  if (parsed.ids.length === 0) {
    return errorResult('请提供要修复的 finding ID，例如 `/logi-fix COR-4F2A1`；只支持按报告中的 ID 修复，不支持无参数列出或 --all。')
  }

  const selection = selectFixFindings(verdict, parsed.ids)
  if (selection.error) return errorResult(selection.error)

  if (parsed.dryRun) {
    return successResult([
      `修复计划（dry-run，未修改源码）：`,
      ...selection.selected.map(formatFixPlan),
      '',
      `测试命令：${testCommandText(scope, { empty: '（未检测到，执行时会标记“未验证”）' })}`,
      '去掉 --dry-run 后才会派发 fixer；不会自动 commit。',
    ].join('\n'))
  }

  if (!scope?.isGit) {
    return errorResult('修复需要 git 仓库：当前判决来自非 git 工作区。')
  }
  if (currentSourceDirty(root)) {
    return errorResult('工作区有未提交的源码改动，修复前请先提交或暂存（生成物除外）。')
  }
  const stale = staleReason(root, { scope })
  if (stale) {
    return errorResult(`判决生成后${stale}，证据可能过期。请重新运行 /logi 后再修复。`)
  }

  const allowed = [...new Set(selection.selected.flatMap((finding) => finding.fix?.files ?? [finding.file]))]
  if (allowed.length === 0) return errorResult('所选 finding 没有可修改的文件。')

  const fixDir = resolve(root, '.logistics', 'fixes', makeRunId())
  ensureDir(fixDir)
  const selectionPath = resolve(fixDir, 'selection.json')
  const head = git(['rev-parse', 'HEAD'], root).stdout.trim()
  appendRunLog(fixDir, 'fix.selection', {
    verdictRunId: verdict.runId,
    ids: selection.selected.map((finding) => finding.id),
    allowedFiles: allowed,
    head,
  })
  writeJsonFile(selectionPath, {
    schemaVersion: 2,
    verdictRunId: verdict.runId,
    verdictPath: verdict.verdictPath,
    scopePath: resolve(scope.output.runDir, 'scope.json'),
    createdAt: nowIso(),
    head,
    ids: selection.selected.map((finding) => finding.id),
    findings: selection.selected,
    allowedFiles: allowed,
    testCommand: scope?.testCommand,
    testCommands: scope?.testCommands ?? (scope?.testCommand ? [scope.testCommand] : []),
    root: toPosix(root),
  })

  const dispatch = buildFixDispatch({
    source: { scope, verdictPath: verdict.verdictPath, selectionPath, head },
    selection: selection.selected,
    fixDir,
    pluginRoot: undefined,
  })
  writeRunText(fixDir, 'dispatch.md', dispatch)
  appendRunLog(fixDir, 'fix.dispatch', {
    ids: selection.selected.map((finding) => finding.id),
    promptChars: dispatch.length,
  })
  const failure = queueDispatch(invocation, dispatch)
  appendRunLog(fixDir, failure ? 'fix.dispatch.failed' : 'fix.dispatch.accepted', {
    message: failure?.text ?? '已注入修复任务',
  })
  if (failure) return failure

  return successResult([
    `已派发修复：${selection.selected.map((finding) => finding.id).join('、')}`,
    `- 判决：${verdict.runId}`,
    `- 修复目录：${toPosix(fixDir)}`,
    `- 允许修改：${allowed.join('、')}`,
    `- 测试：${testCommandText(scope, { empty: '（未检测到，结果会标记“未验证”）' })}`,
    '- 不会自动 commit；失败会回滚并保留 patch。',
  ].join('\n'))
}

function reportSpec(pluginRoot, command, experts) {
  return {
    name: command.slice(1),
    description: command === '/logi'
      ? '全项目后勤：正确性、安全、健壮性、可维护性四位专家审查整个项目，生成一份完整报告'
      : `全项目${EXPERT_BY_KEY[experts[0]].title}：只运行 ${EXPERT_BY_KEY[experts[0]].title} 专家审查整个项目`,
    input: {
      hint: command === '/logi'
        ? '可选：补充全项目审查重点，例如“优先看鉴权与数据库”'
        : '可选：补充本项目审查重点',
      attachments: false,
    },
    handler: (invocation) => runReport(invocation, { pluginRoot, command, experts }),
  }
}

/**
 * Build the seven DSH command definitions. Keeping them as data makes the
 * registration loop in lib/index.js trivial and lets tests assert names,
 * descriptions, and input hints without a live DSH context.
 */
export function createCommands({ pluginRoot }) {
  return [
    reportSpec(pluginRoot, '/logi', [...DEFAULT_EXPERTS]),
    ...EXPERT_LIST.map((expert) => reportSpec(pluginRoot, `/logi-${expert.key}`, [expert.key])),
    {
      name: 'logi-fix',
      description: '按问题 ID 修复最近完整报告中的 direct 项；支持 --dry-run，不支持 --all',
      input: {
        hint: '<ID...> = 执行；--dry-run <ID...> = 只出计划；必须提供 ID',
        attachments: false,
      },
      handler: runFix,
    },
  ]
}
