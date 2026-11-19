import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTestIdentity } from './helpers/identity.js'

let normalize
let share
let duty
let store
let biliModule

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000a49444154789c6360000002000154a24f6d0000000049454e44ae426082',
  'hex',
)

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-phase2-bili-'))
  ;({ normalize } = await import('../src/core/config.js'))
  share = await import('../src/bili/group-share.js')
  duty = await import('../src/bili/duty.js')
  store = await import('../src/core/store.js')
  biliModule = (await import('../src/modules/bili/index.js')).default
})

const freshShareFile = () => rmSync(store.dataDir('bili-group-share.json'), { force: true })
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

test('PR-2B: config.normalize 保留飞书与规范平台群分享地址，过滤非法地址', () => {
  const cfg = normalize({
    bili: {
      enabled: true,
      groupShare: {
        enabled: true,
        groupId: 'feishu:group:oc_main123',
        groups: ['20000002', 'qq:group:30000003', 'feishu:private:ou_wrong_kind', 'bad:::id'],
      },
    },
  })
  assert.equal(cfg.bili.groupShare.groupId, 'feishu:group:oc_main123')
  assert.deepEqual(cfg.bili.groupShare.groups, ['20000002', 'qq:group:30000003'])
})

test('PR-2B: bili.sendShot 接受飞书会话并拒绝 system 会话（无 QQ 专属拦截文案）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-shot-feishu-'))
  const prev = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  try {
    mkdirSync(join(dir, 'bili-shots'), { recursive: true })
    const jpgPath = join(dir, 'bili-shots', 'abcdef123456.jpg')
    writeFileSync(jpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    writeFileSync(join(dir, 'bili-shots', 'index.json'), JSON.stringify({
      items: [{ file: 'abcdef123456.jpg', bvid: 'BV1feishu01', title: '飞书测试视频', sec: 12, at: Date.now(), note: '' }],
    }))
    const images = []
    const cfg = normalize({ enabled: true, dryRun: false, bili: { enabled: true } })
    const identity = makeTestIdentity('ou_owner', 'feishu')
    const b = duty.createBili({
      getConfig: () => cfg,
      hub: {
        sendImage: async (chatId, file) => {
          images.push({ chatId, file })
          return { messageId: 'om_shot_1' }
        },
      },
      identity,
      routeOwner: identity.routeOwner,
      log: { info() {}, warn() {}, debug() {} },
    })

    const bad = await b.sendShot({ chatId: 'system:bili' })
    assert.equal(bad.ok, false)
    assert.doesNotMatch(bad.message, /QQ 会话/)

    const ok = await b.sendShot({ chatId: 'feishu:group:oc_chat1', query: '飞书' })
    assert.equal(ok.ok, true, ok.message)
    assert.equal(ok.sent, true)
    assert.equal(images[0].chatId, 'feishu:group:oc_chat1')
  } finally {
    if (prev === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prev
  }
})

