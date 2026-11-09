import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createMemoryStore } from '../src/features/memory.js'
import { createHub } from '../src/chat/hub.js'
import memoryModule from '../src/modules/memory/index.js'
import { readMemoryState, writeMemoryState } from './helpers/memory-state.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001', A = '30000001', B = '30000002', BOT = '20000001'
const log = { info() {}, warn() {}, debug() {}, error() {} }
const day = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const privateChat = (qq) => ({ kind: 'private', userId: qq, chatId: `private:${qq}` })
const row = (uid, extra = {}) => ({ t: Date.now() - 600_000, chatId: 'group:777', uid, who: uid === A ? '阿甲' : '阿乙', text: '我喜欢画画', ...extra })
const extraction = (qq = A) => ({
  facts: [{ text: '阿甲喜欢画画', about: '阿甲', about_qq: qq, speaker: qq, status: 'fact', tier: 2 }],
  people: [{ qq, alias: { text: '画友', speaker: qq }, style: { text: '说话简短', speaker: qq } }],
})

function fixture(t, initial = { items: [] }) {
  const previous = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'person-delete-forget-'))
  process.env.AURABOT_DATA_DIR = dir
  writeFileSync(join(dir, 'memories.json'), JSON.stringify(initial))
  const cfg = normalize({ enabled: true, ownerQQ: OWNER, botQQ: BOT, allow: { groups: ['777'], private: [A, B] }, model: { provider: 'p', model: 'm' }, memory: { dailyConsolidate: false, compress: false, gistEnabled: false, keepChatlogDays: 7, extractDailyBatches: 100 } })
  // 群聊用例必须自己提供互动或好友证据，不能靠私聊白名单隐式通过。
  cfg.allow.private = []
  const rows = [], calls = [], friends = new Set()
  const model = { output: extraction(), beforeExtract: null }
  const hub = {
    chatLogDays: () => rows.length ? [day()] : [], chatLogOf: () => rows,
    groupNames: new Map([['777', '画画群']]), speakersOf: () => [A, B],
    isFriend: (qq) => friends.has(String(qq)), refreshFriends: async () => {},
    logChat(chatId, who, text, uid = '', opts = {}) { rows.push(row(uid, { chatId, who, text, t: opts.at || Date.now(), ...opts })); return true },
    forgetChatLog(qq) {
      let marked = 0
      for (const r of rows) if (!r.forgottenAt && (r.chatId === `private:${qq}` || (r.who !== 'bot' && r.uid === qq))) { r.forgottenAt = Date.now(); marked++ }
      return marked
    },
  }
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    calls.push({ system, text: messages?.[0]?.content?.[0]?.text || '' })
    let out
    if (system.includes('整理长期记忆')) {
      await model.beforeExtract?.()
      out = JSON.stringify(model.output)
    } else if (system.includes('相处')) out = '{"insights":["聊画画就好"],"style":["喜欢短句"]}'
    else if (system.includes('人物小档案')) out = '阿甲喜欢画画，是熟悉的画友'
    else if (system.includes('刚才和一个人')) out = '刚才在聊画画'
    else out = '[]'
    yield { type: 'text-delta', text: out }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const memory = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, cfg, hub, rows, calls, friends, model, memory, state: () => readMemoryState(dir), put: (s) => writeMemoryState(dir, s) }
}

