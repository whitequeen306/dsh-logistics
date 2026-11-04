import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CONFIG } from '../lib/constants.js'
import { buildProjectPlan, isProjectFile, moduleKeyFor } from '../lib/project.js'
import {
  cleanup,
  commitAll,
  initRepo,
  makeProjectScope,
  tempDir,
  write,
} from './helpers.js'

function projectConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    ignore: [],
    project: { ...DEFAULT_CONFIG.project, ...overrides },
  }
}

test('project plan groups every source file into review units', () => {
  const root = initRepo()
  try {
    const created = makeProjectScope(root, ['correctness'])
    assert.equal(created.scope.mode, 'project')
    assert.equal(created.scope.source, 'project')
    assert.equal(created.scope.assignments, undefined)
    assert.ok(created.scope.project.units.length >= 1)
    assert.ok(created.scope.files.some((file) => file.path === 'src/a.js'))
    assert.ok(created.scope.files.some((file) => file.path === 'package.json'))
    assert.ok(created.scope.project.totals.lines > 0)
    const ids = created.scope.project.units.map((unit) => unit.id)
    assert.equal(new Set(ids).size, ids.length)
  } finally {
    cleanup(root)
  }
})

test('project files ignore docs, generated output, dependencies, and binary assets', () => {
  const root = initRepo()
  try {
    write(root, 'docs/guide.md', '# guide\n')
    write(root, 'docs/logistics/latest.md', '# generated\n')
    write(root, '.logistics/runs/x/scope.json', '{}')
    write(root, 'node_modules/pkg/index.js', 'module.exports = 1\n')
    write(root, 'dist/bundle.js', 'console.log(1)\n')
    write(root, 'public/logo.png', 'not-an-image')
    commitAll(root, 'add non-project files')

    const plan = buildProjectPlan({ root, config: projectConfig() })
    const paths = plan.files.map((file) => file.path)
    assert.ok(paths.includes('src/a.js'))
    assert.ok(!paths.some((path) => path.startsWith('docs/')))
    assert.ok(!paths.some((path) => path.startsWith('.logistics/')))
    assert.ok(!paths.some((path) => path.startsWith('node_modules/')))
    assert.ok(!paths.some((path) => path.startsWith('dist/')))
    assert.ok(!paths.some((path) => path.startsWith('public/')))
  } finally {
    cleanup(root)
  }
})

test('large modules split into numbered units and small modules merge uniquely', () => {
  const root = initRepo()
  try {
    for (let index = 0; index < 25; index += 1) {
      write(root, `pkg/file-${String(index).padStart(2, '0')}.js`, `export const v${index} = ${index}\n`)
    }
    commitAll(root, 'many files')
    const plan = buildProjectPlan({
      root,
      config: projectConfig({ maxFiles: 100, maxFilesPerUnit: 10, maxUnits: 20 }),
    })
    const pkgUnits = plan.units.filter((unit) => unit.label.startsWith('pkg'))
    assert.ok(pkgUnits.length >= 3)
    assert.match(pkgUnits[0].label, /pkg \(\d+\/\d+\)/u)
  } finally {
    cleanup(root)
  }
})

test('unit labels stay unique when small modules are merged', () => {
  const root = initRepo()
  try {
    for (let index = 0; index < 6; index += 1) {
      write(root, `mod${index}/file.js`, `export const value = ${index}\n`)
    }
    commitAll(root, 'modules')
    const plan = buildProjectPlan({
      root,
      config: projectConfig({ maxFiles: 100, maxFilesPerUnit: 50, maxUnits: 3 }),
    })
    const labels = plan.units.map((unit) => unit.label)
    assert.equal(new Set(labels).size, labels.length)
    assert.ok(plan.units.length <= 3)
  } finally {
    cleanup(root)
  }
})

test('project mode requires a git repository', () => {
  const root = tempDir('dsh-logi-nogit-')
  try {
    write(root, 'src/a.js', 'export const a = 1\n')
    assert.throws(
      () => makeProjectScope(root, ['correctness']),
      /全项目模式需要 git 仓库/u,
    )
  } finally {
    cleanup(root)
  }
})

test('project file classification is deterministic', () => {
  assert.equal(isProjectFile('src/a.js'), true)
  assert.equal(isProjectFile('package.json'), true)
  assert.equal(isProjectFile('docs/readme.md'), false)
  assert.equal(isProjectFile('.logistics/runs/x/scope.json'), false)
  assert.equal(moduleKeyFor('backend/lianyu-dao/x.java'), 'backend/lianyu-dao')
  assert.equal(moduleKeyFor('src/a.js'), 'src')
})