test('PR-2B: groupShare 兼容飞书群发送 + 旧数字 groupId 按 qq:group:<id> 归一与 sameChat + 坏条目记警跳过', async () => {
  freshShareFile()
  const warnings = []
  const sent = []
  const images = []
  // 先写一份含旧纯数字 groupId + 一条坏 groupId + 一条非对象脏数据的历史文件
  writeFileSync(store.dataDir('bili-group-share.json'), JSON.stringify({
    day: new Date().toISOString().slice(0, 10),
    sentToday: 0,
    nextId: 10,
    items: [
      { id: 1, at: Date.now(), bvid: 'BV1legacy001', title: '老记录', text: '旧格式群号', shotIds: [], groupId: '20000002', state: 'pending', decidedAt: 0 },
      { id: 2, at: Date.now(), bvid: 'BV1bad000002', title: '坏地址', text: '应跳过', shotIds: [], groupId: 'bad:::broken', state: 'pending', decidedAt: 0 },
      { id: 3, at: Date.now(), bvid: 'BV1priv00003', title: '误配私聊', text: '应跳过', shotIds: [], groupId: 'feishu:private:ou_1', state: 'pending', decidedAt: 0 },
      'corrupt-entry',
    ],
  }))

  // 新配置写成规范地址 qq:group:20000002：必须认出旧的 '20000002' 是同一个群，而不是报「别的群待批没回」
  const cfgCompat = normalize({
    enabled: true, dryRun: false, ownerQQ: '10000001',
    bili: { enabled: true, cookie: 'SESSDATA=x', groupShare: { enabled: true, groupId: 'qq:group:20000002', queueLimit: 5 } },
  })
  const qqIdentity = makeTestIdentity('10000001', 'qq')
  const gsCompat = share.createGroupShare({
    getConfig: () => cfgCompat,
    hub: { sendText: async (chatId, text) => { sent.push({ chatId, text }); return { messageId: 'm1' } } },
    identity: qqIdentity,
    routeOwner: qqIdentity.routeOwner,
    log: { info() {}, warn: (m) => warnings.push(String(m)), debug() {} },
    think: async (kind) => (kind === 'ask' ? '这条能发吗？' : '发啦'),
  })
  const pending = gsCompat.pending()
  assert.equal(pending.length, 1, '坏条目应跳过，不阻断正常待批恢复')
  assert.equal(pending[0].groupId, 'qq:group:20000002', '读时按 qq:group:<id> 归一')
  assert.ok(warnings.some((w) => w.includes('无效群地址')), '坏条目应记警告')

  const subCompat = await gsCompat.submit([{ bvid: 'BV1new000004', title: '新条', text: 'sameChat 匹配同一个群' }])
  assert.equal(subCompat.ok, true, subCompat.why)

  // 纯飞书群分享闭环：飞书主人审批 → 截图和文字发送到飞书群（不带 group: 前缀错误拼串）
  freshShareFile()
  sent.length = 0
  const fsIdentity = makeTestIdentity('ou_owner_fs', 'feishu')
  const cfgFeishu = normalize({
    enabled: true, dryRun: false,
    bili: { enabled: true, cookie: 'SESSDATA=x', groupShare: { enabled: true, groupId: 'feishu:group:oc_fs1', groups: ['feishu:group:oc_fs2'] } },
  })
  const gsFeishu = share.createGroupShare({
    getConfig: () => cfgFeishu,
    hub: {
      sendText: async (chatId, text) => { sent.push({ chatId, text }); return { messageId: 'om_txt' } },
      sendImage: async (chatId, file) => { images.push({ chatId, file }); return { messageId: 'om_img' } },
      groupNames: new Map([['feishu:group:oc_fs1', '飞书大群']]),
    },
    identity: fsIdentity,
    routeOwner: fsIdentity.routeOwner,
    log: { info() {}, warn() {}, debug() {} },
    think: async (kind) => (kind === 'ask' ? '飞书发吗' : kind === 'receipt' ? '发过去啦' : '{"action":"none","items":[],"groups":[]}'),
    captureShot: async () => '/tmp/shots/fs.jpg',
  })
  const rSub = await gsFeishu.submit([{ bvid: 'BV1fs0000001', title: '飞书条', text: '好看' }])
  assert.equal(rSub.ok, true)
  assert.equal(sent[0].chatId, 'feishu:private:ou_owner_fs')
  sent.length = 0
  assert.equal(await gsFeishu.handleReply('feishu:private:ou_owner_fs', 'ou_owner_fs', '发 1'), true)
  await tick()
  assert.deepEqual(images.map((x) => x.chatId), ['feishu:group:oc_fs1'])
  assert.equal(sent.some((x) => x.chatId === 'feishu:group:oc_fs1' && x.text.includes('好看')), true)
  assert.equal(sent.some((x) => x.chatId === 'feishu:private:ou_owner_fs'), true)
})

