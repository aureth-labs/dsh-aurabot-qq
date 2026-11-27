// 她的小闹钟（P2b 迁 purpose）：设定、上限、到点触发、失败重试、手动关闭、旧数据兼容读。
// 方案 docs/SPEAKUP-INTO-PURPOSE-PLAN.md §2.2-A / §7.1 P2b；场景照旧 speakup-reminder.test.js 改写为 purpose 入口。
// 落盘测试 AURABOT_DATA_DIR 隔离；不引入新依赖。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createPurpose
let normalize
const OWNER = '10000001'

before(async () => {
  ;({ createPurpose } = await import('../src/purpose/module.js'))
  ;({ normalize } = await import('../src/core/config.js'))
})

beforeEach(() => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-p2b-'))
})

function textOf(at) {
  const d = new Date(at)
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
const remindersPath = () => join(process.env.AURABOT_DATA_DIR, 'purpose', 'reminders.json')
const legacyRemindersPath = () => join(process.env.AURABOT_DATA_DIR, 'speakup-reminders.json')

function setup({ remind = {}, extPurpose = {}, onTurnEnd = () => ({ ok: true }) } = {}) {
  const cfg = normalize({
    enabled: true,
    ownerQQ: OWNER,
    ownerName: '主人',
    speakUp: {
      awakeFrom: 0,
      awakeTo: 24,
      idleMinutes: 9999,
      maxPerDay: 0,
      reminderEnabled: true,
      ...remind,
    },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0, ...extPurpose } },
  })
  const pushed = []
  const hub = {
    lastOwnerChatAt: 0,
    lastChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => [],
    chatLogOf: () => [],
    pushToSession: async (chat, content, sender, opts) => {
      pushed.push({ chat, text: content[0].text })
      await opts?.onTurnEnd?.(onTurnEnd())
    },
    async runSystemTurn() { return '嗯' },
    async deliver(chatId, text, opts = {}) { pushed.push({ chatId, text }); return { missedAt: [], failed: 0, errors: [], sent: text } },
  }
  const p = createPurpose({
    getConfig: () => cfg,
    setConfig: (next) => { Object.assign(cfg, next) },
    hub,
    log: { info() {}, warn() {} },
    isMuted: () => false,
    mood: () => null,
    memory: () => ({ list: () => [] }),
    personaText: () => '',
    use: () => null,
    pet: () => null,
  })
  return { p, cfg, pushed }
}

/** 造一条已到点的闹钟：先正常设定，再把文件里的时间拨到过去。 */
async function makeDue(p, note = '问主人晚饭吃了没', file = remindersPath()) {
  const at = Date.now() + 3600_000
  const r = p.addReminder(textOf(at), note)
  assert.equal(r.ok, true)
  const list = JSON.parse(readFileSync(file, 'utf8'))
  const item = list.find((x) => x.id === r.id)
  item.at = Date.now() - 1000
  item.atText = textOf(item.at)
  item.nextAt = item.at
  item.expiresAt = Date.now() + 14 * 60_000
  writeFileSync(file, JSON.stringify(list))
  return r
}

test('小闹钟开关键冻结在 speakUp.reminderEnabled（默认关、上限 5、硬顶 10）', () => {
  const c = normalize({}).speakUp
  assert.equal(c.reminderEnabled, false)
  assert.equal(c.reminderLimit, 5)
  assert.equal(c.reminderRetry, true)
  assert.equal(normalize({ speakUp: { reminderLimit: 99 } }).speakUp.reminderLimit, 10)
  assert.equal(normalize({ speakUp: { reminderLimit: 0 } }).speakUp.reminderLimit, 1)
})

test('设定提醒必须用 yyyy-mm-dd HH:MM，过去时间拒绝', () => {
  const { p } = setup()
  assert.equal(p.addReminder('明天五点半', '问晚饭').ok, false)
  const past = p.addReminder('2020-01-01 00:00', '旧提醒')
  assert.equal(past.ok, false)
  assert.match(past.message, /已经过去/)
})

