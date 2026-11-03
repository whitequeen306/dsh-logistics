import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { SCOPE_SCHEMA_VERSION, TIERS, TOOL_NAME, TOOL_VERSION } from './constants.js'
import {
  ensureDir,
  git,
  gitRoot,
  isDirectory,
  isFile,
  makeMatcher,
  makeRunId,
  nowIso,
  readPackageJson,
  relativePosix,
  resolveFrom,
  toPosix,
  writeJsonFile,
} from './util.js'

const MAX_WALK_ENTRIES = 20000
const MAX_UNTRACKED_READ = 512 * 1024

const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.rb', '.php',
  '.swift', '.scala', '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm',
  '.vue', '.svelte', '.astro', '.css', '.scss', '.less', '.html',
  '.sh', '.bash', '.zsh', '.ps1', '.sql', '.graphql',
])

const TEST_PATTERNS = [
  /(^|\/)(__tests__|tests?|specs?)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /_test\.(py|go)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /(Test|Tests)\.(java|kt|cs)$/,
]

const DOC_PATTERN = /\.(md|mdx|txt|rst|adoc)$/i

const SENSITIVE_PATTERNS = [
  /(^|\/)\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)(secrets?|credentials?|passwords?)(\/|\.|$)/i,
  /(^|\/)(auth|oauth|crypto|security)(\/|\.|$)/i,
  /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i,
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)(terraform|k8s|helm|charts)\//i,
  /\.(sql|tf|tfvars)$/i,
]

const DEPENDENCY_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'requirements.txt',
  'requirements-dev.txt',
  'pyproject.toml',
  'poetry.lock',
  'Pipfile',
  'Pipfile.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'composer.lock',
  'Gemfile',
  'Gemfile.lock',
])

const MIGRATION_PATTERN = /(^|\/)(migrations?|migrate|schema)\//i

const LANGUAGE_BY_EXTENSION = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin',
  '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.scala': 'Scala',
  '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.hpp': 'C++',
  '.vue': 'Vue', '.svelte': 'Svelte', '.css': 'CSS', '.scss': 'SCSS', '.less': 'Less',
  '.html': 'HTML', '.sh': 'Shell', '.ps1': 'PowerShell', '.sql': 'SQL',
}

function isTestFile(path) {
  return TEST_PATTERNS.some((pattern) => pattern.test(path))
}

function isDocFile(path) {
  return DOC_PATTERN.test(path) || /(^|\/)docs?\//i.test(path)
}

function isSensitiveFile(path) {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path))
}

function isMigrationFile(path) {
  return MIGRATION_PATTERN.test(path)
}

function isDependencyFile(path) {
  return DEPENDENCY_FILES.has(path.split('/').pop() ?? path)
}

function languageFor(path) {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()]
}

function parseShortstat(text) {
  const source = String(text ?? '')
  const files = /(\d+) files? changed/.exec(source)
  const additions = /(\d+) insertions?\(\+\)/.exec(source)
  const deletions = /(\d+) deletions?\(-\)/.exec(source)
  return {
    filesChanged: files ? Number(files[1]) : 0,
    additions: additions ? Number(additions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  }
}

function normalizeStatus(code) {
  const [indexStatus, worktreeStatus] = code
  if (indexStatus === '?' && worktreeStatus === '?') return 'untracked'
  if (indexStatus === 'U' || worktreeStatus === 'U') return 'conflicted'
  if (indexStatus === 'R') return 'renamed'
  if (indexStatus === 'C') return 'copied'
  if (indexStatus === 'D' || worktreeStatus === 'D') return 'deleted'
  if (indexStatus === 'A' || worktreeStatus === 'A') return 'added'
  return 'modified'
}

/**
 * Parse `git status --porcelain=v1 -z`. Records are `XY PATH\0`; rename and
 * copy records are followed by the original path as a separate record.
 */
export function parseStatusZ(stdout) {
  const records = String(stdout).split('\0')
  const files = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const code = record.slice(0, 2)
    const path = record.slice(3)
    if (!path) continue
    const status = normalizeStatus(code)
    let oldPath
    if (status === 'renamed' || status === 'copied') {
      oldPath = records[index + 1]
      if (oldPath) index += 1
    }
    files.push({ path: toPosix(path), oldPath: oldPath ? toPosix(oldPath) : undefined, status })
  }
  return files
}

