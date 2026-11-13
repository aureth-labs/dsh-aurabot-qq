// 群分享待批：认编号、攒待批、主人回「发 1/发全部/不发」才真发、每日上限、过期、去重。
// 全程假 hub：sendText 只记账，不碰真网关。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let share
let store
let normalize
let duty

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-group-share-'))
  share = await import('../src/bili/group-share.js')
  store = await import('../src/core/store.js')
  ;({ normalize } = await import('../src/core/config.js'))
  duty = await import('../src/bili/duty.js')
})

const file = () => store.dataDir('bili-group-share.json')
const fresh = () => rmSync(file(), { force: true })
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const GROUP = '20000002'
const OWNER = '10000001'

function setup({ over = {}, top = {}, sendResult = { message_id: 1 }, say = '', understand = '', receipt = '', images: shotFiles = {} } = {}) {
  const sent = []
  const images = []
  const cfg = normalize({
    enabled: true, dryRun: false, ownerQQ: OWNER,
    bili: { enabled: true, cookie: 'SESSDATA=x; bili_jct=y', groupShare: { enabled: true, groupId: GROUP, ...over } },
    ...top,
  })
  const hub = {
    sendText: async (chatId, text) => { sent.push({ chatId, text }); return typeof sendResult === 'function' ? sendResult(chatId) : sendResult },
    sendImage: async (chatId, file) => { images.push({ chatId, file }); return { message_id: 9 } },
    groupNames: new Map(),
  }
  const log = { info() {}, warn() {}, debug() {} }
  const gs = share.createGroupShare({
    getConfig: () => cfg, hub, log,
    // 话术和理解都注掉：测试只验流程，不看模型文笔
    think: async (kind) => (kind === 'ask'
      ? (say || '看到这个挺有意思，想发到群里给大家看看，可以吗？')
      : kind === 'receipt'
        ? (typeof receipt === 'function' ? receipt() : (receipt || '发到群啦，群里这下热闹了'))
        : (typeof understand === 'function' ? understand() : (understand || '{"action":"none","items":[],"groups":[]}'))),
    shotPathOf: (name) => (name ? `/tmp/shots/${name}` : ''),
    captureShot: async (bvid) => shotFiles[bvid] || '',
  })
  return { gs, cfg, sent, images, hub, log }
}

test('回复解析：只认短命令，正常聊天和超长句不碰', () => {
  assert.deepEqual(share.parseDecision('发1'), { action: 'send', index: 1 })
  assert.deepEqual(share.parseDecision('发 #2'), { action: 'send', index: 2 })
  assert.deepEqual(share.parseDecision('发送 12'), { action: 'send', index: 12 })
  assert.deepEqual(share.parseDecision('发全部'), { action: 'send', index: 0, all: true })
  assert.deepEqual(share.parseDecision('不发1'), { action: 'skip', index: 1 })
  assert.deepEqual(share.parseDecision('别发 2'), { action: 'skip', index: 2 })
  assert.deepEqual(share.parseDecision('不发全部'), { action: 'skip', index: 0, all: true })
  assert.deepEqual(share.parseDecision('不发'), { action: 'skip', index: 0, all: true })
  assert.deepEqual(share.parseDecision('发'), { action: 'send', index: 0 })
  assert.equal(share.parseDecision('发0'), null, '编号从 1 开始')
  // 这些词 DSH 工具授权中继在用（approval.js），群分享别抢
  for (const w of ['批准', '同意', '允许', '拒绝', '取消', '批准 1']) assert.equal(share.parseDecision(w), null, w)
  assert.equal(share.parseDecision('今天吃什么'), null)
  assert.equal(share.parseDecision('这个视频真好笑我笑了半天哈哈哈哈'), null, '超 12 字当正常聊天')
  assert.equal(share.parseDecision(''), null)
})

