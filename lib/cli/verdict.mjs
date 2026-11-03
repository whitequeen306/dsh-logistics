#!/usr/bin/env node
import { resolve } from 'node:path'
import { readScope } from '../scope.js'
import { readVerdict, summarizeVerdict, validateVerdict } from '../verdict.js'
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
let loaded
try {
  loaded = readVerdict(runDir, root)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const result = validateVerdict({ root, scope, verdict: loaded.verdict })
console.log(summarizeVerdict(result))
if (!result.ok) {
  console.error('')
  console.error('verdict 无效；请修正后重新运行。机器只校验 contract，不替你决定内容。')
  process.exit(1)
}
console.log('verdict 通过 contract 校验（不代表覆盖/质量已通过）。')
