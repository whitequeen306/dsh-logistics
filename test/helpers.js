import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function tempDir(prefix = 'logi-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function write(root, relative, content) {
  const file = join(root, ...relative.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

export function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function initRepo({ commit = true } = {}) {
  const root = tempDir()
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'logi@example.com')
  git(root, 'config', 'user.name', 'Logi Test')
  git(root, 'config', 'core.autocrlf', 'false')
  if (commit) {
    write(root, 'package.json', JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }, null, 2))
    write(root, 'src/a.js', 'export const a = 1\nexport function add(x, y) { return x + y }\n')
    commitAll(root, 'init')
  }
  return root
}

export function commitAll(root, message = 'update') {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
}

export function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

export function handoff(pass, findings = [], extra = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    pass,
    status: 'ok',
    summary: `${pass} 完成，${findings.length} 个发现。`,
    findings,
    ...extra,
  }, null, 2)
}

export const sampleFinding = {
  category: 'logic',
  severity: 'high',
  confidence: 'high',
  title: '示例逻辑问题',
  file: 'src/a.js',
  line: 2,
  ruleId: 'COR-logic',
  evidence: '2: return x - y // 与函数名 add 不符',
  impact: '调用方得到错误结果。',
  recommendation: '改为 x + y，并补充测试。',
  autoFixable: true,
}
