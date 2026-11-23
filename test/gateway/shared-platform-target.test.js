import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSharedPlatformTarget } from '../../src/gateway/shared-platform-target.js'

const ownerPersonId = 'p-owner'
const feishuOwner = { platform: 'feishu', account: 'ou_owner' }
const alternateFeishuOwner = { platform: 'feishu', account: 'ou_owner_alt' }

function instanceStatus(instance, overrides) {
  return { instance, platform: 'feishu', enabled: true, state: 'connected', caps: { proactive: 'free' }, ...overrides }
}

function fixture({ accounts = [feishuOwner], instances = [instanceStatus('feishu')], observed = {}, lookup } = {}) {
  return {
    platform: 'feishu', ownerPersonId, sourceChatId: 'qq:private:10001',
    identity: {
      owner: () => ownerPersonId,
      accountsOf: () => accounts,
      lookup: lookup || ((platform, account) => accounts.some(item => item.platform === platform && item.account === account) ? ownerPersonId : null),
    },
    gateway: {
      catalog: () => ['feishu', 'qq', 'qqbot', 'wechat-clawbot'].map(id => ({ id })),
      instances: () => instances,
      routing: { instancesForAccount: (_, account) => observed[account] || [] },
    },
  }
}

test('共享会话指定平台发送：注册的别名指向主人的唯一私聊账号', () => {
  const feishu = fixture()
  assert.deepEqual(resolveSharedPlatformTarget({ ...feishu, platform: ' 飞书 ' }), {
    ok: true, platform: 'feishu', instance: 'feishu', account: 'ou_owner', chatId: 'feishu:private:ou_owner',
  })
  for (const [alias, platform] of [['WeChat', 'wechat-clawbot'], ['微信', 'wechat-clawbot'], ['QQ', 'qq'], ['QQBot', 'qqbot']]) {
    const target = fixture({ accounts: [{ platform, account: 'owner' }], instances: [instanceStatus(platform, { platform })] })
    assert.equal(resolveSharedPlatformTarget({ ...target, platform: alias }).chatId, `${platform}:private:owner`)
  }
  assert.equal(resolveSharedPlatformTarget({ ...feishu, platform: 'outside' }).ok, false)
})

test('共享会话指定平台发送：只接受当前主人的绑定账号和平台', () => {
  const absent = fixture({ accounts: [{ platform: 'qq', account: '10001' }] })
  assert.match(resolveSharedPlatformTarget(absent).error, /没有.*已绑定账号/)
  const normal = fixture()
  assert.match(resolveSharedPlatformTarget({ ...normal, ownerPersonId: 'p-former' }).error, /授权已变化/)
  assert.match(resolveSharedPlatformTarget({ ...normal, account: 'secret-arbitrary' }).error, /未绑定/)
  assert.doesNotMatch(resolveSharedPlatformTarget({ ...normal, account: 'secret-arbitrary' }).error, /secret-arbitrary/)
  assert.match(resolveSharedPlatformTarget({ ...normal, account: 'feishu:group:123' }).error, /未绑定/)
  const stale = fixture({ lookup: () => 'p-other' })
  assert.match(resolveSharedPlatformTarget(stale).error, /没有.*已绑定账号/)
  const self = fixture({ instances: [instanceStatus('feishu', { self: { account: 'ou_owner' } })] })
  assert.match(resolveSharedPlatformTarget(self).error, /没有.*已绑定账号/)
})

test('共享会话指定平台发送：多账号时按固定主账号或显式账号选择', () => {
  const options = fixture({ accounts: [feishuOwner, alternateFeishuOwner, { platform: 'qq', account: '10001' }] })
  const ambiguous = resolveSharedPlatformTarget(options)
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.error, /请指定 account（ou_owner、ou_owner_alt）/)
  assert.doesNotMatch(ambiguous.error, /10001/)
  const ownerPrimary = { mode: 'fixed', platform: 'feishu', account: 'ou_owner_alt' }
  assert.equal(resolveSharedPlatformTarget({ ...options, ownerPrimary }).account, 'ou_owner_alt')
  assert.equal(resolveSharedPlatformTarget({ ...options, ownerPrimary, account: 'ou_owner' }).account, 'ou_owner')
  assert.equal(resolveSharedPlatformTarget({ ...options, ownerPrimary: { ...ownerPrimary, platform: 'qq' } }).ok, false)
  assert.equal(resolveSharedPlatformTarget({ ...options, ownerPrimary: { ...ownerPrimary, mode: 'recent' } }).ok, false)
})

