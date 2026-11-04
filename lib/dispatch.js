import { basename, resolve } from 'node:path'
import { DEFAULT_EXPERTS, EXPERT_BY_KEY, EXPERT_LIST } from './constants.js'
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

export function collectCommand({ pluginRoot, scope }) {
  return nodeCommand(pluginRoot, 'collect.mjs', [
    '--run', quote(scope.output.runDir),
  ])
}

export function bundleCommand({ pluginRoot, scope }) {
  return nodeCommand(pluginRoot, 'bundle.mjs', [
    '--run', quote(scope.output.runDir),
  ])
}

export function verdictCommand({ pluginRoot, scope }) {
  return nodeCommand(pluginRoot, 'verdict.mjs', [
    '--run', quote(scope.output.runDir),
  ])
}

function modelRoutingBlock(scope) {
  const entries = Object.entries(scope.models ?? {})
  const lines = ['## 模型路由（可选）', '']
  if (entries.length === 0) {
    lines.push('没有配置 per-expert 模型；全部使用父会话当前模型。')
  } else {
    lines.push('项目配置了以下专家模型路由；派发对应专家时优先使用：')
    for (const [key, route] of entries) {
      const effort = route.reasoningEffort ? `，reasoning_effort: ${route.reasoningEffort}` : ''
      lines.push(`- ${key}: provider \`${route.provider}\`，model \`${route.model}\`${effort}`)
    }
    lines.push('')
    lines.push('只有 DSH 允许子代理模型选择时才传 `provider` / `model` / `reasoning_effort`；如果工具报“不支持子代理模型选择”或路由不被允许，**去掉这些字段重试**，不要因此中断任务。')
  }
  lines.push('')
  return lines.join('\n')
}

function optionalExpertBlock(scope) {
  const optional = (scope.optionalExperts ?? []).filter((key) => key === 'perf')
  if (optional.length === 0) return ''
  const info = EXPERT_BY_KEY.perf
  return `## 可选专家（性能）

默认不派发性能专家。先读 \`scope.json\` 的 files/summary：只有当改动明确涉及热路径（数据库查询/索引、请求链路、渲染循环、大列表、缓存/序列化、启动路径）时，才追加这一位；不要仅因为文件多就加。不追加时，最终报告写“性能未覆盖”。

如果决定追加，把下面 prompt 逐字交给一个额外的 subagent：

\`\`\`\`text
${buildChildPrompt({ expertKey: info.key, scope })}
\`\`\`\`

`
}

function verdictFormatBlock(scope) {
  return `## 主编裁决格式

把最终裁决写到 \`${scope.output.verdictJson}\`，机器只校验 contract，不替你判断内容：

\`\`\`json
{
  "schemaVersion": 2,
  "runId": "${scope.runId}",
  "generatedAt": "ISO-8601",
  "coverage": {
    "expected": ${JSON.stringify(scope.experts)},
    "received": ["…实际收到的专家…"],
    "missing": [],
    "complete": true
  },
  "findings": [
    {
      "id": "COR-4F2A1",
      "expert": "correctness",
      "module": "src/auth",
      "section": "logic",
      "severity": "high",
      "confidence": "high",
      "title": "一句话问题",
      "file": "src/auth/session.js",
      "line": 42,
      "evidence": "可复现的证据，保留关键代码/命令输出",
      "impact": "会造成什么后果",
      "kind": "direct",
      "fix": {
        "summary": "怎么修",
        "steps": ["步骤 1", "步骤 2", "步骤 3"],
        "files": ["src/auth/session.js"],
        "tests": ["应补的测试"]
      }
    }
  ],
  "deferred": [
    {
      "from": "security",
      "expert": "correctness",
      "file": "src/migrations/V57.sql",
      "lines": "15-18",
      "summary": "迁移绕过事件日志，属于 correctness 问题（不要塞进 security findings）"
    }
  ],
  "dropped": [{ "id": "SEC-AB12C", "reason": "与 COR-4F2A1 是同一根因，合并" }]
}
\`\`\`

规则：
- \`findings\` 只放你确认保留的项；被合并/丢弃的写进 \`dropped\` 并说明原因。
- \`deferred\` 收集所有 handoff 的跨专家转交项；每条必须有 \`from\`（来源专家）、目标 \`expert\`（可空）、\`summary\`，不能静默丢弃。
- \`id\` 从 handoff / packet 中的候选 ID 复制，不要自己发明。
- 每个 finding 必须有非空 evidence；critical/high 没有证据就降级或丢弃。
- \`kind: direct\` 才允许 \`/logi-fix\`；性能问题一律 \`plan\`。
- \`coverage.missing\` 必须诚实；缺 handoff 不能写成“没有发现问题”。

`
}

