import { basename } from 'node:path'
import { EXPERT_BY_KEY } from './constants.js'
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
  return nodeCommand(pluginRoot, 'aggregate.mjs', [
    '--run', quote(scope.output.runDir),
  ])
}

export function statusCommand({ pluginRoot, scope }) {
  return nodeCommand(pluginRoot, 'status.mjs', [
    '--run', quote(scope.output.runDir),
    '--expect', scope.experts.join(','),
  ])
}

function scopeDigest(scope) {
  const lines = []
  lines.push(`- 运行目录：\`${scope.output.runDir}\``)
  lines.push(`- 工作区：\`${scope.root}\``)
  if (scope.isGit) {
    lines.push(`- Git：分支 \`${scope.git.branch ?? '?'}\`，HEAD \`${scope.git.head ?? '?'}\`，来源 ${scope.source}`)
    if (scope.git.headSubject) lines.push(`- 最近提交：${scope.git.headSubject}`)
  } else {
    lines.push('- Git：否（按文件扫描）')
  }
  lines.push(`- 范围：${scope.stats.analyzedFiles} 个文件，+${scope.stats.additions} / -${scope.stats.deletions} 行${scope.stats.truncated ? `，另有 ${scope.stats.omittedFiles} 个未分析` : ''}`)
  if (scope.summary.languages.length > 0) {
    lines.push(`- 语言：${scope.summary.languages.map((item) => `${item.name} ${item.count}`).join(' · ')}`)
  }
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
  '- 如果 `subagent` 工具不可用，直接停止并报告，不要降级为父代理自审。',
  '- 不要调用 `present` 工具。',
  '- 报告与 summary 使用中文；skill 内部指令保持英文。',
  '- 不要输出健康分、评分、基线或门禁结论；本版本只输出模块化问题与修复方案。',
  '- 忽略 `.logistics/` 和 `docs/logistics/` 里由本工具产生的文件。',
].join('\n')

export function buildChildPrompt({ expertKey, scope }) {
  const info = EXPERT_BY_KEY[expertKey]
  return [
    `你是 DSH Logistics 的 ${info.title} 专家（${info.expert}），只负责 ${info.key} 这一项。`,
    '',
    '## 范围',
    `- 工作区：\`${scope.root}\``,
    `- 运行目录：\`${scope.output.runDir}\``,
    `- 先读 scope.json：\`${scope.output.runDir}/scope.json\``,
    `- handoff 输出：\`${scope.output.handoffDir}/${info.key}.json\``,
    `- 本次改动 ${scope.files.length} 个文件；先读 scope.json 的 files，再按需读取源码、diff、测试和配置。`,
    '',
    '## 必读 skill',
    `调用 \`skill\` 读取 \`${info.skill}\`，严格按其中的章节和证据标准执行。`,
    '不要加载其他专家 skill，不要调用其他 subagent。',
    '',
    '## 覆盖要求',
    `- 只能使用这些 section：${info.sections.join(' / ')}。`,
    '- 每个 section 都必须检查并在 handoff 的 sections 中给出条数；0 表示“已检查且干净”，跳过则用 status=partial 并在 notes 说明，不要用 0 冒充已查。',
    '- sections 的计数必须与 findings 实际条数逐项一致，否则 handoff 会被判为无效。',
    '',
    '## 证据与输出',
    '- 每条 finding 必须包含：section、category、severity、confidence、title、file、line、evidence、impact、kind、fix。',
    '- severity 只能是 critical / high / medium / low / info；critical/high 必须有可复现证据，否则会被降为低置信度。',
    '- kind 只能是 direct（机械、低风险、可白名单内直接修）或 plan（需要人判断/设计）；性能问题一律 plan。',
    '- fix 必须包含 summary、steps（3-6 步）、files、tests；没有文件或步骤的 direct 会被降为 plan。',
    '- 最多 12 条发现；中文写 summary/impact/fix，代码和文件路径保持原样。',
    '',
    '## Handoff',
    `把 JSON 写到 \`${scope.output.handoffDir}/${info.key}.json\`，格式：`,
    '```json',
    '{"schemaVersion":2,"expert":"' + info.key + '","status":"ok|partial|failed","summary":"非空中文摘要","sections":{...},"findings":[...],"deferred":[],"notes":""}',
    '```',
    '先写文件，再结束回复；回复只需一句中文说明写了多少条发现。',
    '',
    '## 约束',
    '- 只读：不要修改源码、不要提交、不要删除文件。',
    '- 只写运行目录下的 handoff；不要改动用户项目里的其他文件。',
    '- 没有证据就不要报告；不要为了凑数报告推测。',
    '- 忽略 `.logistics/` 和 `docs/logistics/` 里由本工具产生的文件。',
  ].join('\n')
}

