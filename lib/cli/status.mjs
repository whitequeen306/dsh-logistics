#!/usr/bin/env node
import { resolve } from 'node:path'
import { EXPERT_BY_KEY, EXPERT_LIST } from '../constants.js'
import { isFile, readJsonFile, toPosix } from '../util.js'
import { parseArgs, requireArg, splitList } from './args.mjs'

function inspectHandoff(runDir, expert) {
  const info = EXPERT_BY_KEY[expert]
  const flat = resolve(runDir, 'handoff', `${expert}.json`)
  const nested = resolve(runDir, 'handoff', expert, `${expert}.json`)
  const file = isFile(flat) ? flat : nested
  if (!isFile(file)) return { expert, status: 'missing', findings: 0, error: 'handoff 不存在' }
  const raw = readJsonFile(file, undefined)
  if (raw === undefined) return { expert, status: 'invalid', findings: 0, error: 'JSON 无法解析' }
  const handoff = raw && typeof raw === 'object' && raw.handoff && typeof raw.handoff === 'object'
    ? raw.handoff
    : raw
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) {
    return { expert, status: 'invalid', findings: 0, error: 'handoff 不是对象' }
  }
  if (handoff.status === 'failed' || handoff.error) {
    return {
      expert,
      status: 'failed',
      findings: 0,
      error: String(handoff.error ?? '子代理报告失败'),
    }
  }
  if (!Array.isArray(handoff.findings)) {
    return { expert, status: 'invalid', findings: 0, error: '缺少 findings 数组' }
  }
  if (typeof handoff.summary !== 'string' || !handoff.summary.trim()) {
    return { expert, status: 'invalid', findings: handoff.findings.length, error: '缺少非空 summary' }
  }
  if (!handoff.sections || typeof handoff.sections !== 'object' || Array.isArray(handoff.sections)) {
    return { expert, status: 'invalid', findings: handoff.findings.length, error: '缺少 sections 声明' }
  }
  for (const section of info?.sections ?? []) {
    if (!Number.isInteger(handoff.sections[section]) || handoff.sections[section] < 0) {
      return { expert, status: 'invalid', findings: handoff.findings.length, error: `sections.${section} 缺失或无效` }
    }
  }
  const actual = Object.fromEntries((info?.sections ?? []).map((section) => [section, 0]))
  for (const finding of handoff.findings) {
    const section = finding && typeof finding === 'object' ? String(finding.section ?? '') : ''
    if (!(section in actual)) {
      return { expert, status: 'invalid', findings: handoff.findings.length, error: `发现缺少合法 section：${section || '（空）'}` }
    }
    actual[section] += 1
  }
  for (const section of info?.sections ?? []) {
    if (actual[section] !== handoff.sections[section]) {
      return {
        expert,
        status: 'invalid',
        findings: handoff.findings.length,
        error: `sections.${section} 计数不一致（声明 ${handoff.sections[section]} / 实际 ${actual[section]}）`,
      }
    }
  }
  return {
    expert,
    status: handoff.status === 'partial' ? 'partial' : 'ok',
    findings: handoff.findings.length,
    summary: handoff.summary,
  }
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
const experts = expected.length > 0
  ? expected
  : Array.isArray(scope.experts) && scope.experts.length > 0
    ? scope.experts
    : EXPERT_LIST.map((expert) => expert.key)

const results = experts.map((expert) => inspectHandoff(runDir, expert))
const partial = results.filter((result) => result.status === 'partial').map((result) => result.expert)
const missing = results.filter((result) => result.status === 'missing').map((result) => result.expert)
const invalid = results.filter((result) => result.status === 'invalid').map((result) => result.expert)
const failed = results.filter((result) => result.status === 'failed').map((result) => result.expert)
const ready = missing.length === 0 && invalid.length === 0

if (args.json) {
  console.log(JSON.stringify({ runDir: toPosix(runDir), expected: experts, results, partial, missing, invalid, failed, ready }, null, 2))
} else {
  console.log(`run: ${toPosix(runDir)}`)
  console.log(`expected: ${experts.join(',')}`)
  for (const result of results) {
    const title = EXPERT_BY_KEY[result.expert]?.title ?? result.expert
    const detail = result.status === 'ok'
      ? `${result.findings} 项发现${result.summary ? ` — ${result.summary}` : ''}`
      : result.error
    console.log(`${result.expert} [${title}]: ${result.status}${detail ? ` — ${detail}` : ''}`)
  }
  console.log(`ready: ${ready}`)
  if (partial.length > 0) console.log(`partial: ${partial.join(',')}`)
  if (missing.length > 0) console.log(`missing: ${missing.join(',')}`)
  if (invalid.length > 0) console.log(`invalid: ${invalid.join(',')}`)
  if (failed.length > 0) console.log(`failed: ${failed.join(',')}`)
}

// Exit 0 means "all expected handoffs are present (failed counts as terminal)".
// A missing/invalid handoff is a retry signal for the orchestrator.
process.exitCode = ready ? 0 : 1
