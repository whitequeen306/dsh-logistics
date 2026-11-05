import { closeSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { resolveHandoffJsonPath, resolveHandoffMarkdownPath } from './handoff-paths.js'
import { isDirectory, isFile } from './util.js'

/**
 * Deterministic secret redaction for the human-facing report artifacts.
 *
 * This is deliberately a small, auditable denylist of high-confidence token
 * shapes and secret assignments. It is not a general DLP engine: it must never
 * turn normal source excerpts into noise, and it must not require network or
 * model calls. The report is the product; redaction runs before the report
 * contract is validated, so a leaked credential cannot pass as a complete run.
 */

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/gu
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/gu
const NPM_TOKEN = /\bnpm_[A-Za-z0-9]{36}\b/gu
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/gu
const STRIPE_KEY = /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/gu
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/giu
const BASIC_AUTH = /(\bAuthorization\s*:\s*Basic\s+)([A-Za-z0-9+/=]{8,})/giu
const BEARER_AUTH = /(\bAuthorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+/-]{16,})/giu
const SECRET_ASSIGNMENT = /(\b[A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET)[A-Za-z0-9_.-]*\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu
const USERNAME_ASSIGNMENT = /(\b(?:USERNAME|DB_USER|SMTP_USER)\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu

const SAFE_VALUE = /^(?:\*{3,}|x{3,}|<[^>]*>|\$\{[^}]*\}|process\.env\.[A-Za-z0-9_]+.*|os\.environ.*|env\([^)]*\)|\[REDACTED[^\]]*\]|changeme|change_me|your[_-]?(?:password|passwd|secret|token|key|username|user)|placeholder|dummy|none|null|undefined)$/iu

function stripQuotes(value) {
  const text = value.trim()
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1)
  }
  return text
}

function isSafeValue(rawValue) {
  const value = stripQuotes(String(rawValue ?? ''))
  if (!value) return true
  if (SAFE_VALUE.test(value)) return true
  return false
}

function bump(counts, kind) {
  counts.set(kind, (counts.get(kind) ?? 0) + 1)
}

const RULES = [
  {
    kind: 'private-key',
    pattern: PRIVATE_KEY,
  },
  {
    kind: 'aws-access-key',
    pattern: AWS_ACCESS_KEY,
  },
  {
    kind: 'github-token',
    pattern: GITHUB_TOKEN,
  },
  {
    kind: 'npm-token',
    pattern: NPM_TOKEN,
  },
  {
    kind: 'slack-token',
    pattern: SLACK_TOKEN,
  },
  {
    kind: 'google-api-key',
    pattern: GOOGLE_API_KEY,
  },
  {
    kind: 'stripe-key',
    pattern: STRIPE_KEY,
  },
  {
    kind: 'jwt',
    pattern: JWT,
  },
  {
    kind: 'url-password',
    pattern: URL_CREDENTIALS,
    replacement: (prefix, password, at) =>
      /\[REDACTED/u.test(password) ? null : `${prefix}[REDACTED:url-password]${at}`,
  },
  {
    kind: 'basic-auth',
    pattern: BASIC_AUTH,
    replacement: (prefix) => `${prefix}[REDACTED:basic-auth]`,
  },
  {
    kind: 'bearer-token',
    pattern: BEARER_AUTH,
    replacement: (prefix) => `${prefix}[REDACTED:bearer-token]`,
  },
  {
    kind: 'username',
    pattern: USERNAME_ASSIGNMENT,
    assignment: true,
  },
  {
    kind: 'secret',
    pattern: SECRET_ASSIGNMENT,
    assignment: true,
  },
]

/**
 * Redact high-confidence secrets in a string.
 * @returns {{text: string, redactions: Array<{kind: string, count: number}>, total: number}}
 */
export function redactSecrets(input) {
  let output = String(input ?? '')
  const counts = new Map()
  for (const rule of RULES) {
    output = output.replace(rule.pattern, (...args) => {
      const match = args[0]
      if (rule.assignment) {
        const rawValue = args[2]
        if (isSafeValue(rawValue)) return match
      }
      let replacement
      if (rule.replacement) {
        replacement = rule.replacement(args[1], ...args.slice(2))
      } else if (rule.assignment) {
        replacement = `${args[1]}[REDACTED:${rule.kind}]`
      } else {
        replacement = `[REDACTED:${rule.kind}]`
      }
      if (replacement === null) return match
      bump(counts, rule.kind)
      return replacement
    })
  }
  return {
    text: output,
    redactions: [...counts].map(([kind, count]) => ({ kind, count })),
    total: [...counts.values()].reduce((sum, value) => sum + value, 0),
  }
}

/** Return only the redaction counts, without exposing the secret values. */
export function scanSecrets(input) {
  const { redactions, total } = redactSecrets(input)
  return { redactions, total }
}

function mergeStats(target, source) {
  target.total += source.total
  for (const item of source.redactions) {
    target.map.set(item.kind, (target.map.get(item.kind) ?? 0) + item.count)
  }
}

function statsResult(stats) {
  return {
    redactions: [...stats.map].map(([kind, count]) => ({ kind, count })),
    total: stats.total,
  }
}

/** Redact one file in place. Missing files are a no-op. */
export function redactFile(path) {
  if (!isFile(path)) return { path, changed: false, redactions: [], total: 0 }
  const before = readFileSync(path, 'utf8')
  const result = redactSecrets(before)
  if (result.total > 0) writeFileSync(path, result.text)
  return { path, changed: result.total > 0, ...result }
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tif', '.tiff',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.bz2', '.xz',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi', '.mkv',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.xls', '.xlsx', '.doc', '.docx', '.ppt', '.pptx',
  '.class', '.jar', '.pyc', '.pyo', '.wasm', '.exe', '.dll', '.so', '.dylib',
  '.sqlite', '.sqlite3', '.db',
])