test('攒待批：问主人一次，编号从 1 开始；同一条视频不重复问', async () => {
  fresh()
  const { gs, sent } = setup({ over: { queueLimit: 5 } })
  const r = await gs.submit([{ bvid: 'BV1aaaaaaa1', title: '米饭大赛', text: '群友快看这个' }])
  assert.deepEqual(r, { ok: true, n: 1 })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, `private:${OWNER}`)
  assert.equal(sent[0].text, '看到这个挺有意思，想发到群里给大家看看，可以吗？', '问话走模型（测试里注的是固定句）')
  assert.equal(gs.pending().length, 1)
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 0, '攒的时候一条都不发群')

  const again = await gs.submit([{ bvid: 'BV1aaaaaaa1', title: '米饭大赛', text: '再说一次' }])
  assert.equal(again.ok, false)
  assert.match(again.why, /没有能攒的新条目/)
  assert.equal(sent.length, 1, '重复的不再问一遍')
  assert.equal(gs.pending().length, 1)
})

test('试运行 / 没开关 / 没群号 / 总开关关着 / 额度用完：一律不攒', async () => {
  fresh()
  const dry = setup({ top: { dryRun: true } })
  assert.match((await dry.gs.submit([{ bvid: 'BV1a', title: 'A', text: 'a' }])).why, /试运行/)
  const off = setup({ over: { enabled: false } })
  assert.match((await off.gs.submit([{ bvid: 'BV1a', title: 'A', text: 'a' }])).why, /群分享没开/)
  const noGroup = setup({ over: { groupId: '' } })
  assert.match((await noGroup.gs.submit([{ bvid: 'BV1a', title: 'A', text: 'a' }])).why, /群分享没开/)
  const allOff = setup({ top: { enabled: false } })
  assert.match((await allOff.gs.submit([{ bvid: 'BV1a', title: 'A', text: 'a' }])).why, /总开关关着/)
  const quota = setup({ over: { dailyLimit: 0 } })
  assert.match((await quota.gs.submit([{ bvid: 'BV1a', title: 'A', text: 'a' }])).why, /今天已经发够 0 条/)
  for (const s of [dry, off, noGroup, allOff, quota]) {
    assert.equal(s.sent.length, 0, '不攒就不问主人')
    assert.equal(s.gs.pending().length, 0)
  }
})

test('回执模型没话说：退回模板，主人照样知道发了没有', async () => {
  fresh()
  const { gs, sent } = setup({ receipt: ' ' })
  await gs.submit([{ bvid: 'BV1ccccccc3', title: '深夜食堂', text: '看完饿了' }])
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 1)
  assert.equal(sent.at(-1).chatId, `private:${OWNER}`)
  assert.match(sent.at(-1).text, /发到群了（1 条）/, '模型空手时用模板兜底')
})

test('回「发 2」：只发那一条、带链接、给主人回执、当天计数 +1', async () => {
  fresh()
  const { gs, sent } = setup({ over: { queueLimit: 5 } })
  await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: '米饭大赛', text: '群友快看' },
    { bvid: 'BV1bbbbbbb2', title: '猫猫做饭', text: '猫猫好会' },
  ])
  assert.equal(gs.pending().length, 2)
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 2'), true)
  await tick()
  const toGroup = sent.filter((x) => x.chatId === `group:${GROUP}`)
  assert.equal(toGroup.length, 1)
  assert.equal(toGroup[0].text, '猫猫好会\nhttps://www.bilibili.com/video/BV1bbbbbbb2')
  assert.equal(gs.pending().length, 1, '发掉的那条不再是待批')
  const receipt = sent.at(-1)
  assert.equal(receipt.chatId, `private:${OWNER}`)
  assert.equal(receipt.text, '发到群啦，群里这下热闹了', '回执是模型写的，不是模板')
  // 编号越界：不重发，只提醒现在只剩几条
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 2'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 0)
  assert.match(sent.at(-1).text, /第 2 条(已经不在了|没有)/)
})

test('「不发 1」丢掉那一条，一条也不发群', async () => {
  fresh()
  const { gs, sent } = setup()
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: '米饭大赛', text: '群友快看' }])
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '不发 1'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 0)
  assert.equal(gs.pending().length, 0)
  assert.match(sent.at(-1).text, /没发 1 条/)
})

