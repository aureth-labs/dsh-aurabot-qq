// 面板集成：目的引擎 / 桌宠的 /panel/* 代理与 /state 聚合。
// fake-dsh 模式；AURABOT_DATA_DIR 隔离；不引入新依赖。
// P1/Q1 拍板起 purpose 默认开：这里验证「默认开时的面板聚合」与「显式关掉后的降级语义」。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function brain() { await sleep(1); return '嗯' }

const call = async (path, body) => (await fake.call(path, body)).json()

let mock
let fake
let api
let dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-panel-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    bridge: { dshTools: false, http: true, token: 'a'.repeat(32) },
  }))
  fake = createFakeDsh({ brain })
  // DSH 的 webServer 服务带真实端口（真机同理）：host.js 靠它给 pet 模块注入端口、破「host.json 写 :0」的自举死锁
  fake.ctx.webServer.port = 5099
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready.catch(() => {})
  await fake.call('/onebot/reconnect')
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const sentToOwner = () => mock.calls.filter((c) => c.action === 'send_private_msg' && String(c.params.user_id) === OWNER)

test('/state 聚合 purpose 字段（独立模块，默认关也不炸）', async () => {
  const st = await call('/state')
  assert.equal(st.ok, true)
  // 概览页要的 speakUp.count 必须还在（speakup 模块保持默认实现，不受影响）
  assert.equal(typeof st.speakUp.count, 'number')
  assert.ok(st.purpose, 'purpose 聚合字段存在')
  assert.equal(st.purpose.available, true, 'purpose 模块已提供 status()')
  assert.equal(st.purpose.enabled, true, 'P1 默认开：ext.purpose.enabled 缺省即开')
  assert.equal(st.purpose.pacing, 'default')
  assert.equal(st.purpose.dailyMax, 20, 'dailyMax 取自 speakUp.maxPerDay 默认值')
  assert.equal(st.purpose.quietStart, '23:00', '安静时段由醒着窗口 8~23 推算')
  assert.equal(st.purpose.quietEnd, '08:00')
  assert.equal(st.pet, null, '桌宠没装：/state 里是 null')
  // token 脱敏：32 位 bridge token 不出现在任何返回里
  assert.ok(!JSON.stringify(st).includes('a'.repeat(32)), 'state 返回不得出现 32 位令牌明文')
})

test('面板代理 /panel/purpose/status：聚合 purpose + pet，token 已脱敏', async () => {
  const r = await call('/panel/purpose/status')
  assert.equal(r.ok, true)
  assert.equal(r.purpose.available, true)
  assert.equal(r.purpose.enabled, true, 'P1 默认开')
  assert.equal(r.pet, null, '桌宠没装：不影响目的引擎')
  assert.ok(!JSON.stringify(r).includes('a'.repeat(32)))
})