export function buildSingleDispatch({ command, expertKey, scope, pluginRoot }) {
  const info = EXPERT_BY_KEY[expertKey]
  return `# 后勤派发 · ${command}

你收到的是 DSH 命令注入的后勤任务，不是普通聊天。请严格按顺序执行，不要跳步。

## 任务

只运行 **${info.title}（${info.key}）** 这一位专家：\`${info.expert}\`。
这是一次单模块分析：只覆盖 ${info.key}，报告不会更新 latest，其他模块未覆盖。

${scopeDigest(scope)}

## 执行步骤

1. 父代理不需要加载专家 skill；下面已经给出完整的子代理 prompt。
2. 调用 \`subagent\` **一次**：
   - 不要传 provider：子代理后端由 DSH composition 决定
   - description: \`logi-${info.key}\`
   - prompt: **逐字使用**下面代码块里的内容
3. 发出 subagent 调用后**立即结束本轮回复**，只回一句中文："已派发${info.title}，等待子代理完成。" 不要凭空编造结果。
4. 收到子代理完成通知后：
   - 检查 \`${scope.output.handoffDir}/${info.key}.json\` 是否存在且为合法 JSON；
   - 若缺失/无效：用同一 prompt 重试一次；仍失败则写入失败 handoff：
     \`{"schemaVersion":2,"expert":"${info.key}","status":"failed","summary":"未能完成分析","findings":[],"sections":{},"error":"原因"}\`；
   - 若子代理在完成消息中返回了合法 JSON 但没有落盘，可由你代为写入该 handoff（不要伪造内容）；
   - 用下面的状态命令核对；\`ready: true\` 后再运行聚合命令，然后读取运行目录下的 \`report.md\`。
5. 用中文回复用户：一句结论、最多 3 个最重要发现（\`ID\` + \`file:line\` + 标题）、报告路径。不要粘贴整份报告。

## 子代理 prompt（逐字使用）

\`\`\`\`text
${buildChildPrompt({ expertKey, scope })}
\`\`\`\`

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
  const expertLines = scope.experts.map((key, index) => {
    const info = EXPERT_BY_KEY[key]
    return `${index + 1}. **${info.title}（${info.key}）** — \`${info.expert}\`，skill \`${info.skill}\``
  })
  const perfNotice = scope.experts.includes('perf')
    ? ''
    : '\n> 性能模块本次未运行；报告必须明确写“性能未覆盖”。\n'
  return `# 后勤派发 · ${command}

你收到的是 DSH 命令注入的后勤任务，不是普通聊天。请严格按顺序执行，不要跳步。

## 任务

运行 ${scope.experts.length} 位后勤专家，全部完成后聚合为一份按模块组织的中文报告。

${scopeDigest(scope)}
${perfNotice}
## 专家清单

${expertLines.join('\n')}

## 子代理 prompts（逐字使用）

${scope.experts.map((key) => `### ${key}\n\`\`\`\`text\n${buildChildPrompt({ expertKey: key, scope })}\n\`\`\`\``).join('\n\n')}

## 执行步骤

