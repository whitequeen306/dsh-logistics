#!/usr/bin/env node
import { resolve } from 'node:path'
import { loadHandoffs } from '../handoffs.js'
import { readScope } from '../scope.js'
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
const inventory = loadHandoffs({ root, scope })

if (args.json) {
  console.log(JSON.stringify(inventory, null, 2))
  process.exit(0)
}

console.log(`run: ${toPosix(runDir)}`)
console.log(`expected: ${inventory.expected.join(',') || '（无）'}`)
console.log(`received: ${inventory.received.join(',') || '（无）'}`)
console.log(`missing: ${inventory.missing.join(',') || '（无）'}`)
console.log(`invalid: ${inventory.invalid.join(',') || '（无）'}`)
console.log(`failed: ${inventory.failed.join(',') || '（无）'}`)
console.log(`partial: ${inventory.partial.join(',') || '（无）'}`)
console.log(`complete: ${inventory.complete}`)
console.log('')
for (const handoff of inventory.handoffs) {
  const state = handoff.valid
    ? handoff.status
    : handoff.exists
      ? 'invalid'
      : handoff.expected
        ? 'missing'
        : 'not-selected'
  const detail = handoff.valid
    ? `${handoff.findings.length} findings${handoff.deferred.length > 0 ? ` · ${handoff.deferred.length} deferred` : ''}`
    : handoff.error || (handoff.expected ? '没有 handoff' : '可选专家，本次未选择')
  console.log(`- ${handoff.expert}: ${state} · ${detail}`)
}
if (inventory.warnings.length > 0) {
  console.log('')
  console.log('warnings:')
  for (const warning of inventory.warnings) console.log(`- ${warning}`)
}
console.log('')
console.log('这是收集结果，不是质量裁决；缺失/无效表示主编需要处理，不能当作“无问题”。')
