// 解析 PID|路径|版本 输出：路径可能带空格/中文，版本可能为空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProcessLines } from '../src/snowluma/process-info.js'

test('解析正常的 PID / 路径 / 版本', () => {
  const rows = parseProcessLines('21340|D:\\software\\Tencent\\QQ_NT\\QQ.exe|9.9.22.40990\r\n28368|D:\\software\\Tencent\\QQ_NT\\QQ.exe|9.9.22.40990')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { pid: 21340, path: 'D:\\software\\Tencent\\QQ_NT\\QQ.exe', version: '9.9.22.40990' })
})

test('路径为空 / 版本为空也能解析', () => {
  const rows = parseProcessLines('123||\n456|C:\\Program Files (x86)\\QQ\\Bin\\QQ.exe|')
  assert.deepEqual(rows[0], { pid: 123, path: '', version: '' })
  assert.equal(rows[1].path, 'C:\\Program Files (x86)\\QQ\\Bin\\QQ.exe')
  assert.equal(rows[1].version, '')
})

test('无关输出被忽略', () => {
  const rows = parseProcessLines('noise\n|bad|line\n789|C:\\a b\\QQ.exe|9.9.0')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].pid, 789)
})
