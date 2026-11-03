#!/usr/bin/env node
import { resolve } from 'node:path'
import { acceptBaseline, compareToBaseline, fingerprint } from '../baseline.js'
import { PASS_LIST } from '../constants.js'
import { loadConfig } from '../config.js'
import { evaluateGate, readLatestReport } from '../report.js'
import { gitRoot } from '../util.js'
import { parseArgs } from './args.mjs'

const args = parseArgs()
const root = typeof args.root === 'string' ? resolve(args.root) : gitRoot(process.cwd()) ?? process.cwd()
const latest = readLatestReport(root)
if (!latest) {
  console.error(`还没有可用的后勤报告（工作区：${root}）。请先运行 /logi-full。`)
  process.exit(3)
}
const { report } = latest

if (args.accept === true) {
  if (!report.coverage?.full || report.coverage?.expected?.length !== PASS_LIST.length) {
    console.error(`拒绝接受基线：最近报告覆盖不完整（${report.coverage?.valid ?? '?'}/${PASS_LIST.length}）。`)
    process.exit(3)
  }
  const accepted = acceptBaseline({ root, report })
  console.log(`已接受基线：${accepted.path}`)
  console.log(`entries: ${accepted.count}`)
  console.log(`score: ${accepted.score}`)
  process.exitCode = 0
} else {
  // Recompute against the current baseline instead of trusting the gate stored
  // in the report: `accept` can happen after the report was written.
  const { config } = loadConfig(root)
  const findings = report.findings.map((finding) => ({
    ...finding,
    fingerprint: finding.fingerprint || fingerprint(finding),
  }))
  const coverage = {
    ...report.coverage,
    full: report.coverage?.full === true
      || Boolean(report.coverage?.complete && report.coverage?.expected?.length === PASS_LIST.length),
  }
  const comparison = compareToBaseline({
    root,
    findings,
    passes: report.coverage?.expected ?? PASS_LIST.map((pass) => pass.key),
    score: report.score?.value ?? 0,
    complete: coverage.full,
  })
  const gate = evaluateGate({ comparison, coverage, config })
  console.log(`gate: ${gate.status} (exit ${gate.code})`)
  for (const reason of gate.reasons ?? []) console.log(`- ${reason}`)
  console.log(`baseline: ${comparison.hasBaseline ? 'yes' : 'no'} · new critical=${gate.newCritical} high=${gate.newHigh} · score=${report.score?.value ?? '?'}`)
  console.log(`report: ${latest.reportPath}`)
  process.exitCode = Number.isInteger(gate.code) ? gate.code : 3
}
