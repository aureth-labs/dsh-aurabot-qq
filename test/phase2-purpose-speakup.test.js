import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTestIdentity } from './helpers/identity.js'

let normalize
let createSpeakUp
let createPurpose
let engine
let parseCommand
let runCommand

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-phase2-pr2d-'))
  ;({ normalize } = await import('../src/core/config.js'))
  ;({ createSpeakUp } = await import('../src/features/companion.js'))
  ;({ createPurpose } = await import('../src/purpose/module.js'))
  engine = await import('../src/purpose/engine.js')
  ;({ parseCommand, runCommand } = await import('../src/chat/commands.js'))
})

beforeEach(() => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-phase2-pr2d-'))
})

test('PR-2D: config.normalize 与 /speak 支持飞书私聊 ChatId 并过滤群/坏地址', async () => {
  const c = normalize({
    speakUp: { allow: ['123456', 'feishu:private:ou_fs1', 'feishu:group:oc_grp', 'bad:::x'] },
  })
  assert.deepEqual(c.speakUp.allow, ['123456', 'feishu:private:ou_fs1'])

  let cfg = normalize({ ownerQQ: '1' })
  const ctx = { getConfig: () => cfg, setConfig: (n) => { cfg = n } }
  const run = (text) => runCommand(parseCommand(text), { chatId: 'private:1', kind: 'private', userId: '1' }, ctx)
  const added = await run('/speak add feishu:private:ou_fs2')
  assert.match(added, /feishu:private:ou_fs2/)
  assert.ok(cfg.speakUp.allow.includes('feishu:private:ou_fs2'))
  assert.ok(cfg.allow.private.includes('feishu:private:ou_fs2'))
  const del = await run('/speak del feishu:private:ou_fs2')
  assert.match(del, /不再主动找/)
  assert.deepEqual(cfg.speakUp.allow, [])
})

test('PR-2D: speakup.json 旧 s.friends 只读归一解析 + 保存时按新键惰性重写，坏条目警告跳过', async () => {
  const warnings = []
  const file = join(process.env.AURABOT_DATA_DIR, 'speakup.json')
  const rawOld = {
    day: new Date().toDateString(),
    count: 0,
    nextAt: Date.now() + 3600_000,
    friends: {
      '22222': { day: new Date().toDateString(), count: 1, nextAt: Date.now() - 1 },
      'bad:::key': { count: 9 },
      'corrupt-val': 'not-an-object',
    },
  }
  writeFileSync(file, JSON.stringify(rawOld))

  const sent = []
  const cfg = normalize({
    enabled: true,
    ownerQQ: '10000001',
    speakUp: { enabled: true, allow: ['qq:private:22222', 'feishu:private:ou_f1', 'bad:::allow'], awakeFrom: 0, awakeTo: 24, idleMinutes: 1, minIntervalMinutes: 1, maxIntervalMinutes: 1, maxPerDay: 5 },
  })
  const identity = makeTestIdentity('10000001', 'qq')
  const su = createSpeakUp({
    getConfig: () => cfg,
    hub: {
      get lastOwnerChatAt() { return Date.now() },
      lastBotToOwner: { at: 0, text: '' },
      lastPrivateAt: () => 0,
      pushToSession: async (chat, content) => { sent.push({ chat, text: content[0].text }) },
    },
    identity,
    routeOwner: identity.routeOwner,
    log: { info() {}, warn: (m) => warnings.push(String(m)), debug() {} },
  })

  // 1) 只读 state() 返回归一化键，不提前写盘破坏旧文件
  const stRead = su.state()
  assert.equal(stRead.friends['qq:private:22222']?.count, 1)
  assert.equal(stRead.friends['bad:::key'], undefined)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).friends['22222']?.count, 1, '只读访问不应改写磁盘文件')

  // 2) tickFriends 触发时读取旧槽 count=1（+1 变 2）并保存：按新键惰性重写且丢弃坏条目
  await su.tick()
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.friends['qq:private:22222']?.count, 2, '继承旧键次数后写入规范新键')
  assert.equal(saved.friends['22222'], undefined, '惰性重写后清除旧裸键')
  assert.equal(saved.friends['bad:::key'], undefined)
  assert.equal(saved.friends['corrupt-val'], undefined)
  assert.ok(warnings.some((w) => w.includes('无效条目')), '坏条目应记警跳过不阻断')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chat.chatId, 'qq:private:22222')
})

