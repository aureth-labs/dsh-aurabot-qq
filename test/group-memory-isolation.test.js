// 多平台群记忆隔离专项验证（对应《发布前验收清单》§0.1「群记忆隔离专项验证」）：
//   - 同群号（qq:group:777 vs qq#2:group:777 vs qqbot:group:OPENID_777 vs feishu:group:oc_777 vs 传统 group:777）
//     的群印象 / 相处经验 / 说话方式 / 群公共事实 / 群梗概 / 去重严格按规范 chatId 隔离，不串群；
//   - ownerBrief（groupBackdrop）、chats()、lookupChat() 支持多平台规范 chatId 且不因 groupId/slice 碰撞；
//   - hub.deliver() / silenceTurn() / membersOf() / logChat(/forget) 对非默认平台规范地址生效且不回落 legacy OneBot。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createMemoryStore } from '../src/features/memory.js'
import { createIdentity } from '../src/gateway/identity.js'
import { createHub } from '../src/chat/hub.js'
import { writeMemoryState, readMemoryState } from './helpers/memory-state.js'

const log = { info() {}, warn() {}, debug() {}, error() {}, child() { return this } }
const dayKey = (at = Date.now()) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('群记忆跨实例与跨平台严格隔离：同群号 777 在 qq / qq#2 / feishu / qqbot 间不串印象、经验、事实与去重', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-group-mem-iso-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const identity = createIdentity({ dataDir: join(dir, 'gw'), log })
  const ownerPerson = identity.claimOwner('qq', '10000001')
  identity.link('feishu', 'ou_owner', ownerPerson, 'owner')
  identity.link('qqbot', 'oid_owner', ownerPerson, 'owner')

  t.after(() => {
    identity.close?.()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
    rmSync(dir, { recursive: true, force: true })
  })

  const cfg = normalize({
    enabled: true,
    botQQ: '20000002',
    allow: { groups: ['777', 'qq#2:group:777', 'feishu:group:oc_777', 'qqbot:group:OPENID_777'] },
    model: { provider: 'p', model: 'm' },
    memory: { compress: false, chatImpression: true },
  })
  const dsh = { get: () => null, llm: { async *stream() {} } }
  const hub = {
    chatLogDays: () => [],
    chatLogOf: () => [],
    groupNames: new Map([
      ['777', '默认QQ777群'],
      ['qq:group:777', '默认QQ777群'],
      ['qq#2:group:777', '二号QQ777群'],
      ['feishu:group:oc_777', '飞书777群'],
      ['qqbot:group:OPENID_777', '官方777群'],
    ]),
    speakersOf: () => [],
    forgetChatLog: () => 0,
  }
  const mem = createMemoryStore({ getConfig: () => cfg, dsh, hub, log, identity })

  const now = Date.now() - 1000
  writeMemoryState(dir, {
    items: [
      { id: 'f_def_legacy', text: '默认QQ旧格式群规则禁止发广告', about: '', scope: 'group', chatId: 'group:777', source: 'auto', at: now, saidAt: now, importance: 0.9 },
      { id: 'f_qq2', text: '二号QQ777群周五开游戏局', about: '', scope: 'group', chatId: 'qq#2:group:777', source: 'auto', at: now, saidAt: now, importance: 0.9 },
      { id: 'f_fs', text: '飞书777群每周三晨会', about: '', scope: 'group', chatId: 'feishu:group:oc_777', source: 'auto', at: now, saidAt: now, importance: 0.9 },
      { id: 'f_bot', text: '官方Bot777群只做答疑', about: '', scope: 'group', chatId: 'qqbot:group:OPENID_777', source: 'auto', at: now, saidAt: now, importance: 0.9 },
    ],
    gists: [
      { id: 'g_def', kind: 'gist', level: 1, text: '默认QQ昨日在讨论猫猫', chatId: 'group:777', at: now, saidAt: now },
      { id: 'g_qq2', kind: 'gist', level: 1, text: '二号QQ昨日在讨论咖啡', chatId: 'qq#2:group:777', at: now, saidAt: now },
      { id: 'g_fs', kind: 'gist', level: 1, text: '飞书777昨日在讨论发布计划', chatId: 'feishu:group:oc_777', at: now, saidAt: now },
    ],
    chats: {
      'group:777': { vibe: '热闹的默认QQ老群', topics: '猫猫', impression: '爱斗图' },
      'qq#2:group:777': { vibe: '安静的二号机群', topics: '咖啡', impression: '常聊天' },
      'feishu:group:oc_777': { vibe: '飞书工作项目群', topics: '排期', impression: '高效率' },
    },
    insights: {
      'group:777': [{ text: '默认QQ群用轻松语气' }],
      'qq#2:group:777': [{ text: '二号QQ群用简短回复' }],
      'feishu:group:oc_777': [{ text: '飞书群用条目归纳' }],
    },
    styles: {
      'group:777': ['默认QQ口癖'],
      'qq#2:group:777': ['二号QQ口癖'],
      'feishu:group:oc_777': ['飞书群口癖'],
    },
  })

  // 1) contextFor 严格按平台与实例隔离：qq#2 / feishu / qqbot 传入同 groupId='777' 时绝不继承默认 group:777
  const ctxDef = mem.contextFor({ kind: 'group', groupId: '777', platform: 'qq', chatId: 'qq:group:777' }, 's_def')
  assert.match(ctxDef, /热闹的默认QQ老群/)
  assert.match(ctxDef, /默认QQ群用轻松语气/)
  assert.match(ctxDef, /默认QQ口癖/)
  assert.doesNotMatch(ctxDef, /安静的二号机群|飞书工作项目群|二号QQ口癖|飞书群口癖/)

  const ctxQq2 = mem.contextFor({ kind: 'group', groupId: '777', platform: 'qq', chatId: 'qq#2:group:777' }, 's_qq2')
  assert.match(ctxQq2, /安静的二号机群/)
  assert.match(ctxQq2, /二号QQ群用简短回复/)
  assert.match(ctxQq2, /二号QQ口癖/)
  assert.doesNotMatch(ctxQq2, /热闹的默认QQ老群|默认QQ群用轻松语气|默认QQ口癖|飞书工作项目群/)

  // qqbot:group:OPENID_777 即使携带 groupId='777' 也不得误读 group:777
  const ctxBot = mem.contextFor({ kind: 'group', groupId: '777', platform: 'qqbot', chatId: 'qqbot:group:OPENID_777' }, 's_bot')
  assert.doesNotMatch(ctxBot, /热闹的默认QQ老群|默认QQ群用轻松语气|默认QQ口癖|安静的二号机群|飞书工作项目群/)

  const ctxFs = mem.contextFor({ kind: 'group', groupId: '777', platform: 'feishu', chatId: 'feishu:group:oc_777' }, 's_fs')
  assert.match(ctxFs, /飞书工作项目群/)
  assert.doesNotMatch(ctxFs, /热闹的默认QQ老群|默认QQ群用轻松语气|默认QQ口癖|安静的二号机群/)

  // 2) recall 与 gists 隔离
  const fsRecalled = mem.recall('发布计划 猫猫 咖啡 广告', { where: 'feishu:group:oc_777', groupChatId: 'feishu:group:oc_777', limit: 10 })
  assert.equal(fsRecalled.some((x) => /发布计划/.test(x.it.text)), true)
  assert.equal(fsRecalled.some((x) => /猫猫|咖啡|禁止发广告/.test(x.it.text)), false, '飞书群不得召回 QQ 默认群或二号实例的群记忆/梗概')

  const botRecalled = mem.recall('答疑 广告 游戏', { where: 'qqbot:group:OPENID_777', groupChatId: 'qqbot:group:OPENID_777', limit: 10 })
  assert.equal(botRecalled.some((x) => /只做答疑/.test(x.it.text)), true)
  assert.equal(botRecalled.some((x) => /禁止发广告|游戏局/.test(x.it.text)), false, 'QQBot 同群号不得召回 OneBot 群记忆')

  // 3) chats() 不把默认QQ群名张冠李戴给 qq#2 或 qqbot，并支持 lookupChat 跨平台查询
  const allChats = mem.chats()
  const qq2Chat = allChats.find((x) => x.chatId === 'qq#2:group:777')
  assert.equal(qq2Chat?.name, '二号QQ777群')
  const lookFs = mem.lookupChat({ kind: 'private', userId: 'ou_owner', platform: 'feishu', chatId: 'feishu:private:ou_owner' }, 'feishu:group:oc_777')
  assert.equal(lookFs.ok, true)
  assert.match(lookFs.message, /飞书工作项目群/)

  // 4) 同一句群公共事实在不同实例/平台分别记入各自 chatId，绝不跨聊天去重吞并
  mem.add({ text: '大家每周五点外卖', about: '', scope: 'group', chatId: 'qq:group:777', source: 'auto' })
  mem.add({ text: '大家每周五点外卖', about: '', scope: 'group', chatId: 'qq#2:group:777', source: 'auto' })
  mem.add({ text: '大家每周五点外卖', about: '', scope: 'group', chatId: 'feishu:group:oc_777', source: 'auto' })
  const items = readMemoryState(dir).items.filter((m) => m.text === '大家每周五点外卖')
  assert.deepEqual(items.map((m) => m.chatId).sort(), ['feishu:group:oc_777', 'qq#2:group:777', 'qq:group:777'])
})

