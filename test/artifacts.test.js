import assert from 'node:assert/strict'
import test from 'node:test'
import { runExtraDirs, runExtraFiles } from '../lib/artifacts.js'
import { cleanup, initRepo, makeProjectScope, write } from './helpers.js'

test('run root extras report model scripts but not documented artifacts', () => {
  const root = initRepo()
  try {
    const { scope } = makeProjectScope(root, ['security'])
    write(scope.output.runDir, 'report.md', 'ok')
    write(scope.output.runDir, 'build-report.mjs', 'console.log(1)')
    write(scope.output.runDir, 'scratch', 'temp')
    assert.deepEqual(
      runExtraFiles(scope).map((file) => file.split(/[\\/]/u).pop()),
      ['build-report.mjs', 'scratch'],
    )
    write(scope.output.runDir, 'logs.txt', 'x')
    assert.equal(runExtraDirs(scope).length, 0)
  } finally {
    cleanup(root)
  }
})
