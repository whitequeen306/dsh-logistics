import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractJson,
  globToRegExp,
  makeMatcher,
  parseSkillFile,
  sha1,
  toPosix,
} from '../lib/util.js'

test('globToRegExp stays inside a segment for a single star', () => {
  const regex = globToRegExp('src/*.js')
  assert.ok(regex.test('src/a.js'))
  assert.ok(!regex.test('src/deep/a.js'))
  assert.ok(!regex.test('src/a.ts'))
})

test('makeMatcher supports basename patterns and directory globs', () => {
  const match = makeMatcher(['node_modules/**', '*.min.js', 'src/generated/**'])
  assert.equal(match('node_modules/pkg/index.js'), true)
  assert.equal(match('assets/app.min.js'), true)
  assert.equal(match('src/generated/api.ts'), true)
  assert.equal(match('src/app.js'), false)
  assert.equal(match('README.md'), false)
})

test('extractJson accepts fenced and prose-wrapped JSON', () => {
  assert.deepEqual(extractJson('```json\n{"ok":true}\n```'), { ok: true })
  assert.deepEqual(extractJson('结果如下：\n{"a":[1,2]}\n请查收'), { a: [1, 2] })
  assert.deepEqual(extractJson('prefix [1,2,3] suffix'), [1, 2, 3])
  assert.equal(extractJson('not json'), undefined)
})

test('parseSkillFile reads frontmatter and preserves body', () => {
  const parsed = parseSkillFile('---\nname: logi-demo\ndescription: "演示 skill"\n---\n\n# 标题\n\n正文\n', 'fallback')
  assert.equal(parsed.name, 'logi-demo')
  assert.equal(parsed.description, '演示 skill')
  assert.match(parsed.content, /^# 标题/)
  assert.equal(parseSkillFile('no frontmatter', 'fallback').name, 'fallback')
})

test('toPosix and sha1 are stable', () => {
  assert.equal(toPosix('a\\b\\c.js'), 'a/b/c.js')
  assert.equal(sha1('abc').length, 40)
  assert.equal(sha1('abc'), sha1('abc'))
  assert.notEqual(sha1('abc'), sha1('abd'))
})
