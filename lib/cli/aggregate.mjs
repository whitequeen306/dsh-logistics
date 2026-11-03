#!/usr/bin/env node
import { resolve } from 'node:path'
import { loadConfig } from '../config.js'
import { buildReport } from '../report.js'
import { readJsonFile, toPosix } from '../util.js'
import { parseArgs, requireArg } from './args.mjs'

const args = parseArgs()
let runDir
let root
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
root = typeof scope.root === 'string' ? resolve(scope.root) : resolve(requireArg(args, 'root'))
if (typeof args.root === 'string' && resolve(args.root) !== root) {
  console.error(`提示：--root ${args.root} 与 scope.root 不一致，使用 ${toPosix(root)}`)
}

const { config, warnings } = loadConfig(root)
if (warnings.length > 0) {
  for (const warning of warnings) console.error(`config: ${warning}`)
}

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
console.log(`latest: ${toPosix(latestMarkdownPath)}`)
console.log(`score: ${report.score.value}/100 (${report.score.grade} · ${report.score.label})`)
console.log(`coverage: ${report.coverage.valid}/${report.coverage.expected.length} (full=${report.coverage.full})`)
console.log(`findings: critical=${counts.critical} high=${counts.high} medium=${counts.medium} low=${counts.low} info=${counts.info}`)
console.log(`new: critical=${report.baseline.newCounts.critical ?? 0} high=${report.baseline.newCounts.high ?? 0}`)
console.log(`gate: ${report.gate.status} (exit ${report.gate.code})`)
if (report.coverage.missing.length > 0) console.log(`missing: ${report.coverage.missing.join(',')}`)
if (report.coverage.failed.length > 0) console.log(`failed: ${report.coverage.failed.join(',')}`)
if (report.warnings.length > 0) {
  for (const warning of report.warnings.slice(0, 8)) console.log(`warning: ${warning}`)
}