test('开关与调参透传：/panel/purpose/config 写 ext.purpose.*，醒着窗口写 speakUp.*', async () => {
  const r = await call('/panel/purpose/config', { enabled: true, carrier: 'pet', petFallbackToQQ: false, pacing: 'conservative', awakeFrom: 9, awakeTo: 22, maxPerDay: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.purpose.enabled, true)
  assert.equal(r.purpose.carrier, 'pet')
  assert.equal(r.purpose.petFallbackToQQ, false)
  assert.equal(r.purpose.pacing, 'conservative')
  assert.equal(r.purpose.awakeFrom, 9)
  assert.equal(r.purpose.awakeTo, 22)
  assert.equal(r.purpose.quietStart, '22:00', '安静时段随醒着窗口重推')
  assert.equal(r.purpose.quietEnd, '09:00')
  assert.equal(r.purpose.dailyMax, 2)
  // 落盘位置：引擎开关/载体进 ext.purpose，醒着窗口/每日上限进 speakUp（保持单一真相）
  const saved = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
  assert.equal(saved.ext.purpose.enabled, true)
  assert.equal(saved.ext.purpose.pacing, 'conservative')
  assert.equal(saved.ext.purpose.carrier, 'pet')
  assert.equal(saved.speakUp.awakeFrom, 9)
  // 透传到 /state（面板另一处数据源一致）
  const st = await call('/state')
  assert.equal(st.purpose.enabled, true)
  assert.equal(st.purpose.carrier, 'pet')
  // 非法字段拒绝
  const bad = await call('/panel/purpose/config', { carrier: 'wechat' })
  assert.equal(bad.ok, false)
  // 关回去，不污染别的用例
  const back = await call('/panel/purpose/config', { enabled: false, carrier: 'qq', petFallbackToQQ: true, pacing: 'default' })
  assert.equal(back.ok, true)
  assert.equal(back.purpose.enabled, false)
  assert.equal(back.purpose.carrier, 'qq')
})

test('预览零副作用：/panel/purpose/preview 收素材拼提示词，但不发 QQ', async () => {
  const before = sentToOwner().length
  const r = await call('/panel/purpose/preview')
  assert.equal(r.ok, true)
  assert.ok(r.result, '有预览结果')
  assert.ok(r.result.stats, '预览含素材统计：' + JSON.stringify(r).slice(0, 400))
  assert.ok(Array.isArray(r.result.materials), '预览含素材列表')
  // preview() 是 async：路由必须 await，否则序列化成 {}（接口回归回归用例）
  assert.ok(r.result.materials.length >= 0 && r.result.stats, '预览对象不是空 Promise 序列化')
  assert.ok(!JSON.stringify(r).includes('a'.repeat(32)), '预览返回不得出现 32 位令牌明文')
  await sleep(50)
  assert.equal(sentToOwner().length, before, '预览不得向 QQ 发送任何消息')
})

test('追问开关写 ext.purpose.nudge（P1 翻键），读侧双层兼容', async () => {
  const r = await call('/panel/purpose/config', { nudge: false })
  assert.equal(r.ok, true)
  // 落盘位置：追问写入口已翻到 ext.purpose.nudge；speakUp.nudge 键保留不动（与 awake/allow 同口径）
  const saved = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
  assert.equal(saved.ext.purpose.nudge, false, '追问写入口在 ext.purpose.nudge')
  assert.equal(saved.speakUp.nudge, true, 'speakUp.nudge 键不被动')
  // 读侧 fallback：ext 覆写位优先，老用户 speakUp.nudge 仍生效，缺省默认开
  const { purposeConfig } = await import('../src/purpose/module.js')
  assert.equal(purposeConfig({ speakUp: { nudge: true }, ext: { purpose: { nudge: false } } }).nudge, false, '覆写位优先')
  assert.equal(purposeConfig({ speakUp: { nudge: false } }).nudge, false, '老用户 speakUp.nudge=false 仍生效')
  assert.equal(purposeConfig({ speakUp: { nudge: false }, ext: { purpose: { nudge: true } } }).nudge, true, '显式 ext 覆写可重新打开')
  assert.equal(purposeConfig({}).nudge, true, '两边都没设默认开')
  // 写回 true，不污染后面的用例
  const back = await call('/panel/purpose/config', { nudge: true })
  assert.equal(back.ok, true)
})

test('手动试跑：引擎关着时明确拒绝；打开后能真跑一轮并投递私聊', async () => {
  const r0 = await call('/panel/purpose/run')
  assert.equal(r0.ok, false, '默认关：run 明确报「开关是关的」')
  assert.match(String(r0.message || ''), /开关/)
  // 打开时顺手把醒着窗口设成全日（0~24）：真跑一轮断言不能依赖测试运行的墙钟时间，
  // 否则深夜（默认 8~23 窗口外）跑这套用例会被安静时段拦下（凌晨实测踩过）。
  const on = await call('/panel/purpose/config', { enabled: true, awakeFrom: 0, awakeTo: 24 })
  assert.equal(on.ok, true)
  const before = sentToOwner().length
  const r = await call('/panel/purpose/run')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(sentToOwner().length, before + 1, '真跑一轮：私聊里多发了一条')
  // 写回默认作息，不污染后面的用例
  await call('/panel/purpose/config', { enabled: false, awakeFrom: 8, awakeTo: 23 })
})

// ---------- 桌宠（pet 模块与面板代理） ----------
