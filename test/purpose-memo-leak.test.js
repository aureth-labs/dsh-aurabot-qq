// 目的引擎备忘泄漏兜底：普通回复里复读【目的】备忘块时，出站清洗要整段拦下。
// 背景：#446 之后目的回合直接在她的聊天会话里跑（runTurnInChat），目的提示词模板
// 与带备忘的回答留在会话历史里，之后普通回复模型照猫画虎也写备忘——
// 而普通回复不走目的模块的 cleanReply，必须由统一出站清洗兜底
// （2026-11-19 实测：备忘原文被发到 QQ，对方问「你咋还出现状态栏嘞」）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanOutboundText } from '../src/chat/reply.js'

test('备忘块：出现多个备忘头时，从第一个头连到末尾整段删除', () => {
  const leak = '合着你搁这扮二郎神呢 那我可等着了\n\n【目的】他自报我是杨戬，我接住身份梗继续斗嘴\n【需求】玩 / 陪\n【情绪】轻松，被逗乐，跃跃欲试\n【感受】玩+0.10 陪+0.05 喜+0.03\n【类型】分享\n【状态】待续\n【持续】还想弄清他看的哪版杨戬'
  assert.equal(cleanOutboundText(leak), '合着你搁这扮二郎神呢 那我可等着了')
})

test('备忘块：带前缀的变体（【感受】在前）同样从第一个头删起', () => {
  const leak = '行 快去看 上课别迟到\n【感受】陪+0.05 玩+0.05\n【目的】送走他并惦记他下课回来'
  assert.equal(cleanOutboundText(leak), '行 快去看 上课别迟到')
})

test('备忘块：只出现 1 个备忘头不误伤（正文可能真在聊这些词）', () => {
  const one = '我今天【状态】不太好，别理我'
  assert.equal(cleanOutboundText(one), one)
  const chat = '说说你这次的目的和需求呗'
  assert.equal(cleanOutboundText(chat), chat)
})

test('备忘块：删完整段是空白时按沉默处理（返回空串）', () => {
  const only = '【目的】无\n【需求】无\n【状态】跳过\n【待续】无'
  assert.equal(cleanOutboundText(only), '')
})
