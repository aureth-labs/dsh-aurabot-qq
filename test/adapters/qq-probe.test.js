// G2 · QQ 平台端 · 能力探测与入站等价的补充用例
//
// 为什么单独一个文件：test/adapters/qq.test.js 覆盖了契约包和基础路径，
// 这里补任务书点名要求、但那边没展开的几项：
//   1. caps 缓存：命中先用缓存、版本变了重探、缓存文件坏了不影响启动
//   2. 探测失败逐项降级（某一项 false、其它项不受影响），且日志里能看到「当前网关不支持 X」
//   3. 探测绝无副作用（不发消息、不改真资料、不动群管理），「一定被拒」的参数形状
//   4. 入站与 src/chat/inbound.js 的 parseMessageEvent 逐字段等价（text / wakeText /
//      mentioned / atOthers / replyId / 图片数 / 表情包数 / 语音数 / 文件列表）
//   5. 错误映射：transport → not-sent、uncertain → unknown、isDefiniteFailure 原样沿用
//   6. SnowLuma 子模块只 import 原文件、不复制
//
// 全部用可注入的假 OneBot client，绝不真连网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runAdapterContract, makeCtx } from '../contract/adapter-kit.js'
import { createQqAdapter } from '../../src/adapters/qq/index.js'
import {
  CAPS_CONSERVATIVE, capsFromProbes, cacheMatchesGateway, classifyProbeError,
  probeGateway, readCapsCache, supportedActions, writeCapsCache, PROBE_TABLE,
} from '../../src/adapters/qq/probe.js'
import { fromOneBotEvent, segmentsToParts, toAdapterEvent, toParts } from '../../src/adapters/qq/inbound.js'
import { buildParts, mediaSource } from '../../src/adapters/qq/outbound.js'
import { toSendError, makeSendError } from '../../src/adapters/qq/errors.js'
import { parseMessageEvent } from '../../src/chat/inbound.js'
import { renderParts } from '../../src/gateway/render.js'

const SELF = '20000002'

// ───────────────────────── 假 OneBot client ─────────────────────────
//
// 形状照 src/onebot/client.js 的对外面：call / start / stop / on / off / isConnected。
// gateway 选项模拟不同网关的脾气：
//   missing: [动作名]  该动作回 retcode 1404「不支持的API」（网关没有这个动作）
//   hang:    [动作名]  该动作一直不返回（探测结果不明 → 必须按不支持处理）
//   app/version         get_version_info 的返回值（决定缓存还认不认）

function makeFakeClient(gateway = {}) {
  const calls = []
  const listeners = { event: new Set(), state: new Set() }
  const missing = new Set(gateway.missing || [])
  const hang = new Set(gateway.hang || [])
  let started = false
  let connected = false
  const failQueue = []

  const client = {
    calls,
    started: () => started,
    isConnected: () => connected,
    state: () => (connected ? 'connected' : started ? 'connecting' : 'stopped'),
    start() {
      started = true
      connected = true
      queueMicrotask(() => { for (const fn of listeners.state) fn('connected') })
    },
    stop() {
      started = false
      connected = false
      for (const fn of listeners.state) fn('stopped')
    },
    on(name, fn) { listeners[name]?.add(fn); return () => listeners[name]?.delete(fn) },
    off(name, fn) { listeners[name]?.delete(fn) },
    push(event) { for (const fn of listeners.event) fn(event) },
    /** 下一次 send_* 按指令失败：'refused' 连不上 / 'timeout' 超时。 */
    failNext(why) { failQueue.push(why) },
    __connect() { connected = true; for (const fn of listeners.state) fn('connected') },
    __disconnect() { connected = false; for (const fn of listeners.state) fn('disconnected', '模拟断线') },
    async call(action, params) {
      calls.push({ action, params })
      if (hang.has(action)) return new Promise(() => {}) // 永不返回
      if (missing.has(action)) {
        throw Object.assign(new Error(`不支持的API：${action}`), { data: { retcode: 1404, message: `不支持的API：${action}` } })
      }
      if ((action === 'send_private_msg' || action === 'send_group_msg') && failQueue.length) {
        const why = failQueue.shift()
        if (why === 'timeout') throw Object.assign(new Error('超时'), { uncertain: true, data: { message: '超时' } })
        throw Object.assign(new Error('连不上 QQ 网关'), { transport: true, data: { message: '连不上 QQ 网关' } })
      }
      return respond(action, params, gateway)
    },
  }
  return client
}

