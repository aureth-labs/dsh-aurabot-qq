// F2：非 QQ 平台默认关闭，白名单支持规范 ChatId / PersonId；QQ 旧裸号仍兼容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkAllowed } from '../src/chat/access.js'

const OWNER = 'p-owner'
const identity = {
  owner: () => OWNER,
  isOwner: (person) => person === OWNER,
  lookup: (platform, account) => (platform === 'feishu' && account === 'ou_owner' ? OWNER : null),
  accountsOf: () => [{ platform: 'feishu', account: 'ou_owner' }],
}

test('非 QQ 私聊默认关闭，只有主人或规范地址/PersonId 白名单放行', () => {
  const cfg = { allow: { private: [], groups: [] } }
  const foreign = { kind: 'private', platform: 'feishu', chatId: 'feishu:private:ou_stranger', userId: 'ou_stranger' }
  assert.equal(checkAllowed(cfg, foreign, identity).allowed, false)

  const owner = { kind: 'private', platform: 'feishu', chatId: 'feishu:private:ou_owner', userId: 'ou_owner', sender: { person: OWNER } }
  assert.equal(checkAllowed(cfg, owner, identity).allowed, true)

  const allowedChat = { ...foreign, chatId: 'feishu:private:ou_ok' }
  assert.equal(checkAllowed({ allow: { private: ['feishu:private:ou_ok'] } }, allowedChat, identity).allowed, true)

  const person = 'p-guest'
  const allowedPerson = { ...foreign, sender: { person } }
  assert.equal(checkAllowed({ allow: { private: [person] } }, allowedPerson, identity).allowed, true)
})

test('非 QQ 群默认关闭，群白名单按规范 ChatId 生效', () => {
  const g = { kind: 'group', platform: 'feishu', chatId: 'feishu:group:oc_1', groupId: 'oc_1' }
  assert.equal(checkAllowed({ allow: { groups: [] } }, g, identity).allowed, false)
  assert.equal(checkAllowed({ allow: { groups: ['feishu:group:oc_1'] } }, g, identity).allowed, true)
})

test('QQ 旧裸号白名单继续可用', () => {
  const qq = { kind: 'private', platform: 'qq', chatId: 'qq:private:10001', userId: '10001' }
  assert.equal(checkAllowed({ allow: { private: ['10001'] } }, qq, identity).allowed, true)
  assert.equal(checkAllowed({ allow: { private: ['feishu:private:10001'] } }, qq, identity).allowed, false)
})
