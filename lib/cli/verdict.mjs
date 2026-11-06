#!/usr/bin/env node
import { resolve } from 'node:path'
import { runExtraDirs, runExtraFiles } from '../artifacts.js'
import { writeGraph } from '../graph.js'
import { publishLatest } from '../latest.js'
import { redactArtifacts, scanArtifacts } from '../redact.js'
import { readScope } from '../scope.js'
import { markCompleted, readProgress, setPhase } from '../progress.js'
import { appendRunLog } from '../runlog.js'
import { readVerdict, summarizeVerdict, validateVerdict } from '../verdict.js'
import { toPosix } from '../util.js'
import { parseArgs, requireArg } from './args.mjs'

const args = parseArgs()
let runDir
try {
  runDir = resolve(requireArg(args, 'run'))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(3)
}

let scope
try {
  scope = readScope(runDir)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(3)
}

const root = resolve(args.root ?? scope.root)
const progressBefore = readProgress(runDir)
if (progressBefore && ['running', 'cancelling'].includes(progressBefore.status)) {
  setPhase(scope, 'verdict')
}

// The report is the product. Redact it before validating the contract so a
// leaked credential cannot be accepted as a complete run, even when the
// verdict later fails for an unrelated reason.
const redaction = redactArtifacts(scope)
if (redaction.total > 0) {
  appendRunLog(runDir, 'secrets.redacted', {
    total: redaction.total,
    redactions: redaction.redactions,
    files: redaction.files.filter((file) => file.total > 0).map((file) => toPosix(file.path)),
  })
}

let loaded
try {
  loaded = readVerdict(runDir, root)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const result = validateVerdict({ root, scope, verdict: loaded.verdict })
if (redaction.total > 0) {
  const kinds = redaction.redactions.map((item) => `${item.kind}×${item.count}`).join(', ')
  result.warnings.push(`运行产物中发现 ${redaction.total} 处疑似凭据，已替换为 [REDACTED:*]（${kinds}）；请同时轮换真实凭据。`)
}
if (result.ok) {
  try {
    const { paths } = writeGraph({ scope, verdict: result.verdict })
    console.log(`graph: ${toPosix(paths.html)}`)
    const graphRedaction = redactArtifacts(scope)
    if (graphRedaction.total > 0) {
      appendRunLog(runDir, 'secrets.redacted', {
        total: graphRedaction.total,
        redactions: graphRedaction.redactions,
        files: graphRedaction.files.filter((file) => file.total > 0).map((file) => toPosix(file.path)),
      })
    }
  } catch (error) {
    result.errors.push(`关系图生成失败：${error instanceof Error ? error.message : String(error)}`)
    result.ok = false
  }
}
// Final scan runs after the graph writer (and before latest): backups and
// reproduction scripts are text artifacts too; a residual match must fail.
const residual = scanArtifacts(scope)
if (residual.total > 0) {
  const files = residual.files
    .filter((file) => file.total > 0)
    .map((file) => `${toPosix(file.path)}（${file.total}）`)
    .join('、')
  result.errors.push(`脱敏后仍有 ${residual.total} 处疑似凭据：${files}`)
  result.ok = false
}
const extras = [...runExtraFiles(scope), ...runExtraDirs(scope)]
if (extras.length > 0) {
  result.warnings.push(
    `运行目录存在临时文件或目录（请在结束前删除）：${extras.map((file) => toPosix(file)).join('、')}`,
  )
}
// Publish latest only after the report, graph and residual scan are all clean.
if (result.ok) {
  try {
    const latest = publishLatest(scope)
    if (latest) console.log(`latest: ${toPosix(latest.markdownPath)}`)
  } catch (error) {
    result.errors.push(`latest 生成失败：${error instanceof Error ? error.message : String(error)}`)
    result.ok = false
  }
}
appendRunLog(runDir, 'verdict.validated', {
  ok: result.ok,
  runId: loaded.verdict?.runId ?? null,
  errors: result.errors,
  warnings: result.warnings,
  coverage: result.verdict?.coverage ?? null,
  findings: result.verdict?.findings?.length ?? 0,
  deferred: result.verdict?.deferred?.length ?? 0,
})
console.log(summarizeVerdict(result))
if (!result.ok) {
  console.error('')
  console.error('verdict 无效；请修正后重新运行。机器只校验 contract，不替你决定内容。')
  process.exit(1)
}
console.log('verdict 通过 contract 校验（不代表覆盖/质量已通过）。')
if (readProgress(runDir)) markCompleted(scope)