function respond(action, params, gateway = {}) {
  const envelope = (data) => ({ status: 'ok', retcode: 0, data })
  switch (action) {
    case 'get_login_info': return envelope({ user_id: Number(SELF), nickname: '假机器人' })
    case 'get_version_info': return envelope({ app_name: gateway.app || 'SnowLuma', app_version: gateway.version || '2.4.1', protocol_version: 11 })
    case 'get_status': return envelope({ online: true, good: true })
    case 'can_send_image':
    case 'can_send_record': return envelope({ yes: true })
    case 'get_friend_list': return envelope([{ user_id: 10001, nickname: '张三' }])
    case 'get_group_list': return envelope([{ group_id: 7001, group_name: '测试群' }])
    case 'get_group_msg_history':
    case 'get_friend_msg_history': return envelope({ messages: [] })
    case 'get_group_member_list': return envelope([{ user_id: 10001 }])
    case 'get_group_member_info': return envelope({ group_id: 7001, user_id: 10001, role: 'owner' })
    case 'get_forward_msg': return envelope({ messages: [] })
    case 'get_group_file_url': return envelope({ url: 'https://x/f.zip' })
    case 'get_private_file_url': return envelope({ url: 'https://x/f.zip' })
    case 'upload_group_file': return envelope({ file_id: 'gf-1' })
    case 'upload_private_file': return envelope({ file_id: 'pf-1' })
    case 'send_private_msg': return envelope({ message_id: 900 + Number(params.user_id || 0) % 100 })
    case 'send_group_msg': return envelope({ message_id: 800 + Number(params.group_id || 0) % 100 })
    case 'send_poke': return envelope(null)
    case 'set_input_status': return envelope(null)
    case 'delete_msg': return envelope(null)
    case 'set_msg_emoji_like': return envelope(null)
    case 'set_qq_profile':
      // 真网关会先拒掉超长昵称；这里模拟「动作存在但参数不对」
      throw Object.assign(new Error('昵称太长'), { data: { retcode: 100, message: '昵称太长' } })
    case 'set_qq_avatar': throw Object.assign(new Error('图片格式不对'), { data: { retcode: 100, message: '图片格式不对' } })
    case 'set_self_longnick': throw Object.assign(new Error('签名太长'), { data: { retcode: 100, message: '签名太长' } })
    case 'get_qzone_msg_list': return envelope({ total: 0, msglist: [] })
    case 'fetch_custom_face': return envelope([])
    case 'fetch_ptt_text': throw Object.assign(new Error('消息不存在'), { data: { retcode: 100, message: '消息不存在' } })
    case 'fetch_sys_faces': return envelope({ packs: [] })
    case 'get_image':
    case 'get_record': return envelope({ file: '/tmp/a.bin' })
    case 'get_stranger_info': return envelope({ user_id: 1, nickname: '路人' })
    case 'get_group_info': return envelope({ group_id: 7001, group_name: '测试群' })
    case 'get_doubt_friends_add_request': return envelope([])
    case 'get_msg': throw Object.assign(new Error('消息不存在'), { data: { retcode: 100, message: '消息不存在' } })
    default: return envelope(null)
  }
}

/** 内存假 fs（caps.json 不落真盘）：形状与 node:fs 用到的四个函数一致。 */
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    existsSync: (p) => files.has(String(p)),
    readFileSync: (p) => {
      if (!files.has(String(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files.get(String(p))
    },
    writeFileSync: (p, data) => { files.set(String(p), typeof data === 'string' ? data : JSON.stringify(data)) },
    mkdirSync: () => {},
  }
}

function makeAdapter({ gateway, fs, config = {} } = {}) {
  const client = makeFakeClient(gateway)
  const adapter = createQqAdapter({ client, fs })
  adapter.__config = { backend: 'onebot', wsUrl: 'ws://127.0.0.1:3001', token: '', ...config }
  adapter.__fakeClient = client
  return { adapter, client }
}

/** 等探测落定（探测是连上之后异步跑的）。 */
async function waitProbed(adapter, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (adapter.probeInfo?.().probed) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return Boolean(adapter.probeInfo?.().probed)
}

// ═════════════════════════ 1. 探测前保守 / 探测后升级 ═════════════════════════

test('探测前：扩展能力一律 false，标准能力按 v11 报，proactive 不因探测而变', () => {
  const { adapter } = makeAdapter()
  const caps = adapter.caps()
  for (const key of ['image', 'sticker', 'voice', 'video', 'file', 'maxFileBytes', 'quoteReply', 'mention', 'mentionAll', 'poke', 'typing', 'recall', 'card', 'listenAllInGroup', 'proactive', 'replyWindowMs', 'repliesPerMessage', 'history', 'memberList', 'forwardExpand']) {
    assert.ok(key in caps, `caps 缺少 ${key}（网关直接拿它降级，缺键 = 撒谎）`)
  }
  // 扩展能力：探测前不许吹牛
  for (const key of ['video', 'file', 'poke', 'typing', 'recall', 'history', 'memberList', 'forwardExpand', 'card']) {
    assert.equal(caps[key], false, `探测前 ${key} 必须是 false`)
  }
  assert.equal(caps.maxFileBytes, 0, '不能发文件时上限必须是 0')
  // v11 标准能力
  assert.equal(caps.image, true)
  assert.equal(caps.mention, true)
  assert.equal(caps.mentionAll, true)
  assert.equal(caps.quoteReply, true)
  assert.equal(caps.voice, 'native')
  // proactive 是 QQ 个人号的性质、不是网关能力：探测前后都 free（否则主动消息会全进补发队列）
  assert.equal(caps.proactive, 'free')
})

test('探测后：caps 升级且调了 ctx.capsChanged（契约 §八.1）', async () => {
  const { adapter } = makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  assert.ok(await waitProbed(adapter), '探测要跑完')
  assert.ok(ctx.capsChanges >= 1, '探测完必须调 ctx.capsChanged，否则网关还拿着旧的保守能力表')
  const caps = adapter.caps()
  assert.equal(caps.poke, true)
  assert.equal(caps.typing, true)
  assert.equal(caps.recall, true)
  assert.equal(caps.history, true)
  assert.equal(caps.memberList, true)
  assert.equal(caps.forwardExpand, true)
  assert.equal(caps.file, true)
  assert.ok(caps.maxFileBytes > 0)
  await adapter.stop()
})

test('探测先查 get_version_info，再逐个试探扩展动作', async () => {
  const { adapter, client } = makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await waitProbed(adapter)
  const actions = client.calls.map((c) => c.action)
  assert.ok(actions.includes('get_version_info'), '必须先查 get_version_info')
  for (const action of ['get_group_msg_history', 'get_group_file_url', 'send_poke', 'set_input_status', 'set_qq_avatar', 'get_qzone_msg_list', 'fetch_custom_face', 'fetch_ptt_text']) {
    assert.ok(actions.includes(action), `缺少探针：${action}`)
  }
  await adapter.stop()
})

// ═════════════════════════ 2. 逐项降级 ═════════════════════════

test('某个动作不支持时 caps 对应项为 false，其它项不受影响', async () => {
  const { adapter } = makeAdapter({ gateway: { missing: ['send_poke', 'set_input_status'] } })
  const ctx = makeCtx(adapter)
  const warnings = []
  ctx.log = { debug() {}, info() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} }
  await adapter.start(ctx)
  await waitProbed(adapter)
  const caps = adapter.caps()
  assert.equal(caps.poke, false, '没有 send_poke → poke=false')
  assert.equal(caps.typing, false, '没有 set_input_status → typing=false')
  // 一次探测失败不能把整张表打成 false
  assert.equal(caps.history, true)
  assert.equal(caps.file, true)
  assert.equal(caps.recall, true)
  assert.equal(caps.image, true)
  // 面板要能看到「当前网关不支持 X」
  assert.ok(warnings.some((w) => /不支持/.test(w) && /戳一戳/.test(w)), `日志里要有「当前网关不支持 戳一戳」，实际：${warnings.join(' | ')}`)
  await adapter.stop()
})

