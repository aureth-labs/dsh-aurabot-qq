import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTestIdentity } from './helpers/identity.js'
import { readMemoryState } from './helpers/memory-state.js'

let normalize
let createMemoryStore
let createHub
let memoryMod

const log = { info() {}, warn() {}, debug() {} }

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-phase2-mem-'))
  ;({ normalize } = await import('../src/core/config.js'))
  ;({ createMemoryStore } = await import('../src/features/memory.js'))
  ;({ createHub } = await import('../src/chat/hub.js'))
  memoryMod = (await import('../src/modules/memory/index.js')).default
})

beforeEach(() => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-phase2-mem-'))
})

test('PR-2E: handleCommand / recallHint / shortRows 兼容飞书与规范 qq:private 地址并写入 PersonId', async () => {
  const dir = process.env.AURABOT_DATA_DIR
  const cfg = normalize({
    enabled: true,
    allow: { private: ['feishu:private:ou_friend', 'qq:private:20001'] },
    model: { provider: 'p', model: 'm' },
    memory: { enabled: true, shortTermIdleMinutes: 0, keepChatlogDays: 0 },
  })
  const identity = makeTestIdentity('ou_owner_fs', 'feishu')
  const friendPid = identity.resolve('feishu', 'ou_friend')
  const dsh = {
    get: () => null,
    llm: {
      async *stream({ system }) {
        const text = system.includes('简短印象') ? '刚在聊周末去海边露营' : '{"insights":[],"style":[]}'
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
    },
  }
  const hub = createHub({ dsh, getConfig: () => cfg, log, identity, routeOwner: identity.routeOwner, defaultPlatform: 'qq', onebot: {} })
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log, identity })
  try {
    const fsChat = { chatId: 'feishu:private:ou_friend', platform: 'feishu', kind: 'private', userId: 'ou_friend', nickname: '小飞' }
    // 1) handleCommand('记住...') 必须识别 feishu:private:... 并关联到 PersonId
    const rem = mem.handleCommand(fsChat, '记住我周末想去海边露营')
    assert.equal(rem.ok, true)
    assert.equal(mem.list('').find((x) => x.text.includes('海边露营'))?.about, friendPid)

    // 2) shortRows + updateShortTerms 处理飞书私聊日志并落盘到 PersonId
    hub.logChat('feishu:private:ou_friend', '小飞', '周末准备带帐篷去海边露营啦', 'ou_friend', { at: Date.now() - 10_000 })
    await mem.tick()
    const rawState = readMemoryState(dir)
    assert.match(rawState.shortTerm?.[friendPid]?.text || '', /露营/)

    // 3) recallHint 与 recallHintAsync 在 feishu:private:... 上同时命中 shortTerm 与 PersonId 记忆
    const hintSync = mem.recallHint(fsChat, '周末干嘛去')
    assert.match(hintSync, /露营/)
    const hintAsync = await mem.recallHintAsync(fsChat, '周末干嘛去')
    assert.match(hintAsync, /露营/)

    // 4) handleCommand('忘掉...') 清理记忆与聊天流水
    const forgot = mem.handleCommand(fsChat, '忘掉海边露营')
    assert.equal(forgot.ok, true)
    assert.ok(forgot.forgotten >= 1)
    assert.equal(mem.recallHint(fsChat, '海边露营'), '')
  } finally {
    hub.dispose()
  }
})

