import { resolve } from 'node:path'
import { isFile } from './util.js'

/**
 * Run layouts:
 * - 0.5.x and older: handoff/<expert>.json + .md for every run.
 * - 0.5.1+: multi-expert (/logi) runs nest each expert: handoff/<expert>/<expert>.json.
 *
 * The layout is persisted in scope.output.handoffLayout. Old scopes do not have
 * the field, so they default to the flat layout and stay readable.
 */
export function nestedHandoffs(scope) {
  return scope?.output?.handoffLayout === 'nested'
}

export function handoffJsonPath(scope, expert) {
  const base = scope.output.handoffDir
  return nestedHandoffs(scope)
    ? resolve(base, expert, `${expert}.json`)
    : resolve(base, `${expert}.json`)
}

export function handoffMarkdownPath(scope, expert) {
  const base = scope.output.handoffDir
  return nestedHandoffs(scope)
    ? resolve(base, expert, `${expert}.md`)
    : resolve(base, `${expert}.md`)
}

function flatPath(scope, expert, ext) {
  return resolve(scope.output.handoffDir, `${expert}.${ext}`)
}

/**
 * Read path with a flat fallback. A new /logi prompt may still be answered by a
 * model that follows an older flat-path instruction; accepting that keeps the
 * run usable while new runs prefer the clear nested layout.
 */
export function resolveHandoffJsonPath(scope, expert) {
  const primary = handoffJsonPath(scope, expert)
  return isFile(primary) ? primary : flatPath(scope, expert, 'json')
}

export function resolveHandoffMarkdownPath(scope, expert) {
  const primary = handoffMarkdownPath(scope, expert)
  return isFile(primary) ? primary : flatPath(scope, expert, 'md')
}

/** Display path used in prompts, reports and errors, always POSIX. */
export function handoffRelPath(scope, expert, ext = 'json') {
  return nestedHandoffs(scope)
    ? `handoff/${expert}/${expert}.${ext}`
    : `handoff/${expert}.${ext}`
}

export function handoffPattern(scope, ext = 'md') {
  return nestedHandoffs(scope)
    ? `handoff/<expert>/<expert>.${ext}`
    : `handoff/<expert>.${ext}`
}