test('探测结果不明（超时）按不支持处理，不许升级为支持', async () => {
  const client = makeFakeClient({ hang: ['fetch_custom_face'] })
  // 探测超时压到 50ms，免得这条用例等 5 秒（真实默认是 5s / 单项）
  const adapter = createQqAdapter({ client, fs: fakeFs(), probeTimeoutMs: 50 })
  adapter.__config = { backend: 'onebot', wsUrl: 'ws://127.0.0.1:3001', token: '' }
  adapter.__fakeClient = client
  const ctx = makeCtx(adapter)
  // 探测整套跑完（含超时那一项）再断言
  await adapter.start(ctx)
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !adapter.probeInfo().probed) await new Promise((r) => setTimeout(r, 20))
  const info = adapter.probeInfo()
  assert.ok(info.unknown.includes('custom_faces'), '超时的探针落到 unknown 清单')
  assert.equal(adapter.caps().file, true, '超时只影响那一项，别的项照常')
  await adapter.stop()
})

test('capsFromProbes：单项判定（纯函数，逐条覆盖 caps 映射）', () => {
  // 注意：entries 的键是**探针名**（PROBE_TABLE 里的 name），不是动作名
  const all = capsFromProbes({
    upload_group_file: { exists: true },
    upload_private_file: { exists: false },
    poke: { exists: true },
    typing: { exists: true },
    recall: { exists: true },
    history: { exists: true },
    members: { exists: true },
    forward: { exists: true },
    can_send_image: { exists: true },
    can_send_record: { exists: true },
  })
  assert.equal(all.file, true, '有一个上传动作就能发文件')
  assert.equal(all.poke, true)
  assert.equal(all.typing, true)
  assert.equal(all.recall, true)
  assert.equal(all.history, true)
  assert.equal(all.memberList, true)
  assert.equal(all.forwardExpand, true)
  assert.equal(all.maxFileBytes, 30 * 1024 * 1024)

  // 只拿掉 poke：别的项不许跟着变
  const noPoke = capsFromProbes({ poke: { exists: false }, typing: { exists: true } })
  assert.equal(noPoke.poke, false)
  assert.equal(noPoke.typing, true)

  // 语音条发不了、但能发文件 → 降级成「当音频文件发」（契约 Caps.voice='file'）
  const noRecord = capsFromProbes({ can_send_record: { exists: false }, upload_group_file: { exists: true } })
  assert.equal(noRecord.voice, 'file')

  // 语音和文件都不能发 → voice=false
  const minimal = capsFromProbes({ can_send_record: { exists: false } })
  assert.equal(minimal.voice, false)
  assert.equal(minimal.file, false)
  assert.equal(minimal.maxFileBytes, 0)

  // 网关明确说不能发图 → image/sticker 都关（表情包当图片发）
  const noImage = capsFromProbes({ can_send_image: { exists: false } })
  assert.equal(noImage.image, false)
  assert.equal(noImage.sticker, false)

  // unknown 一律不升级
  const unknown = capsFromProbes({ poke: { exists: 'unknown' }, upload_group_file: { exists: 'unknown' } })
  assert.equal(unknown.poke, false)
  assert.equal(unknown.file, false)
})

test('探测错误分类：1404/不支持的API → unsupported；超时 → unknown；参数错 → exists', () => {
  assert.equal(classifyProbeError({ data: { retcode: 1404, message: '不支持的API' } }), 'unsupported')
  assert.equal(classifyProbeError({ data: { retcode: 404 } }), 'unsupported')
  assert.equal(classifyProbeError({ message: 'unknown action' }), 'unsupported')
  assert.equal(classifyProbeError({ message: 'Not supported' }), 'unsupported')
  assert.equal(classifyProbeError({ message: '未实现该接口' }), 'unsupported')
  assert.equal(classifyProbeError({ uncertain: true, message: '超时' }), 'unknown')
  assert.equal(classifyProbeError({ transport: true, message: '连不上 QQ 网关' }), 'unknown')
  assert.equal(classifyProbeError({ data: { retcode: 100, message: '参数错误' } }), 'exists')
})

// ═════════════════════════ 3. 探测无副作用 ═════════════════════════

test('探测绝不发消息、不动群管理、不改真资料', async () => {
  const { adapter, client } = makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await waitProbed(adapter)
  const forbidden = ['send_private_msg', 'send_group_msg', 'send_msg', 'send_qzone_msg',
    'add_custom_face', 'delete_custom_face', 'modify_custom_face',
    'set_group_ban', 'set_group_kick', 'set_group_whole_ban', '_send_group_notice']
  const hit = client.calls.filter((c) => forbidden.includes(c.action)).map((c) => c.action)
  assert.deepEqual(hit, [], `探测期间不许做这些动作：${hit.join(', ')}`)

  // 改资料的探针必须带「一定被拒」的参数：超长昵称 + 空头像
  const profile = client.calls.find((c) => c.action === 'set_qq_profile')
  assert.ok(profile, '要有 set_qq_profile 探针')
  assert.ok(String(profile.params.nickname || '').length > 60, '昵称要超长，宁可被拒也不能真改')
  const avatar = client.calls.find((c) => c.action === 'set_qq_avatar')
  assert.equal(avatar.params.file, 'base64://', '头像只能给空图')
  await adapter.stop()
})

