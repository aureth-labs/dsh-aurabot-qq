// 自驱引擎面板的「预览」块：v5 之后 /autotelic/preview 换了返回形状（observe/recent/schedule/nextFireAt），
// 旧渲染直接读 pv.candidates.length / pv.rejected.slice 会整页崩
// （真机报错：Cannot read properties of undefined (reading 'length')）。这里锁两件事：
// 1. 认 v5 标记，走新文案；2. 老字段一律判空，不再裸取。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const stripComments = (s) => s.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')

const block = () => {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('const doPreview =')
  assert.ok(start > 0, 'client/client.js 里找不到 doPreview')
  const end = source.indexOf('// ---------- 卡 2', start)
  assert.ok(end > start, '找不到预览块的结尾')
  return stripComments(source.slice(start, end))
}

test('自驱引擎预览块认 v5 形状，旧字段不裸取', () => {
  const s = block()
  assert.ok(s.includes('pv.v5'), '要按 v5 标记分流渲染')
  assert.ok(s.includes('pv.observe'), 'v5 要展示观察统计')
  assert.ok(s.includes('pv.nextFireAt'), 'v5 要展示下次回味时间')
  assert.ok(!s.includes('pv.candidates.length'), 'pv.candidates 不能裸取 length')
  assert.ok(!s.includes('pv.rejected.slice'), 'pv.rejected 不能裸取 slice')
  assert.ok(!s.includes('pv.thresholds.minCuriosity)'), 'pv.thresholds 不能裸取')
  assert.ok(!s.includes("pv.materialCount + '"), 'pv.materialCount 不能裸取')
  assert.ok(s.includes('(pv.candidates || []).length'), '候选数要判空')
  assert.ok(s.includes('(pv.rejected || []).slice'), '被否候选要判空')
})

test('服务端 v5 预览确实不带老字段', async () => {
  const src = readFileSync(new URL('../src/modules/autotelic/index.js', import.meta.url), 'utf8')
  const at = src.indexOf("api.route('/autotelic/preview'")
  assert.ok(at > 0, '找不到 /autotelic/preview 路由')
  const body = src.slice(at, src.indexOf('api.route(', at + 10))
  assert.ok(body.includes('v5: true'), '路由要带 v5 标记')
  assert.ok(!body.includes('candidates'), 'v5 预览不再返回 candidates')
  assert.ok(!body.includes('materialCount'), 'v5 预览不再返回 materialCount')
})
