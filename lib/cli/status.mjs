#!/usr/bin/env node
import { resolve } from 'node:path'
import { PASS_BY_KEY, PASS_LIST } from '../constants.js'
import { isFile, readJsonFile, toPosix } from '../util.js'
import { parseArgs, requireArg, splitList } from './args.mjs'

function inspectHandoff(runDir, pass) {
  const file = resolve(runDir, 'handoff', `${pass}.json`)
  if (!isFile(file)) return { pass, status: 'missing', findings: 0, error: 'handoff 不存在' }
  const raw = readJsonFile(file, undefined)
  if (raw === undefined) return { pass, status: 'invalid', findings: 0, error: 'JSON 无法解析' }
  const handoff = raw && typeof raw === 'object' && raw.handoff && typeof raw.handoff === 'object'
    ? raw.handoff
    : raw
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) {
    return { pass, status: 'invalid', findings: 0, error: 'handoff 不是对象' }
  }
  if (handoff.status === 'failed' || handoff.error) {
    return {
      pass,
      status: 'failed',
      findings: 0,
      error: String(handoff.error ?? '子代理报告失败'),
    }
  }
  if (!Array.isArray(handoff.findings)) {
    return { pass, status: 'invalid', findings: 0, error: '缺少 findings 数组' }
  }
  return { pass, status: 'ok', findings: handoff.findings.length, summary: handoff.summary }
}

const args = parseArgs()
let runDir
try {
  runDir = resolve(requireArg(args, 'run'))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(3)
}

const scope = readJsonFile(resolve(runDir, 'scope.json'), undefined)
if (!scope || typeof scope !== 'object') {
  console.error(`无法读取 scope.json：${toPosix(resolve(runDir, 'scope.json'))}`)
  process.exit(3)
}

const expected = splitList(args.expect)
const passes = expected.length > 0
  ? expected
  : Array.isArray(scope.passes) && scope.passes.length > 0
    ? scope.passes
    : PASS_LIST.map((pass) => pass.key)

const results = passes.map((pass) => inspectHandoff(runDir, pass))
const missing = results.filter((result) => result.status === 'missing').map((result) => result.pass)
const invalid = results.filter((result) => result.status === 'invalid').map((result) => result.pass)
const failed = results.filter((result) => result.status === 'failed').map((result) => result.pass)
const ready = missing.length === 0 && invalid.length === 0

if (args.json) {
  console.log(JSON.stringify({ runDir: toPosix(runDir), expected: passes, results, missing, invalid, failed, ready }, null, 2))
} else {
  console.log(`run: ${toPosix(runDir)}`)
  console.log(`expected: ${passes.join(',')}`)
  for (const result of results) {
    const title = PASS_BY_KEY[result.pass]?.title ?? result.pass
    const detail = result.status === 'ok'
      ? `${result.findings} 项发现${result.summary ? ` — ${result.summary}` : ''}`
      : result.error
    console.log(`${result.pass} [${title}]: ${result.status}${detail ? ` — ${detail}` : ''}`)
  }
  console.log(`ready: ${ready}`)
  if (missing.length > 0) console.log(`missing: ${missing.join(',')}`)
  if (invalid.length > 0) console.log(`invalid: ${invalid.join(',')}`)
  if (failed.length > 0) console.log(`failed: ${failed.join(',')}`)
}

// Exit 0 means "all expected handoffs are present (failed counts as terminal)".
// A missing/invalid handoff is a retry signal for the orchestrator.
process.exitCode = ready ? 0 : 1