test('探测用的目标号来自 get_group_list / get_friend_list（真实群/好友），不是瞎填', async () => {
  const { adapter, client } = makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await waitProbed(adapter)
  const hist = client.calls.find((c) => c.action === 'get_group_msg_history')
  assert.equal(hist.params.group_id, 7001, '历史消息探针要用探到的真实群号')
  const up = client.calls.find((c) => c.action === 'upload_group_file')
  assert.equal(up.params.group_id, 7001)
  assert.equal(up.params.file, '', '上传探针只能给空文件（必然失败，不会真传东西）')
  await adapter.stop()
})

// ═════════════════════════ 4. caps 缓存 ═════════════════════════

test('缓存读写：写进去能读出来，版本对不上就重探', () => {
  const fs = fakeFs()
  const file = 'D:/data/qq/caps.json'
  assert.equal(readCapsCache(file, { fs }), null, '文件不存在返回 null')
  writeCapsCache(file, { gateway: { app: 'SnowLuma', version: '2.4.1' }, caps: { poke: true, file: true, maxFileBytes: 123 }, supported: ['send_poke'], probedAt: 111 }, { fs })
  const cache = readCapsCache(file, { fs })
  assert.ok(cache)
  assert.equal(cache.caps.poke, true)
  assert.equal(cache.caps.file, true)
  assert.equal(cache.caps.maxFileBytes, 123)
  assert.deepEqual(cache.supported, ['send_poke'])
  assert.equal(cache.probedAt, 111)

  // 版本没变：认
  assert.equal(cacheMatchesGateway(cache, { app: 'SnowLuma', version: '2.4.1' }), true)
  // 版本变了 / 换了网关 / 读不出版本：都不认
  assert.equal(cacheMatchesGateway(cache, { app: 'SnowLuma', version: '2.4.2' }), false)
  assert.equal(cacheMatchesGateway(cache, { app: 'NapCat', version: '2.4.1' }), false)
  assert.equal(cacheMatchesGateway(cache, { app: 'SnowLuma', version: '' }), false)
  assert.equal(cacheMatchesGateway(null, { app: 'x', version: '1' }), false)
})

test('缓存文件坏了 / 版本号变了 / 取值不合法：读到 null 或落回保守值，绝不影响启动', () => {
  // 坏 JSON
  const bad = fakeFs({ 'caps.json': '{ 不是 json' })
  assert.equal(readCapsCache('caps.json', { fs: bad }), null)

  // 版本号不对（契约升级过）：丢掉旧缓存
  const old = fakeFs({ 'caps.json': JSON.stringify({ v: 0, caps: { poke: true } }) })
  assert.equal(readCapsCache('caps.json', { fs: old }), null)

  // voice / proactive 的取值不合法：丢掉那一项，落回保守值
  const weird = fakeFs({ 'caps.json': JSON.stringify({ v: 1, caps: { voice: 'yes', proactive: 'maybe', poke: true } }) })
  const cache = readCapsCache('caps.json', { fs: weird })
  assert.equal(cache.caps.voice, 'native', '非法 voice 落回保守值')
  assert.equal(cache.caps.proactive, 'free', '非法 proactive 落回保守值')
  assert.equal(cache.caps.poke, true, '合法项保留')
})

test('缓存命中：启动时先用缓存报能力（不必等探测跑完）', async () => {
  const fs = fakeFs()
  // 用绝对路径：平台端只认绝对路径的数据目录（相对路径会被拒，见 cacheFilePath 的注释）
  const file = join(tmpdir(), `qq-caps-hit-${Date.now()}`, 'caps.json')
  // 预先放一份与假网关版本一致的缓存
  writeCapsCache(file, {
    gateway: { app: 'SnowLuma', version: '2.4.1' },
    caps: { ...CAPS_CONSERVATIVE, poke: true, typing: true, history: true, file: true, maxFileBytes: 1024 },
    supported: ['send_poke', 'set_input_status', 'get_group_msg_history', 'upload_group_file'],
    probedAt: 42,
  }, { fs })

  const { adapter } = makeAdapter({ fs })
  const ctx = makeCtx(adapter)
  ctx.dataDir = () => file
  // 探测本身挂住，确保「立刻可用」只能是缓存给的
  adapter.__client.call = async (action) => {
    if (action === 'get_version_info') return { status: 'ok', retcode: 0, data: { app_name: 'SnowLuma', app_version: '2.4.1' } }
    return new Promise(() => {})
  }
  await adapter.start(ctx)
  // start 返回后立刻看：缓存应该已经生效
  const caps = adapter.caps()
  assert.equal(caps.poke, true, '缓存命中时 poke 立刻可用')
  assert.equal(caps.history, true)
  assert.equal(caps.file, true)
  assert.equal(adapter.probeInfo().probed, true, '缓存命中即视为已探测')
  assert.equal(adapter.probeInfo().fromCache, true, '要能看出这次是缓存来的')
  await adapter.stop()
})

test('探测完把结果写进 dataDir(caps.json)', async () => {
  const fs = fakeFs()
  const { adapter } = makeAdapter({ fs })
  const ctx = makeCtx(adapter)
  const file = join(tmpdir(), `qq-caps-write-${Date.now()}`, 'caps.json')
  ctx.dataDir = () => file
  await adapter.start(ctx)
  await waitProbed(adapter)
  assert.ok(fs.files.has(file), `探测完要写 ${file}`)
  const cache = readCapsCache(file, { fs })
  assert.ok(cache.supported.includes('send_poke'))
  assert.equal(cache.gateway.app, 'SnowLuma')
  assert.equal(cache.gateway.version, '2.4.1')
  await adapter.stop()
})

test('相对路径的数据目录不落盘（不许把 caps.json 写进工作目录）', async () => {
  const fs = fakeFs()
  const { adapter } = makeAdapter({ fs })
  const ctx = makeCtx(adapter)
  // adapter-kit 的 makeCtx.dataDir 就是 parts.join('/')，这里是相对的 'caps.json'
  await adapter.start(ctx)
  await waitProbed(adapter)
  assert.equal(fs.files.has('caps.json'), false, '相对路径必须被拒，否则会污染仓库根目录')
  await adapter.stop()
})

