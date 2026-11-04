import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureDir, nowIso } from './util.js'

export const RUN_LOG_FILE = 'run.jsonl'

/**
 * Append one durable, machine-readable event to a run's log.
 * The log deliberately contains no secrets: only command metadata, paths,
 * prompts, handoff/verdict summaries, and CLI outcomes.
 */
export function appendRunLog(runDir, event, data = {}) {
  if (!runDir) return
  ensureDir(runDir)
  const line = JSON.stringify({ ts: nowIso(), event, ...data })
  appendFileSync(join(runDir, RUN_LOG_FILE), `${line}\n`, 'utf8')
}

/** Write a human-readable artifact next to the log (prompts, notes, etc.). */
export function writeRunText(runDir, relativePath, text) {
  const target = join(runDir, relativePath)
  ensureDir(dirname(target))
  appendFileSync(target, text, 'utf8')
}

/** Read a run log for CLI/debug use; malformed lines are skipped. */
export function readRunLog(runDir) {
  const target = join(runDir, RUN_LOG_FILE)
  if (!existsSync(target)) return []
  return readFileSync(target, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { event: 'log.malformed', line }
      }
    })
}
