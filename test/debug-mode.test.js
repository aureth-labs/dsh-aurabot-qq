// 调试模式：不真发 + 不写任何持久记忆，只在日志里留痕；和「试运行」互斥。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-debug-'))

const { normalize, publicConfig } = await import('../src/core/config.js')
const { createMemoryStore } = await import('../src/features/memory.js')
const { createStickerStore } = await import('../src/features/stickers.js')

const logs = []
const log = { info: (...a) => logs.push(a.join(' ')), warn () {}, debug () {} }

test('配置：开调试就等于不真发（内部 dryRun 置真）', () => {
  const c = normalize({ debug: true, dryRun: false })
  assert.equal(c.debug, true)
  assert.equal(c.dryRun, true, '调试必须连带 dryRun，否则对外动作会漏出去')
})

test('配置：面板上「试运行」和「调试」互斥显示', () => {
  const dbg = publicConfig(normalize({ enabled: true, debug: true, dryRun: true }))
  assert.equal(dbg.debug, true)
  assert.equal(dbg.dryRun, false, '调试开着时，面板里的「试运行」要显示成关')

  const dry = publicConfig(normalize({ enabled: true, debug: false, dryRun: true }))
  assert.equal(dry.debug, false)
  assert.equal(dry.dryRun, true, '只开试运行时它照常显示为开')

  const live = publicConfig(normalize({ enabled: true, debug: false, dryRun: false }))
  assert.equal(live.dryRun, false)
  assert.equal(live.debug, false)
})

function memoryOf (over = {}) {
  const cfg = normalize({ enabled: true, ...over })
  const store = createMemoryStore({ dsh: null, getConfig: () => cfg, hub: { chatLogDays: () => [], chatLogOf: () => [] }, log })
  return { store, cfg }
}

test('调试模式：自己记的、经历都不落盘', () => {
  const { store } = memoryOf({ debug: true })
  const r = store.add({ text: '主人喜欢白米饭', importance: 0.8 })
  assert.equal(r.ok, true)
  assert.equal(r.debug, true)
  assert.equal(store.list('').length, 0, '调试期间不该写进记忆库')

  store.addEvent({ text: '在B站看了《米饭大赛》' })
  assert.equal(store.list('').length, 0)
  assert.ok(logs.some((l) => l.includes('[调试] 不写记忆')), '至少要能在日志里看到')
})

test('试运行（非调试）：照常写记忆 —— 这是和调试的关键区别', () => {
  const { store } = memoryOf({ dryRun: true, debug: false })
  const r = store.add({ text: '主人喜欢白米饭' })
  assert.equal(r.ok, true)
  assert.equal(Boolean(r.debug), false)
  assert.equal(store.list('').length, 1, '试运行是「不真发但照写」，保持原样')
})

test('调试模式：不整理记忆（不然流水还是会被提炼进来）', async () => {
  const { store } = memoryOf({ debug: true, memory: { enabled: true, dailyConsolidate: true, consolidateTimes: ['00:00'] } })
  const r = await store.tick()
  assert.equal(r, undefined, 'tick 直接返回，不做整理')
})

test('面板有调试开关 / 调试对话，不会在合并上游后丢失', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes("toggleRun('debug', v)"), '右上角缺调试开关')
  assert.ok(src.includes("post('/debug/session')"), '缺新建 / 打开调试会话')
  assert.ok(src.includes("post('/debug/say'"), '缺调试对话发送')
  assert.ok(src.includes('function DebugChat('), '缺调试对话组件')
  assert.ok(src.includes('cfg.debug ? { cls: \'warn\', text: \'在线 · 调试\' }'), '状态栏没显示调试')
})

test('调试模式：不收表情（不往表情库里添东西）', async () => {
  const cfg = normalize({ enabled: true, debug: true })
  const calls = []
  const store = createStickerStore({
    dsh: null,
    getConfig: () => cfg,
    onebot: { call: async (a) => { calls.push(a); return {} } },
    log,
  })
  const seg = { type: 'image', data: { url: 'https://example.com/x.jpg', sub_type: 1, summary: '[动画表情]' } }
  const r = await store.collect(seg, 'private:1')
  assert.equal(r.ok, false)
  assert.match(r.reason, /调试/)
  assert.equal(store.library().items.length, 0)
  assert.equal(calls.length, 0, '不该去下载/收藏')
  assert.equal(existsSync(join(process.env.AURABOT_DATA_DIR, 'stickers', 'index.json')), false)
})
