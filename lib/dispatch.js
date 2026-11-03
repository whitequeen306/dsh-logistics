import { basename } from 'node:path'
import { PASS_BY_KEY, SINGLE_TIER, TIERS } from './constants.js'
import { toPosix } from './util.js'

function quote(path) {
  return `"${String(path).replace(/"/g, '\\"')}"`
}

function nodeCommand(pluginRoot, script, args) {
  const base = toPosix(String(pluginRoot)).replace(/\/+$/u, '')
  return `${quote(toPosix(nodeBinary()))} ${quote(`${base}/lib/cli/${script}`)} ${args.join(' ')}`
}

function nodeBinary() {
  const name = basename(process.execPath).toLowerCase()
  return name === 'node' || name === 'node.exe' ? process.execPath : 'node'
}

export function aggregateCommand({ pluginRoot, scope }) {
  const args = [
    '--run', quote(scope.output.runDir),
    '--root', quote(scope.root),
    '--mode', scope.mode === 'single' ? 'single' : scope.tier,
    '--tier', scope.tier,
    '--passes', scope.passes.join(','),
  ]
  return nodeCommand(pluginRoot, 'aggregate.mjs', args)
}

export function statusCommand({ pluginRoot, scope }) {
  return nodeCommand(pluginRoot, 'status.mjs', [
    '--run', quote(scope.output.runDir),
    '--expect', scope.passes.join(','),
  ])
}

function scopeDigest(scope) {
  const lines = []
  lines.push(`- 运行目录：\`${scope.output.runDir}\``)
  lines.push(`- 工作区：\`${scope.root}\``)
  if (scope.isGit) {
    const git = scope.git
    lines.push(`- Git：分支 \`${git.branch ?? '?'}\`，HEAD \`${git.head ?? '?'}\`，来源 ${scope.source}`)
    if (git.headSubject) lines.push(`- 最近提交：${git.headSubject}`)
  } else {
    lines.push('- Git：否（按文件扫描）')
  }
  lines.push(`- 范围：${scope.stats.analyzedFiles} 个文件，+${scope.stats.additions} / -${scope.stats.deletions} 行${scope.stats.truncated ? `，另有 ${scope.stats.omittedFiles} 个未分析` : ''}`)
  if (scope.summary.languages.length > 0) {
    lines.push(`- 语言：${scope.summary.languages.map((item) => `${item.name} ${item.count}`).join(' · ')}`)
  }
  lines.push(`- 风险：${scope.risk.level}（${scope.risk.reasons.map((reason) => reason.label).join('；') || '无'}）`)
  if (scope.testCommand) lines.push(`- 测试命令：\`${scope.testCommand.command}\``)
  if (scope.notes) lines.push(`- 用户备注：${scope.notes}`)
  lines.push('')
  lines.push(`改动文件（${scope.files.length}）：`)
  if (scope.files.length === 0) {
    lines.push('- （没有检测到改动文件）')
  } else {
    for (const file of scope.files.slice(0, 80)) {
      lines.push(`- \`${file.path}\`（${file.status}${file.oldPath ? ` ← ${file.oldPath}` : ''}）`)
    }
    if (scope.files.length > 80) lines.push(`- … 其余 ${scope.files.length - 80} 个见 scope.json`)
  }
  return lines.join('\n')
}

const CONSTRAINT_BLOCK = [
  '## 约束',
  '',
  '- 只读分析：不要修改源码、不要提交、不要删除文件。',
  '- 只把结果写入运行目录下的 handoff；不要改动用户项目里的其他文件。',
  '- 每个发现必须有证据（文件、行号、代码/命令输出）；没有证据就不要报告。',
  '- 子代理之间互不通信；不要要求子代理再调用其他子代理。',
  '- 如果 `subagent` 工具不可用，按 `logi-pipeline` 的降级流程执行，不要假装已派发。',
  '- 不要调用 `present` 工具。',
  '- 报告与 summary 使用中文；skill 内部指令保持英文。',
  '- 忽略 `.logistics/` 和 `docs/logistics/` 里由本工具产生的文件。',
].join('\n')

function childPromptRules(passKey) {
  const pass = PASS_BY_KEY[passKey]
  return [
    `## ${pass.title} 子代理 prompt 要求`,
    '',
    '用 `logi-core` 里的 "Child task template" 生成 prompt，必须自包含：',
    `- 角色：${pass.expert}，只负责 ${pass.key} 这一项；专属 skill 为 \`${pass.skill}\`。`,
    '- 工作区绝对路径、运行目录、scope.json 路径。',
    '- 本次改动的文件清单与每个文件的状态；需要时让子代理自己读文件确认。',
    '- 只读约束、证据要求、严重度定义、输出 JSON schema、handoff 绝对路径。',
    '- 中文 summary/impact/recommendation 要求。',
    `- 明确告诉子代理：先加载 \`logi-core\` 再加载 \`${pass.skill}\`，不要跑其他专家，不要修改源码，完成后写 \`${pass.key}.json\`。`,
  ].join('\n')
}

