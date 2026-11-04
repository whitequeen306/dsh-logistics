/**
 * Shared vocabulary for the logistics plugin.
 *
 * Keep this module dependency-free: the plugin is installed into a DSH profile
 * next to official packages and must not pull a second copy of @deepseek-ai/*.
 */

export const TOOL_NAME = 'dsh-logistics'
export const TOOL_VERSION = '0.5.1'
export const REPORT_SCHEMA_VERSION = 2
export const SCOPE_SCHEMA_VERSION = 2
export const VERDICT_SCHEMA_VERSION = 2

/** Finding severities, highest first. No weights: 0.2.0 has no health score. */
export const SEVERITIES = Object.freeze({
  critical: { rank: 0, label: '严重', short: 'C' },
  high: { rank: 1, label: '高', short: 'H' },
  medium: { rank: 2, label: '中', short: 'M' },
  low: { rank: 3, label: '低', short: 'L' },
  info: { rank: 4, label: '提示', short: 'I' },
})

export const SEVERITY_ORDER = Object.freeze(['critical', 'high', 'medium', 'low', 'info'])

/**
 * The five logistics modules. `key` is the machine name shared by the command,
 * the skill directory, and the handoff file. `sections` are the sub-reports a
 * merged module must explicitly account for.
 */
export const EXPERT_LIST = Object.freeze([
  {
    key: 'correctness',
    title: '正确性',
    skill: 'logi-correctness',
    expert: 'code-reviewer',
    prefix: 'COR',
    domain: 'correctness',
    sections: Object.freeze([
      'logic',
      'state',
      'concurrency',
      'data-integrity',
      'contracts',
      'architecture',
      'edge-cases',
    ]),
    focus: '逻辑、状态、并发、数据完整性、接口契约、架构边界、schema 迁移、边界条件',
  },
  {
    key: 'security',
    title: '安全',
    skill: 'logi-security',
    expert: 'security-auditor',
    prefix: 'SEC',
    domain: 'security',
    sections: Object.freeze([
      'auth',
      'authz',
      'injection',
      'browser',
      'uploads',
      'secrets',
      'crypto',
      'exposure',
      'supply-chain',
    ]),
    focus: '认证、授权/租户隔离、注入、浏览器安全、上传/SSRF、密钥、加密、数据暴露、依赖与供应链',
  },
  {
    key: 'reliability',
    title: '健壮性',
    skill: 'logi-reliability',
    expert: 'reliability-engineer',
    prefix: 'REL',
    domain: 'reliability',
    sections: Object.freeze(['error-handling', 'tests']),
    focus: '错误处理、失败传播、重试/幂等、部分失败、测试缺口与回归',
  },
  {
    key: 'maintainability',
    title: '可维护性',
    skill: 'logi-maintainability',
    expert: 'maintainability-engineer',
    prefix: 'MNT',
    domain: 'maintainability',
    sections: Object.freeze(['simplify', 'cleanup']),
    focus: '简化、重复、过度抽象、死代码、未用依赖、孤儿文件',
  },
  {
    key: 'perf',
    title: '性能',
    skill: 'logi-perf',
    expert: 'performance-analyst',
    prefix: 'PRF',
    domain: 'performance',
    sections: Object.freeze(['hot-path', 'data-access', 'runtime', 'frontend', 'memory-startup']),
    focus: '热路径、复杂度、数据库访问、运行时/阻塞、前端渲染与包体、内存与启动',
  },
])

export const EXPERT_BY_KEY = Object.freeze(
  Object.fromEntries(EXPERT_LIST.map((expert) => [expert.key, expert])),
)

export const EXPERT_ORDER = Object.freeze(EXPERT_LIST.map((expert) => expert.key))
export const DEFAULT_EXPERTS = Object.freeze(['correctness', 'security', 'reliability', 'maintainability'])
export const OPTIONAL_EXPERTS = Object.freeze(['perf'])

/** Display tie-break only; this is not a scoring weight. */
export const EXPERT_PRIORITY = Object.freeze({
  security: 0,
  correctness: 1,
  reliability: 2,
  maintainability: 3,
  perf: 4,
})

/** Default config merged under `.logistics/config.json`. */
export const DEFAULT_CONFIG = Object.freeze({
  ignore: [],
  maxFiles: 400,
  maxFindingsPerPass: 12,
  includeLastCommitWhenClean: true,
  testCommand: undefined,
  project: Object.freeze({
    maxFiles: 2000,
    maxFilesPerUnit: 120,
    maxUnits: 12,
  }),
  modules: Object.freeze({}),
  models: Object.freeze({}),
})

/** Default ignore globs, always applied before user config. */
export const DEFAULT_IGNORES = Object.freeze([
  '.git/**',
  '.logistics/**',
  'docs/logistics/**',
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
