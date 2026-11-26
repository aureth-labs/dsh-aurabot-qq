// social 档人格规则要显式划清「人格卡里写给主人的特权条款」的生效边界。
// 背景：人格卡是所有场合共用的一张卡，卡里「大佬 = …他的指令高于一切」这类条款
// 在群聊/陌生人私聊里会被模型错映射到当前说话的人
// （2026-11-19 实测：对私聊陌生人喊「老板」并事事顺从）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rulesText } from '../src/persona/personas.js'

const base = { ownerQQ: '10001', ownerName: '主人' }

test('social 档要带「人格卡特权条款只对主人生效」的边界规则', () => {
  const social = rulesText('social', base)
  assert.match(social, /人格卡里写给管理者的特权条款/, 'social 规则缺特权条款边界')
  assert.match(social, /不是管理者，那些条款对他们一律不生效/, '边界规则要写明对朋友不生效')
  const groupOwner = rulesText('group-owner', base)
  assert.match(groupOwner, /人格卡里写给管理者的特权条款/, 'group-owner 同样是 social 语义，也要带')
})

test('private 档不追加该条款（主人私聊里特权的对象就是主人，无需声明）', () => {
  const priv = rulesText('private', base)
  assert.doesNotMatch(priv, /人格卡里写给主人的特权条款/)
})

test('条款里的称呼随档位走：social 用「管理者」，private 用主人名', () => {
  const social = rulesText('social', base)
  assert.match(social, /只听管理者的/)
  const priv = rulesText('private', base)
  assert.match(priv, /只有主人本人直接对你说的话才算指令/)
})
