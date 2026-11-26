import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { identityNote, flatHistory } from '../src/chat/identity.js'
import { cleanOutboundText } from '../src/chat/reply.js'
import { normalize } from '../src/core/config.js'
const dir = mkdtempSync(join(tmpdir(), 'ab-identity-'))
process.env.AURABOT_DATA_DIR = dir
const { createMemoryStore } = await import('../src/features/memory.js')
after(() => rmSync(dir, { recursive: true, force: true }))

test('补读同名群友和机器人：账号、@ 对象及自身标识不丢失', () => {
  const make = (uid, message) => ({ user_id: uid, sender: { user_id: uid, card: '同名用户' }, message })
  const rows = flatHistory([make(10001, [{type:'text',data:{text:'机器人说的'}}]), make(10002, [{type:'at',data:{qq:'10003'}},{type:'text',data:{text:'你做的'}}]), make(10002,[{type:'at',data:{qq:'10001'}},{type:'text',data:{text:'为什么冒充我'}}])], '10001')
  assert.match(rows[0], /^机器人本人·同名用户\(10001\)/)
  assert.match(rows[1], /^群友·同名用户\(10002\)：@10003/)
  assert.match(rows[2], /@了机器人/)
  assert.match(flatHistory([{user_id:123,nickname:'旧格式',raw_message:'旧消息'}], '10001')[0], /旧格式\(123\)：旧消息/)
  assert.deepEqual(flatHistory([null], '10001'), [])
  assert.match(identityNote('10001'), /你的 QQ 号是 10001/)
})

test('用户选择保留 replace 字面量，不新增清理规则', () => {
  assert.equal(cleanOutboundText('<replace>换成原图后还糊'), '<replace>换成原图后还糊')
  assert.equal(cleanOutboundText('示例 `<replace>` 是一个标签'), '示例 `<replace>` 是一个标签')
})

test('新 HTTP 回退策略显式选择，旧配置仍保持 Windows 合约', () => {
  for (const value of ['edge','text']) assert.equal(normalize({voice:{http:{fallback:value}}}).voice.http.fallback,value)
  assert.equal(normalize({}).voice.http.fallback,'windows')
  assert.equal(normalize({voice:{http:{fallback:'invalid'}}}).voice.http.fallback,'windows')
})

test('关闭学来语气只停止注入，不抹掉经历/档案/风格存档；重新打开可恢复', () => {
  let cfg = normalize({memory:{adaptStyle:false}})
  const mem=createMemoryStore({ getConfig:()=>cfg, dsh:{},hub:{speakersOf:()=>[]},log:{info(){},warn(){},debug(){}} })
  mem.setStyle('group:777',['旧口癖甲'])
  mem.setStyle('self',['旧口癖乙'])
  mem.setInsights('group:777',['要互怼卖萌'])
  const chat={kind:'group',groupId:'777',chatId:'group:777'}
  const oldStyles=JSON.stringify(mem.styles()),oldIns=JSON.stringify(mem.insights())
  assert.doesNotMatch(mem.contextFor(chat,''), /本鲸|白米饭|旧口癖乙|互怼/)
  assert.equal(JSON.stringify(mem.styles()),oldStyles); assert.equal(JSON.stringify(mem.insights()),oldIns)
  cfg=normalize({memory:{adaptStyle:true}})
  assert.match(mem.contextFor(chat,''), /旧口癖甲/)
})

test('历史补读兼容 CQ 字符串，带昵称的 @ 仍保留目标账号', () => {
  const rows = flatHistory([
    { user_id: 10002, raw_message: '[CQ:at,qq=10003]你做的[CQ:reply,id=77]' },
    { user_id: 10002, message: '[CQ:at,qq=10001]你怎么看' },
    { user_id: 10002, message: [{ type: 'at', data: { qq: '10003', name: '同名用户' } }, { type: 'text', data: { text: '你做的' } }] },
  ], '10001')
  assert.match(rows[0], /@10003/)
  assert.match(rows[0], /CQ:reply,id=77/)
  assert.match(rows[1], /@了机器人/)
  assert.match(rows[2], /@同名用户\(10003\)/)
})

test('历史格式化可沿用调用方的日期标签', () => {
  let called
  const rows = flatHistory([{ user_id: 10002, time: 1700000000, message: '昨天的消息' }], '10001', {
    clockLabel: at => { called = at; return '[日期标签]' },
  })
  assert.equal(called, 1700000000000)
  assert.match(rows[0], /^\[日期标签\] 群友/)
})
