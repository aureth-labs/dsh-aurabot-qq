// #85：记忆星图必须定义 smStarMatches，否则筛选一开就整块 ReferenceError。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const start = src.indexOf('const smStarMatches =')
const end = src.indexOf('const smTintIndexOf', start)
assert.ok(start > 0 && end > start, 'client/client.js 里找不到 smStarMatches 定义')
const smStarMatches = new Function(src.slice(start, end) + '; return smStarMatches')()
const now = Date.now()

test('查询匹配正文、人物名和标签', () => {
  const star = { text: '昨天在公园看锦鲤', aboutName: '阿花', tags: ['散步'] }
  assert.equal(smStarMatches(star, '锦鲤', '', '', now), true)
  assert.equal(smStarMatches(star, '阿花', '', '', now), true)
  assert.equal(smStarMatches(star, '散步', '', '', now), true)
  assert.equal(smStarMatches(star, '不存在', '', '', now), false)
})

test('区域/层级筛选和快忘/最近筛选可用', () => {
  const star = { text: 'x', region: 'person', tier: 'long', brightness: 0.2, lastHit: now - 86400_000 }
  assert.equal(smStarMatches(star, '', 'person', '', now), true)
  assert.equal(smStarMatches(star, '', 'event', '', now), false)
  assert.equal(smStarMatches(star, '', '', 'dim', now), true)
  assert.equal(smStarMatches(star, '', '', 'recent', now), true)
  const old = { ...star, lastHit: now - 30 * 86400_000 }
  assert.equal(smStarMatches(old, '', '', 'recent', now), false)
})