function parseNameStatus(stdout) {
  const files = []
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const statusCode = parts[0][0]
    if (statusCode === 'R' || statusCode === 'C') {
      if (parts.length < 3) continue
      files.push({
        path: toPosix(parts[2]),
        oldPath: toPosix(parts[1]),
        status: statusCode === 'C' ? 'copied' : 'renamed',
      })
    } else {
      const status = statusCode === 'A' ? 'added' : statusCode === 'D' ? 'deleted' : 'modified'
      files.push({ path: toPosix(parts[1]), status })
    }
  }
  return files
}

function countLines(path, maxBytes = MAX_UNTRACKED_READ) {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > maxBytes) return 0
    const buffer = readFileSync(path)
    if (buffer.includes(0)) return 0
    if (buffer.length === 0) return 0
    let lines = 1
    for (const byte of buffer) if (byte === 10) lines += 1
    return lines
  } catch {
    return 0
  }
}

function walkWorkspace(root, matcher, limit) {
  const files = []
  const stack = [{ dir: root, depth: 0 }]
  let visited = 0
  while (stack.length > 0 && files.length < limit && visited < MAX_WALK_ENTRIES) {
    const { dir, depth } = stack.pop()
    if (depth > 8) continue
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        if (entry.name !== '.github' && entry.name !== '.env.example') continue
      }
      visited += 1
      const absolute = resolve(dir, entry.name)
      const rel = relativePosix(root, absolute)
      if (matcher(rel) || matcher(`${rel}/`)) continue
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        stack.push({ dir: absolute, depth: depth + 1 })
      } else if (entry.isFile()) {
        files.push({ path: rel, status: 'present', absolute })
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

function detectTestCommand(root, config) {
  if (typeof config.testCommand === 'string' && config.testCommand.trim()) {
    return { command: config.testCommand.trim(), source: 'config' }
  }
  const pkg = readPackageJson(root)
  if (pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts.test === 'string') {
    const script = pkg.scripts.test.trim()
    if (script && !/no test specified/i.test(script)) {
      const manager = isFile(resolve(root, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : isFile(resolve(root, 'yarn.lock'))
          ? 'yarn'
          : isFile(resolve(root, 'bun.lockb'))
            ? 'bun'
            : 'npm'
      return { command: `${manager} test`, source: 'package.json' }
    }
  }
  const deps = {
    ...(pkg && typeof pkg === 'object' ? pkg.dependencies : {}),
    ...(pkg && typeof pkg === 'object' ? pkg.devDependencies : {}),
  }
  if (deps.vitest) return { command: 'npx vitest run', source: 'vitest' }
  if (deps.jest) return { command: 'npx jest --ci', source: 'jest' }
  if (isFile(resolve(root, 'pyproject.toml')) || isFile(resolve(root, 'pytest.ini'))) {
    return { command: 'pytest -q', source: 'pytest' }
  }
  if (isFile(resolve(root, 'go.mod'))) return { command: 'go test ./...', source: 'go' }
  if (isFile(resolve(root, 'Cargo.toml'))) return { command: 'cargo test', source: 'cargo' }
  return undefined
}

function assessRisk({ files, stats, docsOnly }) {
  const reasons = []
  const add = (code, label, weight) => reasons.push({ code, label, weight })

  const sensitive = files.filter((file) => isSensitiveFile(file.path))
  const dependencies = files.filter((file) => isDependencyFile(file.path))
  const migrations = files.filter((file) => isMigrationFile(file.path))
  const tests = files.filter((file) => isTestFile(file.path))
  const sources = files.filter((file) => SOURCE_EXTENSIONS.has(extname(file.path).toLowerCase()))
  const changedLines = stats.additions + stats.deletions

  if (files.length === 0) {
    add('no-changes', '没有检测到改动', 0)
    return { level: 'low', score: 0, reasons, recommendTier: 'quick', docsOnly: false }
  }
  if (sensitive.length > 0) {
    add('sensitive', `涉及 ${sensitive.length} 个敏感/安全边界文件`, 4)
  }
  if (dependencies.length > 0) {
    add('dependencies', `涉及 ${dependencies.length} 个依赖或构建配置文件`, 2)
  }
  if (migrations.length > 0) {
    add('migration', `涉及 ${migrations.length} 个迁移/数据库文件`, 3)
  }
  if (changedLines > 800) {
    add('large-diff', `改动约 ${changedLines} 行，范围较大`, 3)
  } else if (changedLines > 200) {
    add('medium-diff', `改动约 ${changedLines} 行`, 1)
  }
  if (files.length > 40) {
    add('many-files', `改动 ${files.length} 个文件`, 2)
  } else if (files.length > 10) {
    add('some-files', `改动 ${files.length} 个文件`, 1)
  }
  if (sources.length > 0 && tests.length === 0) {
    add('no-tests', '有源码改动但没有测试改动', 1)
  }

  let score = reasons.reduce((total, reason) => total + reason.weight, 0)
  let level = 'low'
  if (!docsOnly) {
    if (score >= 4) level = 'high'
    else if (score >= 2) level = 'medium'
  } else {
    score = Math.min(score, 1)
  }

  let recommendTier = 'quick'
  if (level === 'high') recommendTier = 'full'
  else if (level === 'medium') recommendTier = 'standard'

  return { level, score, reasons, recommendTier, docsOnly }
}

function summarizeFiles(files) {
  const byStatus = {}
  const byLanguage = {}
  let sourceFiles = 0
  let testFiles = 0
  let docsFiles = 0
  let sensitiveFiles = 0
  let dependencyFiles = 0
  for (const file of files) {
    byStatus[file.status] = (byStatus[file.status] ?? 0) + 1
    const language = languageFor(file.path)
    if (language) {
      byLanguage[language] = (byLanguage[language] ?? 0) + 1
      sourceFiles += 1
    }
    if (isTestFile(file.path)) testFiles += 1
    if (isDocFile(file.path)) docsFiles += 1
    if (isSensitiveFile(file.path)) sensitiveFiles += 1
    if (isDependencyFile(file.path)) dependencyFiles += 1
  }
  const languages = Object.entries(byLanguage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }))
  return { byStatus, languages, sourceFiles, testFiles, docsFiles, sensitiveFiles, dependencyFiles }
}

/** Paths written by Logistics itself; they must not make a report look stale. */
export function isGeneratedPath(file) {
  const path = toPosix(file)
  return path === '.logistics' || path.startsWith('.logistics/')
    || path === 'docs/logistics' || path.startsWith('docs/logistics/')
}

function collectGitChanges(root, config) {
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], root)
  const dirtyFiles = status.ok ? parseStatusZ(status.stdout) : []
  const dirty = dirtyFiles.length > 0
  const sourceDirty = dirtyFiles.some((file) => !isGeneratedPath(file.path))
  const branchResult = git(['rev-parse', '--abbrev-ref', 'HEAD'], root)
  const headResult = git(['rev-parse', '--short', 'HEAD'], root)
  const subjectResult = git(['log', '-1', '--pretty=%s'], root)
  const meta = {
    available: true,
    dirty,
    sourceDirty,
    branch: branchResult.ok ? branchResult.stdout.trim() : undefined,
    head: headResult.ok ? headResult.stdout.trim() : undefined,
    headSubject: subjectResult.ok ? subjectResult.stdout.trim() : undefined,
  }

  if (dirty) {
    const unstaged = parseShortstat(git(['diff', '--shortstat'], root).stdout)
    const staged = parseShortstat(git(['diff', '--cached', '--shortstat'], root).stdout)
    const stats = {
      filesChanged: dirtyFiles.length,
      additions: unstaged.additions + staged.additions,
      deletions: unstaged.deletions + staged.deletions,
    }
    for (const file of dirtyFiles) {
      if (file.status === 'untracked') {
        stats.additions += countLines(resolve(root, file.path))
      }
    }
    return { files: dirtyFiles, stats, meta, source: 'working-tree' }
  }

  if (config.includeLastCommitWhenClean) {
    const headExists = git(['rev-parse', '--verify', 'HEAD'], root).ok
    if (headExists) {
      const names = git(['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', '--root', 'HEAD'], root)
      const files = names.ok ? parseNameStatus(names.stdout) : []
      const stats = parseShortstat(git(['show', '--shortstat', '--format=', 'HEAD'], root).stdout)
      stats.filesChanged = files.length || stats.filesChanged
      meta.base = 'last-commit'
      meta.head = meta.head ?? (headResult.ok ? headResult.stdout.trim() : undefined)
      return { files, stats, meta, source: 'last-commit' }
    }
  }

  return { files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 }, meta, source: 'none' }
}

