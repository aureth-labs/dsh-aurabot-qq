// QQ.exe 是启动器，热更新后 FileVersion 仍是 baseVersion；真实版本读 versions/config.json。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actualQqVersion } from '../src/snowluma/manager.js'
import { classifyQqVersion } from '../src/snowluma/qq-version.js'

test('QQ 版本优先读热更新后的 curVersion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-version-'))
  const qqDir = join(dir, 'QQ_NT')
  mkdirSync(join(qqDir, 'versions'), { recursive: true })
  writeFileSync(join(qqDir, 'versions', 'config.json'), JSON.stringify({
    baseVersion: '9.9.22-40990',
    curVersion: '9.9.37-54395',
  }))
  assert.equal(actualQqVersion(join(qqDir, 'QQ.exe'), '9.9.22.40990'), '9.9.37-54395')
})

test('版本目录里的 QQ.exe 也能上溯到 versions/config.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-version-'))
  const qqDir = join(dir, 'QQ_NT')
  mkdirSync(join(qqDir, 'versions', '9.9.37-54395'), { recursive: true })
  writeFileSync(join(qqDir, 'versions', 'config.json'), JSON.stringify({ curVersion: '9.9.37-54395' }))
  assert.equal(actualQqVersion(join(qqDir, 'versions', '9.9.37-54395', 'QQ.exe'), '9.9.22.40990'), '9.9.37-54395')
})

test('读不到 config.json 时回退 FileVersion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-version-'))
  assert.equal(actualQqVersion(join(dir, 'QQ.exe'), '9.9.22.40990'), '9.9.22.40990')
})

test('QQ 9.9.22 标记为低于 SnowLuma 2.4 要求', () => {
  assert.equal(classifyQqVersion('9.9.22.40990').tooOld, true)
  assert.equal(classifyQqVersion('9.9.37-54395').tooOld, undefined)
})
