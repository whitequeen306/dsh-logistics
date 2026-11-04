#!/usr/bin/env node
import { resolve } from 'node:path'
import { flattenDeferred, loadHandoffs, flattenFindings, renderPacket } from '../handoffs.js'
import { readScope } from '../scope.js'
import { appendRunLog } from '../runlog.js'
import { writeJsonFile, writeTextFile } from '../util.js'
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
const inventory = loadHandoffs({ root, scope })
const findings = flattenFindings(inventory)
const deferred = flattenDeferred(inventory)
const packetPath = resolve(runDir, 'packet.md')
const handoffsPath = resolve(runDir, 'handoffs.json')
const packet = renderPacket({ root, scope, inventory, findings })

writeJsonFile(handoffsPath, {
  schemaVersion: 2,
  runId: scope.runId,
  generatedAt: new Date().toISOString(),
  coverage: {
    expected: inventory.expected,
    received: inventory.received,
    missing: inventory.missing,
    invalid: inventory.invalid,
    failed: inventory.failed,
    partial: inventory.partial,
    complete: inventory.complete,
  },
  handoffs: inventory.handoffs,
  findings,
  deferred,
  warnings: inventory.warnings,
})
writeTextFile(packetPath, packet)
appendRunLog(runDir, 'bundle.completed', {
  received: inventory.received,
  missing: inventory.missing,
  invalid: inventory.invalid,
  findings: findings.length,
  deferred: deferred.length,
  complete: inventory.complete,
  packetPath,
  handoffsPath,
})

console.log(`packet: ${packetPath}`)
console.log(`handoffs: ${handoffsPath}`)
console.log(`received: ${inventory.received.join(',') || '（无）'}`)
console.log(`missing: ${inventory.missing.join(',') || '（无）'}`)
console.log(`invalid: ${inventory.invalid.join(',') || '（无）'}`)
console.log(`findings: ${findings.length}`)
console.log(`deferred: ${deferred.length}`)
console.log(`complete: ${inventory.complete}`)
if (inventory.received.length === 0) {
  console.error('没有有效的 handoff，无法生成主编材料。')
  process.exit(1)
}
console.log('')
console.log('下一步：主编读取 packet.md 与原始 handoff，合并/取舍后写 verdict.json 和 report.md。')
