import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_EXPERTS } from './constants.js'
import { readProgress } from './progress.js'
import { ensureDir, nowIso, toPosix, writeJsonFile } from './util.js'

/**
 * A latest report is only meaningful when the same complete default review set
 * that produced it is still the current run. Single-expert runs must never
 * replace the shared report.
 */
export function shouldPublishLatest(scope) {
  if (!scope || scope.mode !== 'project' || scope.command !== '/logi') return false
  const experts = Array.isArray(scope.experts) ? scope.experts : []
  if (!DEFAULT_EXPERTS.every((expert) => experts.includes(expert))) return false
  const progress = readProgress(scope.output?.runDir)
  if (progress && (progress.cancelRequested || ['cancelling', 'cancelled'].includes(progress.status))) {
    return false
  }
  return true
}

/**
 * Publish the already-validated run report as docs/logistics/latest.md.
 *
 * The verdict CLI owns this step. The editor model must not copy `latest`
 * itself: doing so before the final verdict is what made `latest.md` older and
 * different from the final severity-ordered report.
 */
export function publishLatest(scope) {
  if (!shouldPublishLatest(scope)) return undefined
  const source = scope.output?.reportMarkdown
  const target = scope.output?.latestMarkdown
  const pointerPath = scope.output?.latestJson
  if (!source || !existsSync(source)) {
    throw new Error('缺少最终 report.md，无法发布 latest')
  }
  if (!target || !pointerPath) {
    throw new Error('scope.output 缺少 latestMarkdown/latestJson')
  }

  ensureDir(dirname(target))
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  copyFileSync(source, temp)
  try {
    rmSync(target, { force: true })
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }

  writeJsonFile(pointerPath, {
    schemaVersion: 1,
    runId: scope.runId,
    createdAt: nowIso(),
    command: scope.command,
    version: scope.version,
    experts: scope.experts,
    reportPath: toPosix(scope.output.reportMarkdown),
    reportMarkdownPath: toPosix(scope.output.reportMarkdown),
    marker: 'final-validated-report',
    markdownPath: toPosix(target),
    graphHtml: scope.output.graphHtml ? toPosix(scope.output.graphHtml) : undefined,
    coverageComplete: true,
    publishable: true,
  })
  return { markdownPath: target, jsonPath: pointerPath }
}
