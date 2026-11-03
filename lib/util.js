import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

/** ISO timestamp without milliseconds; stable enough for humans and JSON. */
export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Sortable, collision-resistant run id. */
export function makeRunId(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
  return `${stamp}-${randomUUID().slice(0, 6)}`
}

export function sha1(value) {
  return createHash('sha1').update(String(value)).digest('hex')
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

export function readJsonFile(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJsonFile(file, value) {
  ensureDir(dirname(file))
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return file
}

export function writeTextFile(file, text) {
  ensureDir(dirname(file))
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
  return file
}

export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Normalize a filesystem path to forward slashes for reports and matching. */
export function toPosix(path) {
  return String(path).split(sep).join('/')
}

/** Path relative to root, using forward slashes. */
export function relativePosix(root, path) {
  return toPosix(relative(root, path))
}

export function truncate(text, max = 400) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

export function oneLine(text, max = 220) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), max)
}

/** Extract the first JSON object/array from a model-authored string. */
export function extractJson(text) {
  if (typeof text !== 'string') return undefined
  const source = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  try {
    return JSON.parse(source)
  } catch {
    // Fall through to bracket slicing.
  }
  const firstObject = source.indexOf('{')
  const firstArray = source.indexOf('[')
  const starts = [firstObject, firstArray].filter((index) => index >= 0)
  if (starts.length === 0) return undefined
  const start = Math.min(...starts)
  const end = source.lastIndexOf(source[start] === '{' ? '}' : ']')
  if (end <= start) return undefined
  try {
    return JSON.parse(source.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * Parse a Markdown file with optional YAML-ish frontmatter. Only the two keys
 * this plugin needs (`name`, `description`) are supported, which keeps the
 * plugin zero-dependency.
 */
export function parseSkillFile(text, fallbackName) {
  const source = String(text ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  let body = source
  let name = fallbackName
  let description = ''
  if (match) {
    body = source.slice(match[0].length)
    for (const line of match[1].split(/\r?\n/)) {
      const entry = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
      if (!entry) continue
      const key = entry[1].toLowerCase()
      const value = entry[2].trim().replace(/^['"]|['"]$/g, '')
      if (key === 'name') name = value || fallbackName
      if (key === 'description') description = value
    }
  }
  return { name, description, content: body.trim() }
}

export function fileExists(path) {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/** Resolve a possibly relative user path against a root. */
export function resolveFrom(root, path) {
  return resolve(root, path)
}

/**
 * Run git without a shell. Returns `{ ok, stdout, stderr }`; never throws so a
 * non-git workspace degrades into a directory scan instead of a command error.
 */
export function git(args, cwd, { timeout = 4000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout,
      maxBuffer,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout: String(stdout), stderr: '' }
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : String(error?.message ?? error),
    }
  }
}

/** Find the git top-level for a directory, or undefined. */
export function gitRoot(cwd) {
  const result = git(['rev-parse', '--show-toplevel'], cwd)
  if (!result.ok) return undefined
  const root = result.stdout.trim()
  return root.length > 0 ? root : undefined
}

/** Escape a string for use inside a RegExp. */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Minimal gitignore-ish glob matcher: `**` crosses directories, `*` and `?`
 * stay inside one segment. A pattern without `/` matches a basename at any
 * depth. Patterns are matched against forward-slash relative paths.
 */
export function globToRegExp(pattern) {
  const source = String(pattern).trim()
  if (source.length === 0) return undefined
  let regex = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '*') {
      if (source[index + 1] === '*') {
        regex += '.*'
        index += 1
        if (source[index + 1] === '/') index += 1
      } else {
        regex += '[^/]*'
      }
    } else if (char === '?') {
      regex += '[^/]'
    } else {
      regex += escapeRegExp(char)
    }
  }
  if (source.endsWith('/')) regex += '.*'
  return new RegExp(`^${regex}$`, 'u')
}

export function makeMatcher(patterns) {
  const compiled = []
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue
    const trimmed = pattern.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const regex = globToRegExp(trimmed)
    if (regex) compiled.push({ pattern: trimmed, regex, basenameOnly: !trimmed.includes('/') })
  }
  return (path) => {
    const normalized = toPosix(path).replace(/^\.\//, '')
    const base = normalized.split('/').pop() ?? normalized
    return compiled.some(({ regex, basenameOnly }) =>
      basenameOnly ? regex.test(base) : regex.test(normalized))
  }
}

/** Read a package.json without throwing. */
export function readPackageJson(root) {
  return readJsonFile(resolve(root, 'package.json'), undefined)
}
