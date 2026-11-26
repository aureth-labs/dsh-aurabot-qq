// 读 JSON 的健壮性：瞬时失败（占用 / 空文件 / 写一半）重试，文件不存在直接回落。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJson } from '../src/core/store.js'

const dir = mkdtempSync(join(tmpdir(), 'aurabot-readjson-'))
const file = (name) => join(dir, name)

test('正常读', () => {
  writeFileSync(file('ok.json'), JSON.stringify({ a: 1 }))
  assert.deepEqual(readJson(file('ok.json'), {}), { a: 1 })
})

test('带 BOM 也能读', () => {
  writeFileSync(file('bom.json'), '\uFEFF{"b":2}')
  assert.deepEqual(readJson(file('bom.json'), {}), { b: 2 })
})

test('文件不存在：直接回落，不重试也不等待', () => {
  const t = process.hrtime.bigint()
  const v = readJson(file('missing.json'), { fallback: true })
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  assert.deepEqual(v, { fallback: true })
  assert.ok(ms < 100, `ENOENT 不该进入重试：${ms.toFixed(1)}ms`)
})

test('空文件：重试后回落，fallback 是函数时照常调用', () => {
  writeFileSync(file('empty.json'), '')
  assert.deepEqual(readJson(file('empty.json'), () => ({ d: 1 })), { d: 1 })
})

test('只写了一半的 JSON：重试后回落，不抛错', () => {
  writeFileSync(file('half.json'), '{"a": 1')
  assert.deepEqual(readJson(file('half.json'), null), null)
})