test('共享会话指定平台发送：多实例只用已观测的账号归属', () => {
  const options = fixture({
    instances: [instanceStatus('feishu'), instanceStatus('feishu#2'), instanceStatus('feishu#3')],
    observed: { ou_owner: ['feishu', 'feishu#2'] },
  })
  const ambiguous = resolveSharedPlatformTarget(options)
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.error, /请指定 instance（feishu、feishu#2）/)
  assert.doesNotMatch(ambiguous.error, /feishu#3/)
  const ownerPrimary = { mode: 'fixed', platform: 'feishu', account: 'ou_owner', instance: 'feishu#2' }
  assert.equal(resolveSharedPlatformTarget({ ...options, ownerPrimary }).chatId, 'feishu#2:private:ou_owner')
  assert.equal(resolveSharedPlatformTarget({ ...options, instance: 'feishu', account: 'ou_owner' }).chatId, 'feishu:private:ou_owner')
  assert.match(resolveSharedPlatformTarget({ ...options, instance: 'feishu#3', account: 'ou_owner' }).error, /尚未.*观测到/)
  assert.match(resolveSharedPlatformTarget({ ...options, instance: 'qq' }).error, /未启用或不属于/)
  const unobserved = fixture({ instances: [instanceStatus('feishu'), instanceStatus('feishu#2')] })
  assert.match(resolveSharedPlatformTarget(unobserved).error, /尚未.*观测到/)
  assert.match(resolveSharedPlatformTarget({ ...fixture(), instance: 'feishu' }).error, /尚未.*观测到/)
  const onlyObserved = fixture({ instances: [instanceStatus('feishu'), instanceStatus('feishu#2')], observed: { ou_owner: ['feishu#2'] } })
  assert.equal(resolveSharedPlatformTarget(onlyObserved).instance, 'feishu#2')
})

test('共享会话指定平台发送：目标必须在线可主动发送，当前私聊直接回复', () => {
  const blocked = fixture({ instances: [instanceStatus('feishu', { enabled: false })] })
  assert.match(resolveSharedPlatformTarget(blocked).error, /没有启用/)
  const offline = fixture({ instances: [instanceStatus('feishu', { state: 'closed' })] })
  assert.match(resolveSharedPlatformTarget(offline).error, /未连接/)
  const passive = fixture({ instances: [instanceStatus('feishu', { caps: { proactive: 'none' } })] })
  assert.match(resolveSharedPlatformTarget(passive).error, /无法主动发送/)
  const limited = fixture({ instances: [instanceStatus('feishu', { caps: { proactive: 'limited' } })] })
  assert.equal(resolveSharedPlatformTarget(limited).ok, true)
  const unknownCaps = { ...limited, gateway: { ...limited.gateway, caps: () => null } }
  assert.match(resolveSharedPlatformTarget(unknownCaps).error, /无法主动发送/)
  const sameChat = fixture({ accounts: [{ platform: 'qq', account: '10001' }], instances: [instanceStatus('qq', { platform: 'qq' })] })
  assert.match(resolveSharedPlatformTarget({ ...sameChat, platform: 'qq', sourceChatId: 'private:10001' }).error, /请直接回复/)
})

test('共享会话指定平台发送：扩展别名、目录展示名匹配与不可用平台提示', () => {
  const aliasPairs = [
    ['QQ官方机器人', 'qqbot'],
    ['QQ 官方机器人', 'qqbot'],
    ['qq机器人', 'qqbot'],
    ['wx', 'wechat-clawbot'],
    ['weixin', 'wechat-clawbot'],
    ['微信 ClawBot', 'wechat-clawbot'],
    ['Lark', 'feishu'],
    ['通用接入端', 'bridge'],
    ['桥接', 'bridge'],
  ]
  const catalogWithNames = () => [
    { id: 'feishu', name: '飞书' },
    { id: 'qq', name: 'QQ' },
    { id: 'qqbot', name: 'QQ 官方机器人' },
    { id: 'wechat-clawbot', name: '微信 ClawBot' },
    { id: 'bridge', name: '通用接入端' },
    { id: 'wecom', name: '企业微信' },
  ]
  for (const [alias, platform] of aliasPairs) {
    const base = fixture({ accounts: [{ platform, account: 'owner' }], instances: [instanceStatus(platform, { platform })] })
    const res = resolveSharedPlatformTarget({
      ...base,
      gateway: { ...base.gateway, catalog: catalogWithNames },
      platform: alias,
    })
    assert.equal(res.ok, true, `别名 ${alias} 解析失败：${res.error}`)
    assert.equal(res.platform, platform)
  }

  // 目录 display name 匹配：已注册「企业微信」可命中，未注册时不误映射到个人微信且在错误里列出可用平台
  const wecomFixture = fixture({
    accounts: [{ platform: 'wecom', account: 'u_wecom' }],
    instances: [instanceStatus('wecom', { platform: 'wecom' })],
  })
  const matchedByName = resolveSharedPlatformTarget({
    ...wecomFixture,
    gateway: { ...wecomFixture.gateway, catalog: catalogWithNames },
    platform: '企业微信',
  })
  assert.equal(matchedByName.ok, true)
  assert.equal(matchedByName.platform, 'wecom')

  const missingWithCatalog = resolveSharedPlatformTarget({
    ...fixture(),
    gateway: { ...fixture().gateway, catalog: () => [{ id: 'feishu', name: '飞书' }, { id: 'qqbot', name: 'QQ 官方机器人' }] },
    platform: '企业微信',
  })
  assert.equal(missingWithCatalog.ok, false)
  assert.match(missingWithCatalog.error, /可用平台：feishu（飞书）、qqbot（QQ 官方机器人）/)

  const emptyCatalog = resolveSharedPlatformTarget({
    ...fixture(),
    gateway: { ...fixture().gateway, catalog: () => [] },
    platform: 'outside',
  })
  assert.equal(emptyCatalog.ok, false)
  assert.equal(emptyCatalog.error, '指定的平台不可用，请选择网关已注册的平台')
})