test('目的引擎显式关着时不能设闹钟（迁移后的归属闸）', () => {
  const { p } = setup({ extPurpose: { enabled: false } })
  const r = p.addReminder(textOf(Date.now() + 3600_000), '问晚饭')
  assert.equal(r.ok, false)
  assert.match(r.message, /目的引擎没开启/)
  assert.equal(p.closeReminder('x').ok, false)
})

test('到上限时返回「你设定的提醒太多了」', () => {
  const { p } = setup({ remind: { reminderLimit: 1 } })
  const at = Date.now() + 3600_000
  assert.equal(p.addReminder(textOf(at), '第一条').ok, true)
  const second = p.addReminder(textOf(at + 60_000), '第二条')
  assert.equal(second.ok, false)
  assert.equal(second.message, '你设定的提醒太多了')
})

test('到点触发系统提醒（purpose.tick），成功后从列表删除', async () => {
  const { p, pushed } = setup()
  await makeDue(p)
  await p.tick()
  assert.equal(pushed.length, 1)
  assert.match(pushed[0].text, /系统提醒/)
  assert.match(pushed[0].text, /问主人晚饭吃了没/)
  assert.equal(p.state().reminders.length, 0)
  // 新数据落在 purpose/reminders.json
  assert.ok(existsSync(remindersPath()), '迁移后新写 purpose/reminders.json')
})

test('触发失败保留 15 分钟；重试开关关闭时直接丢弃', async () => {
  const { p, cfg } = setup({ onTurnEnd: () => ({ ok: false, error: '模型调用失败' }) })
  await makeDue(p)
  await p.tick()
  const left = p.state().reminders
  assert.equal(left.length, 1)
  assert.equal(left[0].attempts, 1)
  assert.ok(left[0].nextAt > Date.now())

  cfg.speakUp.reminderRetry = false
  const list = JSON.parse(readFileSync(remindersPath(), 'utf8'))
  list[0].nextAt = Date.now() - 1
  writeFileSync(remindersPath(), JSON.stringify(list))
  await p.tick()
  assert.equal(p.state().reminders.length, 0)
})

test('可以手动关闭指定提醒', () => {
  const { p } = setup()
  const r = p.addReminder(textOf(Date.now() + 3600_000), '带伞')
  assert.equal(r.ok, true)
  assert.equal(p.closeReminder(r.id).ok, true)
  assert.equal(p.state().reminders.length, 0)
  assert.equal(p.closeReminder('missing').ok, false)
})

test('兼容读：新文件没建过时读旧 speakup-reminders.json，首写后旧文件冻结', async () => {
  // 旧文件里放一条已到点的闹钟（老用户升级前留下的）
  const at = Date.now() - 1000
  writeFileSync(legacyRemindersPath(), JSON.stringify([{
    id: 'legacy-1', at, atText: textOf(at), note: '旧闹钟：提醒主人喝水', createdAt: at, attempts: 0, nextAt: at, expiresAt: Date.now() + 14 * 60_000, lastError: '',
  }]))
  const { p, pushed } = setup()
  assert.equal(p.state().reminders.length, 1, '兼容读旧文件')
  await p.tick()
  assert.equal(pushed.length, 1, '旧闹钟照常触发')
  assert.match(pushed[0].text, /旧闹钟：提醒主人喝水/)
  // 触发成功 → 删除 → 首次写盘落在新文件；旧文件冻结不动（不删不写）
  assert.ok(existsSync(remindersPath()), '首写后新文件存在')
  assert.equal(p.state().reminders.length, 0)
  assert.equal(JSON.parse(readFileSync(legacyRemindersPath(), 'utf8')).length, 1, '旧文件保持原样（冻结，不删）')
  // 此后新文件优先：旧文件再有数据也不被读到
  writeFileSync(legacyRemindersPath(), JSON.stringify([{ id: 'legacy-2', at: Date.now() + 3600_000, atText: '', note: '不该被读到', createdAt: Date.now(), attempts: 0, nextAt: Date.now() + 3600_000, expiresAt: Date.now() + 3600_000, lastError: '' }]))
  assert.equal(p.state().reminders.length, 0, '新文件存在后旧文件不再参与')
})
