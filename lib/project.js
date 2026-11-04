import { readFileSync, statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { git, makeMatcher, toPosix } from './util.js'

const MAX_PROJECT_FILE_BYTES = 1024 * 1024

const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.rb', '.php',
  '.swift', '.scala', '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm',
  '.vue', '.svelte', '.astro', '.css', '.scss', '.less', '.html',
  '.sh', '.bash', '.zsh', '.ps1', '.sql', '.graphql',
])

const CONFIG_BASENAMES = new Set([
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'Gemfile',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'nginx.conf',
  '.env.example',
  'tsconfig.json',
  'vite.config.js',
  'vite.config.ts',
  'webpack.config.js',
  'rollup.config.js',
  'eslint.config.js',
])

const CONFIG_EXTENSIONS = new Set(['.yml', '.yaml', '.toml', '.properties', '.xml', '.json'])

const MONOREPO_HEADS = new Set([
  'backend', 'frontend', 'packages', 'apps', 'services', 'modules', 'libs', 'crates',
])

const SKIP_PATH_PATTERNS = [
  /(^|\/)(docs?|documentation|examples?|samples?|fixtures?)\//iu,
  /(^|\/)(frontend\/public|public|static\/assets|assets)\//iu,
  /(^|\/)(coverage|dist|build|out|target|node_modules|vendor)\//iu,
]

function isIgnoredPath(path) {
  return SKIP_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

/**
 * Files worth reviewing in a whole-project audit. Documentation, generated
 * assets and lockfiles are intentionally excluded; configuration and build
 * descriptors stay in because they carry security and deployment decisions.
 */
export function isProjectFile(path) {
  const normalized = toPosix(path)
  const name = basename(normalized)
  if (normalized.startsWith('.logistics/') || normalized.startsWith('docs/logistics/')) return false
  if (isIgnoredPath(normalized)) return false
  if (CONFIG_BASENAMES.has(name)) return true
  if (/^(application|bootstrap|log4j2?|settings)[.-].*\.(ya?ml|properties|xml)$/iu.test(name)) return true
  if (/^(vite|webpack|rollup|eslint|tsconfig|babel)\.(config\.)?[cm]?[jt]s$/iu.test(name)) return true
  const ext = extname(name).toLowerCase()
  if (SOURCE_EXTENSIONS.has(ext)) return true
  if (CONFIG_EXTENSIONS.has(ext)) {
    return normalized.split('/').length <= 3 || /(^|\/)(config|deploy|infra|ci|\.github)\//iu.test(normalized)
  }
  return false
}

export function moduleKeyFor(path) {
  const normalized = toPosix(path).replace(/^\.\//u, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return '(root)'
  if (parts.length === 1) return '(root)'
  const head = parts[0]
  if (MONOREPO_HEADS.has(head) && parts[1] && !extname(parts[1])) return `${head}/${parts[1]}`
  return head
}

function countLines(path) {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_PROJECT_FILE_BYTES) return 0
    const buffer = readFileSync(path)
    if (buffer.includes(0)) return 0
    let lines = 1
    for (const byte of buffer) if (byte === 10) lines += 1
    return lines
  } catch {
    return 0
  }
}

function listTrackedFiles(root) {
  const result = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root)
  if (!result.ok) return []
  return [...new Set(String(result.stdout).split('\0').filter(Boolean).map(toPosix))]
}

/**
 * Deterministic project inventory. Every path is classified before any model
 * sees it, so a missing module is a planner bug rather than a prompt omission.
 */
export function listProjectFiles({ root, config }) {
  const matcher = makeMatcher([...(config.ignore ?? [])])
  const all = listTrackedFiles(root)
  const files = []
  let omitted = 0
  for (const path of all.sort()) {
    if (matcher(path) || !isProjectFile(path)) {
      omitted += 1
      continue
    }
    const lines = countLines(resolve(root, path))
    if (lines === 0) {
      omitted += 1
      continue
    }
    files.push({ path, status: 'present', lines })
  }
  return { files, totalTracked: all.length, omitted }
}

