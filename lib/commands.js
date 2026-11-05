import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { DEFAULT_EXPERTS, EXPERT_BY_KEY, EXPERT_LIST } from './constants.js'
import { loadConfig } from './config.js'
import { createScope } from './scope.js'
import { buildChildPrompt, buildProjectDispatch } from './dispatch.js'
import { handoffPattern } from './handoff-paths.js'
import { appendRunLog, writeRunText } from './runlog.js'
import { testCommandLines } from './test-command.js'
import { gitRoot, toPosix } from './util.js'

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
    `- 机器判决：${scope.output.verdictJson}（完成后生成，供机器校验）`,
    '- 产物目录不要提交：请确认 `.gitignore` 已忽略 `.logistics/` 和 `docs/logistics/`。',
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

const EXPERT_COMMAND_DESCRIPTIONS = Object.freeze({
  correctness: '全项目正确性审查：逻辑错误、状态与并发、数据一致性、接口契约、架构边界、数据库迁移和边界输入',
  security: '全项目安全体检：认证授权、注入、浏览器安全、上传/SSRF、密钥、加密、数据暴露和依赖供应链',
  reliability: '全项目健壮性审查：错误处理、失败传播、重试与幂等、超时清理、部分失败和测试/回归缺口',
  maintainability: '全项目可维护性审查：重复与耦合、过度抽象、死代码、孤儿文件、未用依赖和配置漂移',
  perf: '全项目性能审查：热路径复杂度、数据库访问、阻塞 I/O、前端渲染与包体、内存增长和启动',
})

function reportSpec(pluginRoot, command, experts) {
  return {
    name: command.slice(1),
    description: command === '/logi'
      ? '全项目后勤：正确性、安全、健壮性、可维护性四位专家审查整个项目，输出一份带证据、覆盖矩阵和修复顺序的总报告'
      : EXPERT_COMMAND_DESCRIPTIONS[experts[0]] ?? `全项目${EXPERT_BY_KEY[experts[0]].title}专家审查整个项目`,
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
 * Build the six DSH command definitions. Keeping them as data makes the
 * registration loop in lib/index.js trivial and lets tests assert names,
 * descriptions, and input hints without a live DSH context.
 */
export function createCommands({ pluginRoot }) {
  return [
    reportSpec(pluginRoot, '/logi', [...DEFAULT_EXPERTS]),
    ...EXPERT_LIST.map((expert) => reportSpec(pluginRoot, `/logi-${expert.key}`, [expert.key])),
  ]
}
