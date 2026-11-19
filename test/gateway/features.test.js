// Step 0B · Gateway L2 Features（5 步解析、multi-instance 隔离、onCapsChanged 去重与 message 拉取转发）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createGateway, mergeCaps } from '../../src/gateway/index.js'
import { ALL_FEATURES, deriveFeatures, emptyFeatures } from '../../src/gateway/features.js'
import { makeFakeAdapter } from '../helpers/fake-adapter.js'
import { makeIdentity, makeTempRoot } from './helpers.js'

function spyLog() {
  const warnings = []
  return {
    warnings,
    log: {
      debug() {},
      info() {},
      warn: (...a) => warnings.push(a.join(' ')),
      error() {},
    },
  }
}

test('Step 0B：ALL_FEATURES 与 deriveFeatures 精确覆盖 14 项及 5 步不可逆解析规则', () => {
  assert.equal(ALL_FEATURES.length, 14)
  assert.equal(Object.keys(emptyFeatures()).length, 14)
  assert.equal(Object.values(emptyFeatures()).every((v) => v === false), true)

  // Step 1：仅有 L1 Caps（无 adapter.features）→ 5 项严格显式 Feature 全部保持 false；chat.member.read 缺省跟随 memberList
  const l1Only = {
    image: true,
    sticker: true,
    voice: 'native',
    video: true,
    file: true,
    maxFileBytes: 1024,
    quoteReply: true,
    mention: true,
    mentionAll: true,
    poke: true,
    typing: true,
    recall: true,
    card: false,
    listenAllInGroup: true,
    proactive: 'free',
    replyWindowMs: 0,
    repliesPerMessage: 0,
    history: true,
    memberList: true,
    forwardExpand: true,
  }
  const d1 = deriveFeatures(l1Only)
  assert.equal(d1['message.quote.send'], true)
  assert.equal(d1['message.history.read'], true)
  assert.equal(d1['message.forward.expand'], true)
  assert.equal(d1['message.recall'], true)
  assert.equal(d1['chat.member.list'], true)
  assert.equal(d1['chat.member.read'], true)
  assert.equal(d1['chat.typing'], true)
  assert.equal(d1['sticker.send.native'], true)
  assert.equal(d1['card.send'], false)
  for (const strictExplicit of [
    'message.quote.read',
    'message.reaction',
    'media.fetch',
    'sticker.collect',
    'sticker.sync.native',
  ]) {
    assert.equal(d1[strictExplicit], false, `未显式声明时 ${strictExplicit} 必须为 false`)
  }

  // Step 2 ~ 5：表驱动合并测试
  const { warnings, log } = spyLog()
  const adapterCaps = {
    ...l1Only,
    memberList: true,
    features: {
      'message.quote.read': true,
      'media.fetch': true,
      'sticker.collect': true,
      'card.send': true, // card=false（L1 为假），adapter.features 想强开 → 应忽略并告警
      'message.recall': false, // L1=true → features 收敛为 false 合法
      'chat.member.read': true,
      'bogus.adapter.key': true, // 未知键 → 丢弃并告警
    },
  }
  const userCaps = {
    memberList: false, // 关 L1 memberList：chat.member.list 必关，但 chat.member.read 独立保留
    features: {
      'media.fetch': false, // 允许 true → false
      'sticker.sync.native': true, // 企图 false → true → 忽略并告警
      'card.send': true, // 企图 false → true → 忽略并告警
      'bogus.user.key': false, // 未知键 → 丢弃并告警
    },
  }

  const merged = mergeCaps(adapterCaps, userCaps, 'qq#test', log)
  assert.equal(merged.memberList, false)
  assert.equal(merged.features['chat.member.list'], false, '用户关 memberList 应联动关闭 chat.member.list')
  assert.equal(merged.features['chat.member.read'], true, 'chat.member.read 独立于 memberList，不被联动关闭')
  assert.equal(merged.features['media.fetch'], false, '用户可通过 caps.features 关闭 media.fetch')
  assert.equal(merged.features['sticker.collect'], true, '不破坏其余未关闭的显式 Feature（非整块替换）')
  assert.equal(merged.features['message.quote.read'], true)
  assert.equal(merged.features['message.recall'], false, 'adapter 显式收敛 message.recall 生效')
  assert.equal(merged.features['card.send'], false, 'L1 为假时 features 不得强开')
  assert.equal(merged.features['sticker.sync.native'], false, '用户 caps.features 不得将 false 改为 true')
  assert.equal(Object.hasOwn(merged.features, 'bogus.adapter.key'), false)
  assert.equal(Object.hasOwn(merged.features, 'bogus.user.key'), false)
  assert.equal(Object.keys(merged.features).length, 14)
  assert.ok(warnings.some((w) => w.includes('bogus.adapter.key')))
  assert.ok(warnings.some((w) => w.includes('bogus.user.key')))
  assert.ok(warnings.some((w) => w.includes('sticker.sync.native')))
  assert.ok(warnings.some((w) => w.includes('card.send')))
})