test('ownerBrief（groupBackdrop）按规范 chatId 过滤与分块，不因 slice(6) 串群且不混群名', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-group-backdrop-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const identity = createIdentity({ dataDir: join(dir, 'gw'), log })
  identity.claimOwner('feishu', 'ou_owner')
  t.after(() => {
    identity.close?.()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
    rmSync(dir, { recursive: true, force: true })
  })

  const cfg = normalize({
    enabled: true,
    allow: { groups: ['777', 'qq#2:group:777', 'feishu:group:oc_777'] },
    group: { ownerBrief: { enabled: true, groups: ['qq#2:group:777', 'feishu:group:oc_777'], lines: 5 } },
    model: { provider: 'p', model: 'm' },
    memory: { compress: false, recallMode: 'always' },
  })
  const now = Date.now() - 1000
  const rows = [
    { t: now - 300, chatId: 'qq:group:777', who: '张三', uid: '31', text: '默认QQ777群今天买奶茶啦' },
    { t: now - 200, chatId: 'qq#2:group:777', who: '李四', uid: '32', text: '二号QQ777群刚刚在修接口' },
    { t: now - 100, chatId: 'feishu:group:oc_777', who: '王五', uid: 'ou_5', text: '飞书工作群刚同步了版本进度' },
  ]
  const hub = {
    chatLogDays: () => [dayKey(now)],
    chatLogOf: () => rows,
    groupNames: new Map([
      ['777', '默认QQ群名'],
      ['qq#2:group:777', '二号实例群名'],
      ['feishu:group:oc_777', '飞书项目群名'],
    ]),
    speakersOf: () => [],
    forgetChatLog: () => 0,
  }
  const mem = createMemoryStore({ getConfig: () => cfg, dsh: { get: () => null, llm: { async *stream() {} } }, hub, log, identity })

  const out = mem.recallHint({ kind: 'private', userId: 'ou_owner', platform: 'feishu', chatId: 'feishu:private:ou_owner' }, '最近群里都在聊什么')
  assert.doesNotMatch(out, /默认QQ777群今天买奶茶啦|默认QQ群名/, '未在白名单的默认 QQ 777 不得渗入，也不得借其群名')
  assert.match(out, /二号实例群名.*二号QQ777群刚刚在修接口/s)
  assert.match(out, /飞书项目群名.*飞书工作群刚同步了版本进度/s)
})