// ═════════════════════════ 5. 入站与 parseMessageEvent 逐字段等价 ═════════════════════════

/**
 * 测试语料：把现有 test/ 里出现过的入站形状都过一遍
 * （纯文本 / @机器人 / @全体 / @别人 / 引用 / 图片 / 表情包 / 语音 / 视频 / 文件 /
 *  闪传 / 系统表情 / 骰子 / 分享卡片 / 合并转发 / 戳一戳 / CQ 码 / 临时会话）。
 */
const CORPUS = [
  { name: '纯文本私聊', event: { message_type: 'private', user_id: 10001, message_id: 'm1', sender: { nickname: '张三' }, message: [{ type: 'text', data: { text: '今天吃什么' } }] } },
  { name: '@机器人', event: { message_type: 'group', group_id: 7001, user_id: 10002, message_id: 'm2', sender: { card: '小明', role: 'admin' }, message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 在吗' } }] } },
  { name: '@全体 + @别人', event: { message_type: 'group', group_id: 7001, user_id: 10002, message_id: 'm3', sender: { nickname: '小明' }, message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '开会' } }, { type: 'at', data: { qq: '10003', name: '小红' } }, { type: 'text', data: { text: ' 你也来' } }] } },
  { name: '引用回复', event: { message_type: 'group', group_id: 7001, user_id: 10002, message_id: 'm4', sender: { nickname: '小明' }, message: [{ type: 'reply', data: { id: '9001' } }, { type: 'text', data: { text: '我也觉得' } }] } },
  { name: '图片 + 表情包', event: { message_type: 'private', user_id: 10001, message_id: 'm5', sender: { nickname: '张三' }, message: [{ type: 'image', data: { file: 'a.jpg', url: 'https://x/a.jpg', sub_type: 0 } }, { type: 'image', data: { file: 's.gif', url: 'https://x/s.gif', sub_type: 1 } }] } },
  { name: '带说明的表情包', event: { message_type: 'private', user_id: 10001, message_id: 'm6', sender: { nickname: '张三' }, message: [{ type: 'image', data: { file: 'e.gif', summary: '[啊？]', sub_type: 7 } }] } },
  { name: 'mface（商城表情）', event: { message_type: 'private', user_id: 10001, message_id: 'm7', sender: { nickname: '张三' }, message: [{ type: 'mface', data: { emoji_id: 'e1', summary: '[打call]' } }] } },
  { name: '语音 + 视频', event: { message_type: 'private', user_id: 10001, message_id: 'm8', sender: { nickname: '张三' }, message: [{ type: 'record', data: { file: 'r.amr', duration: 3 } }, { type: 'video', data: { file: 'v.mp4' } }] } },
  { name: '文件 + 闪传', event: { message_type: 'private', user_id: 10001, message_id: 'm9', sender: { nickname: '张三' }, message: [{ type: 'file', data: { name: 'a.txt', size: 5, id: 'f1', url: 'https://x/a', file_hash: 'h' } }, { type: 'flash_file', data: { title: '闪传' } }] } },
  { name: '系统表情 + 骰子', event: { message_type: 'private', user_id: 10001, message_id: 'm10', sender: { nickname: '张三' }, message: [{ type: 'face', data: { id: '178' } }, { type: 'face', data: { id: '358', resultId: '4' } }] } },
  { name: '分享卡片', event: { message_type: 'private', user_id: 10001, message_id: 'm11', sender: { nickname: '张三' }, message: [{ type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.structmsg', meta: { news: { title: 'B站', desc: '一个视频', jumpUrl: 'https://b23.tv/x?a=1' } } }) } }] } },
  { name: '合并转发', event: { message_type: 'private', user_id: 10001, message_id: 'm12', sender: { nickname: '张三' }, message: [{ type: 'forward', data: { id: 'fw1' } }] } },
  { name: '戳一戳段', event: { message_type: 'private', user_id: 10001, message_id: 'm13', sender: { nickname: '张三' }, message: [{ type: 'poke', data: {} }] } },
  { name: 'CQ 码字符串', event: { message_type: 'private', user_id: 10001, message_id: 'm14', sender: { nickname: '张三' }, message: '你好[CQ:face,id=1]呀' } },
  { name: '临时会话', event: { message_type: 'private', sub_type: 'group', user_id: 10004, message_id: 'm15', sender: { nickname: '群里的人', group_id: 7001 }, message: [{ type: 'text', data: { text: '私聊你一下' } }] } },
]

test('入站翻译与 parseMessageEvent 逐字段一致（text / wakeText / mentioned / atOthers / replyId / 条目数）', () => {
  for (const { name, event } of CORPUS) {
    const inbound = fromOneBotEvent(event, { selfId: SELF })
    const expected = parseMessageEvent(event, SELF)
    const { text, wakeText } = renderParts(inbound.parts)
    const atOthers = inbound.parts.some((p) => p.type === 'mention' && p.account !== 'all')

    assert.equal(text, expected.text, `${name}：text 必须与 parseMessageEvent 逐字一致`)
    assert.equal(wakeText, expected.wakeText, `${name}：wakeText 必须一致`)
    assert.equal(inbound.mentionedMe, expected.mentioned, `${name}：mentionedMe 必须一致`)
    assert.equal(atOthers, expected.atOthers, `${name}：atOthers 必须一致`)
    assert.equal(inbound.replyTo || '', expected.replyId, `${name}：replyId 必须一致`)

    const count = (t) => inbound.parts.filter((p) => p.type === t).length
    assert.equal(count('image'), expected.images.length, `${name}：图片数必须一致`)
    assert.equal(count('sticker'), expected.stickers.length, `${name}：表情包数必须一致`)
    assert.equal(count('voice'), expected.records.length, `${name}：语音数必须一致`)
    assert.equal(count('file'), expected.files.length, `${name}：文件数必须一致`)

    if (expected.files.length) {
      const f = inbound.parts.find((p) => p.type === 'file')
      assert.equal(f.media.name, expected.files[0].name, `${name}：文件名一致`)
      assert.equal(f.media.size || 0, expected.files[0].size, `${name}：文件大小一致`)
      assert.equal(f.media.id || '', expected.files[0].id, `${name}：文件 id 一致`)
      assert.equal(f.media.md5 || '', expected.files[0].hash, `${name}：文件哈希一致`)
    }
    if (expected.forwards.length) {
      const fwd = inbound.parts.find((p) => p.type === 'forward')
      assert.equal(fwd.id, expected.forwards[0], `${name}：合并转发 id 一致`)
    }
  }
})

test('入站：契约要的字段齐全（messageId 非空、at 毫秒、chat/sender/parts/raw）', () => {
  for (const { name, event } of CORPUS) {
    const m = fromOneBotEvent(event, { selfId: SELF })
    assert.ok(m.messageId, `${name}：messageId 非空`)
    assert.equal(typeof m.messageId, 'string')
    assert.ok(Number.isInteger(m.at) && m.at > 1e11, `${name}：at 是毫秒级时间戳（实际 ${m.at}）`)
    assert.ok(['private', 'group'].includes(m.chat.kind))
    assert.ok(m.chat.id, `${name}：chat.id 非空`)
    assert.ok(m.sender.account, `${name}：sender.account 非空`)
    assert.equal(typeof m.sender.name, 'string')
    assert.ok(Array.isArray(m.parts))
    assert.ok('raw' in m)
    assert.equal(typeof m.mentionedMe, 'boolean')
  }
})

test('入站：@机器人自己不进 parts；私聊 role 是空串', () => {
  const group = fromOneBotEvent({ message_type: 'group', group_id: 1, user_id: 2, message_id: 'g', message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: '在吗' } }] }, { selfId: SELF })
  assert.equal(group.mentionedMe, true)
  assert.equal(group.parts.some((p) => p.type === 'mention'), false, '@自己 不该出现在 parts 里')

  const priv = fromOneBotEvent({ message_type: 'private', user_id: 1, message_id: 'p', sender: { nickname: 'a', role: 'admin' }, message: [] }, {})
  assert.equal(priv.sender.role, '', '私聊的 sender.role 按契约是空串')
})

