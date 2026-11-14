// F2：新平台第一次私聊带一次交接摘要，只用这个人的其他平台私聊，不带群聊/别人。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdentity } from '../src/gateway/identity.js'
import { createHandover } from '../src/features/handover.js'

test('交接摘要只读同一人的其他平台私聊，且只做一次', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'f2-handover-'))
  process.env.AURABOT_DATA_DIR = dataDir
  const identity = createIdentity({ dataDir: join(dataDir, 'gw'), log: { info() {}, warn() {}, debug() {} } })
  const owner = identity.claimOwner('feishu', 'ou_owner')
  identity.link('qq', '10001', owner, 'owner')
  const today = new Date()
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  mkdirSync(join(dataDir, 'chatlog'), { recursive: true })
  const t = Date.now() - 60_000
  writeFileSync(join(dataDir, 'chatlog', `${day}.jsonl`), [
    { t, chatId: 'feishu:private:ou_owner', who: 'user', text: '飞书里说过喜欢下雨' },
    { t: t + 1, chatId: 'feishu:group:oc_1', who: 'user', text: '群里说过的秘密' },
    { t: t + 2, chatId: 'qq:private:20002', who: 'user', text: '别人私聊的内容' },
    { t: t + 3, chatId: 'qq:private:10001', who: 'bot', text: '旧平台的机器人回复' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n')

  let prompt = ''
  const h = createHandover({
    dsh: {},
    getConfig: () => ({ ownerName: '主人', memory: { enabled: true } }),
    identity,
    ask: async (_dsh, opts) => { prompt = opts.text; return '你记得她喜欢下雨。' },
    log: { warn() {} },
  })
  const summary = await h.contextFor(owner, 'bridge', 'bridge:private:ou_owner')
  assert.match(summary, /从别处带来的印象/)
  assert.match(prompt, /喜欢下雨/)
  assert.doesNotMatch(prompt, /群里说过的秘密|旧平台的机器人回复/)
  assert.doesNotMatch(prompt, /qq:private:20002/)
  assert.equal(await h.contextFor(owner, 'bridge', 'bridge:private:ou_owner'), '')
})
