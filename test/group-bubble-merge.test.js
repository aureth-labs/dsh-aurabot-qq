// 群聊里一段回复最多 3 条（防刷屏）。以前超出的直接 slice 掉、不留痕：
// 2026-11-16 20:53 那次，②③ 和结尾一句就是这么没的。现在改成整段并成一条发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'aurabot-groupmerge-'))
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
process.env.AURABOT_DATA_DIR = mkdtempSync(join(root, 'data-'))

const { normalize } = await import('../src/core/config.js')
const { createFakeDsh } = await import('./helpers/fake-dsh.js')
const { createHub } = await import('../src/chat/hub.js')

const OWNER = '10000001'
const OTHER = '10000002'
const GROUP = '685164226'
const log = { info () {}, warn () {}, debug () {}, error () {} }

// 真实那次回复（会话原文，219 字），parseReply 会拆成 5 条
const REPLY = `翻了，三格：

① 右边：哎——见过赫尔塔本体之后，再看人偶赫尔塔，真是乖得可爱呀！
左边：什么？你还有这种爱好？真没救了！

② 右边：反正有两百多具呢，带一具回去也没关系吧？可以吧！
中间：……嘛，要是你的话，给你一具也不是不行……
小字：真的！？

③ 右：既然要送，那——
左：你得说句「我想要本体」才行啊，不然多没意思。
左下小字：啊……果然还是麻烦事……

就是赫尔塔在逗人，趁她要东西的时候讨价还价，看完感觉自己被绕进去了。`

function config () {
  return normalize({
    enabled: true, dryRun: false, setupDone: true, ownerQQ: OWNER, botQQ: '20000002',
    allow: { private: [OTHER], groups: [GROUP] }, voice: { enabled: false }, merge: { enabled: false },
    stickers: { collect: false, autoChance: 0 }, snowluma: { autoStart: false, autoAttach: false, dir: join(root, 'no-snowluma') },
  })
}

async function deliver (t, chatId) {
  const sent = []
  const onebot = { connected: true, async call (action, params) { sent.push(params); return { message_id: sent.length } } }
  const fake = createFakeDsh({ brain: async () => '' })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => config(), log, onebot })
  t.after(() => { try { hub.dispose?.() } finally { fake.dispose() } })
  await hub.deliver(chatId, REPLY, { own: true })
  const texts = sent.map((p) => (p.message || []).map((s) => s.data?.text ?? `[${s.type}]`).join(''))
  return { sent, texts }
}

test('群聊里超过 3 条时并成一条发，②③ 不再消失', { timeout: 20000 }, async (t) => {
  const { texts } = await deliver(t, `group:${GROUP}`)
  assert.equal(texts.length, 1, '群聊里这一段应当只发 1 条')
  const joined = texts.join('\n')
  for (const needle of ['②', '③', '就是赫尔塔在逗人']) {
    assert.ok(joined.includes(needle), `合并后应当包含「${needle}」`)
  }
})

test('私聊节奏不变：还是逐条发', { timeout: 20000 }, async (t) => {
  const { texts } = await deliver(t, `private:${OTHER}`)
  assert.ok(texts.length > 3, `私聊仍按原样分条（实际 ${texts.length} 条）`)
})
