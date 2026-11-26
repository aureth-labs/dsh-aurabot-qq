// ModuleRow 操作区的删除按钮：只做静态契约，避免为了一个按钮把整个前端跑起来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readRow = () => {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('function ModuleRow(')
  const end = source.indexOf('/** 模拟测试', start)
  assert.ok(start > 0 && end > start, 'client/client.js 里找不到 ModuleRow')
  return source.slice(start, end)
}

test('ModuleRow 删除按钮覆盖社区模块与本地模块', () => {
  const row = readRow()
  assert.ok(row.includes("'/modules/community/remove'"), '社区模块走现有卸载接口')
  assert.ok(row.includes("'/modules/remove'"), '本地模块走新增删除接口')
  assert.ok(row.includes("m.hasUser && m.community"), '社区模块按钮条件')
  assert.ok(row.includes("m.hasUser && !m.community"), '本地模块按钮条件')
  assert.ok(row.includes("m.builtin ? '删除副本' : '删除'"), '内置副本与自写模块的按钮文案')
  assert.ok(row.includes("confirm('把它的数据和设置也清掉吗？"), '删除前确认是否清数据和设置')
})