test('「发全部」碰到每日上限就停，剩下的还留着待批', async () => {
  fresh()
  const { gs, sent } = setup({ over: { dailyLimit: 1, queueLimit: 5 } })
  await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
  ])
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发全部'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 1, '只发一条')
  assert.equal(gs.pending().length, 1, '剩下的明天再说')
  assert.match(sent.at(-1).text, /还有 1 条没发，今天 1 条的额度用完了/)
})

test('裸「发」：不管几条待批都只发第一条，不刷屏', async () => {
  fresh()
  const one = setup()
  await one.gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  one.sent.length = 0
  assert.equal(await one.gs.handleReply(`private:${OWNER}`, OWNER, '发'), true)
  await tick()
  assert.equal(one.sent.filter((x) => x.chatId === `group:${GROUP}`).length, 1)

  fresh()
  const two = setup({ over: { queueLimit: 5 } })
  await two.gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
  ])
  two.sent.length = 0
  assert.equal(await two.gs.handleReply(`private:${OWNER}`, OWNER, '发'), true)
  await tick()
  const toGroup = two.sent.filter((x) => x.chatId === `group:${GROUP}`)
  assert.equal(toGroup.length, 1, '只发一条')
  assert.match(toGroup[0].text, /BV1aaaaaaa1/, '发最早那一条')
  assert.equal(two.gs.pending().length, 1, '另一条还留着')
})

test('说「都发」才把剩下的都发出去', async () => {
  fresh()
  const { gs, sent } = setup({ over: { queueLimit: 5 } })
  await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
  ])
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '都发'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 2)
})

test('模型没点名发哪条：也只发第一条', async () => {
  fresh()
  const { gs, sent } = setup({ over: { queueLimit: 5 }, understand: '{"action":"send","items":[],"groups":[]}' })
  await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
  ])
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '这个挺有意思，发吧'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 1)
})

test('只认主人私聊：别人、群里、长句、没待批时都不截流', async () => {
  fresh()
  const { gs, sent } = setup()
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), false, '没待批就不管')
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  sent.length = 0
  assert.equal(await gs.handleReply('private:99999999', '99999999', '发 1'), false, '别人说发 1 不算')
  assert.equal(await gs.handleReply(`group:${GROUP}`, OWNER, '发 1'), false, '群里说发 1 不算数')
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '这个视频真好笑我笑了一下午'), false)
  assert.equal(sent.length, 0)
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 1)
})

test('过期待批自动作废：不发、不吵主人', async () => {
  fresh()
  const { gs, sent } = setup({ over: { pendingTtlHours: 1 } })
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  sent.length = 0
  const s = store.readJson(file(), null)
  s.items[0].at = Date.now() - 2 * 3600_000
  store.writeJson(file(), s)
  assert.equal(gs.expire(), 1)
  assert.equal(gs.pending().length, 0)
  assert.equal(sent.length, 0, '过期不发也不提醒')
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), false, '过期后再回也没用了')
  assert.equal(gs.expire(), 0, '不重复计数')
})

test('发群失败（hub 返回空）记 failed，不占当天额度', async () => {
  fresh()
  const { gs, sent } = setup({ sendResult: (chatId) => (chatId.startsWith('group:') ? null : { message_id: 1 }) })
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
  await tick()
  assert.equal(gs.pending().length, 0)
  const s = store.readJson(file(), null)
  assert.equal(s.items.find((x) => x.bvid === 'BV1aaaaaaa1').state, 'failed')
  assert.equal(s.sentToday, 0, '没真发出去就不算额度')
  assert.match(sent.at(-1).text, /1 条没确认发出去/)
})