function oldState() {
  const now = Date.now()
  return {
    items: [
      { id: 'a', text: '阿甲下周有面试', about: A, speaker: A, chatId: `private:${A}`, at: now, tier: 3, related: ['b'], followUp: { at: now, tries: 1, question: '面试顺利吗' } },
      { id: 'b', text: '阿乙提到阿甲的名字，也想去画画', about: B, aboutName: '阿乙', speaker: B, at: now, related: ['a'], followUp: { at: now, tries: 0, question: '画画了吗' } },
    ],
    profiles: { [A]: { name: '阿甲', alias: '甲甲', text: '画画朋友', tags: ['讨厌', '朋友'], tagsBy: 'owner' }, [B]: { text: '阿乙的档案' } },
    dirtyProfiles: { [A]: true, [B]: true },
    relations: [
      { id: 'ab', subj: '阿甲', subjQq: A, pred: '是朋友', obj: '阿乙', objQq: B },
      { id: 'alias', subj: '甲甲', pred: '是同学', obj: '别的人' },
      { id: 'other', subj: '阿乙', subjQq: B, pred: '是朋友', obj: '主人', objQq: OWNER },
    ],
    insights: { [`qq:${A}`]: [{ text: '耐心听阿甲说话' }], [`qq:${B}`]: [{ text: '和阿乙聊画画' }] },
    insightNames: { [`qq:${A}`]: '阿甲', [`qq:${B}`]: '阿乙' },
    styles: { [`qq:${A}`]: ['爱用叠字'], [`qq:${B}`]: ['爱用短句'] },
    shortTerm: { [A]: { text: '聊面试', through: now }, [B]: { text: '聊画画', through: now } },
    gists: [{ id: 'ga', kind: 'gist', about: A, chatId: `private:${A}`, text: '聊面试' }, { id: 'gb', kind: 'gist', about: B, text: '聊画画' }],
    gistParts: { yesterday: { 'group:777': { parts: ['阿甲聊过面试'] } } },
  }
}

test('删除一个人清理整套记忆及引用，别人的事实只提名字仍保留', (t) => {
  const f = fixture(t, oldState())
  f.rows.push(row(A), row(B), row(A, { chatId: `private:${A}` }))
  assert.equal(f.memory.deletePerson(A).ok, true)
  const s = f.state()
  for (const key of ['profiles', 'dirtyProfiles', 'shortTerm']) assert.equal(s[key]?.[A], undefined, key)
  for (const key of ['insights', 'insightNames', 'styles']) assert.equal(s[key]?.[`qq:${A}`], undefined, key)
  assert.deepEqual(s.items.map((m) => m.id), ['b'])
  assert.match(s.items[0].text, /阿甲/)
  assert.deepEqual(s.items[0].related, [])
  assert.equal(s.items[0].followUp.question, '画画了吗')
  assert.deepEqual(s.relations.map((r) => r.id), ['other'])
  assert.deepEqual(s.gists.map((g) => g.id), ['gb'])
  assert.equal(s.gistParts, undefined)
  assert.ok(f.rows.filter((r) => r.uid === A).every((r) => r.forgottenAt))
  assert.ok(f.rows.filter((r) => r.uid === B).every((r) => !r.forgottenAt))
  assert.equal(f.memory.personaOverview().some((p) => p.qq === A), false)
})

test('主人不能删除、不能停止记忆，旧数据里的错误标记也不屏蔽主人', (t) => {
  const f = fixture(t, { items: [], profiles: { [OWNER]: { text: '主人', noMemory: true } } })
  const before = f.state()
  assert.equal(f.memory.deletePerson(OWNER).ok, false)
  assert.equal(f.memory.setNoMemory(OWNER, true).ok, false)
  assert.equal(f.memory.remembers(OWNER), true)
  assert.deepEqual(f.state(), before)
})