test('Step 0B：无 L1 memberList 时 adapter 仍可独立声明 chat.member.read = true', () => {
  const merged = mergeCaps({
    image: true,
    memberList: false,
    features: { 'chat.member.read': true },
  }, {}, 'qq')
  assert.equal(merged.features['chat.member.list'], false)
  assert.equal(merged.features['chat.member.read'], true)

  // 用户可通过 caps.features 显式关掉 chat.member.read
  const narrowed = mergeCaps(merged, { features: { 'chat.member.read': false } }, 'qq')
  assert.equal(narrowed.features['chat.member.read'], false)
})

test('Step 0B：gateway.features 离线全 false、多实例隔离与 onCapsChanged 去重快照', async (t) => {
  const root = makeTempRoot('gw-features-')
  const identity = makeIdentity()
  const a1 = makeFakeAdapter({
    id: 'qq',
    caps: {
      history: true,
      features: { 'media.fetch': true, 'sticker.collect': true, 'message.quote.read': true },
    },
  })
  const a2 = makeFakeAdapter({
    id: 'qq#2',
    caps: {
      history: false,
      features: { 'media.fetch': true, 'sticker.collect': false },
    },
  })

  const cfg = {
    platforms: {
      qq: { enabled: true },
      'qq#2': { enabled: true, caps: { quoteReply: false } },
    },
  }

  // 用两个不同 adapter 实例挂到同平台 qq / qq#2（用队列按实例提供不同能力）
  const instances = [a1, a2]
  let idx = 0
  const gw = createGateway({
    config: cfg,
    dataDir: (...p) => join(root, 'data', ...p),
    identity,
  })
  gw.register(() => {
    const adapter = instances[idx] || makeFakeAdapter({ id: 'qq' })
    idx++
    // probe 只需 id='qq'；随后两个实例各拿 a1 与 a2
    return adapter === a2 ? Object.assign(a2, { id: 'qq' }) : adapter
  })
  // 首次 sync 前 未连接 → 全 false
  assert.equal(gw.features('qq')['sticker.collect'], false)
  assert.equal(gw.features('unknown-inst')['message.quote.send'], false)

  const events = []
  const off = gw.onCapsChanged((info) => {
    events.push({
      instance: info.instance,
      state: info.state,
      collect: info.features['sticker.collect'],
      history: info.features['message.history.read'],
      quoteSend: info.features['message.quote.send'],
    })
    // 尝试篡改回调收到的 features 副本，不应污染网关内部状态
    info.features['sticker.sync.native'] = true
  })
  t.after(async () => {
    off()
    await gw.stopAll()
  })

  // probe 调用了一次 factory，因此重置 idx 从 0 给实例 qq / qq#2
  idx = 0
  await gw.sync()

  // sync 之后才注册的新订阅者应立刻收到当前运行中实例的快照补发
  const lateReplay = []
  const offLate = gw.onCapsChanged((info) => lateReplay.push(info))
  offLate()
  assert.equal(lateReplay.length, 2)
  assert.equal(lateReplay.find((x) => x.instance === 'qq')?.features['sticker.collect'], true)
  assert.equal(lateReplay.find((x) => x.instance === 'qq#2')?.features['message.quote.send'], false)

  // 两实例同平台能力严格隔离
  assert.equal(gw.features('qq:private:1')['sticker.collect'], true)
  assert.equal(gw.features('qq:private:1')['message.history.read'], true)
  assert.equal(gw.features('qq:private:1')['message.quote.send'], true)
  assert.equal(gw.features('qq:private:1')['sticker.sync.native'], false, '回调篡改副本不能影响网关返回值')

  assert.equal(gw.features('qq#2:private:1')['sticker.collect'], false)
  assert.equal(gw.features('qq#2:private:1')['message.history.read'], false)
  assert.equal(gw.features('qq#2:private:1')['message.quote.send'], false, 'qq#2 配置关掉了 quoteReply')

  const countAfterSync = events.length
  assert.ok(events.some((e) => e.instance === 'qq' && e.state === 'connected' && e.collect === true))
  assert.ok(events.some((e) => e.instance === 'qq#2' && e.state === 'connected' && e.collect === false))

  // 无实质变化的重复 capsChanged 不触发事件
  a1.setCaps({})
  assert.equal(events.length, countAfterSync, 'state 与 14 项 features 均未变时不重发 onCapsChanged')

  // 运行时新探测出 sticker.sync.native → 触发 onCapsChanged
  a1.setCaps({ features: { 'sticker.sync.native': true } })
  assert.equal(events.length, countAfterSync + 1)
  assert.equal(gw.features('qq')['sticker.sync.native'], true)

  // 断线 → features 全部收敛为 false 并触发 onCapsChanged
  a1.disconnect()
  assert.equal(gw.features('qq')['sticker.collect'], false)
  assert.equal(gw.features('qq:private:1')['message.quote.send'], false)
  assert.equal(events.at(-1).state, 'disconnected')
  assert.equal(events.at(-1).collect, false)

  // 重连 → features 恢复并触发 onCapsChanged
  a1.reconnect()
  assert.equal(gw.features('qq')['sticker.collect'], true)
  assert.equal(events.at(-1).state, 'connected')
  assert.equal(events.at(-1).collect, true)

  // 配置停用实例 → stopped（caps: null, features 全 false）
  cfg.platforms.qq.enabled = false
  await gw.sync()
  assert.equal(gw.features('qq')['sticker.collect'], false)
  assert.equal(events.at(-1).instance, 'qq')
  assert.equal(events.at(-1).state, 'stopped')
})

test('Step 0B：gateway.fetch(message) 自动补齐 chat 并校验 messageId', async (t) => {
  const root = makeTempRoot('gw-fetch-msg-')
  const identity = makeIdentity()
  const received = []
  const adapter = makeFakeAdapter({ id: 'feishu' })
  adapter.fetch = async (req) => {
    received.push(req)
    return { messageId: req.messageId, parts: [{ type: 'text', text: '被引用内容' }] }
  }

  const gw = createGateway({
    config: { platforms: { feishu: { enabled: true } } },
    dataDir: (...p) => join(root, 'data', ...p),
    identity,
  })
  gw.register(() => adapter)
  t.after(() => gw.stopAll())
  await gw.sync()

  const msg = await gw.fetch('feishu:group:oc_1', { kind: 'message', messageId: 'om_99' })
  assert.equal(msg.messageId, 'om_99')
  assert.deepEqual(received.at(-1), {
    kind: 'message',
    messageId: 'om_99',
    chat: { kind: 'group', id: 'oc_1' },
  })

  await assert.rejects(
    () => gw.fetch('feishu:private:ou_1', { kind: 'message', messageId: '' }),
    (e) => e.certainty === 'not-sent' && e.code === 'bad-fetch-request',
  )
})
