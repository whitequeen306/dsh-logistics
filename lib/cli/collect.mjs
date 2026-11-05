#!/usr/bin/env node
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadHandoffs, unitCoverage } from '../handoffs.js'
import { readScope } from '../scope.js'
import { appendRunLog } from '../runlog.js'
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
const extraFiles = handoffExtras(scope)
if (extraFiles.length > 0) {
  inventory.warnings.push(`handoff 目录存在临时文件（请删除）：${extraFiles.join('、')}`)
}
appendRunLog(runDir, 'collect.completed', {
  expected: inventory.expected,
  received: inventory.received,
  missing: inventory.missing,
  invalid: inventory.invalid,
  failed: inventory.failed,
  partial: inventory.partial,
  complete: inventory.complete,
  warnings: inventory.warnings,
  extraFiles,
})

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
if (Array.isArray(inventory.projectUnits) && inventory.projectUnits.length > 0) {
  console.log('')
  console.log('units:')
  for (const item of unitCoverage(inventory)) {
    const { reviewed, sampled, skipped, missing } = item.counts
    console.log(
      `- ${item.id} ${item.label}: reviewed ${reviewed} / sampled ${sampled} / skipped ${skipped} / missing ${missing}`,
    )
  }
}
if (extraFiles.length > 0) {
  console.log('')
  console.log('extra files (delete these temporary files):')
  for (const file of extraFiles) console.log(`- ${file}`)
}
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

function handoffExtras(scope) {
  const dir = scope.output?.handoffDir
  if (!dir) return []
  const expected = new Set((scope.experts ?? []).flatMap((expert) => [`${expert}.json`, `${expert}.md`]))
  const extras = []
  const nested = scope.output.handoffLayout === 'nested'
  for (const expert of scope.experts ?? []) {
    const target = nested ? join(dir, expert) : dir
    let entries
    try {
      entries = readdirSync(target, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (nested && expected.has(entry.name) && entry.name.startsWith(`${expert}.`)) continue
      if (!nested && expected.has(entry.name)) continue
      extras.push(join(target, entry.name).replace(/\\\\/gu, '/'))
    }
    if (!nested) break
  }
  return [...new Set(extras)].sort()
}
