// 主动发出的话（刷B站分享 / 群分享）要在目标聊天留痕：
//   真发成功后写聊天流水（who=bot, proactive=<proactiveCause>）+ 记进「别处说过」桥接；
//   dry-run、总开关关闭、发送失败都不记——没说出口的话不能算说过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'

function setup(t, { dryRun = false, enabled = true, onebotCall = null, files = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-proactive-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const calls = []
  const cfg = normalize({
    enabled,
    dryRun,
    workspaceDir: dir,
    voice: { enabled: false },
    stickers: { enabled: false },
    ...(files ? { files } : {}),
  })
  const hub = createHub({
    dsh: {},
    getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, () => {}])),
    onebot: {
      async call(action, params) {
        calls.push({ action, params })
        if (onebotCall) await onebotCall(calls.length)
        return { message_id: 42 }
      },
    },
  })
  t.after(() => {
    hub.dispose()
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, calls, dir }
}

function chatlogRows(dir) {
  const d = new Date()
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const file = join(dir, 'chatlog', `${day}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

test('主动发送成功：聊天流水有 bot 行（带 proactive），桥接记下原文', async (t) => {
  const s = setup(t)
  const r = await s.hub.sendText('private:10001', '刷到个视频，挺有意思的\nhttps://b23.tv/abc', undefined, undefined, undefined, { proactive: true, proactiveCause: 'bili' })
  assert.equal(r.message_id, 42)
  assert.equal(s.calls.length, 1)
  assert.deepEqual(s.hub.saidElsewhereOf('private:10001'), ['刷到个视频，挺有意思的\nhttps://b23.tv/abc'])
  const rows = chatlogRows(s.dir).filter((x) => x.who === 'bot')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].chatId, 'private:10001')
  assert.equal(rows[0].proactive, 'bili')
  assert.equal(rows[0].via, undefined, '不占 via —— 那是记忆模块的平台字段')
  assert.match(rows[0].text, /刷到个视频/)
})

test('不带 proactive 的发送（聊天回合自己回复）不重复记账', async (t) => {
  const s = setup(t)
  await s.hub.sendText('private:10001', '普通回复')
  assert.deepEqual(s.hub.saidElsewhereOf('private:10001'), [])
  assert.equal(chatlogRows(s.dir).filter((x) => x.who === 'bot').length, 0)
})

test('dry-run：没真发，不记流水、不记桥接', async (t) => {
  const s = setup(t, { dryRun: true })
  const r = await s.hub.sendText('private:10001', '试运行的话', undefined, undefined, undefined, { proactive: true, proactiveCause: 'bili' })
  assert.equal(r, null)
  assert.equal(s.calls.length, 0)
  assert.deepEqual(s.hub.saidElsewhereOf('private:10001'), [])
  assert.equal(chatlogRows(s.dir).filter((x) => x.who === 'bot').length, 0)
})

test('总开关关闭：同样不记', async (t) => {
  const s = setup(t, { enabled: false })
  await s.hub.sendText('private:10001', '发不出去的话', undefined, undefined, undefined, { proactive: true, proactiveCause: 'bili' })
  assert.equal(s.calls.length, 0)
  assert.deepEqual(s.hub.saidElsewhereOf('private:10001'), [])
})

test('发送失败：不记（失败的话不能算说过）', async (t) => {
  const s = setup(t, { onebotCall: async () => { throw new Error('网关 500') } })
  const r = await s.hub.sendText('private:10001', '发失败的话', undefined, undefined, undefined, { proactive: true, proactiveCause: 'bili' })
  assert.equal(r, null)
  assert.deepEqual(s.hub.saidElsewhereOf('private:10001'), [])
  assert.equal(chatlogRows(s.dir).filter((x) => x.who === 'bot').length, 0)
})

test('群分享：发到群成功后群会话也有留痕，proactiveCause 能区分来源', async (t) => {
  const s = setup(t)
  await s.hub.sendText('group:644343678', '这条挺有意思，分享给你们', undefined, undefined, undefined, { proactive: true, proactiveCause: 'bili-groupshare' })
  assert.equal(s.calls[0].action, 'send_group_msg')
  assert.deepEqual(s.hub.saidElsewhereOf('group:644343678'), ['这条挺有意思，分享给你们'])
  const rows = chatlogRows(s.dir).filter((x) => x.who === 'bot')
  assert.equal(rows[0].chatId, 'group:644343678')
  assert.equal(rows[0].proactive, 'bili-groupshare')
})

test('主动发图：留痕记成 [图片]（路径直发）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-proactive-img-'))
  const png = join(dir, 'shot.png')
  writeFileSync(png, 'not-a-real-png')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const s = setup(t, { files: { imageByPath: true } })
  const r = await s.hub.sendImage('private:10001', png, undefined, undefined, { proactive: true, proactiveCause: 'bili' })
  assert.equal(r.message_id, 42)
  assert.deepEqual(s.hub.saidElsewhereOf('private:10001'), ['[图片]'])
})

test('桥接只留最近 5 条（和 noteSaid / deliver 一致的窗口）', async (t) => {
  const s = setup(t)
  for (let i = 1; i <= 7; i++) {
    await s.hub.sendText('private:10001', `第 ${i} 条`, undefined, undefined, undefined, { proactive: true, proactiveCause: 'bili' })
  }
  assert.deepEqual(s.hub.saidElsewhereOf('private:10001'), ['第 3 条', '第 4 条', '第 5 条', '第 6 条', '第 7 条'])
})

test('重启后从聊天流水回捞：换一个 hub 实例也认得上一条主动发言，且只补一次', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-proactive-restart-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  const cfg = normalize({ enabled: true, dryRun: false, workspaceDir: dir, voice: { enabled: false }, stickers: { enabled: false } })
  const mk = () => createHub({
    dsh: {},
    getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, () => {}])),
    onebot: { async call() { return { message_id: 7 } } },
  })
  const first = mk()
  await first.sendText('private:10001', '刚才分享的视频', undefined, undefined, undefined, { proactive: true, proactiveCause: 'bili' })
  first.dispose()
  const second = mk()
  t.after(() => second.dispose())
  assert.deepEqual(second.saidElsewhereOf('private:10001'), [], '新进程内存里本来是空的')
  assert.deepEqual(second.proactiveHistoryOf('private:10001'), ['刚才分享的视频'], '能从流水回捞')
  assert.deepEqual(second.proactiveHistoryOf('private:10001'), [], '同一批只补一次')
})