test('入站：临时会话的来源群进 ext.sourceGroupId', () => {
  const m = fromOneBotEvent({ message_type: 'private', sub_type: 'group', user_id: 5, message_id: 'q', sender: { nickname: 'a', group_id: 7001 }, message: [] }, {})
  assert.equal(m.ext.sourceGroupId, '7001')
})

test('事件翻译：戳一戳 / 离线 / 群文件 / 撤回 / 自己发的 / 其余 notice', () => {
  assert.equal(toAdapterEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 1, user_id: 2, target_id: 3 }).type, 'poke')
  assert.equal(toAdapterEvent({ post_type: 'notice', notice_type: 'bot_offline', tag: '别处登录' }).type, 'offline')
  assert.equal(toAdapterEvent({ post_type: 'notice', notice_type: 'group_upload', group_id: 1, user_id: 2, file: { name: 'a.zip', size: 9 } }).media.name, 'a.zip')
  assert.equal(toAdapterEvent({ post_type: 'notice', notice_type: 'group_recall', group_id: 1, message_id: 'r1', operator_id: 2 }).type, 'recall')
  assert.equal(toAdapterEvent({ post_type: 'message_sent', message_type: 'group', group_id: 1, message_id: 's1', message: [{ type: 'text', data: { text: '我说的' } }] }).type, 'self-sent')
  assert.equal(toAdapterEvent({ post_type: 'notice', notice_type: 'group_increase', group_id: 1, user_id: 2 }).type, 'native')
  assert.equal(toAdapterEvent({ post_type: 'request', request_type: 'friend', user_id: 3 }).type, 'native')
  assert.equal(toAdapterEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), null, '心跳是噪声，不收')
})

test('机器人自己发的消息走 emitEvent(self-sent)，绝不进 emit', async () => {
  const { adapter } = makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const before = ctx.emitted.length
  adapter.__fakeClient.push({
    post_type: 'message_sent', message_type: 'private', user_id: 10001, message_id: 'self-1',
    message: [{ type: 'text', data: { text: '我自己说的' } }],
  })
  assert.equal(ctx.emitted.length, before, '自己发的消息进 emit 会让她以为有人在冒充她')
  assert.equal(ctx.events.at(-1).type, 'self-sent')
  await adapter.stop()
})

// ═════════════════════════ 6. 出站往返 ═════════════════════════

test('出站往返：Part[] → 消息段 → Part[]，内容不变', () => {
  const parts = [
    { type: 'text', text: '你好' },
    { type: 'mention', account: '10002', name: '小明' },
    { type: 'mention', account: 'all' },
    { type: 'image', media: { url: 'https://x/a.png' } },
    { type: 'face', name: '微笑' },
    { type: 'voice', media: { url: 'https://x/r.amr' }, durationMs: 3000 },
    { type: 'video', media: { url: 'https://x/v.mp4' } },
  ]
  const { segments, degraded } = buildParts(parts, { voiceMode: 'native', faceIdOf: (n) => (n === '微笑' ? 14 : undefined) })
  assert.deepEqual(degraded, [])
  // 回来的 face 段只有编号（OneBot 里 face 只有 id），要还原名字得靠调用方注入的表
  const back = segmentsToParts(segments, { selfId: SELF, faceName: (id) => (String(id) === '14' ? '微笑' : undefined) }).parts
  assert.deepEqual(back.map((p) => p.type), ['text', 'mention', 'mention', 'image', 'face', 'voice', 'video'])
  assert.equal(back[0].text, '你好')
  assert.equal(back[1].account, '10002')
  assert.equal(back[2].account, 'all')
  // 出站把 url 放进 data.file（OneBot 就是这么收的），回来时是 media.id —— 只要「同一个来源」没丢就行
  assert.equal(back[3].media.url || back[3].media.id, 'https://x/a.png')
  assert.equal(back[4].name, '微笑')
  assert.equal(back[5].media.url || back[5].media.id, 'https://x/r.amr')
})

