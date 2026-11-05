#!/usr/bin/env node
import { resolve } from 'node:path'
import { readScope } from '../scope.js'
import {
  expertFinished,
  expertStarted,
  markCancelled,
  markCompleted,
  markFailed,
  readProgress,
  renderProgress,
  requestCancel,
  setPhase,
  startProgress,
  waveDispatched,
  writeProgress,
} from '../progress.js'
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

const event = typeof args.event === 'string' ? args.event : 'status'
const expert = typeof args.expert === 'string' ? args.expert : undefined
const findings = Number(args.findings ?? 0)

try {
  let progress = readProgress(runDir)
  switch (event) {
    case 'status':
      break
    case 'run.started':
      progress = startProgress(scope)
      break
    case 'phase':
      progress = setPhase(scope, typeof args.phase === 'string' ? args.phase : undefined)
      break
    case 'wave.dispatched': {
      const experts = typeof args.experts === 'string'
        ? args.experts.split(',').map((item) => item.trim()).filter(Boolean)
        : []
      progress = waveDispatched(scope, experts)
      break
    }
    case 'expert.started':
      if (!expert) throw new Error('缺少参数 --expert')
      progress = expertStarted(scope, expert, typeof args.child === 'string' ? args.child : null)
      break
    case 'expert.finished':
      if (!expert) throw new Error('缺少参数 --expert')
      progress = expertFinished(scope, expert, {
        findings: Number.isFinite(findings) ? findings : 0,
        status: args.status === 'failed' ? 'failed' : 'done',
      })
      break
    case 'check-cancel':
      if (!progress) throw new Error('progress.json 不存在')
      console.log(`cancel=${progress.cancelRequested || progress.status === 'cancelling' ? 'yes' : 'no'}`)
      break
    case 'run.cancel':
      progress = requestCancel(scope, typeof args.reason === 'string' ? args.reason : 'user')
      break
    case 'run.cancelled':
      progress = markCancelled(scope, typeof args.reason === 'string' ? args.reason : 'user')
      break
    case 'run.completed':
      progress = markCompleted(scope)
      break
    case 'run.failed':
      progress = markFailed(scope, typeof args.message === 'string' ? args.message : 'unknown')
      break
    case 'set':
      if (!progress) throw new Error('progress.json 不存在')
      if (typeof args.phase === 'string') progress.phase = args.phase
      if (typeof args.status === 'string') progress.status = args.status
      if (args.cancel === 'true') progress.cancelRequested = true
      writeProgress(runDir, progress)
      break
    default:
      throw new Error(`未知进度事件：${event}`)
  }
  if (!progress) {
    console.error('progress.json 不存在；先运行 run.started 或由 /logi 创建。')
    process.exit(3)
  }
  if (args.json) {
    console.log(JSON.stringify(progress, null, 2))
  } else if (event !== 'status' && event !== 'check-cancel') {
    console.log(renderProgress(scope, progress))
  } else if (event === 'status') {
    console.log(renderProgress(scope, progress))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(3)
}