test('刷一轮：模型给了 shareGroup 就攒成待批，现场不往群里发', async () => {
  fresh()
  rmSync(store.dataDir('bili.json'), { force: true })
  const sent = []
  const posted = []
  const fakeApi = {
    nav: async () => ({ isLogin: true }),
    search: async (kw) => [
      { bvid: 'BV1aaaaaaa1', aid: 1, title: kw + ' 视频一', play: 20000, pubdate: Date.now() },
      { bvid: 'BV1bbbbbbb2', aid: 2, title: kw + ' 视频二', play: 30000, pubdate: Date.now() },
    ],
    popular: async () => [],
    view: async ({ bvid }) => ({ bvid, aid: bvid === 'BV1bbbbbbb2' ? 2 : 1, cid: 9, title: bvid === 'BV1bbbbbbb2' ? '猫猫做饭' : '米饭大赛', author: 'UP主', play: 20000, desc: '简介' }),
    subtitle: async () => '',
    comments: async () => [],
    postComment: async (aid, message) => { posted.push({ aid, message }); return { rpid: 1, missed: [] } },
    likeVideo: async () => {},
  }
  const hub = {
    runSystemTurn: async (name, title, prompt) => {
      if (prompt.includes('挑 3 个')) return '["米饭","猫咪"]'
      if (prompt.includes('看完说说你的想法')) {
        assert.match(prompt, /"shareGroup"/, '群分享开着时提示词里才有这个字段')
        return JSON.stringify([
          { i: 1, feeling: '米饭好香', comment: '', share: '', shareGroup: '群友快看这个米饭大赛', remember: '' },
          { i: 2, feeling: '猫好可爱', comment: '', share: '', shareGroup: '', remember: '' },
        ])
      }
      return ''
    },
    sendText: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 1 } },
    logChat: () => {},
  }
  const memory = { list: () => [], recentEvents: () => [], addEvent: () => {}, add: () => {} }
  const cfg = normalize({
    enabled: true, dryRun: false, ownerQQ: OWNER,
    bili: { enabled: true, cookie: 'SESSDATA=x; bili_jct=y', perRun: 2, groupShare: { enabled: true, groupId: GROUP } },
  })
  const log = { info() {}, warn() {}, debug() {} }
  const gs = share.createGroupShare({ getConfig: () => cfg, hub, log })
  const b = duty.createBili({ getConfig: () => cfg, hub, memory, log, api: fakeApi, groupShare: gs })
  const r = await b.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.awaitingGroup, 1)
  assert.match(r.message, /1 条等你批准发群/)
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 0, '刷的时候不直接发群')
  const ask = sent.find((x) => x.chatId === `private:${OWNER}` && /想发到/.test(x.text))
  assert.ok(ask, '攒完要问主人一次')
  assert.match(ask.text, /米饭大赛/)
  assert.equal(gs.pending().length, 1)

  // 主人回「发 1」才真发
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
  await tick()
  const toGroup = sent.filter((x) => x.chatId === `group:${GROUP}`)
  assert.equal(toGroup.length, 1)
  assert.match(toGroup[0].text, /群友快看这个米饭大赛\nhttps:\/\/www\.bilibili\.com\/video\/BV1aaaaaaa1/)
})