test('出站：表情名查不到编号时退回文字（不丢内容），并记 degraded', () => {
  const { segments, degraded } = buildParts([{ type: 'face', name: '不存在的表情' }], { faceIdOf: () => undefined })
  assert.deepEqual(segments, [{ type: 'text', data: { text: '[不存在的表情]' } }])
  assert.ok(degraded.includes('face→text'))
})

test('出站：sticker.native 原样重发；文件与语音走 upload_*', () => {
  const native = { type: 'mface', data: { emoji_id: 'e1' } }
  assert.deepEqual(buildParts([{ type: 'sticker', media: {}, native }]).segments, [native])

  const f = buildParts([{ type: 'text', text: 'x' }, { type: 'file', media: { path: 'C:/a.txt', name: 'a.txt' } }])
  assert.equal(f.segments.length, 1)
  assert.equal(f.uploads.length, 1)
  assert.equal(f.uploads[0].file, 'C:/a.txt')

  const v = buildParts([{ type: 'voice', media: { path: 'C:/r.mp3' } }], { voiceMode: 'file' })
  assert.equal(v.segments.length, 0, 'voice=file 时不发语音条')
  assert.equal(v.uploads.length, 1)
})

test('出站：mediaSource 优先级 bytes > path > url > id', () => {
  assert.equal(mediaSource({ bytes: new Uint8Array([1, 2]), path: 'p', url: 'u', id: 'i' }), 'base64://' + Buffer.from([1, 2]).toString('base64'))
  assert.equal(mediaSource({ path: 'p', url: 'u', id: 'i' }), 'p')
  assert.equal(mediaSource({ url: 'u', id: 'i' }), 'u')
  assert.equal(mediaSource({ id: 'i' }), 'i')
  assert.equal(mediaSource({}), '')
})

test('出站：私聊/群聊分别调 send_private_msg / send_group_msg；引用回复在首位', async () => {
  const { adapter, client } = makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await waitProbed(adapter) // 等探测跑完，否则"最后一条调用"会是探测的探针
  client.calls.length = 0
  await adapter.send({ chat: { kind: 'private', id: '10001' }, parts: [{ type: 'text', text: '私聊' }] })
  assert.equal(client.calls.at(-1).action, 'send_private_msg')
  assert.equal(client.calls.at(-1).params.user_id, 10001)

  await adapter.send({ chat: { kind: 'group', id: '7001' }, parts: [{ type: 'text', text: '群聊' }], replyTo: '9001' })
  const last = client.calls.at(-1)
  assert.equal(last.action, 'send_group_msg')
  assert.equal(last.params.group_id, 7001)
  assert.equal(last.params.message[0].type, 'reply', 'OneBot 规定 reply 段必须在首位')
  assert.equal(last.params.message[0].data.id, '9001')
  await adapter.stop()
})

// ═════════════════════════ 7. 错误映射 ═════════════════════════

test('错误映射：transport → not-sent（确定没发出去，可入队重试）', () => {
  const err = Object.assign(new Error('连不上 QQ 网关'), { transport: true, uncertain: false })
  const mapped = toSendError(err, { instance: 'qq' })
  assert.equal(mapped.certainty, 'not-sent')
  assert.equal(mapped.instance, 'qq')
  assert.equal(mapped.name, 'SendError')
})

test('错误映射：uncertain → unknown（绝不重发）', () => {
  assert.equal(toSendError(Object.assign(new Error('超时'), { uncertain: true }), { instance: 'qq' }).certainty, 'unknown')
  assert.equal(toSendError(Object.assign(new Error('连接断开'), { uncertain: true }), { instance: 'qq' }).certainty, 'unknown')
  // 业务错误但没标 transport：拿不准 → unknown
  assert.equal(toSendError(Object.assign(new Error('群不存在'), { data: { retcode: 100 } }), { instance: 'qq' }).certainty, 'unknown')
  // 裸 Error 一律 unknown
  assert.equal(toSendError(new TypeError('x'), { instance: 'qq' }).certainty, 'unknown')
})

test('错误映射：isDefiniteFailure 的判定原样沿用（不复制、不改写）', async () => {
  const { isDefiniteFailure, OneBotError } = await import('../../src/onebot/client.js')
  // 语音上传失败：现成判定认得出「消息肯定没发出去」
  const highway = new OneBotError('send_private_msg', { retcode: 1200, message: '富媒体上传失败 highway' })
  assert.equal(isDefiniteFailure(highway), true)
  assert.equal(toSendError(highway, { instance: 'qq', isDefiniteFailure }).certainty, 'not-sent')
  // 超时：现成判定说不是「确定没发出去」→ unknown
  const timeout = new OneBotError('send_private_msg', { message: '超时' }, { uncertain: true })
  assert.equal(isDefiniteFailure(timeout), false)
  assert.equal(toSendError(timeout, { instance: 'qq', isDefiniteFailure }).certainty, 'unknown')
})

test('send 真路径：网关拒绝 → not-sent；超时 → unknown', async () => {
  const { adapter } = makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  adapter.__fakeClient.failNext('refused')
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: '10001' }, parts: [{ type: 'text', text: 'x' }] }),
    (e) => { assert.equal(e.certainty, 'not-sent'); assert.equal(e.instance, 'qq'); return true },
  )
  adapter.__fakeClient.failNext('timeout')
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: '10001' }, parts: [{ type: 'text', text: 'y' }] }),
    (e) => { assert.equal(e.certainty, 'unknown'); return true },
  )
  await adapter.stop()
})