test('删除打断正在跑的提炼，事实、画像、关系都不能写回，后续整理也不复活', async (t) => {
  const f = fixture(t)
  f.rows.push(row(A, { interaction: [A] }))
  f.model.output.relations = [{ subj: '阿甲', subj_qq: A, pred: '是朋友', obj: '阿乙', obj_qq: B, speaker: A }]
  let entered, release
  const started = new Promise((resolve) => { entered = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  f.model.beforeExtract = async () => { entered(); await wait }
  const running = f.memory.consolidate({ includeToday: true })
  await started
  f.memory.deletePerson(A)
  release()
  await running
  assert.equal(f.state().items.length, 0)
  assert.equal(f.state().profiles?.[A], undefined)
  assert.equal(f.state().relations?.length || 0, 0)
  f.model.beforeExtract = null
  await f.memory.consolidate({ includeToday: true })
  assert.equal(f.state().items.length, 0)
  assert.equal(f.memory.personaOverview().some((p) => p.qq === A), false)
})

test('不再记住保留旧数据但不提炼、不注入、不召回、不生成摘要和跟进；流水照常', async (t) => {
  const f = fixture(t, oldState())
  f.cfg.speakUp.allow = [A]
  f.memory.setNoMemory(A, true)
  const old = f.state().profiles[A]
  assert.equal(old.noMemory, true)
  assert.equal(old.text, '画画朋友')
  assert.equal(f.memory.noteVia({ via: 'test-chat', qq: A, who: 'user', text: '我还喜欢画画' }).ok, true)
  assert.ok(f.rows.some((r) => r.uid === A && r.text === '我还喜欢画画' && !r.forgottenAt))
  assert.equal(f.memory.add({ about: A, text: '不应该写入' }).ok, false)
  assert.equal(f.memory.setProfile(A, '不应该写入'), false)
  f.memory.setInsights(`qq:${A}`, ['不应该写入'])
  f.memory.setStyle(`qq:${A}`, ['不应该写入'])
  assert.equal(f.memory.saveRelation({ subj: '阿甲', pred: '是朋友', obj: '阿乙', speaker: B }).ok, false, '关系只有名字也不能绕过停止记忆')
  assert.equal(f.memory.savePersonaPerson(A, { text: '不应该写入' }).ok, false)
  assert.equal(f.memory.contextFor(privateChat(A), ''), '')
  assert.equal(f.memory.contextVia({ qq: A, query: '画画面试' }), '')
  assert.equal(f.memory.dueFollowUp(A), null)
  assert.equal(f.memory.recall('面试', { limit: 20 }).some((h) => h.it.about === A), false)
  assert.equal(f.memory.lookupPerson(privateChat(OWNER), A).message.includes('画画朋友'), false)
  await f.memory.consolidate({ includeToday: true })
  await f.memory.tick()
  const s = f.state()
  assert.equal(s.items.some((m) => m.text === '不应该写入'), false)
  assert.equal(s.profiles[A].alias, '甲甲')
  assert.equal(s.profiles[A].noMemory, true)
  assert.deepEqual(s.insights[`qq:${A}`], [{ text: '耐心听阿甲说话' }])
  assert.deepEqual(s.styles[`qq:${A}`], ['爱用叠字'])
  assert.equal(s.shortTerm?.[A], undefined)
  assert.equal(s.items.find((m) => m.id === 'a').followUp, undefined)
  assert.equal(f.calls.some((c) => c.text.includes('我还喜欢画画')), false)
})

test('不再记住在提炼途中开启也会撤销在途结果', async (t) => {
  const f = fixture(t)
  f.rows.push(row(A, { chatId: `private:${A}` }))
  f.model.beforeExtract = () => f.memory.setNoMemory(A, true)
  await f.memory.consolidate({ includeToday: true })
  assert.equal(f.state().items.length, 0)
  assert.deepEqual(f.state().profiles[A], { noMemory: true })
  assert.ok(f.rows.every((r) => !r.forgottenAt), '停止记忆不等于忘掉原话')
})

test('撤销恢复后续提炼；讨厌标签与不再记住分别设置', async (t) => {
  const f = fixture(t)
  f.memory.savePersonaPerson(A, { tags: ['讨厌'] })
  f.memory.setNoMemory(A, true)
  assert.equal(f.memory.dislikes(A), true)
  f.memory.savePersonaPerson(A, { tags: ['朋友'] })
  assert.equal(f.memory.remembers(A), false)
  f.memory.savePersonaPerson(A, { tags: ['讨厌'] })
  f.memory.setNoMemory(A, false)
  assert.equal(f.memory.remembers(A), true)
  assert.equal(f.memory.dislikes(A), true)
  f.rows.push(row(A, { chatId: `private:${A}` }))
  await f.memory.consolidate({ includeToday: true })
  assert.ok(f.state().items.some((m) => m.about === A))
  assert.equal(f.state().profiles[A].alias, '画友')
  assert.match(f.memory.contextFor(privateChat(A), ''), /画友/)
})

test('开启时可同时删除已有记忆，重建 store 后 noMemory 标记仍在', (t) => {
  const f = fixture(t, oldState())
  f.memory.setNoMemory(A, true, { deleteExisting: true })
  assert.deepEqual(f.state().profiles[A], { noMemory: true })
  assert.ok(f.state().items.every((m) => m.about !== A))
  const reloaded = createMemoryStore({ getConfig: () => f.cfg, hub: f.hub, log })
  assert.equal(reloaded.remembers(A), false)
  assert.equal(reloaded.setNoMemory(A, false).ok, true)
  assert.equal(reloaded.remembers(A), true)
})

test('路过群友不形成人物记忆，群公共事实保留；旧画像不删除也不更新', async (t) => {
  const f = fixture(t, { items: [], profiles: { [A]: { text: '历史印象', alias: '旧称呼' } } })
  f.rows.push(row(A))
  f.model.output.facts.push({ text: '群里周六举行绘画活动', scope: 'group', speaker: A, tier: 2 })
  f.model.output.relations = [{ subj: '阿甲', subj_qq: A, pred: '是朋友', obj: '阿乙', obj_qq: B, speaker: A }]
  assert.equal(f.memory.isAcquainted(A), false)
  assert.equal(f.memory.setProfile(A, '不能自动建画像'), false)
  await f.memory.consolidate({ includeToday: true })
  const s = f.state()
  assert.equal(s.profiles[A].text, '历史印象')
  assert.equal(s.profiles[A].alias, '旧称呼')
  assert.equal(s.items.some((m) => m.about === A), false)
  assert.ok(s.items.some((m) => m.scope === 'group' && /绘画活动/.test(m.text)))
  assert.equal(s.relations?.length || 0, 0)
  f.memory.setInsights(`qq:${A}`, ['不该记录'])
  f.memory.setStyle(`qq:${A}`, ['不该记录'])
  assert.equal(f.state().insights?.[`qq:${A}`], undefined)
  assert.equal(f.state().styles?.[`qq:${A}`], undefined)
  for (const text of ['喜欢猫', '喜欢茶', '喜欢围棋']) f.memory.add({ about: A, text })
  assert.equal(await f.memory.buildProfile(A), false)
})

for (const evidence of ['at', 'reply', 'replied', 'friend', 'allow', 'private']) {
  test(`有交集才建画像：${evidence}`, async (t) => {
    const f = fixture(t)
    if (evidence === 'friend') f.friends.add(A)
    if (evidence === 'allow') f.cfg.allow.private = [A]
    f.rows.push(row(A, evidence === 'private' ? { chatId: `private:${A}` } : ['at', 'reply'].includes(evidence) ? { interaction: [A] } : {}))
    if (evidence === 'replied') f.rows.push(row('', { who: 'bot', text: '你画得不错', interaction: [A] }))
    assert.equal(f.memory.isAcquainted(A), true)
    assert.equal((await f.memory.consolidate({ includeToday: true })).ok, true)
    assert.equal(f.state().profiles[A].alias, '画友')
    assert.ok(f.state().items.some((m) => m.about === A))
  })
}

test('profileOnlyAcquainted 默认开、可关闭，老画像和无互动字段的私聊流水兼容', async (t) => {
  assert.equal(normalize({}).memory.profileOnlyAcquainted, true)
  assert.equal(normalize({ memory: { profileOnlyAcquainted: false } }).memory.profileOnlyAcquainted, false)
  const f = fixture(t, { items: [], profiles: { [B]: { text: '老朋友画像' } } })
  assert.equal(f.memory.remembers(B), true)
  assert.match(f.memory.contextFor(privateChat(B), ''), /老朋友画像/)
  f.rows.push(row(B, { chatId: `private:${B}`, uid: undefined }))
  assert.equal(f.memory.isAcquainted(B), true)
  f.rows.push(row(A))
  f.cfg.memory.profileOnlyAcquainted = false
  await f.memory.consolidate({ includeToday: true })
  assert.equal(f.state().profiles[A].alias, '画友')
})

test('人物墙主人第一，互动多的朋友优先于刚路过的活跃群友，最近互动打破同次数平局', (t) => {
  const C = '30000003', D = '30000004'
  const f = fixture(t, { items: [], profiles: Object.fromEntries([OWNER, A, B, C, D].map((qq) => [qq, { text: qq }])) })
  const now = Date.now()
  for (let i = 0; i < 8; i++) f.rows.push(row(A, { interaction: [A], t: now - 86400_000 }))
  for (let i = 0; i < 100; i++) f.rows.push(row(B, { t: now }))
  f.rows.push(row(C, { interaction: [C], t: now - 86400_000 }), row(D, { interaction: [D], t: now - 1000 }))
  assert.deepEqual(f.memory.personaOverview().map((p) => p.qq), [OWNER, A, D, C, B])
  assert.equal(f.memory.personaOverview().find((p) => p.qq === A).interactions, 8)
})

test('真实 hub 在静默路径也记录 @ 和回复证据，QQ 好友使用同一判断，停止记忆不拦流水', async (t) => {
  const f = fixture(t)
  const fake = createFakeDsh({ brain: async () => '好' })
  f.cfg.stickers.enabled = false
  const hub = createHub({ dsh: fake.ctx, getConfig: () => f.cfg, log, isMuted: () => true, onebot: { connected: true, call: async (action) => action === 'get_friend_list' ? [{ user_id: Number(B) }] : action === 'get_msg' ? { sender: { user_id: Number(BOT) }, message: [] } : {} } })
  t.after(() => { hub.dispose(); fake.dispose() })
  const memory = createMemoryStore({ getConfig: () => f.cfg, hub, log })
  memory.setNoMemory(A, true)
  const event = (uid, segments) => ({ post_type: 'message', message_type: 'group', group_id: 777, self_id: Number(BOT), user_id: Number(uid), message_id: 123, sender: { user_id: Number(uid), nickname: uid }, message: [...segments, { type: 'text', data: { text: '你好，画画吗' } }] })
  await hub.onMessage(event(A, [{ type: 'at', data: { qq: BOT } }]))
  await hub.onMessage(event('30000003', [{ type: 'reply', data: { id: '42' } }]))
  await hub.onMessage(event('30000004', []))
  const rows = hub.chatLogOf(day())
  assert.ok(rows.some((r) => r.uid === A && !r.forgottenAt && r.interaction.includes(A)))
  assert.equal(memory.remembers(A), false)
  assert.equal(memory.isAcquainted(A), true)
  assert.equal(memory.isAcquainted('30000003'), true)
  assert.equal(memory.isAcquainted('30000004'), false)
  assert.equal(memory.isAcquainted(B), true)
  await hub.capture(() => hub.deliver('group:777', '你好呀', { autoReply: { uid: '30000005', mid: '501' } }))
  assert.equal(memory.isAcquainted('30000005'), true)
  assert.ok(hub.chatLogOf(day()).some((r) => r.who === 'bot' && r.interaction?.includes('30000005')))
  memory.setNoMemory(A, false)
  memory.deletePerson(A)
  assert.ok(hub.chatLogOf(day()).filter((r) => r.uid === A).every((r) => r.forgottenAt))
})

test('面板路由复用人物删除与不再记住接口；前端保留筛选并提供两次确认', async (t) => {
  const f = fixture(t, oldState())
  const routes = new Map()
  let toolFactory
  memoryModule.setup({ core: { hub: f.hub, http: { body: async (req) => req, query: (req) => req } }, dsh: null, config: () => f.cfg, log, context() {}, on() {}, every() {}, tool(fn) { toolFactory = fn }, route: (path, fn) => routes.set(path, fn) })
  const remember = toolFactory({ chat: { kind: 'group', userId: A, chatId: 'group:777' }, sessionId: '' }).find((tool) => tool.name === 'remember')
  assert.equal((await remember.execute({ text: '路过的阿甲喜欢茶' })).ok, false, '模型的记事工具也不能给路过群友建人物记忆')
  assert.equal((await routes.get('/persona/person/no-memory')({ qq: A, enabled: true })).ok, true)
  assert.equal(f.state().profiles[A].noMemory, true)
  assert.equal((await routes.get('/persona/person/delete')({ qq: OWNER })).ok, false)
  assert.equal((await routes.get('/persona/person/delete')({ qq: A })).ok, true)
  assert.equal(f.state().profiles[A], undefined)
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const deleteAction = client.slice(client.indexOf('const forgetPerson ='), client.indexOf('const toggleNoMemory ='))
  assert.equal((deleteAction.match(/confirm\(/g) || []).length, 2)
  for (const label of ['所有群', '所有标签', '所有状态', '不再记住', '删除这个人', '只记住有交集的人']) assert.ok(client.includes(label), label)
})