test('群分享关着时提示词里不塞 shareGroup，也不攒', async () => {
  fresh()
  rmSync(store.dataDir('bili.json'), { force: true })
  const sent = []
  const fakeApi = {
    nav: async () => ({ isLogin: true }),
    search: async (kw) => [{ bvid: 'BV1aaaaaaa1', aid: 1, title: kw + ' 视频', play: 20000, pubdate: Date.now() }],
    popular: async () => [],
    view: async ({ bvid }) => ({ bvid, aid: 1, cid: 9, title: '米饭大赛', author: 'UP主', play: 20000, desc: '简介' }),
    subtitle: async () => '',
    comments: async () => [],
    postComment: async () => ({ rpid: 1, missed: [] }),
    likeVideo: async () => {},
  }
  const hub = {
    runSystemTurn: async (name, title, prompt) => {
      if (prompt.includes('挑 3 个')) return '["米饭"]'
      if (prompt.includes('看完说说你的想法')) {
        assert.doesNotMatch(prompt, /"shareGroup"/)
        return JSON.stringify([{ i: 1, feeling: '好香', comment: '', share: '', shareGroup: '不该被用到', remember: '' }])
      }
      return ''
    },
    sendText: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 1 } },
    logChat: () => {},
  }
  const memory = { list: () => [], recentEvents: () => [], addEvent: () => {}, add: () => {} }
  const cfg = normalize({
    enabled: true, dryRun: false, ownerQQ: OWNER,
    bili: { enabled: true, cookie: 'SESSDATA=x; bili_jct=y', perRun: 1, groupShare: { enabled: false, groupId: GROUP } },
  })
  const log = { info() {}, warn() {}, debug() {} }
  const gs = share.createGroupShare({ getConfig: () => cfg, hub, log })
  const b = duty.createBili({ getConfig: () => cfg, hub, memory, log, api: fakeApi, groupShare: gs })
  const r = await b.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.awaitingGroup, 0)
  assert.equal(gs.pending().length, 0)
  assert.equal(sent.filter((x) => /【群分享待批】/.test(x.text)).length, 0)
})

test('模拟返回（sim-*）和排队补发都不算发出去：不占额度、回执说没确认', async () => {
  for (const sendResult of [{ message_id: 'sim-3' }, { queued: true, queuedId: 'q1' }]) {
    fresh()
    const { gs, sent } = setup({ sendResult: (chatId) => (chatId.startsWith('group:') ? sendResult : { message_id: 1 }) })
    await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
    sent.length = 0
    assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
    await tick()
    const s = store.readJson(file(), null)
    assert.equal(s.items.find((x) => x.bvid === 'BV1aaaaaaa1').state, 'failed')
    assert.equal(s.sentToday, 0, '没真发出去就不算额度')
    assert.match(sent.at(-1).text, /没确认发出去/)
  }
})

test('过期兜底：tick 没跑过，主人回「发 1」也不可能发过期的那条', async () => {
  fresh()
  const { gs, sent } = setup({ over: { pendingTtlHours: 1 } })
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  const s = store.readJson(file(), null)
  s.items[0].at = Date.now() - 2 * 3600_000
  store.writeJson(file(), s)
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), false, '过期的不接命令')
  await tick()
  assert.equal(sent.length, 0, '一条都不发、也不回执')
  assert.equal(gs.pending().length, 0)
  assert.equal(store.readJson(file(), null).items[0].state, 'expired')
})

test('已有别的群的待批时不攒新的，避免一句话里混两个群号', async () => {
  fresh()
  const a = setup()
  await a.gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  // 同一个数据文件换群号再攒
  const b = setup({ over: { groupId: '30000003' } })
  const r = await b.gs.submit([{ bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' }])
  assert.equal(r.ok, false)
  assert.match(r.why, /别的群/)
  assert.equal(b.gs.pending().length, 1)
})

test('审批消息发不出去（网关断线 / 试运行模拟）：这批直接作废，不留没人知道的待批', async () => {
  for (const sendResult of [null, { message_id: 'sim-1' }]) {
    fresh()
    const { gs } = setup({ sendResult })
    const r = await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
    assert.equal(r.ok, false)
    assert.match(r.why, /审批消息没发出去/)
    assert.equal(gs.pending().length, 0, '不能留 pending')
    assert.equal(store.readJson(file(), null).items[0].state, 'failed')
  }
})

test('问完之后有条目过期：编号跟着当时的快照走，不会拿新条目顶上去', async () => {
  fresh()
  const { gs, sent } = setup({ over: { pendingTtlHours: 1, queueLimit: 5 } })
  await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
  ])
  const s = store.readJson(file(), null)
  s.items.find((x) => x.title === 'A').at = Date.now() - 2 * 3600_000
  store.writeJson(file(), s)
  sent.length = 0
  // 第 1 条已过期：回「发 1」不能把（现在排在首位的）B 发出去
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId.startsWith('group:')).length, 0)
  assert.match(sent.at(-1).text, /第 1 条已经不在了/)
  // 第 2 条还在：照发 B
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 2'), true)
  await tick()
  const toGroup = sent.filter((x) => x.chatId.startsWith('group:'))
  assert.equal(toGroup.length, 1)
  assert.match(toGroup[0].text, /BV1bbbbbbb2/)
})