test('PR-2D: purpose.brokerReview 消除 ownerKey.slice 缺陷，兼容 feishu 与 qq 规范地址', async () => {
  const identity = makeTestIdentity('ou_owner_fs', 'feishu')
  const ownerPid = identity.owner()
  const seenPersonaArgs = []
  const now = Date.now()
  const rows = [
    { t: now - 300_000, chatId: 'feishu:private:ou_owner_fs', who: '主人', uid: 'ou_owner_fs', text: '今天好累' },
    { t: now - 100_000, chatId: 'feishu:private:ou_owner_fs', who: 'bot', text: '早点休息哦' },
  ]
  const hub = {
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => ['d1'],
    chatLogOf: () => rows,
    turns: [],
    async runSystemTurn(name, title, prompt, opts) { this.turns.push({ name, title, prompt, opts }); return '原样发送' },
    async deliver() { return { missedAt: [], failed: 0, errors: [], sent: 'ok' } },
  }
  const p = createPurpose({
    getConfig: () => ({
      enabled: true, ownerName: '阿白',
      speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 3, nudge: false },
      ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
    }),
    hub,
    identity,
    resolveOwnerRoute: () => ({ chatId: 'feishu:private:ou_owner_fs', blocked: false, reason: 'ok' }),
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    mood: () => null,
    memory: () => ({
      list: () => [],
      recall: () => [],
      personaPerson: (arg) => {
        seenPersonaArgs.push(arg)
        return arg === ownerPid ? { alias: '阿白哥', persona: '飞书测试主人', handle: '熟人' } : null
      },
    }),
    personaText: () => '活泼的大肥鱼',
  })

  await p.brokerReview({ to: 'feishu:private:ou_owner_fs', text: '发现个好玩的视频', moduleId: 'bili' })
  assert.equal(hub.turns.length, 1)
  assert.deepEqual(seenPersonaArgs, [ownerPid], '不再错切 private: 前缀，正确传 PersonId 查档案')
  assert.match(hub.turns[0].prompt, /阿白哥/, '人物档案应注入提示词')
  assert.match(hub.turns[0].prompt, /今天好累/, '飞书最近聊天记录应注入提示词')
})

