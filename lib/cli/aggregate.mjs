#!/usr/bin/env node
import { resolve } from 'node:path'
import { loadConfig } from '../config.js'
import { buildReport } from '../report.js'
import { readJsonFile, toPosix } from '../util.js'
import { parseArgs, requireArg } from './args.mjs'

const args = parseArgs()
let runDir
try {
  runDir = resolve(requireArg(args, 'run'))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const scope = readJsonFile(resolve(runDir, 'scope.json'), undefined)
if (!scope || typeof scope !== 'object') {
  console.error(`无法读取 scope.json：${toPosix(resolve(runDir, 'scope.json'))}`)
  process.exit(1)
}
const root = typeof scope.root === 'string' ? resolve(scope.root) : resolve(requireArg(args, 'root'))
if (typeof args.root === 'string' && resolve(args.root) !== root) {
  console.error(`提示：--root ${args.root} 与 scope.root 不一致，使用 ${toPosix(root)}`)
}

const { config, warnings } = loadConfig(root)
for (const warning of warnings) console.error(`config: ${warning}`)

let result
try {
  result = buildReport({ root, runDir, scope, config })
} catch (error) {
  console.error(`聚合失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const { report, reportJsonPath, latestMarkdownPath } = result
const counts = report.counts.bySeverity
console.log(`report: ${toPosix(reportJsonPath)}`)
if (latestMarkdownPath) {
  console.log(`latest: ${toPosix(latestMarkdownPath)}`)
} else {
  console.log('latest: 未更新（报告不完整，保留上一份完整报告）')
}
console.log(`coverage: ${report.coverage.completed.length}/${report.coverage.expected.length} (complete=${report.coverage.complete})`)
console.log(`findings: total=${report.counts.total} critical=${counts.critical} high=${counts.high} medium=${counts.medium} low=${counts.low} info=${counts.info}`)
console.log(`direct: ${report.counts.direct} · plan: ${report.counts.plan} · low-confidence: ${report.counts.lowConfidence}`)
console.log(`modules: ${report.modules.map((module) => module.module).join(', ') || '（无）'}`)
if (report.coverage.partial.length > 0) console.log(`partial: ${report.coverage.partial.join(',')}`)
if (report.coverage.missing.length > 0) console.log(`missing: ${report.coverage.missing.join(',')}`)
if (report.coverage.invalid.length > 0) console.log(`invalid: ${report.coverage.invalid.join(',')}`)
if (report.coverage.failed.length > 0) console.log(`failed: ${report.coverage.failed.join(',')}`)
for (const warning of report.warnings.slice(0, 8)) console.log(`warning: ${warning}`)

process.exitCode = report.coverage.complete ? 0 : 3
