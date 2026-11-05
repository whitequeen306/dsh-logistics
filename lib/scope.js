import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import {
  EXPERT_BY_KEY,
  OPTIONAL_EXPERTS,
  SCOPE_SCHEMA_VERSION,
  TOOL_NAME,
  TOOL_VERSION,
} from './constants.js'
import { buildProjectPlan } from './project.js'
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

const LANGUAGE_BY_EXTENSION = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin',
  '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.scala': 'Scala',
  '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.hpp': 'C++',
  '.vue': 'Vue', '.svelte': 'Svelte', '.css': 'CSS', '.scss': 'SCSS', '.less': 'Less',
  '.html': 'HTML', '.sh': 'Shell', '.ps1': 'PowerShell', '.sql': 'SQL',
}

export function isTestFile(path) {
  return TEST_PATTERNS.some((pattern) => pattern.test(path))
}

export function isDocFile(path) {
  return DOC_PATTERN.test(path) || /(^|\/)docs?\//i.test(path)
}

export function isSensitiveFile(path) {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path))
}

export function isDependencyFile(path) {
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

function packageManager(root) {
  return isFile(resolve(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : isFile(resolve(root, 'yarn.lock'))
      ? 'yarn'
      : isFile(resolve(root, 'bun.lockb'))
        ? 'bun'
        : 'npm'
}

function packageTestCommand(manager, dir) {
  if (!dir) return `${manager} test`
  if (manager === 'pnpm') return `pnpm --dir ${dir} test`
  if (manager === 'yarn') return `yarn --cwd ${dir} test`
  if (manager === 'bun') return `bun --cwd ${dir} test`
  return `npm --prefix ${dir} test`
}

function addTestCommand(commands, command, source) {
  if (!command || commands.some((item) => item.command === command)) return
  commands.push({ command, source })
}

/**
 * Detect test commands for a project, including common monorepo layouts.
 * A single root command is not enough: Java Maven modules, Python sidecars,
 * and a separate frontend often live in sibling directories.
 */
export function detectTestCommands(root, config) {
  if (typeof config.testCommand === 'string' && config.testCommand.trim()) {
    return [{ command: config.testCommand.trim(), source: 'config' }]
  }
  const commands = []
  const pkg = readPackageJson(root)
  const manager = packageManager(root)
  if (pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts.test === 'string') {
    const script = pkg.scripts.test.trim()
    if (script && !/no test specified/i.test(script)) {
      addTestCommand(commands, packageTestCommand(manager), 'package.json')
    }
  }
  const deps = {
    ...(pkg && typeof pkg === 'object' ? pkg.dependencies : {}),
    ...(pkg && typeof pkg === 'object' ? pkg.devDependencies : {}),
  }
  if (deps.vitest) addTestCommand(commands, 'npx vitest run', 'vitest')
  if (deps.jest) addTestCommand(commands, 'npx jest --ci', 'jest')

  if (isFile(resolve(root, 'pom.xml'))) addTestCommand(commands, 'mvn -q test', 'maven')
  if (isFile(resolve(root, 'build.gradle')) || isFile(resolve(root, 'build.gradle.kts'))) {
    addTestCommand(commands, 'gradle test', 'gradle')
  }
  if (isFile(resolve(root, 'gradlew'))) addTestCommand(commands, './gradlew test', 'gradle')
  if (isFile(resolve(root, 'pyproject.toml')) || isFile(resolve(root, 'pytest.ini'))) {
    addTestCommand(commands, 'pytest -q', 'pytest')
  }
  if (isFile(resolve(root, 'go.mod'))) addTestCommand(commands, 'go test ./...', 'go')
  if (isFile(resolve(root, 'Cargo.toml'))) addTestCommand(commands, 'cargo test', 'cargo')

  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()
        && !entry.name.startsWith('.')
        && !['node_modules', 'target', 'build', 'dist', 'vendor'].includes(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    entries = []
  }
  for (const dir of entries) {
    const base = resolve(root, dir)
    if (isFile(resolve(base, 'pom.xml'))) {
      addTestCommand(commands, `mvn -q -f ${dir}/pom.xml test`, `maven:${dir}`)
      continue
    }
    if (isFile(resolve(base, 'gradlew'))) {
      addTestCommand(commands, `cd ${dir} && ./gradlew test`, `gradle:${dir}`)
      continue
    }
    if (isFile(resolve(base, 'pyproject.toml')) || isFile(resolve(base, 'pytest.ini'))) {
      addTestCommand(commands, `pytest -q ${dir}`, `pytest:${dir}`)
      continue
    }
    const childPkg = readPackageJson(base)
    if (childPkg && typeof childPkg === 'object') {
      const script = childPkg.scripts && typeof childPkg.scripts.test === 'string'
        ? childPkg.scripts.test.trim()
        : ''
      if (script && !/no test specified/i.test(script)) {
        addTestCommand(commands, packageTestCommand(manager, dir), `package.json:${dir}`)
      } else {
        const childDeps = { ...childPkg.dependencies, ...childPkg.devDependencies }
        if (childDeps.vitest) addTestCommand(commands, `cd ${dir} && npx vitest run`, `vitest:${dir}`)
        else if (childDeps.jest) addTestCommand(commands, `cd ${dir} && npx jest --ci`, `jest:${dir}`)
      }
    }
  }
  return commands.slice(0, 8)
}

export function detectTestCommand(root, config) {
  return detectTestCommands(root, config)[0]
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

/** Git reports a wholly untracked directory as one `dir/` record; expand it. */
export function expandUntrackedDirs(root, files) {
  const expanded = []
  for (const file of files) {
    if (file.status !== 'untracked' || !file.path.endsWith('/')) {
      expanded.push(file)
      continue
    }
    const listed = git(['ls-files', '--others', '--exclude-standard', '-z', '--', file.path], root)
    const children = listed.ok ? listed.stdout.split('\0').filter(Boolean) : []
    for (const child of children) {
      expanded.push({ ...file, path: toPosix(child) })
    }
  }
  return expanded
}

function collectGitChanges(root, config) {
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], root)
  const changedFiles = status.ok ? expandUntrackedDirs(root, parseStatusZ(status.stdout)) : []
  const dirtyFiles = changedFiles.filter((file) => !isGeneratedPath(file.path))
  const dirty = dirtyFiles.length > 0
  const sourceDirty = dirty
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

function projectGitMeta(root) {
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], root)
  const dirtyFiles = status.ok
    ? expandUntrackedDirs(root, parseStatusZ(status.stdout)).filter((file) => !isGeneratedPath(file.path))
    : []
  const branchResult = git(['rev-parse', '--abbrev-ref', 'HEAD'], root)
  const headResult = git(['rev-parse', '--short', 'HEAD'], root)
  const subjectResult = git(['log', '-1', '--pretty=%s'], root)
  return {
    available: true,
    dirty: dirtyFiles.length > 0,
    sourceDirty: dirtyFiles.length > 0,
    branch: branchResult.ok ? branchResult.stdout.trim() : undefined,
    head: headResult.ok ? headResult.stdout.trim() : undefined,
    headSubject: subjectResult.ok ? subjectResult.stdout.trim() : undefined,
    base: 'project',
  }
}

/**
 * Build a scope snapshot for one analysis run. The function is synchronous by
 * design: command handlers need the run id before they can enqueue the model
 * turn that starts the analysis.
 */
export function createScope({ cwd, command, experts, notes, config, mode = 'changes' }) {
  const start = resolve(cwd)
  const root = gitRoot(start) ?? start
  if (!isDirectory(root)) throw new Error(`工作区不存在：${root}`)

  const requested = Array.isArray(experts) ? experts : []
  const resolvedExperts = []
  const warnings = []
  for (const key of requested) {
    if (!EXPERT_BY_KEY[key]) {
      warnings.push(`未知专家 "${key}"，已跳过`)
      continue
    }
    if (!resolvedExperts.includes(key)) resolvedExperts.push(key)
  }
  if (resolvedExperts.length === 0) throw new Error('至少需要选择一位专家')

  const runLabel = command === '/logi' || resolvedExperts.length > 1 ? 'master' : resolvedExperts[0]
  const runId = `${makeRunId()}-${runLabel}`
  const runDir = resolve(root, '.logistics', 'runs', runId)
  const handoffDir = resolve(runDir, 'handoff')
  const handoffLayout = runLabel === 'master' ? 'nested' : 'flat'
  ensureDir(handoffDir)
  if (handoffLayout === 'nested') {
    for (const expert of resolvedExperts) ensureDir(resolve(handoffDir, expert))
  }

  const matcher = makeMatcher([...config.ignore])
  const gitInfo = gitRoot(start)
  let changes
  let projectPlan
  if (mode === 'project') {
    if (!gitInfo) {
      throw new Error('全项目模式需要 git 仓库；当前目录不在 git 工作区。')
    }
    projectPlan = buildProjectPlan({ root, config })
    changes = {
      files: projectPlan.files,
      stats: {
        filesChanged: projectPlan.totals.reviewedFiles,
        additions: projectPlan.totals.lines,
        deletions: 0,
      },
      meta: projectGitMeta(root),
      source: 'project',
    }
  } else if (gitInfo) {
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

  const filtered = mode === 'project' ? changes.files : changes.files.filter((file) => !matcher(file.path))
  const truncated = mode === 'project'
    ? Boolean(projectPlan?.totals.truncated)
    : filtered.length > config.maxFiles
  const files = mode === 'project' ? filtered : filtered.slice(0, config.maxFiles)
  const summary = summarizeFiles(files)
  const testCommands = detectTestCommands(root, config)
  const testCommand = testCommands[0]

  const scope = {
    schemaVersion: SCOPE_SCHEMA_VERSION,
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    runId,
    createdAt: nowIso(),
    command,
    mode: mode === 'project' ? 'project' : 'changes',
    experts: resolvedExperts,
    optionalExperts: OPTIONAL_EXPERTS.filter((key) => !resolvedExperts.includes(key)),
    maxFindings: config.maxFindingsPerPass,
    models: Object.fromEntries(
      Object.entries(config.models ?? {}).filter(([key]) => EXPERT_BY_KEY[key]),
    ),
    expertDetails: resolvedExperts.map((key) => {
      const info = EXPERT_BY_KEY[key]
      return { key, title: info.title, skill: info.skill, sections: info.sections, focus: info.focus }
    }),
    trigger: 'command',
    notes: notes && notes.trim() ? notes.trim().slice(0, 2000) : undefined,
    root: toPosix(root),
    cwd: toPosix(start),
    isGit: Boolean(gitInfo),
    git: changes.meta,
    source: changes.source,
    files,
    ...(projectPlan
      ? {
          project: {
            units: projectPlan.units.map((unit) => ({
              id: unit.id,
              label: unit.label,
              stats: unit.stats,
              files: unit.files,
            })),
            totals: projectPlan.totals,
          },
        }
      : {}),
    output: {
      runDir: toPosix(runDir),
      handoffDir: toPosix(handoffDir),
      handoffLayout,
      reportJson: toPosix(resolve(runDir, 'report.json')),
      reportMarkdown: toPosix(resolve(runDir, 'report.md')),
      verdictJson: toPosix(resolve(runDir, 'verdict.json')),
      graphJson: toPosix(resolve(runDir, 'graph.json')),
      graphHtml: toPosix(resolve(runDir, 'graph.html')),
      packetMarkdown: toPosix(resolve(runDir, 'packet.md')),
      handoffsJson: toPosix(resolve(runDir, 'handoffs.json')),
      latestMarkdown: toPosix(resolve(root, 'docs', 'logistics', 'latest.md')),
      latestJson: toPosix(resolve(root, '.logistics', 'latest.json')),
    },
    stats: {
      ...changes.stats,
      analyzedFiles: files.length,
      truncated,
      omittedFiles: projectPlan
        ? projectPlan.totals.omittedFiles
        : Math.max(0, filtered.length - files.length),
    },
    summary,
    testCommand,
    ...(testCommands.length > 1 ? { testCommands } : {}),
    warnings: truncated
      ? [mode === 'project'
        ? `全项目文件数超过 project.maxFiles=${config.project?.maxFiles ?? 2000}，仅分析前 ${files.length} 个`
        : `文件数超过 maxFiles=${config.maxFiles}，仅分析前 ${config.maxFiles} 个`, ...warnings]
      : warnings,
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