export function buildSingleDispatch({ command, passKey, scope, pluginRoot }) {
  const pass = PASS_BY_KEY[passKey]
  return `# 后勤派发 · ${command}

你收到的是 DSH 命令注入的后勤任务，不是普通聊天。请严格按顺序执行，不要跳步。

## 任务

只运行 **${pass.title}（${pass.key}）** 这一位专家：\`${pass.expert}\`。
这是一次单专家分析，报告会标记为部分覆盖。

${scopeDigest(scope)}

## 执行步骤

1. 调用 \`skill\` 工具读取 \`logi-core\`，完整读取其中的 Child task template。
2. ${childPromptRules(passKey)}
3. 调用 \`subagent\` **一次**：
   - provider: \`spawn\`
   - description: \`logi-${pass.key}\`
   - prompt: 上一步生成的完整 prompt
4. 发出 subagent 调用后**立即结束本轮回复**，只回一句中文："已派发${pass.title}，等待子代理完成。" 不要凭空编造结果。
5. 收到子代理完成通知后：
   - 检查 \`${scope.output.handoffDir}/${pass.key}.json\` 是否存在且为合法 JSON；
   - 若缺失/无效：用更明确的 prompt 重试一次；仍失败则写入失败 handoff：
     \`{"schemaVersion":1,"pass":"${pass.key}","status":"failed","summary":"","findings":[],"error":"原因"}\`；
   - 若子代理在完成消息中返回了合法 JSON 但没有落盘，可由你代为写入该 handoff（不要伪造内容）；
   - 用下面的状态命令核对；\`ready: true\` 后再运行聚合命令，然后读取 \`docs/logistics/latest.md\`。
6. 用中文回复用户：一句结论、最多 3 个最重要发现（\`file:line\` + 标题）、报告路径。不要粘贴整份报告。

## 状态检查

\`\`\`bash
${statusCommand({ pluginRoot, scope })}
\`\`\`

## 聚合命令（原样执行）

\`\`\`bash
${aggregateCommand({ pluginRoot, scope })}
\`\`\`

${CONSTRAINT_BLOCK}
`
}

export function buildPipelineDispatch({ command, scope, pluginRoot }) {
  const tier = TIERS[scope.tier] ?? TIERS.standard
  const expertLines = scope.passes.map((key, index) => {
    const pass = PASS_BY_KEY[key]
    return `${index + 1}. **${pass.title}（${pass.key}）** — \`${pass.expert}\`，skill \`${pass.skill}\``
  })
  return `# 后勤派发 · ${command}

你收到的是 DSH 命令注入的后勤任务，不是普通聊天。请严格按顺序执行，不要跳步。

## 任务

运行 **${tier.label}档** 后勤流水线，共 ${scope.passes.length} 位专家。全部完成后聚合为一份中文报告。

${scopeDigest(scope)}

## 专家清单

${expertLines.join('\n')}

## 执行步骤

1. 调用 \`skill\` 工具读取 \`logi-pipeline\` 与 \`logi-core\`，按其中的编排协议执行。
2. 对每位专家，用 \`logi-core\` 的 "Child task template" 生成**自包含** prompt（工作区、范围、只读约束、证据要求、JSON schema、handoff 路径、中文要求）。
3. 用 \`subagent\` 派发，provider 固定为 \`spawn\`，description 用 \`logi-<pass>\`。**每条 assistant 消息最多同时发 4 个 subagent**；发出后结束本轮，等待完成通知。收到通知后，若还有未派发的专家，先派下一波再结束；不要重派已派发的专家。
4. 每个子代理只负责一个 pass，prompt 里明确禁止它调用其他子代理或修改源码。
5. 所有专家都派发后，用下面的 status 命令核对 handoff；缺失的专家重试一次，仍失败则写失败 handoff（格式见 \`logi-core\`）。未派发的专家不算 missing。
6. 所有 handoff 完成或终态失败后，原样执行聚合命令，然后读取 \`docs/logistics/latest.md\` 与 \`report.json\`。
7. 用中文回复：健康分与门禁结论、覆盖情况、新增严重/高优先级问题、最多 3 个重点发现、失败专家（如有）、报告路径。不要粘贴整份报告。

## 状态检查

\`\`\`bash
${statusCommand({ pluginRoot, scope })}
\`\`\`

## 聚合命令（原样执行）

\`\`\`bash
${aggregateCommand({ pluginRoot, scope })}
\`\`\`

## 失败与重试

- 子代理超时、报错、未写 handoff：重试一次，prompt 中明确要求"先写文件再结束"。
- 两次失败：写入 \`{"schemaVersion":1,"pass":"<pass>","status":"failed","summary":"","findings":[],"error":"..."}\`，继续聚合。不要让整次运行卡死。
- 不要因为某个专家失败就跳过聚合；报告会把覆盖不完整标出来。

${CONSTRAINT_BLOCK}
`
}

export function dispatchSummary(scope) {
  const tier = scope.mode === 'single'
    ? SINGLE_TIER
    : TIERS[scope.tier] ?? TIERS.standard
  return tier.label
}