test('hub.deliver / logChat(/forget) / membersOf 支持规范网关地址，不回落 legacy OneBot', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-hub-nonqq-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  mkdirSync(dir, { recursive: true })
  t.after(() => {
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
    rmSync(dir, { recursive: true, force: true })
  })

  const onebotCalls = []
  const sentMessages = []
  const fetchedCalls = []
  const cfg = normalize({
    enabled: true,
    dryRun: false,
    allow: { groups: ['feishu:group:oc_1'], private: ['feishu:private:ou_owner'] },
    platforms: { qq: { enabled: false }, feishu: { enabled: true } },
    voice: { enabled: false },
    stickers: { enabled: false },
  })
  const gateway = {
    instances: () => [{ instance: 'feishu', platform: 'feishu', enabled: true, state: 'connected' }],
    caps: () => ({ image: true, file: true, mention: true, memberList: true, proactive: 'free', features: { 'chat.member.list': true } }),
    features: () => ({ 'chat.member.list': true }),
    async fetch(cid, req) {
      fetchedCalls.push({ cid, req })
      if (req.kind === 'members') return [{ account: 'ou_alice', name: '爱丽丝' }]
      return {}
    },
    async send(msg) {
      sentMessages.push(msg)
      return { messageId: 'om_out_1' }
    },
  }
  const memoryStub = {
    contextFor: () => '', recall: async () => [], groupBackdrop: () => '', recallTail: () => '',
    isAcquainted: () => true, remembers: () => true, add: () => ({ ok: true }), saveChat: () => ({ ok: true }),
    personProfile: () => null, groupImpression: () => null,
  }
  const hub = createHub({
    dataDir: (...parts) => join(dir, ...parts),
    getConfig: () => cfg,
    onebot: { state: 'stopped', async call(action, params) { onebotCalls.push({ action, params }); return [] } },
    gateway,
    log,
    ask: async () => 'ok',
    memory: memoryStub,
    mood: () => ({ delay: 0, voice: 0, sticker: 0 }),
    stickers: { enabled: false, match: () => null, pickForReply: () => null },
    tts: { speak: async () => ({}) },
    voiceCfg: () => ({ enabled: false }),
    mutes: { isMuted: () => false },
    dsh: { get: () => null },
    hooks: {},
  })
  t.after(() => hub.dispose())

  // 1) 非默认平台私聊写入 /forget 应正确标 forgottenAt
  assert.equal(hub.logChat('feishu:private:ou_owner', 'user', '忘记我刚说过的秘密', 'ou_owner'), true)
  const day = hub.chatLogDays()[0]
  const rows = hub.chatLogOf(day)
  assert.ok(rows[0].forgottenAt, 'feishu:private:... 应识别为私聊并标记 instant /forget')

  // 2) 非默认平台群 deliver：@爱丽丝 走 gateway fetch(members)，不误打 onebot；silenceTurn 也能正常静默
  const res = await hub.deliver('feishu:group:oc_1', '@爱丽丝 开会了')
  assert.equal(onebotCalls.length, 0, '非默认平台群绝不调用 legacy onebot')
  assert.equal(fetchedCalls.some((c) => c.req?.kind === 'members' && c.cid === 'feishu:group:oc_1'), true)
  assert.equal(sentMessages.some((m) => m.parts?.some((p) => p.type === 'mention' && p.account === 'ou_alice')), true)
  assert.match(res.sent, /开会了/)
})