test('主人连发两次「发 1」：只发一条，额度只扣一次', async () => {
  fresh()
  const { gs, sent } = setup({ over: { queueLimit: 5 } })
  await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
  ])
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true, '第二条命令也认，但会被链吃掉')
  await tick()
  assert.equal(sent.filter((x) => x.chatId.startsWith('group:')).length, 1)
  assert.equal(store.readJson(file(), null).sentToday, 1)
  assert.equal(gs.pending().length, 1, '另一条还在等')
})

test('发全部碰到额度：回执说清楚还剩几条（不是只说 1 条）', async () => {
  fresh()
  const { gs, sent } = setup({ over: { dailyLimit: 1, queueLimit: 5 } })
  await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
    { bvid: 'BV1ccccccc3', title: 'C', text: 'c' },
  ])
  sent.length = 0
  gs.handleReply(`private:${OWNER}`, OWNER, '发全部')
  await tick()
  assert.equal(sent.filter((x) => x.chatId.startsWith('group:')).length, 1)
  assert.match(sent.at(-1).text, /还有 2 条没发/)
  assert.equal(gs.pending().length, 2, '没发出去的还在待批里')
})

test('默认一次只攒一条：同批里多出来的当场不攒，主人回完才轮到下一条', async () => {
  fresh()
  const { gs } = setup()
  const r = await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
    { bvid: 'BV1ccccccc3', title: 'C', text: 'c' },
  ])
  assert.deepEqual(r, { ok: true, n: 1 }, '默认 queueLimit=1：一次只攒一条')
  assert.equal(gs.pending().length, 1)
  const again = await gs.submit([{ bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' }])
  assert.equal(again.ok, false)
  assert.match(again.why, /待批的还没回/)
})

test('中间那条过期：后面的编号不往前挪，「发 2」不会改成发第 3 条', async () => {
  fresh()
  const { gs, sent } = setup({ over: { pendingTtlHours: 1, queueLimit: 5 } })
  await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' },
    { bvid: 'BV1ccccccc3', title: 'C', text: 'c' },
  ])
  const s = store.readJson(file(), null)
  s.items.find((x) => x.title === 'B').at = Date.now() - 2 * 3600_000
  store.writeJson(file(), s)
  sent.length = 0
  // 问的是 1.A 2.B 3.C，B 过期后 2 号格子必须还空着
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 2'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId.startsWith('group:')).length, 0, '2 号过期了就不能拿 3 号顶')
  assert.match(sent.at(-1).text, /第 2 条已经不在了/)
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 3'), true)
  await tick()
  const toGroup = sent.filter((x) => x.chatId.startsWith('group:'))
  assert.equal(toGroup.length, 1)
  assert.match(toGroup[0].text, /BV1ccccccc3/, '3 号还是 C')
})

test('问过的那批全过期了：回「发」不拿之后新攒的顶替', async () => {
  fresh()
  const { gs, sent } = setup({ over: { pendingTtlHours: 1, queueLimit: 5 } })
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  // A 问过之后过期了，紧接着又攒进来一条 B（还没问过他）
  const s = store.readJson(file(), null)
  s.items[0].at = Date.now() - 2 * 3600_000
  s.items.push({ id: s.nextId++, at: Date.now(), bvid: 'BV1bbbbbbb2', title: 'B', text: 'b', shotIds: [], groupId: GROUP, state: 'pending', decidedAt: 0 })
  store.writeJson(file(), s)
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发'), false, '问过的那条没了就不发，别拿没问过的顶')
  await tick()
  assert.equal(sent.length, 0)
})

