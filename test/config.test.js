import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfig } from '../lib/config.js'
import { cleanup, tempDir } from './helpers.js'

function writeConfig(root, value) {
  mkdirSync(join(root, '.logistics'), { recursive: true })
  writeFileSync(join(root, '.logistics', 'config.json'), JSON.stringify(value))
}

test('default config always ignores dependency and build directories', (t) => {
  const root = tempDir()
  t.after(() => cleanup(root))
  const { config, found } = loadConfig(root)
  assert.equal(found, false)
  assert.ok(config.ignore.includes('node_modules/**'))
  assert.ok(config.ignore.includes('dist/**'))
  assert.ok(config.ignore.includes('.logistics/**'))
  assert.ok(config.ignore.includes('docs/logistics/**'))
  assert.equal(config.maxFiles, 400)
})

test('user ignore entries are appended to defaults', (t) => {
  const root = tempDir()
  t.after(() => cleanup(root))
  writeConfig(root, { ignore: ['legacy/**', '  '], maxFiles: 12 })
  const { config, found, warnings } = loadConfig(root)
  assert.equal(found, true)
  assert.ok(config.ignore.includes('node_modules/**'))
  assert.ok(config.ignore.includes('legacy/**'))
  assert.ok(!config.ignore.includes(''))
  assert.equal(config.maxFiles, 12)
  assert.deepEqual(warnings, [])
})

test('invalid values fall back with warnings instead of throwing', (t) => {
  const root = tempDir()
  t.after(() => cleanup(root))
  writeConfig(root, { ignore: 'nope', maxFiles: 0, gate: { failOnNewHigh: 'yes' }, extra: true })
  const { config, warnings } = loadConfig(root)
  assert.equal(config.maxFiles, 400)
  assert.equal(config.gate.failOnNewHigh, false)
  assert.match(warnings.join('\n'), /ignore/)
  assert.match(warnings.join('\n'), /maxFiles/)
  assert.match(warnings.join('\n'), /failOnNewHigh/)
  assert.match(warnings.join('\n'), /extra/)
})
