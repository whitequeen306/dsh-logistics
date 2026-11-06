import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDirectory, toPosix } from './util.js'

const KNOWN_FILES = new Set([
  'scope.json',
  'progress.json',
  'children.json',
  'run.jsonl',
  'dispatch.md',
  'report.md',
  'report.json',
  'verdict.json',
  'graph.json',
  'graph.html',
  'packet.md',
  'handoffs.json',
])

const KNOWN_DIRS = new Set(['handoff', 'prompts', 'fixes'])

/** Top-level run files that are not part of the documented artifact set. */
export function runExtraFiles(scope) {
  const runDir = scope?.output?.runDir
  if (!runDir || !isDirectory(runDir)) return []
  return readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !KNOWN_FILES.has(entry.name))
    .map((entry) => toPosix(join(runDir, entry.name)))
    .sort()
}

export function runExtraDirs(scope) {
  const runDir = scope?.output?.runDir
  if (!runDir || !isDirectory(runDir)) return []
  return readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !KNOWN_DIRS.has(entry.name))
    .map((entry) => toPosix(join(runDir, entry.name)))
    .sort()
}
