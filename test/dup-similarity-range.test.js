// chat.dupSimilarity 出界时收进 0–1：负数会让「相似度 ≥ 阈值」恒真（什么都判重复），>1 会恒假。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from '../src/core/config.js'

const val = (v) => normalize({ chat: { dupSimilarity: v } }).chat.dupSimilarity

test('近似去重阈值默认 0.45', () => {
  assert.equal(val(undefined), 0.45)
  assert.equal(val(null), 0.45)
  assert.equal(val(''), 0.45)
})

test('合法值原样保留', () => {
  assert.equal(val(0), 0)
  assert.equal(val(0.3), 0.3)
  assert.equal(val(1), 1)
  assert.equal(val('0.6'), 0.6)
})

test('出界值收回边界，不产生恒真/恒假', () => {
  assert.equal(val(-1), 0)
  assert.equal(val(2), 1)
  assert.equal(val('abc'), 0.45)
})
