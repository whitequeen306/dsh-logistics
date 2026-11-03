/**
 * Shared vocabulary for the logistics plugin.
 *
 * Keep this module dependency-free: the plugin is installed into a DSH profile
 * next to official packages and must not pull a second copy of @deepseek-ai/*.
 */

export const TOOL_NAME = 'dsh-logistics'
export const TOOL_VERSION = '0.1.0'
export const REPORT_SCHEMA_VERSION = 1
export const SCOPE_SCHEMA_VERSION = 1

/** Finding severities, highest first. `weight` feeds the 0-100 health score. */
export const SEVERITIES = Object.freeze({
  critical: { rank: 0, weight: 25, label: '严重', short: 'C' },
  high: { rank: 1, weight: 10, label: '高', short: 'H' },
  medium: { rank: 2, weight: 4, label: '中', short: 'M' },
  low: { rank: 3, weight: 1, label: '低', short: 'L' },
  info: { rank: 4, weight: 0, label: '提示', short: 'I' },
})

export const SEVERITY_ORDER = Object.freeze(['critical', 'high', 'medium', 'low', 'info'])

/**
 * The seven specialist passes. `key` is the stable machine name used in
 * handoff files, report JSON, and the `--passes` argument.
 */
export const PASS_LIST = Object.freeze([
  {
    key: 'review',
    title: '正确性审查',
    skill: 'logi-review',
    expert: 'code-reviewer',
    prefix: 'COR',
    domain: 'correctness',
    focus: '逻辑、状态、并发、数据完整性、架构边界',
  },
  {
    key: 'safety',
    title: '安全审查',
    skill: 'logi-safety',
    expert: 'security-auditor',
    prefix: 'SEC',
    domain: 'security',
    focus: '认证授权、注入、密钥、依赖、边界校验',
  },
  {
    key: 'tests',
    title: '测试审查',
    skill: 'logi-tests',
    expert: 'test-engineer',
    prefix: 'TST',
    domain: 'tests',
    focus: '回归缺口、测试层次、断言质量、易碎测试',
  },
  {
    key: 'errors',
    title: '错误处理审查',
    skill: 'logi-errors',
    expert: 'silent-failure-hunter',
    prefix: 'ERR',
    domain: 'error-handling',
    focus: '吞错、传播、部分失败、重试、可观测性',
  },
  {
    key: 'perf',
    title: '性能审查',
    skill: 'logi-perf',
    expert: 'performance-analyst',
    prefix: 'PRF',
    domain: 'performance',
    focus: '热路径、复杂度、N+1、内存、阻塞 I/O',
  },
  {
    key: 'simplify',
    title: '简化审查',
    skill: 'logi-simplify',
    expert: 'code-simplifier',
    prefix: 'SMP',
    domain: 'simplicity',
    focus: '嵌套、重复、命名、过度抽象、行为保持',
  },
  {
    key: 'cleanup',
    title: '清理审查',
    skill: 'logi-cleanup',
    expert: 'cleanup-curator',
    prefix: 'CLN',
    domain: 'cleanup',
    focus: '死代码、未用导出、依赖债务、孤立文件',
  },
])

export const PASS_BY_KEY = Object.freeze(
  Object.fromEntries(PASS_LIST.map((pass) => [pass.key, pass])),
)

export const TIERS = Object.freeze({
  quick: {
    label: '快速',
    description: '3 位专家：正确性、安全、错误处理',
    passes: Object.freeze(['review', 'safety', 'errors']),
  },
  standard: {
    label: '标准',
    description: '5 位专家：快速档 + 测试、清理',
    passes: Object.freeze(['review', 'safety', 'tests', 'errors', 'cleanup']),
  },
  full: {
    label: '全量',
    description: '7 位专家：全部检查',
    passes: Object.freeze(['review', 'safety', 'tests', 'errors', 'perf', 'simplify', 'cleanup']),
  },
})

export const SINGLE_TIER = Object.freeze({
  label: '单点',
  description: '只运行一位专家',
  passes: Object.freeze([]),
})

export const MODES = Object.freeze(['auto', 'quick', 'standard', 'full', 'single', 'gate'])

/** Default config merged under `.logistics/config.json`. */
export const DEFAULT_CONFIG = Object.freeze({
  ignore: [],
  maxFiles: 400,
  maxFindingsPerPass: 12,
  includeLastCommitWhenClean: true,
  gate: {
    failOnNewHigh: false,
    maxScoreDrop: 5,
  },
})

/** Default ignore globs, always applied before user config. */
export const DEFAULT_IGNORES = Object.freeze([
  '.git/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  'out/**',
  'coverage/**',
  '.next/**',
  '.nuxt/**',
  '.turbo/**',
  '.cache/**',
  'vendor/**',
  'target/**',
  '__pycache__/**',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
])