function editorReportBlock(scope) {
  const fullDefault = DEFAULT_EXPERTS.every((key) => (scope.experts ?? []).includes(key))
  const latestRule = fullDefault
    ? `只有当 **默认四位专家**（${DEFAULT_EXPERTS.join('、')}）完整覆盖时，才把这份报告复制到 \`${scope.output.latestMarkdown}\`，并写指针 \`${scope.output.latestJson}\`：`
    : '本次是单模块或非默认组合：**不要**更新 latest；只写本次 run 的 report.md 与 verdict.json。'
  return `## 最终报告

写 \`${scope.output.reportMarkdown}\`，中文，至少包含：

1. 一句话结论 + 本次覆盖范围（哪些模块跑了、哪些没跑）
2. 按模块组织的发现：模块名、严重度、标题、\`file:line\`、证据摘要、修复摘要
3. 建议修复顺序（同文件合并、根因优先；maintainability/perf 单独批次）
4. 覆盖缺口 / 失败专家（如果有）
5. 跨专家 \`deferred\`：转交给谁、文件、原因；不能因为不在本次模块里就省略

不要写健康分、评分、基线或门禁。报告是给人读的，不是 JSON 的复述。

${latestRule}

\`\`\`json
{"runId":"${scope.runId}","reportPath":"${scope.output.reportMarkdown}","verdictPath":"${scope.output.verdictJson}","coverageComplete":true}
\`\`\`

单模块、追加 perf 但默认四模块不完整、或有 missing/invalid/failed 时，**不要**更新 latest；在最终回复里说明原因。

`
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
    `- 关注面：${info.focus}。`,
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

你收到的是 DSH 命令注入的后勤任务，不是普通聊天。**你是这次单模块审查的主编**：机器只负责范围、收集和 contract 校验；判断与成文由你完成。

## 任务

只运行 **${info.title}（${info.key}）** 这一位专家：\`${info.expert}\`。
这是一次单模块分析：只覆盖 ${info.key}，不会更新 latest，其他模块未覆盖。

${scopeDigest(scope)}
${modelRoutingBlock(scope)}
## 执行步骤

1. 调用 \`subagent\` **一次**，使用下面的 prompt：
   - description: \`logi-${info.key}\`
   - prompt: **逐字使用**代码块里的内容
   - 如果项目配置了该专家的模型路由，按“模型路由”一节传 provider/model/reasoning_effort；被拒绝就去掉重试
2. 发出 subagent 调用后**立即结束本轮回复**，只回一句中文：“已派发${info.title}，等待子代理完成。” 不要凭空编造结果。
3. 收到完成通知后：
   - 检查 \`${scope.output.handoffDir}/${info.key}.json\` 是否存在且合法；
   - 缺失/无效：用同一 prompt 重试一次；仍失败则写失败 handoff：
     \`{"schemaVersion":2,"expert":"${info.key}","status":"failed","summary":"未能完成分析","findings":[],"sections":{},"error":"原因"}\`
   - 先运行 collect 查看库存（advisory，不是质量门），再运行 bundle 生成主编材料，读 \`packet.md\` 和 handoff。
4. 作为主编：核对证据，保留/丢弃，写 \`${scope.output.verdictJson}\`（schema 同多模块，但 coverage.expected 只有 \`${info.key}\`）和 \`${scope.output.reportMarkdown}\`；然后运行 verdict 校验。
5. 单模块运行**不要**更新 \`${scope.output.latestMarkdown}\` 或 \`.logistics/latest.json\`。
6. 中文回复：一句话结论、最多 3 个最重要发现（ID + file:line + 标题）、报告路径；不要粘贴整份报告。

## 子代理 prompt（逐字使用）

\`\`\`\`text
${buildChildPrompt({ expertKey, scope })}
\`\`\`\`

## 主编材料命令

\`\`\`bash
${collectCommand({ pluginRoot, scope })}
${bundleCommand({ pluginRoot, scope })}
\`\`\`

## verdict 校验命令

\`\`\`bash
${verdictCommand({ pluginRoot, scope })}
\`\`\`

${verdictFormatBlock(scope)}
${editorReportBlock(scope)}
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
    : '\n> 性能模块默认不派发；只有 scope 显示明确热路径时才追加，否则报告必须写“性能未覆盖”。\n'
  return `# 后勤派发 · ${command}

你收到的是 DSH 命令注入的后勤任务，不是普通聊天。**你是这次审查的主编**：机器只负责范围、收集和 contract 校验；派发、阅读 handoff、合并、定级、取舍和最终成文都由你完成。

## 任务

先读 \`${scope.output.runDir}/scope.json\`，默认运行 ${scope.experts.length} 位专家（${scope.experts.join('、')}）。${perfNotice}

${scopeDigest(scope)}
${modelRoutingBlock(scope)}
## 专家清单

${expertLines.join('\n')}

## 子代理 prompts（逐字使用）

${scope.experts.map((key) => `### ${key}\n\`\`\`\`text\n${buildChildPrompt({ expertKey: key, scope })}\n\`\`\`\``).join('\n\n')}

${optionalExpertBlock(scope)}
## 执行步骤

1. 读 \`scope.json\`，确认默认四位专家；如需追加 perf，按上面的“可选专家”判断并在回复里说明理由。
2. 对每位专家，直接复制对应 prompt，**不要改写、不要省略路径或 schema**。用 \`subagent\` 派发，description 用 \`logi-<expert>\`；**每条 assistant 消息最多同时发 4 个 subagent**；发出后结束本轮，等待完成通知。收到通知后，若还有未派发的专家，先派下一波再结束；不要重派已派发的专家。
3. 所有专家都派发后，运行下面的 collect 命令做**收集**（不是质量门禁）。缺失/无效/失败的专家重试一次；仍失败就写失败 handoff：
   \`{"schemaVersion":2,"expert":"<expert>","status":"failed","summary":"未能完成分析","findings":[],"sections":{},"error":"..."}\`
   未派发的专家不算 missing；不要把缺失当成“没有问题”。
4. 运行 bundle 命令，生成主编材料。然后**自己读** \`packet.md\` 和原始 handoff；不要只信机器摘要。
5. 作为主编做裁决：
   - 逐条核对证据，合并跨专家重复项；同一根因保留证据最强的一条，其余写入 \`dropped\`。
   - 决定最终 severity/confidence；critical/high 必须有可复现证据。
   - 按模块组织报告；不要输出分数、基线或门禁。
   - 写 \`${scope.output.verdictJson}\` 和 \`${scope.output.reportMarkdown}\`，格式见下。
6. 运行 verdict 校验命令；有 contract 错误就修正后重跑。校验通过不等于质量通过，覆盖缺口仍要在报告和回复里说明。
7. 只有默认四位完整覆盖时，才更新 latest（见下）。最后用中文回复：一句话结论、覆盖情况、最多 3 个重点发现（ID + file:line）、失败/缺失专家、报告路径；不要粘贴整份报告。

## 收集命令（不是门禁）

\`\`\`bash
${collectCommand({ pluginRoot, scope })}
\`\`\`

## 主编材料命令

\`\`\`bash
${bundleCommand({ pluginRoot, scope })}
\`\`\`

## verdict 校验命令

\`\`\`bash
${verdictCommand({ pluginRoot, scope })}
\`\`\`

${verdictFormatBlock(scope)}
${editorReportBlock(scope)}
## 失败与重试

- 子代理超时、报错、未写 handoff：重试一次，prompt 中明确要求“先写文件再结束”。
- 两次失败：写入失败 handoff，继续；最终报告必须列出该专家未覆盖。
- 不要因为某个专家失败就伪造 findings；也不要让整次运行卡死。

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

export function buildFixDispatch({ source, selection, fixDir, pluginRoot }) {
  const items = selection.map(fixItem).join('\n\n')
  const allowed = [...new Set(selection.flatMap((finding) => finding.fix?.files ?? [finding.file]))]
  const testCommand = source.scope?.testCommand?.command
  const sourcePath = source.verdictPath ?? source.scope?.output?.verdictJson ?? source.runId
  const scopePath = source.scope?.output?.scopeJson ?? toPosix(resolve(source.scope.output.runDir, 'scope.json'))
  const selectionPath = source.selectionPath ?? toPosix(resolve(fixDir, 'selection.json'))
  return `# 后勤修复派发

你收到的是一个**写操作**任务，只修复下面列出的 direct 发现。

## 运行信息

- 工作区：\`${source.scope.root}\`
- 来源裁决：\`${sourcePath}\`
- 范围快照：\`${scopePath}\`
- 选择清单：\`${selectionPath}\`
- 修复目录：\`${toPosix(fixDir)}\`
- 允许修改的文件（白名单）：
${allowed.map((file) => `  - \`${file}\``).join('\n')}
- 测试命令：${testCommand ? `\`${testCommand}\`` : '（未检测到，标记“未验证”）'}

