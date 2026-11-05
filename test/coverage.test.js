import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import test from 'node:test'
import { handoffJsonPath } from '../lib/handoff-paths.js'
import { loadHandoffs } from '../lib/handoffs.js'
import {
  cleanup,
  commitAll,
  initRepo,
  makeProjectScope,
  projectHandoff,
  write,
} from './helpers.js'

function fixture() {
  const root = initRepo()
  for (let index = 0; index < 35; index += 1) {
    write(root, `src/file-${String(index).padStart(2, '0')}.js`, `export const v${index} = ${index}\n`)
  }
  write(root, 'src/auth/login.js', 'export function login() { return true }\n')
  commitAll(root, 'coverage fixture')
  const created = makeProjectScope(root, ['security'])
  return { root, scope: created.scope }
}

function handoffWith(scope, mutate) {
  const raw = projectHandoff('security', scope)
  mutate(raw.units[scope.project.units[0].id], scope.project.units[0], raw)
  writeFileSync(handoffJsonPath(scope, 'security'), `${JSON.stringify(raw, null, 2)}\n`)
  return loadHandoffs({ root: scope.root, scope }).handoffs.find((item) => item.expert === 'security')
}

test('core files and minimum reads are part of the project scope', () => {
  const { root, scope } = fixture()
  try {
    const unit = scope.project.units[0]
    assert.ok(unit.core.includes('src/auth/login.js'))
    assert.ok(scope.project.units.some((item) => item.core.includes('package.json')))
    assert.equal(scope.project.minFilesPerUnit, 30)
    assert.ok(unit.files.length >= 30)
  } finally {
    cleanup(root)
  }
})

test('project handoffs must declare actual files and every core file', () => {
  const { root, scope } = fixture()
  try {
    const unit = scope.project.units[0]
    const allFiles = unit.files.map((file) => file.path)
    const missingCore = handoffWith(scope, (rawUnit) => {
      rawUnit.files = allFiles.filter((path) => path !== unit.core[0])
      rawUnit.filesRead = allFiles.length - 1
    })
    assert.equal(missingCore.valid, false)
    assert.match(missingCore.error, /未读核心文件/u)

    const tooFew = handoffWith(scope, (rawUnit) => {
      rawUnit.files = allFiles.slice(0, 5)
      rawUnit.filesRead = 5
    })
    assert.equal(tooFew.valid, false)
    assert.match(tooFew.error, /至少读取/u)

    const noFiles = handoffWith(scope, (rawUnit) => {
      delete rawUnit.files
    })
    assert.equal(noFiles.valid, false)
    assert.match(noFiles.error, /必须提供 files/u)
  } finally {
    cleanup(root)
  }
})