function splitUnit(moduleKey, files, maxFilesPerUnit) {
  if (files.length <= maxFilesPerUnit) return [{ label: moduleKey, files }]
  const chunks = []
  for (let index = 0; index < files.length; index += maxFilesPerUnit) {
    chunks.push(files.slice(index, index + maxFilesPerUnit))
  }
  return chunks.map((chunk, index) => ({
    label: `${moduleKey} (${index + 1}/${chunks.length})`,
    files: chunk,
  }))
}

function makeUnit(label, files, index) {
  const lines = files.reduce((sum, file) => sum + (file.lines ?? 0), 0)
  return {
    id: `u${String(index + 1).padStart(2, '0')}`,
    label,
    files,
    stats: { files: files.length, lines },
  }
}

function groupUnits(files, { maxFilesPerUnit, maxUnits }) {
  const groups = new Map()
  for (const file of files) {
    const key = moduleKeyFor(file.path)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(file)
  }

  let units = []
  for (const [key, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    group.sort((a, b) => a.path.localeCompare(b.path))
    for (const chunk of splitUnit(key, group, maxFilesPerUnit)) {
      units.push(makeUnit(chunk.label, chunk.files, units.length))
    }
  }

  // Merge the smallest units when a project has many tiny directories. Large
  // modules stay intact and keep their name; only small leftovers are folded
  // into a same-prefix bucket so a 200-file service never disappears inside
  // a generic "other modules" batch.
  while (units.length > maxUnits) {
    const sorted = [...units].sort((a, b) => a.files.length - b.files.length || a.label.localeCompare(b.label))
    const first = sorted[0]
    const prefix = first.label.split(/[ /(]/u)[0]
    const samePrefix = sorted.find((unit) => unit !== first && unit.label.startsWith(`${prefix}/`))
    const partner = samePrefix ?? sorted[1]
    if (!partner) break
    const mergedFiles = [...first.files, ...partner.files].sort((a, b) => a.path.localeCompare(b.path))
    let base
    if (samePrefix) {
      base = `${prefix}（小模块合集 ${mergedFiles.length} 文件）`
    } else {
      const keys = [...new Set(mergedFiles.map((file) => moduleKeyFor(file.path)))]
      const preview = keys.slice(0, 3).join('、')
      base = `其他模块（${preview}${keys.length > 3 ? ' 等' : ''}）`
    }
    let label = base
    let suffix = 2
    while (units.some((unit) => unit.label === label)) {
      label = `${base} ${suffix}`
      suffix += 1
    }
    const merged = makeUnit(label, mergedFiles, 0)
    units = units.filter((unit) => unit !== first && unit !== partner)
    units.push(merged)
  }
  units.sort((a, b) => b.stats.files - a.stats.files || a.label.localeCompare(b.label))
  return units.map((unit, index) => ({ ...unit, id: `u${String(index + 1).padStart(2, '0')}` }))
}

/**
 * Build the full-project review plan. A unit is a file batch; every selected
 * expert is expected to cover every unit and report that coverage in its own
 * handoff. There is deliberately no per-unit assignment list: the coverage
 * ledger is the handoff's `units` map, not a generated matrix of subagents.
 */
export function buildProjectPlan({ root, config }) {
  const projectConfig = config.project ?? {}
  const maxFilesPerUnit = projectConfig.maxFilesPerUnit ?? 120
  const maxUnits = projectConfig.maxUnits ?? 12
  const maxFiles = projectConfig.maxFiles ?? 2000
  const inventory = listProjectFiles({ root, config })
  const selected = inventory.files.slice(0, maxFiles)
  const truncated = inventory.files.length > selected.length
  const units = groupUnits(selected, { maxFilesPerUnit, maxUnits })

  return {
    files: selected,
    units,
    totals: {
      trackedFiles: inventory.totalTracked,
      reviewedFiles: selected.length,
      omittedFiles: inventory.omitted + (inventory.files.length - selected.length),
      truncated,
      units: units.length,
      lines: selected.reduce((sum, file) => sum + (file.lines ?? 0), 0),
    },
  }
}