test('PR-2B: bili_set_avatar(last) 使用真实 (chatId, seg, opts) 签名拉网关字节；含端到端 hub.mediaBytes 与 sendShot null 回执', async (t) => {
  const cfg = normalize({ enabled: true, dryRun: true, bili: { enabled: true } })
  const identity = makeTestIdentity('ou_owner_fs', 'feishu')
  const builders = []
  let fetchedArgs = null
  const recentImgSeg = { type: 'image', data: { file: 'img_v2_feishu_abc' } }
  const hub = {
    turnSendersAllOwner: () => true,
    chatOfSession: () => 'feishu:private:ou_owner_fs',
    recentMedia: () => [{ seg: recentImgSeg, userId: 'ou_owner_fs', sticker: false }],
    mediaBytes: async (chatId, seg, opts) => {
      fetchedArgs = { chatId, seg, opts }
      return PNG
    },
    groupName: async () => '飞书群',
  }
  biliModule.setup({
    config: () => cfg,
    lazy: () => null,
    log: { info() {}, debug() {}, warn() {} },
    on() {},
    tool: (fn) => builders.push(fn),
    every() {},
    route() {},
    dataDir: (...parts) => store.dataDir('modules-data', 'bili', ...parts),
    onDispose() {},
    core: { hub, identity, routeOwner: identity.routeOwner },
  })
  const chat = { chatId: 'feishu:private:ou_owner_fs', platform: 'feishu', kind: 'private', userId: 'ou_owner_fs' }
  const avatarTool = builders[1]({ chat, sessionId: 's-fs' }).find((t) => t.name === 'bili_set_avatar')
  assert.ok(avatarTool)
  const r = await avatarTool.execute({ image: 'last' })
  assert.equal(r.ok, true, r.message)
  assert.match(r.message, /试运行/)
  assert.equal(fetchedArgs?.chatId, 'feishu:private:ou_owner_fs')
  assert.deepEqual(fetchedArgs?.seg, recentImgSeg)
  assert.equal(fetchedArgs?.opts?.maxBytes, 10 * 1024 * 1024)

  // 真实 createHub.mediaBytes 端到端（入站只有 mediaId、无 url、不碰 onebot，走 gateway.fetch）
  const { createHub } = await import('../src/chat/hub.js')
  const { createFakeDsh } = await import('./helpers/fake-dsh.js')
  const fake = createFakeDsh({ brain: async () => 'ok' })
  const fetchCalls = []
  const realHub = createHub({
    dsh: fake.ctx,
    getConfig: () => normalize({ enabled: true, dryRun: true, allow: { private: ['feishu:private:ou_owner_fs'], groups: [] } }),
    identity,
    routeOwner: identity.routeOwner,
    defaultPlatform: 'qq',
    gateway: {
      selfAccount: () => 'cli_bot',
      caps: () => ({ image: true, file: true }),
      features: () => ({ 'media.fetch': true }),
      fetch: async (cid, req) => {
        fetchCalls.push({ cid, req })
        return { bytes: PNG }
      },
      send: async () => ({ messageId: 'm1' }),
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    onebot: null,
  })
  t.after(() => { realHub.dispose(); fake.dispose() })
  await realHub.onGatewayMessage({
    id: 'evt-gw-last',
    platform: 'feishu',
    instance: 'feishu',
    chatId: 'feishu:private:ou_owner_fs',
    kind: 'private',
    chat: { id: 'ou_owner_fs', kind: 'private', name: '主人' },
    sender: { account: 'ou_owner_fs', name: '主人', isOwner: true, person: identity.owner() },
    messageId: 'om_gw_only_1',
    at: Date.now(),
    text: '',
    parts: [{ type: 'image', media: { id: 'img_gw_only_99', mime: 'image/png' } }],
  })
  const realBuilders = []
  biliModule.setup({
    config: () => cfg,
    lazy: () => null,
    log: { info() {}, debug() {}, warn() {} },
    on() {},
    tool: (fn) => realBuilders.push(fn),
    every() {},
    route() {},
    dataDir: (...parts) => store.dataDir('modules-data', 'bili-real', ...parts),
    onDispose() {},
    core: { hub: { ...realHub, turnSendersAllOwner: () => true }, identity, routeOwner: identity.routeOwner },
  })
  const realAvatar = realBuilders[1]({ chat, sessionId: 's-real' }).find((t) => t.name === 'bili_set_avatar')
  const fetchesBefore = fetchCalls.length
  const rReal = await realAvatar.execute({ image: 'last' })
  assert.equal(rReal.ok, true, rReal.message)
  assert.equal(fetchCalls.length - fetchesBefore, 1)
  assert.equal(fetchCalls.at(-1).req.media.id, 'img_gw_only_99')

  // P2-2: sendShot 对 null / '' / queued 回执判失败
  const shotsDir = store.dataDir('bili-shots')
  mkdirSync(shotsDir, { recursive: true })
  writeFileSync(join(shotsDir, '0123456789ab.jpg'), PNG)
  writeFileSync(join(shotsDir, 'index.json'), JSON.stringify({ items: [{ file: '0123456789ab.jpg', title: '测试截图', bvid: 'BV1xx', sec: 10, note: '' }] }))
  for (const ret of [{ message_id: null }, { message_id: '' }, { queued: true }]) {
    const biliDuty = duty.createBili({
      getConfig: () => normalize({ enabled: true, dryRun: false, bili: { enabled: true } }),
      hub: { sendImage: async () => ret, chatLogOf: () => [], logChat() {} },
      identity,
      routeOwner: identity.routeOwner,
      log: { info() {}, warn() {}, debug() {} },
    })
    const resShot = await biliDuty.sendShot({ chatId: 'feishu:private:ou_owner_fs' })
    assert.equal(resShot.ok, false, `回执 ${JSON.stringify(ret)} 不应算发送成功`)
    assert.equal(resShot.sent, false)
  }
})
