// SnowLuma 版本兼容性提示：旧版本有已知 bug 时面板要能提示升级。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snowlumaCompat, SNOWLUMA_MIN, SNOWLUMA_RECOMMENDED, SNOWLUMA_TESTED_MAX, SNOWLUMA_QQ_MIN } from '../src/snowluma/compat.js'

test('低于最低版本：判为有已知问题', () => {
  const c = snowlumaCompat('2.2.0')
  assert.equal(c.status, 'outdated')
  assert.match(c.message, /引用/)
  assert.match(c.message, new RegExp(SNOWLUMA_MIN))
  assert.match(c.message, new RegExp(SNOWLUMA_QQ_MIN.replace(/\./g, '\\.')))
  assert.equal(c.qqMin, SNOWLUMA_QQ_MIN)
})

test('最低版本到推荐版本之间：建议升级', () => {
  const c = snowlumaCompat('2.3.4')
  assert.equal(c.status, 'update')
  assert.match(c.label, /建议升级/)
  assert.match(c.message, new RegExp(SNOWLUMA_QQ_MIN.replace(/\./g, '\\.')))
})

test('推荐版本：兼容', () => {
  const c = snowlumaCompat(SNOWLUMA_RECOMMENDED)
  assert.equal(c.status, 'ok')
  assert.equal(c.label, '兼容')
  assert.equal(snowlumaCompat('v2.4.1').status, 'ok', '带 v 前缀也能认')
})

test('比验证过的版本新：提示未验证', () => {
  const c = snowlumaCompat('2.5.0')
  assert.equal(c.status, 'untested')
  assert.match(c.message, new RegExp(SNOWLUMA_TESTED_MAX.replace(/\./g, '\\.')))
  assert.match(c.message, new RegExp(SNOWLUMA_QQ_MIN.replace(/\./g, '\\.')))
})

test('读不到版本：unknown 而不是乱报', () => {
  assert.equal(snowlumaCompat('').status, 'unknown')
  assert.equal(snowlumaCompat(undefined).status, 'unknown')
  assert.equal(snowlumaCompat('abc').status, 'unknown')
})
