import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../lib/config.js'
import { cleanup, tempDir, write } from './helpers.js'

function writeConfig(root, value) {
  write(root, '.logistics/config.json', JSON.stringify(value, null, 2))
}

test('default config includes build, dependency, and generated paths', () => {
  const root = tempDir()
  try {
    const { config, found } = loadConfig(root)
    assert.equal(found, false)
    for (const pattern of ['node_modules/**', 'dist/**', '.logistics/**', 'docs/logistics/**']) {
      assert.ok(config.ignore.includes(pattern), pattern)
    }
    assert.equal(config.maxFiles, 400)
    assert.equal(config.maxFindingsPerPass, 12)
    assert.equal(config.includeLastCommitWhenClean, true)
    assert.deepEqual(config.modules, {})
  } finally {
    cleanup(root)
  }
})

test('user ignore patterns are appended to the defaults', () => {
  const root = tempDir()
  try {
    writeConfig(root, { ignore: ['generated/**', '  *.snap  '] })
    const { config, found, warnings } = loadConfig(root)
    assert.equal(found, true)
    assert.deepEqual(warnings, [])
    assert.ok(config.ignore.includes('node_modules/**'))
    assert.ok(config.ignore.includes('generated/**'))
    assert.ok(config.ignore.includes('*.snap'))
  } finally {
    cleanup(root)
  }
})

test('invalid numbers and booleans fall back with warnings', () => {
  const root = tempDir()
  try {
    writeConfig(root, {
      maxFiles: 'many',
      maxFindingsPerPass: 0,
      includeLastCommitWhenClean: 'yes',
    })
    const { config, warnings } = loadConfig(root)
    assert.equal(config.maxFiles, 400)
    assert.equal(config.maxFindingsPerPass, 12)
    assert.equal(config.includeLastCommitWhenClean, true)
    assert.ok(warnings.some((warning) => warning.includes('maxFiles')))
    assert.ok(warnings.some((warning) => warning.includes('maxFindingsPerPass')))
    assert.ok(warnings.some((warning) => warning.includes('includeLastCommitWhenClean')))
  } finally {
    cleanup(root)
  }
})

test('testCommand must be a non-empty string and modules must be display names', () => {
  const root = tempDir()
  try {
    writeConfig(root, {
      testCommand: '   ',
      modules: { src: '应用源码', bad: 42 },
    })
    const { config, warnings } = loadConfig(root)
    assert.equal(config.testCommand, undefined)
    assert.deepEqual(config.modules, { src: '应用源码' })
    assert.ok(warnings.some((warning) => warning.includes('testCommand')))
    assert.ok(warnings.some((warning) => warning.includes('modules.bad')))
  } finally {
    cleanup(root)
  }
})

test('unknown and retired keys are ignored with warnings', () => {
  const root = tempDir()
  try {
    writeConfig(root, {
      gate: { failOnNewHigh: true },
      baseline: true,
      maxFiles: 50,
      modules: { 'packages/api': 'API' },
    })
    const { config, warnings } = loadConfig(root)
    assert.equal(config.maxFiles, 50)
    assert.deepEqual(config.modules, { 'packages/api': 'API' })
    assert.ok(warnings.some((warning) => warning.includes('"gate"')))
    assert.ok(warnings.some((warning) => warning.includes('"baseline"')))
  } finally {
    cleanup(root)
  }
})

test('a non-object config file is rejected without throwing', () => {
  const root = tempDir()
  try {
    write(root, '.logistics/config.json', '[]')
    const { config, warnings, found } = loadConfig(root)
    assert.equal(found, false)
    assert.equal(config.maxFiles, 400)
    assert.ok(warnings.some((warning) => warning.includes('JSON 对象')))
  } finally {
    cleanup(root)
  }
})
