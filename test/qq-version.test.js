// QQ 版本软判断：只决定提示文案，不拦注入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyQqVersion } from '../src/snowluma/qq-version.js'

test('QQ NT 9.9 及以上判为 NT；9.9.33 以下标成过低', () => {
  for (const v of ['9.9.0', '9.9.20.36330', '9.9.36-53644', '10.0.0']) {
    assert.equal(classifyQqVersion(v).nt, true, v)
  }
  assert.equal(classifyQqVersion('9.9.20.36330').tooOld, true)
  assert.equal(classifyQqVersion('9.9.36-53644').tooOld, undefined)
  assert.equal(classifyQqVersion('9.9.36-53644').label, 'NT')
})

test('QQ 9.7 / TIM 3.x 判为老版', () => {
  for (const v of ['9.7.23.12345', '9.8.0', '3.5.1.12345']) {
    assert.equal(classifyQqVersion(v).nt, false, v)
  }
  assert.match(classifyQqVersion('9.7.23.12345').label, /老版/)
})

test('读不到版本时按安装目录兜底', () => {
  assert.equal(classifyQqVersion('', 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe').nt, true)
  assert.equal(classifyQqVersion('', 'D:\\software\\Tencent\\QQ_NT\\QQ.exe').nt, true)
  assert.equal(classifyQqVersion('', 'C:\\Program Files (x86)\\Tencent\\QQ\\Bin\\QQ.exe').nt, false)
  assert.equal(classifyQqVersion('', 'D:\\QQ\\QQ.exe').nt, null)
  assert.equal(classifyQqVersion(undefined, '').nt, null)
})

test('不能把 9.9 以下误判成 NT（软提示宁可保守）', () => {
  assert.equal(classifyQqVersion('9.8.9').nt, false)
})