test('send：没连上时抛 not-sent（offline，不入重试）', async () => {
  const { adapter } = makeAdapter()
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: '1' }, parts: [{ type: 'text', text: 'x' }] }),
    (e) => { assert.equal(e.certainty, 'not-sent'); assert.equal(e.code, 'offline'); return true },
  )
})

// ═════════════════════════ 8. native / whoami / settings ═════════════════════════

test('native：探测清单里没有的动作抛「当前网关不支持」，且不发请求', async () => {
  const { adapter, client } = makeAdapter({ gateway: { missing: ['send_poke'] } })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await waitProbed(adapter)
  const before = client.calls.length
  await assert.rejects(
    () => adapter.native('send_poke', { user_id: 1 }),
    (e) => { assert.equal(e.code, 'unsupported-action'); assert.match(e.message, /不支持/); return true },
  )
  assert.equal(client.calls.length, before, '不支持的动作不许真的发出去')
  await adapter.stop()
})

test('native：发消息类动作被拦住，必须走网关 send', async () => {
  const { adapter } = makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  for (const action of ['send_private_msg', 'send_group_msg', 'send_msg']) {
    await assert.rejects(() => adapter.native(action, {}), (e) => e.code === 'use-send')
  }
  await adapter.stop()
})

test('native：支持的动作能透传，失败的分类与 send 同一套语义', async () => {
  const { adapter } = makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await waitProbed(adapter)
  const r = await adapter.native('get_group_list', {})
  assert.ok(Array.isArray(r))
  await adapter.stop()
})

test('whoami 从 get_login_info 拿 account / name；settings 声明了 6 个配置键', async () => {
  const { adapter } = makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const me = await adapter.whoami()
  assert.equal(me.account, SELF)
  assert.equal(me.name, '假机器人')
  const keys = adapter.settings.map((s) => s.key)
  for (const key of ['backend', 'wsUrl', 'httpUrl', 'token', 'snowlumaManaged', 'snowlumaDir']) {
    assert.ok(keys.includes(key), `settings 缺少 ${key}`)
  }
  await adapter.stop()
})

test('caps() 返回副本（网关叠 config.caps 时改不到内部状态）', () => {
  const { adapter } = makeAdapter()
  const snapshot = adapter.caps()
  snapshot.poke = true
  assert.equal(adapter.caps().poke, false)
  assert.equal(Object.isFrozen(CAPS_CONSERVATIVE), true, '保守能力表要冻结，防止别处误改')
})

test('supportedActions 永远含标准动作（探测失败也不能堵死发消息）', () => {
  const set = supportedActions({ supported: [] })
  for (const a of ['send_private_msg', 'send_group_msg', 'get_login_info', 'get_version_info']) assert.ok(set.has(a))
  assert.equal(set.has('set_qq_profile'), false)
  assert.equal(supportedActions({ supported: ['set_qq_profile'] }).has('set_qq_profile'), true)
})

// ═════════════════════════ 9. SnowLuma 子模块 ═════════════════════════

test('SnowLuma：只在 Windows + backend=snowluma + 配了目录时启用', async () => {
  const { snowlumaEnabled } = await import('../../src/adapters/qq/snowluma.js')
  assert.equal(snowlumaEnabled({ backend: 'onebot', snowlumaDir: 'C:\\x' }).enabled, false)
  assert.equal(snowlumaEnabled({ backend: 'snowluma', snowlumaDir: '' }).enabled, false)
  const r = snowlumaEnabled({ backend: 'snowluma', snowlumaDir: 'C:\\x' })
  assert.equal(r.enabled, process.platform === 'win32', 'SnowLuma 管理只在 Windows 上可用')
  if (process.platform !== 'win32') assert.match(r.reason, /Windows/)
})

test('SnowLuma：子模块只 import 原文件、不复制、不自己 spawn', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const file = fileURLToPath(new URL('../../src/adapters/qq/snowluma.js', import.meta.url))
  const text = readFileSync(file, 'utf8')
  assert.match(text, /from '\.\.\/\.\.\/snowluma\/manager\.js'/, '必须从 src/snowluma/manager.js 复用')
  assert.equal(/export function createSnowLumaManager/.test(text), false, '不许在本文件里重新定义 manager')
  assert.equal(/\bspawn\(/.test(text), false, '不许自己 spawn 进程（复用原 manager）')
  assert.equal(/download|unzip|extract/i.test(text), false, '不许自己下载/解压 SnowLuma（EULA）')
})

// ═════════════════════════ 10. 启停 ═════════════════════════

test('stop 后不再 emit；重新 start 能恢复', async () => {
  const { adapter } = makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  adapter.__fakeClient.push({ post_type: 'message', message_type: 'private', user_id: 1, message_id: 'a1', message: [{ type: 'text', data: { text: '1' } }] })
  const before = ctx.emitted.length
  await adapter.stop()
  assert.equal(ctx.states.at(-1)[0], 'stopped')
  adapter.__fakeClient.push({ post_type: 'message', message_type: 'private', user_id: 1, message_id: 'a2', message: [{ type: 'text', data: { text: '2' } }] })
  assert.equal(ctx.emitted.length, before, 'stop 之后绝不能再 emit')
  await adapter.start(ctx)
  adapter.__fakeClient.push({ post_type: 'message', message_type: 'private', user_id: 1, message_id: 'a3', message: [{ type: 'text', data: { text: '3' } }] })
  assert.equal(ctx.emitted.length, before + 1, '重启后入站要能继续进来')
  await adapter.stop()
})

test('Probe 表本身健全：每个探针都有名字、动作（或由参数决定）与中文标签', () => {
  for (const p of PROBE_TABLE) {
    assert.ok(p.name, '每个探针都要有 name')
    assert.ok(p.label, `${p.name} 要有中文标签（面板显示用）`)
    assert.ok(p.action || typeof p.params === 'function', `${p.name} 要么有固定动作名，要么由参数决定`)
  }
  const names = PROBE_TABLE.map((p) => p.name)
  assert.equal(new Set(names).size, names.length, '探针名不能重复（缓存和日志按名字索引）')
})