/**
 * Build a scope snapshot for one analysis run. The function is synchronous by
 * design: command handlers need the run id before they can enqueue the model
 * turn that starts the analysis.
 */
export function createScope({ cwd, command, passes, mode, tier, notes, config }) {
  const start = resolve(cwd)
  const root = gitRoot(start) ?? start
  if (!isDirectory(root)) throw new Error(`工作区不存在：${root}`)
  const runId = makeRunId()
  const runDir = resolve(root, '.logistics', 'runs', runId)
  const handoffDir = resolve(runDir, 'handoff')
  ensureDir(handoffDir)

  const matcher = makeMatcher([...config.ignore])
  const gitInfo = gitRoot(start)
  let changes
  if (gitInfo) {
    changes = collectGitChanges(root, config)
  } else {
    const walked = walkWorkspace(root, matcher, config.maxFiles * 2)
    const stats = { filesChanged: walked.length, additions: 0, deletions: 0 }
    for (const file of walked) {
      file.absolute = undefined
      stats.additions += countLines(resolve(root, file.path))
    }
    changes = {
      files: walked,
      stats,
      meta: { available: false, dirty: true },
      source: 'filesystem',
    }
  }

  const filtered = changes.files.filter((file) => !matcher(file.path))
  const truncated = filtered.length > config.maxFiles
  const files = filtered.slice(0, config.maxFiles)
  const docsOnly = files.length > 0 && files.every((file) => isDocFile(file.path))
  const summary = summarizeFiles(files)
  const risk = assessRisk({ files, stats: changes.stats, docsOnly })
  const testCommand = detectTestCommand(root, config)
  const tierHint = tier && tier !== 'auto' ? tier : undefined
  const resolvedTier = mode === 'single' ? 'single' : tierHint ?? (mode === 'auto' ? risk.recommendTier : mode)
  const resolvedPasses = mode === 'single'
    ? [...passes]
    : passes && passes.length > 0
      ? [...passes]
      : [...(TIERS[resolvedTier]?.passes ?? TIERS.standard.passes)]

  const scope = {
    schemaVersion: SCOPE_SCHEMA_VERSION,
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    runId,
    createdAt: nowIso(),
    command,
    mode,
    tier: resolvedTier,
    passes: resolvedPasses,
    trigger: 'command',
    notes: notes && notes.trim() ? notes.trim().slice(0, 2000) : undefined,
    root: toPosix(root),
    cwd: toPosix(start),
    isGit: Boolean(gitInfo),
    git: changes.meta,
    source: changes.source,
    files,
    output: {
      runDir: toPosix(runDir),
      handoffDir: toPosix(handoffDir),
      reportJson: toPosix(resolve(runDir, 'report.json')),
      reportMarkdown: toPosix(resolve(runDir, 'report.md')),
      latestMarkdown: toPosix(resolve(root, 'docs', 'logistics', 'latest.md')),
      baseline: toPosix(resolve(root, '.logistics', 'baseline.json')),
    },
    stats: {
      ...changes.stats,
      analyzedFiles: files.length,
      truncated,
      omittedFiles: Math.max(0, filtered.length - files.length),
    },
    summary,
    testCommand,
    risk,
    warnings: truncated
      ? [`文件数超过 maxFiles=${config.maxFiles}，仅分析前 ${config.maxFiles} 个`]
      : [],
  }

  const scopePath = resolve(runDir, 'scope.json')
  writeJsonFile(scopePath, scope)
  return { root, runId, runDir, handoffDir, scopePath, scope }
}

/** Load a scope.json written by createScope. */
export function readScope(runDir) {
  const scopePath = resolve(runDir, 'scope.json')
  if (!isFile(scopePath)) throw new Error(`找不到 scope.json：${scopePath}`)
  return JSON.parse(readFileSync(scopePath, 'utf8'))
}
