import { test } from 'node:test'
import assert from 'node:assert/strict'
import { privateCapabilityAllowed } from '../src/chat/access.js'
import { normalize } from '../src/core/config.js'

test('功能授权要求私聊白名单和对应功能名单同时匹配', () => {
  const cfg = normalize({ allow: { private: ['12345'] }, capabilityAllow: { image: ['12345', '99999'], song: ['12345'] } })
  assert.equal(privateCapabilityAllowed(cfg, { kind: 'private', userId: '12345' }, 'image'), true)
  assert.equal(privateCapabilityAllowed(cfg, { kind: 'private', userId: '12345' }, 'song'), true)
  assert.equal(privateCapabilityAllowed(cfg, { kind: 'private', userId: '12345' }, 'video'), false)
  assert.equal(privateCapabilityAllowed(cfg, { kind: 'private', userId: '99999' }, 'image'), false)
  assert.equal(privateCapabilityAllowed(cfg, { kind: 'group', userId: '12345' }, 'image'), false)
})

test('非 QQ 私聊功能授权认规范 ChatId / PersonId，不被裸 ID 跨平台误放行', () => {
  const cfg = normalize({
    allow: { private: ['12345', 'feishu:private:ou_ok', 'ou_bare'] },
    capabilityAllow: { video: ['12345', 'feishu:private:ou_ok', 'ou_bare'] },
  })
  assert.equal(privateCapabilityAllowed(cfg, { chatId: 'feishu:private:ou_ok', platform: 'feishu', kind: 'private', userId: 'ou_ok' }, 'video'), true)
  assert.equal(privateCapabilityAllowed(cfg, { chatId: 'feishu:private:ou_bare', platform: 'feishu', kind: 'private', userId: 'ou_bare' }, 'video'), false)
  assert.equal(privateCapabilityAllowed(cfg, { chatId: 'feishu:private:12345', platform: 'feishu', kind: 'private', userId: '12345' }, 'video'), false)
})
