// 目的引擎回归测试：pacing 节流真实现 + force 死参数修活。
//   · pacing：conservative 拉长间隔 1.5×、active 压缩 0.6×；未知值回退 default；乘完夹回引擎 [5 分钟, 24 小时]。
//   · force（手动 fire()）：跳过会话/聊天冷却，但每日上限同样生效——手动开口也占当日次数（防烧钱）。
// 数据隔离：AURABOT_DATA_DIR 每用例独立临时目录（同 integration-carrier.test.js 口径）。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createPurpose, purposeConfig
const OWNER = '10000001'
const MINUTE = 60_000

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-vp-'))
  ;({ createPurpose, purposeConfig } = await import('../src/purpose/module.js'))
})

beforeEach(() => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-vp-'))
})

const BASE_CFG = {
  enabled: true, ownerQQ: OWNER, ownerName: '主人',
  speakUp: { enabled: true, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, maxPerDay: 10 },
  ext: { purpose: { enabled: true, minMaterials: 0 } },
}

// ---------- pacing：purposeConfig 纯函数级断言 ----------

test('pacing：conservative 间隔 = 默认档 1.5 倍', () => {
  const base = purposeConfig(BASE_CFG)
  const paced = purposeConfig({ ...BASE_CFG, ext: { purpose: { ...BASE_CFG.ext.purpose, pacing: 'conservative' } } })
  assert.equal(paced.gapMinMs, Math.round(90 * 1.5) * MINUTE, 'gapMin 90 分钟 × 1.5')
  assert.equal(paced.gapMaxMs, Math.round(240 * 1.5) * MINUTE, 'gapMax 240 分钟 × 1.5')
  assert.equal(base.gapMinMs, 90 * MINUTE, '默认档不受影响')
})

test('pacing：未知 pacing 值回退 default（×1）', () => {
  const paced = purposeConfig({ ...BASE_CFG, ext: { purpose: { ...BASE_CFG.ext.purpose, pacing: 'crazy' } } })
  assert.equal(paced.gapMinMs, 90 * MINUTE, '未知值不放大也不压缩')
  assert.equal(paced.gapMaxMs, 240 * MINUTE)
})

test('pacing：乘完夹回引擎区间（active 不低于 5 分钟；conservative 不高于 24 小时）', () => {
  const active = purposeConfig({ ...BASE_CFG, ext: { purpose: { ...BASE_CFG.ext.purpose, pacing: 'active', minIntervalMinutes: 5 } } })
  assert.equal(active.gapMinMs, 5 * MINUTE, '5 分钟 × 0.6 = 3 分钟 → 夹回下限 5 分钟')
  const slow = purposeConfig({ ...BASE_CFG, ext: { purpose: { ...BASE_CFG.ext.purpose, pacing: 'conservative', maxIntervalMinutes: 2880 } } })
  assert.equal(slow.gapMaxMs, 24 * 60 * MINUTE, '2880 分钟 × 1.5 = 4320 分钟 → 夹回上限 24 小时')
})

// ---------- force：手动触发跳冷却但仍受 dailyMax ----------

// hub：会话排程冷却永远在冷却中（force 要跳的就是它）；挂载失败退避（chatCooldown，private:<QQ>）
// 不在冷却——它属于故障退避而非排程闸门，对 force 也生效，所以这里必须为空，fire 才能走到投递。
function makeColdHub() {
  return {
    systemSessionCooldown: () => ({ retryAt: Date.now() + 60 * MINUTE }),
    chatCooldown: () => null,
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => [],
    chatLogOf: () => [],
    delivered: [],
    noteSaid() {},
    async runSystemTurn() { return '主人，想到一件事想跟你说' },
    async deliver(chatId, text) { this.delivered.push({ chatId, text }); return { missedAt: [], failed: 0, errors: [], sent: text } },
  }
}

function buildPurpose(hub, extPurpose = {}) {
  const cfg = {
    ...BASE_CFG,
    ext: { purpose: { ...BASE_CFG.ext.purpose, ...extPurpose } },
  }
  const p = createPurpose({
    getConfig: () => cfg,
    setConfig: (patch) => { Object.assign(cfg, patch) },
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    mood: () => null,
    memory: () => ({ list: () => [{ id: 'm1', text: '主人喜欢打两把游戏', importance: 0.8, at: Date.now() }], dislikes: () => false }),
    personaText: () => '',
    pet: () => null,
  })
  return { p, cfg }
}

test('force：冷却期内手动 fire() 能立刻发（outcome=sent，不是 skipped-cooldown）', async () => {
  const { p } = buildPurpose(makeColdHub())
  const r = await p.fire('手动')
  assert.equal(r.outcome, 'sent', `冷却闸门被 force 跳过（实际 ${r.outcome}）`)
  assert.equal(p.state().countToday, 1, '手动开口同样占当日次数')
})

test('force：仍受 dailyMax 计数——达到上限后手动 fire() 被拦（outcome=daily-max）', async () => {
  const { p } = buildPurpose(makeColdHub(), { maxPerDay: 1 })
  const r1 = await p.fire('手动')
  assert.equal(r1.outcome, 'sent')
  assert.equal(p.state().countToday, 1)
  const r2 = await p.fire('手动')
  assert.equal(r2.outcome, 'daily-max', 'dailyMax 对 force 生效（防烧钱）')
  assert.equal(p.state().countToday, 1, '被拦的一轮不重复计数')
})