test('PR-2D: purpose 朋友状态支持飞书安全文件名 + 旧 friends/20000010.json 只读读入与新键惰性重写 + engine 清理 reserved2', async () => {
  const warnings = []
  const now = Date.now()
  const qqFriend = '20000010'
  const fsFriend = 'feishu:private:ou_fs_friend'
  const friendsDir = join(process.env.AURABOT_DATA_DIR, 'purpose', 'friends')
  mkdirSync(friendsDir, { recursive: true })
  // 写入一份旧 bare key 文件 + 一份坏的 purpose-state JSON 确认不会阻塞启动
  writeFileSync(join(friendsDir, `${qqFriend}.json`), JSON.stringify({
    ...engine.createPurposeState(now),
    countToday: 1,
    nextFireAt: now - 1000,
    lastPurpose: '老目的继续问候',
  }))

  const identity = makeTestIdentity('10000001', 'qq', { personId: '10000001' })
  const fsPid = identity.resolve('feishu', 'ou_fs_friend')
  const hub = {
    lastOwnerChatAt: now,
    lastBotToOwner: { at: 0, text: '' },
    lastPrivateAt: () => now - 7200_000,
    chatLogDays: () => ['d'],
    chatLogOf: () => [
      { t: now - 3600_000, chatId: fsFriend, who: '朋友', uid: 'ou_fs_friend', text: '我明天想去海边游泳看日出', source: 'feishu' },
      { t: now - 3500_000, chatId: fsFriend, who: 'bot', text: '记得防晒呀' },
    ],
    turns: [],
    delivered: [],
    async runSystemTurn(name, title, prompt) { this.turns.push({ name, title, prompt }); return '海边天气怎样啦\n【目的】问问游泳\n【状态】完成' },
    async deliver(chatId, text, opts) { this.delivered.push({ chatId, text, opts }); return { missedAt: [], failed: 0, errors: [], sent: text } },
  }

  // Case A: allow 配了规范 qq:private:20000010 → 只读读入旧 20000010.json 并在保存时惰性迁到 qq~private~20000010.json
  const cfg = {
    enabled: true, ownerQQ: '10000001', ownerName: '主人',
    speakUp: { allow: ['bad:::friend', `qq:private:${qqFriend}`, fsFriend], awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
  }
  const p = createPurpose({
    getConfig: () => cfg,
    hub,
    identity,
    routeOwner: identity.routeOwner,
    log: { info() {}, warn: (m) => warnings.push(String(m)), debug() {} },
    isMuted: (id) => id === 'private:10000001' || id === 'qq:private:10000001',
    mood: () => null,
    personaText: () => '',
    memory: () => ({
      list: () => [
        { id: 'mf1', text: '喜欢摄影', about: 'qq:20000010', importance: 0.6, at: now },
        { id: 'mf2', text: '周末要去海边游泳', about: fsPid, importance: 0.7, at: now },
      ],
      profiles: () => [{ id: fsPid, name: '小飞' }],
    }),
  })
  // 让 20000010 有素材可直接跑一轮保存，并验证惰性重写新文件名
  hub.chatLogOf = () => [
    { t: now - 3600_000, chatId: 'qq:private:20000010', who: '阿花', uid: '20000010', text: '我想周末去学习摄影构图技巧' },
    { t: now - 3600_000, chatId: fsFriend, who: '小飞', uid: 'ou_fs_friend', text: '我明天要去海边游泳' },
  ]
  await p.tick()
  const qqCanonFile = join(friendsDir, 'qq~private~20000010.json')
  assert.equal(existsSync(qqCanonFile), true, '规范键保存在 Windows 安全的新文件名 qq~private~20000010.json')
  assert.equal(existsSync(join(friendsDir, `${qqFriend}.json`)), false, '旧裸键文件在保存时被惰性重写迁移')
  assert.equal(JSON.parse(readFileSync(qqCanonFile, 'utf8')).countToday, 2, '继承旧文件的 countToday=1 后 +1')
  assert.ok(warnings.some((w) => w.includes('无效地址')), '无效白名单项记录警告并跳过')

  // Case B: 飞书朋友触发（把 QQ 朋友置今日已达上限，只留飞书朋友），验证 Windows 无冒号落盘 + owner-topic 目标形成 + 飞书送达
  writeFileSync(qqCanonFile, JSON.stringify({ ...JSON.parse(readFileSync(qqCanonFile, 'utf8')), countToday: 10 }))
  await p.tick() // 初始化 feishu~private~ou_fs_friend.json
  const fsSafeFile = join(friendsDir, 'feishu~private~ou_fs_friend.json')
  assert.equal(existsSync(fsSafeFile), true, '飞书朋友使用无冒号安全文件名落盘')
  writeFileSync(fsSafeFile, JSON.stringify({ ...JSON.parse(readFileSync(fsSafeFile, 'utf8')), nextFireAt: now - 1000 }))
  await p.tick()
  const fsDeliver = hub.delivered.find((d) => d.chatId === fsFriend)
  assert.ok(fsDeliver, '飞书朋友顺利收到目的引擎搭话')
  assert.match(hub.turns.at(-1).prompt, /海边|游泳/)
  assert.doesNotMatch(hub.turns.at(-1).prompt, /qq_send_private_message|不会发到 QQ|QQ·/)

  // engine buildPurposePrompt 默认不再含 reserved2 / qq_send_private_message
  const built = engine.buildPurposePrompt({ now, ownerUin: 'ou_x', ownerName: '测试' })
  assert.doesNotMatch(built, /qq_send_private_message|不会发到 QQ|QQ·/)

  // P2-1: 显式规范键（qq:private:20000010）已在上面验证读入旧文件并在保存时迁移删除；
  // 而仅配旧裸数字 allow（20000022）时，保留既有 friends/20000022.json 只读兼容策略（不强制重写文件名），确保旧测试与历史习惯不断裂。
  const legacyFriend = '20000022'
  const legacyPath = join(friendsDir, `${legacyFriend}.json`)
  const canonicalPath = join(friendsDir, 'qq~private~20000022.json')
  writeFileSync(legacyPath, JSON.stringify({
    ...engine.createPurposeState(now),
    countToday: 1,
    nextFireAt: now - 1000,
    lastPurpose: '旧裸号兼容状态',
  }))
  const cfgLegacy = {
    enabled: true, ownerQQ: '10000001', ownerName: '主人',
    speakUp: { allow: [legacyFriend], awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
  }
  const pLegacy = createPurpose({
    getConfig: () => cfgLegacy,
    hub: {
      ...hub,
      chatLogOf: () => [{ t: now - 3600_000, chatId: `qq:private:${legacyFriend}`, who: '老友', uid: legacyFriend, text: '我准备周末去爬山' }],
    },
    identity,
    routeOwner: identity.routeOwner,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    mood: () => null,
    personaText: () => '',
    memory: () => ({ list: () => [{ id: 'mf-leg', text: '喜欢爬山', about: legacyFriend, importance: 0.7, at: now }], profiles: () => [] }),
  })
  await pLegacy.tick()
  assert.equal(existsSync(legacyPath), true, '旧裸数字白名单沿用 legacy 状态文件')
  assert.equal(existsSync(canonicalPath), false, '旧裸数字白名单不破坏现有文件路径')
  assert.equal(JSON.parse(readFileSync(legacyPath, 'utf8')).countToday, 2)
})