test('同一批里同一条视频只攒一次', async () => {
  fresh()
  const { gs } = setup()
  const r = await gs.submit([
    { bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' },
    { bvid: 'BV1aaaaaaa1', title: 'A2', text: 'a2' },
  ])
  assert.equal(r.n, 1)
  assert.equal(gs.pending().length, 1)
})

test('parsePlan：从模型带前后文的回答里抠 JSON，乱七八糟就当没看懂', () => {
  assert.deepEqual(share.parsePlan('好的：{"action":"send","items":[1,2],"groups":["3"]} 就这些'), { action: 'send', items: [1, 2], groups: ['3'] })
  assert.deepEqual(share.parsePlan('{"action":"none"}'), { action: 'none', items: [], groups: [] })
  assert.equal(share.parsePlan('我懂了，发吧'), null)
  assert.equal(share.parsePlan('{"action":"explode"}'), null)
  assert.equal(share.parsePlan(''), null)
})

test('自然语言：模型听懂了就按它的意思发（默认群 + 点名的群都发）', async () => {
  fresh()
  const { gs, sent } = setup({ over: { groups: ['30000003'] }, understand: '{"action":"send","items":[],"groups":["30000003"]}' })
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '那就发吧，隔壁群也来一份'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 1)
  assert.equal(sent.filter((x) => x.chatId === 'group:30000003').length, 1, '点名的群也发')
})

test('模型点名了没授权的群：只发默认群，回执说清楚哪个群没发', async () => {
  fresh()
  const { gs, sent } = setup({ understand: '{"action":"send","items":[],"groups":["99999999"]}' })
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发吧，再发到那个大群'), true)
  await tick()
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 1)
  assert.equal(sent.filter((x) => x.chatId === 'group:99999999').length, 0)
  assert.match(sent.at(-1).text, /没授权，没发：99999999/)
})

test('模型说「跟这事没关系」就交回正常聊天，不吞话', async () => {
  fresh()
  const { gs, sent } = setup({ understand: '{"action":"none"}' })
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '今晚吃啥好呢'), false)
  await tick()
  assert.equal(sent.length, 0)
  assert.equal(gs.pending().length, 1, '待批还在')
})

test('发群带截图：攒的时候有图就先发图再发字', async () => {
  fresh()
  const { gs, sent, images } = setup()
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a', shotIds: ['abcdef123456.jpg'] }])
  sent.length = 0
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
  await tick()
  assert.deepEqual(images.map((x) => [x.chatId, x.file]), [[`group:${GROUP}`, '/tmp/shots/abcdef123456.jpg']])
  assert.equal(sent.filter((x) => x.chatId === `group:${GROUP}`).length, 1)
})

test('没截到图的条目：发群前补一张，补不到就纯文字', async () => {
  fresh()
  const { gs, images } = setup({ images: { BV1aaaaaaa1: '/tmp/shots/fresh.jpg' } })
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: 'A', text: 'a' }])
  assert.equal(await gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
  await tick()
  assert.deepEqual(images.map((x) => x.file), ['/tmp/shots/fresh.jpg'])

  fresh()
  const none = setup()
  await none.gs.submit([{ bvid: 'BV1bbbbbbb2', title: 'B', text: 'b' }])
  assert.equal(await none.gs.handleReply(`private:${OWNER}`, OWNER, '发 1'), true)
  await tick()
  assert.equal(none.images.length, 0, '补不到图就纯文字')
})

test('没注入模型时退回朴素话术（带群名/群号），不至于问不出去', async () => {
  fresh()
  const sent = []
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: OWNER, bili: { enabled: true, cookie: 'x', groupShare: { enabled: true, groupId: GROUP } } })
  const hub = { sendText: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 1 } } }
  const gs = share.createGroupShare({ getConfig: () => cfg, hub, log: { info() {}, warn() {}, debug() {} } })
  await gs.submit([{ bvid: 'BV1aaaaaaa1', title: '米饭大赛', text: '群友快看' }])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /米饭大赛/)
  assert.match(sent[0].text, new RegExp(GROUP))
})