test('PR-2E: 保留历史 qq:<id> 键只读兼容 + 新写入逐步关联 PersonId，不做破坏性全量重写', async () => {
  const dir = process.env.AURABOT_DATA_DIR
  const now = Date.now()
  // 写入一份历史格式的 memories.json（旧 qq:<id> 键与数字 about）
  const legacyJson = {
    items: [{ id: 'old1', text: '阿强喜欢喝手冲咖啡', about: '20002', speaker: '20002', chatId: 'private:20002', at: now - 1000, tier: 2 }],
    profiles: { '20002': { name: '阿强', text: '咖啡爱好者' } },
    insights: { 'qq:20002': [{ id: 'ins1', text: '别在早上催他回消息', at: now - 2000 }] },
    insightNames: { 'qq:20002': '阿强' },
    styles: { 'qq:20002': ['习惯发语音后打字补充'] },
    relations: [],
  }
  writeFileSync(join(dir, 'memories.json'), JSON.stringify(legacyJson))

  const identity = makeTestIdentity('ou_owner_fs', 'feishu')
  const pid = identity.resolve('qq', '20002')
  // 同一个人在飞书侧也绑定同一 PersonId
  identity.resolve('feishu', 'ou_20002')
  // Manually link feishu:ou_20002 to the same PersonId? Let's test single person linked via both QQ and PersonId:
  const linkedIdentity = makeTestIdentity('10001', 'qq', { personId: 'p-owner' })
  const pStrong = linkedIdentity.resolve('qq', '20002')
  // Wait: simulate cross-platform link using same PersonId returned from lookup:
  const sharedIdentity = {
    ...linkedIdentity,
    lookup: (plat, acc) => (plat === 'qq' && acc === '20002') || (plat === 'feishu' && acc === 'ou_20002') ? pStrong : linkedIdentity.lookup(plat, acc),
    accountsOf: (person) => (person === pStrong ? [{ platform: 'qq', account: '20002' }, { platform: 'feishu', account: 'ou_20002' }] : linkedIdentity.accountsOf(person)),
  }

  const cfg = normalize({ enabled: true, allow: { private: ['20002', 'feishu:private:ou_20002'] }, memory: { enabled: true } })
  const dsh = {
    get: () => null,
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: '{"insights":["喜欢聊埃塞俄比亚豆"],"style":["语气轻松"]}' }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
    },
  }
  const hub = createHub({ dsh, getConfig: () => cfg, log, identity: sharedIdentity, routeOwner: sharedIdentity.routeOwner, defaultPlatform: 'qq', onebot: {} })
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log, identity: sharedIdentity })
  try {
    const feishuStrong = { chatId: 'feishu:private:ou_20002', platform: 'feishu', kind: 'private', userId: 'ou_20002', sender: { person: pStrong } }
    // 只读 contextFor：跨平台也能读出历史 qq:20002 里的相处经验与说话风格
    const ctx = mem.contextFor(feishuStrong, 's-strong')
    assert.match(ctx, /别在早上催他回消息/, '只读兼容历史 qq:<id> insights')
    assert.match(ctx, /习惯发语音后打字补充/, '只读兼容历史 qq:<id> styles')
    // 确认历史键没有被破坏性重写
    const diskBeforeWrite = readMemoryState(dir)
    assert.ok(diskBeforeWrite.insights['qq:20002'], '只读不破坏重写历史 qq:<id> 键')

    // 新写入（handleCommand '记住...'）逐步关联 PersonId，同时仍不清掉历史 qq:<id>
    const rem = mem.handleCommand(feishuStrong, '记住我最近买了磨豆机')
    assert.equal(rem.ok, true)
    assert.equal(mem.list('').find((x) => x.text.includes('磨豆机'))?.about, pStrong)
    const diskAfterWrite = readMemoryState(dir)
    assert.ok(diskAfterWrite.insights['qq:20002'], '历史 qq:<id> 键保持完整，不做破坏性全量重写')

    // forget 时历史 qq:<id> 中的该关键词也一并被清除
    mem.handleCommand({ chatId: 'qq:private:20002', platform: 'qq', kind: 'private', userId: '20002' }, '忘掉早上催他')
    const ctxAfterForget = mem.contextFor(feishuStrong, 's-strong')
    assert.doesNotMatch(ctxAfterForget, /别在早上催他回消息/)
  } finally {
    hub.dispose()
  }
})

test('PR-2E: /memory/assoc/preview 在飞书主账号下正确构造规范 ChatId 并完成召回', async () => {
  const dir = process.env.AURABOT_DATA_DIR
  const cfg = normalize({ enabled: true, memory: { enabled: true } })
  const identity = makeTestIdentity('ou_owner_fs', 'feishu')
  const ownerPid = identity.owner()
  const routes = new Map()
  const mem = memoryMod.setup({
    config: () => cfg,
    log,
    context() {},
    on() {},
    every() {},
    tool() {},
    route: (path, fn) => routes.set(path, fn),
    ownerChat: () => 'feishu:private:ou_owner_fs',
    core: {
      hub: { chatLogDays: () => [], chatLogOf: () => [] },
      http: { query: (req) => req?.query || {}, body: async () => ({}) },
      identity,
      routeOwner: identity.routeOwner,
      resolveOwnerRoute: () => ({ chatId: 'feishu:private:ou_owner_fs', blocked: false, reason: 'ok' }),
    },
  })
  // Note: module 返回 createMemoryStore 结果；通过面板路由添加与预览
  const addRes = await routes.get('/memory/add')({}).catch(() => null)
  assert.equal(addRes?.ok, false) // empty text check confirms route works
  mem.add({ text: '主人很喜欢在飞书讨论架构设计', about: ownerPid, importance: 0.8, chatId: 'feishu:private:ou_owner_fs' })

  const preview = await routes.get('/memory/assoc/preview')({ query: { q: '架构设计' } })
  assert.equal(preview.ok, true)
  assert.ok(preview.items.some((i) => i.text.includes('架构设计')), '飞书主账号地址可正确命中联想预览')
})