1. 你已经是编排者；不需要加载任何编排 skill，本消息就是完整协议。
2. 对每位专家，直接复制下方对应的 prompt，**不要改写、不要省略路径或 schema**。
3. 用 \`subagent\` 派发，**不要传 provider**（后端由 DSH composition 决定），description 用 \`logi-<expert>\`。**每条 assistant 消息最多同时发 4 个 subagent**；发出后结束本轮，等待完成通知。收到通知后，若还有未派发的专家，先派下一波再结束；不要重派已派发的专家。
4. 每个子代理只负责一个模块，prompt 里明确禁止它调用其他子代理或修改源码。
5. 所有专家都派发后，用下面的 status 命令核对 handoff；缺失/无效的专家重试一次，仍失败则写失败 handoff（格式见下方“失败与重试”）。未派发的专家不算 missing。
6. 所有 handoff 完成或终态失败后，原样执行聚合命令，然后读取运行目录下的 \`report.md\` 与 \`report.json\`。
7. 用中文回复：一句话结论、模块分布、覆盖情况、最多 3 个重点发现（ID + file:line）、失败/缺失专家（如有）、报告路径。不要粘贴整份报告，不要输出分数/基线/门禁。

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
- 两次失败：写入 \`{"schemaVersion":2,"expert":"<expert>","status":"failed","summary":"未能完成分析","findings":[],"sections":{},"error":"..."}\`，继续聚合。不要让整次运行卡死。
- 不要因为某个专家失败就跳过聚合；报告会把覆盖不完整标出来。

${CONSTRAINT_BLOCK}
`
}

function fixItem(finding) {
  return [
    `### ${finding.id} · [${finding.severityLabel ?? finding.severity}] ${finding.title}`,
    `- 模块：${finding.module}`,
    `- 专家：${finding.expert}（${finding.section}）`,
    `- 位置：\`${finding.file}:${finding.line}\``,
    `- 证据：${finding.evidence || '（无）'}`,
    `- 影响：${finding.impact || '（无）'}`,
    `- 修复建议：${finding.fix?.summary || '（无）'}`,
    '- 修复步骤：',
    ...(finding.fix?.steps ?? []).map((step, index) => `  ${index + 1}. ${step}`),
    `- 允许修改的文件：${(finding.fix?.files ?? [finding.file]).join('、')}`,
    `- 建议测试：${(finding.fix?.tests ?? []).join('；') || '（无自动测试）'}`,
  ].join('\n')
}

export function buildFixDispatch({ report, selection, fixDir, pluginRoot }) {
  const items = selection.map(fixItem).join('\n\n')
  const allowed = [...new Set(selection.flatMap((finding) => finding.fix?.files ?? [finding.file]))]
  const testCommand = report.scope?.testCommand?.command
  return `# 后勤修复派发

你收到的是一个**写操作**任务，只修复下面列出的 direct 发现。

## 运行信息

- 工作区：\`${report.scope.root}\`
- 来源报告：\`${report.scope.output?.reportJson ?? report.runId}\`
- 修复目录：\`${toPosix(fixDir)}\`
- 允许修改的文件（白名单）：
${allowed.map((file) => `  - \`${file}\``).join('\n')}
- 测试命令：${testCommand ? `\`${testCommand}\`` : '（未检测到，标记“未验证”）'}

## 要修复的发现

${items}

## 执行步骤

1. 调用 \`skill\` 工具读取 \`logi-fix\`，严格按其中的修复协议执行。
2. 逐个 ID 阅读相关文件和证据；只改白名单内文件，不改无关格式，不重排代码。
3. 修改完成后，运行上面的测试命令；没有测试命令就明确记录“未验证”。
4. 对每个 ID 在修复目录写 \`fix.json\`：\`{"id":"...","status":"fixed|partial|failed","files":[],"tests":[],"notes":"..."}\`。
5. 如果测试失败或改动越界：先保存 \`fix-reverted.patch\`，再回滚该组改动；不要 commit，不要 push，不要安装依赖。
6. 最终用中文回复：修了哪些 ID、改了哪些文件、测试结果、未完成项。不要粘贴整份 diff。

## 约束

- 只在白名单文件内修改；新增文件必须属于修复所需并在 notes 说明。
- 不执行 git commit / git push / 包管理器安装 / 网络请求。
- 不修改 \`.logistics/\`、\`docs/logistics/\` 之外的报告文件。
- 不调用其他子代理，不调用 \`present\`。
- 如果无法安全修复，写 \`status: failed\` 并说明原因，不要强行改。
`
}