/**
 * Include every regular text artifact, not just a short extension allowlist.
 * Handoff backups (`.bak`/`.bak2`), reproduction scripts (`.py`/`.sh`) and
 * extensionless notes have leaked before; a NUL byte in the first 4 KiB is the
 * cheap binary guard used here.
 */
function isTextArtifact(path) {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return false
  let fd
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(4096)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    return !buffer.subarray(0, length).includes(0)
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function walkArtifacts(root, out) {
  if (!isDirectory(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walkArtifacts(path, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!isTextArtifact(path)) continue
    out.add(resolve(path))
  }
}

/**
 * Every persisted artifact of a run can contain a paste of source/config:
 * handoff JSON, verdict evidence, packet, prompts, logs, reports. Redact them
 * all, not just the human-facing Markdown. `scope.json` is included too: its
 * `notes` field is user-controlled and can contain a secret.
 */
export function redactArtifacts(scope) {
  const stats = { map: new Map(), total: 0 }
  const files = []
  if (!scope?.output) return { files, ...statsResult(stats) }

  const targets = new Set()
  for (const value of Object.values(scope.output)) {
    if (typeof value === 'string' && value.length > 0 && isTextArtifact(value)) {
      targets.add(resolve(value))
    }
  }
  for (const expert of scope.experts ?? []) {
    targets.add(resolve(resolveHandoffJsonPath(scope, expert)))
    targets.add(resolve(resolveHandoffMarkdownPath(scope, expert)))
  }
  walkArtifacts(scope.output.runDir, targets)

  for (const target of targets) {
    if (!isFile(target)) continue
    const result = redactFile(target)
    files.push({ path: target, redactions: result.redactions, total: result.total })
    mergeStats(stats, result)
  }

  return { files, ...statsResult(stats) }
}

/** Backwards-compatible name used by older callers/tests. */
export function redactReportArtifacts(scope) {
  return redactArtifacts(scope)
}

/** Scan every artifact without mutating it; used as a final defense in depth. */
export function scanArtifacts(scope) {
  const stats = { map: new Map(), total: 0 }
  const files = []
  if (!scope?.output) return { files, ...statsResult(stats) }
  const targets = new Set()
  for (const value of Object.values(scope.output)) {
    if (typeof value === 'string' && value.length > 0 && isTextArtifact(value)) {
      targets.add(resolve(value))
    }
  }
  for (const expert of scope.experts ?? []) {
    targets.add(resolve(resolveHandoffJsonPath(scope, expert)))
    targets.add(resolve(resolveHandoffMarkdownPath(scope, expert)))
  }
  walkArtifacts(scope.output.runDir, targets)
  for (const target of targets) {
    if (!isFile(target)) continue
    const result = scanSecrets(readFileSync(target, 'utf8'))
    files.push({ path: target, redactions: result.redactions, total: result.total })
    mergeStats(stats, result)
  }
  return { files, ...statsResult(stats) }
}

/** Deep-redact strings in an object (used by the legacy report builder). */
export function redactValue(value) {
  if (typeof value === 'string') return redactSecrets(value).text
  if (Array.isArray(value)) return value.map((item) => redactValue(item))
  if (value && typeof value === 'object') {
    const result = {}
    for (const [key, item] of Object.entries(value)) result[key] = redactValue(item)
    return result
  }
  return value
}
