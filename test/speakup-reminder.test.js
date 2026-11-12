// 她的小闹钟：设定、上限、到点触发、失败重试和手动关闭。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createSpeakUp
let normalize
const OWNER = '10000001'

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-reminder-'))
  ;({ createSpeakUp } = await import('../src/features/companion.js'))
  ;({ normalize } = await import('../src/core/config.js'))
})

function textOf(at) {
  const d = new Date(at)
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

function setup({ remind = {}, onTurnEnd = () => ({ ok: true }), pushed = [] } = {}) {
  try { writeFileSync(join(process.env.AURABOT_DATA_DIR, 'speakup-reminders.json'), '[]') } catch {}
  const cfg = normalize({
    enabled: true,
    ownerQQ: OWNER,
    speakUp: {
      awakeFrom: 0,
      awakeTo: 24,
      idleMinutes: 9999,
      maxPerDay: 0,
      reminderEnabled: true,
      ...remind,
    },
  })
  const hub = {
    lastOwnerChatAt: 0,
    lastChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    pushToSession: async (chat, content, sender, opts) => {
      pushed.push({ chat, text: content[0].text })
      await opts?.onTurnEnd?.(onTurnEnd())
    },
  }
  const s = createSpeakUp({ getConfig: () => cfg, hub, log: { info() {}, warn() {} } })
  return { s, cfg, pushed, hub }
}

function makeDue(s, note = '问主人晚饭吃了没') {
  const at = Date.now() + 3600_000
  const r = s.addReminder(textOf(at), note)
  assert.equal(r.ok, true)
  const file = join(process.env.AURABOT_DATA_DIR, 'speakup-reminders.json')
  const list = JSON.parse(readFileSync(file, 'utf8'))
  const item = list.find((x) => x.id === r.id)
  item.at = Date.now() - 1000
  item.atText = textOf(item.at)
  item.nextAt = item.at
  item.expiresAt = Date.now() + 14 * 60_000
  writeFileSync(file, JSON.stringify(list))
  return r
}

test('小闹钟默认关闭，数量上限硬顶 10 条', () => {
  const c = normalize({}).speakUp
  assert.equal(c.reminderEnabled, false)
  assert.equal(c.reminderLimit, 5)
  assert.equal(c.reminderRetry, true)
  assert.equal(normalize({ speakUp: { reminderLimit: 99 } }).speakUp.reminderLimit, 10)
  assert.equal(normalize({ speakUp: { reminderLimit: 0 } }).speakUp.reminderLimit, 1)
})

test('设定提醒必须用 yyyy-mm-dd HH:MM，过去时间拒绝', () => {
  const { s } = setup()
  const bad = s.addReminder('明天五点半', '问晚饭')
  assert.equal(bad.ok, false)
  const past = s.addReminder('2020-01-01 00:00', '旧提醒')
  assert.equal(past.ok, false)
  assert.match(past.message, /已经过去/)
})

test('到上限时返回“你设定的提醒太多了”', () => {
  const { s } = setup({ remind: { reminderLimit: 1 } })
  const at = Date.now() + 3600_000
  assert.equal(s.addReminder(textOf(at), '第一条').ok, true)
  const second = s.addReminder(textOf(at + 60_000), '第二条')
  assert.equal(second.ok, false)
  assert.equal(second.message, '你设定的提醒太多了')
})

test('到点触发系统提醒，成功后从列表删除', async () => {
  const { s, pushed } = setup()
  makeDue(s)
  await s.tick()
  assert.equal(pushed.length, 1)
  assert.match(pushed[0].text, /系统提醒/)
  assert.match(pushed[0].text, /问主人晚饭吃了没/)
  assert.equal(s.state().reminders.length, 0)
})

test('触发失败保留 15 分钟；重试开关关闭时直接丢弃', async () => {
  const { s, cfg } = setup({ onTurnEnd: () => ({ ok: false, error: '模型调用失败' }) })
  makeDue(s)
  await s.tick()
  const left = s.state().reminders
  assert.equal(left.length, 1)
  assert.equal(left[0].attempts, 1)
  assert.ok(left[0].nextAt > Date.now())

  cfg.speakUp.reminderRetry = false
  const file = join(process.env.AURABOT_DATA_DIR, 'speakup-reminders.json')
  const list = JSON.parse(readFileSync(file, 'utf8'))
  list[0].nextAt = Date.now() - 1
  writeFileSync(file, JSON.stringify(list))
  await s.tick()
  assert.equal(s.state().reminders.length, 0)
})

test('可以手动关闭指定提醒', () => {
  const { s } = setup()
  const r = s.addReminder(textOf(Date.now() + 3600_000), '带伞')
  assert.equal(r.ok, true)
  const closed = s.closeReminder(r.id)
  assert.equal(closed.ok, true)
  assert.equal(s.state().reminders.length, 0)
  assert.equal(s.closeReminder('missing').ok, false)
})