## 要修复的发现

${items}

## 执行步骤

1. 调用 \`skill\` 工具读取 \`logi-fix\`，严格按其中的修复协议执行。
2. 先读 \`selection.json\`、来源裁决和范围快照；确认所选 ID 的 \`kind\`/文件白名单与 \`selection.json\` 一致。
3. 逐个 ID 阅读相关文件和证据；只改白名单内文件，不改无关格式，不重排代码。
4. 修改完成后，运行上面的测试命令；没有测试命令就明确记录“未验证”。
5. 按 \`logi-fix\` 的完整 schema 写 \`fix.json\`（\`items\` 数组，每项含 id/status/files/tests/notes）。
6. 如果测试失败或改动越界：先保存 \`fix-reverted.patch\`，再回滚该组改动；不要 commit，不要 push，不要安装依赖。
7. 最终用中文回复：修了哪些 ID、改了哪些文件、测试结果、未完成项。不要粘贴整份 diff。

## 约束

- 只在白名单文件内修改；新增文件必须属于修复所需并在 notes 说明。
- 不执行 git commit / git push / 包管理器安装 / 网络请求。
- 不修改 \`.logistics/\`、\`docs/logistics/\` 之外的报告文件。
- 不调用其他子代理，不调用 \`present\`。
- 如果无法安全修复，写 \`status: failed\` 并说明原因，不要强行改。
`
}
