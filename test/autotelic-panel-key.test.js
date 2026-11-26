// #512：自驱引擎「节奏与预算」曾把设置写进 ext.autotelic[""]，面板显示已保存但运行期不生效。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalize } from '../src/core/config.js'

const CLIENT = () => readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

test('面板写自驱设置用 ext.autotelic，不再带末尾点', () => {
  const src = CLIENT()
  assert.match(src, /const A = 'ext\.autotelic'/)
  assert.doesNotMatch(src, /const A = 'ext\.autotelic\.'/)
})

test('旧数据 ext.autotelic[""] 会并回父级并删除空键', () => {
  const cfg = normalize({
    ext: {
      autotelic: {
        enabled: true,
        '': { quietFrom: '', quietTo: '', dreamFrom: '01:30', dreamTo: '08:00', dailyReviewHour: 22, minBatchForReview: 3 },
        allowPython: true,
      },
    },
  })
  const a = cfg.ext.autotelic
  assert.equal(a.dreamFrom, '01:30')
  assert.equal(a.dreamTo, '08:00')
  assert.equal(a.dailyReviewHour, 22)
  assert.equal(a.minBatchForReview, 3)
  assert.equal(a.enabled, true)
  assert.equal(a.allowPython, true)
  assert.equal(Object.hasOwn(a, ''), false, '空键应被删除')
})

test('父级已有的值优先于旧空键', () => {
  const cfg = normalize({ ext: { autotelic: { dreamFrom: '02:00', '': { dreamFrom: '01:30', dreamTo: '08:00' } } } })
  assert.equal(cfg.ext.autotelic.dreamFrom, '02:00')
  assert.equal(cfg.ext.autotelic.dreamTo, '08:00')
})
