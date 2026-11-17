// 人格隔离（续）：心情、目的引擎状态、autotelic 账本和日志也是她自己的，跟着人格走。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { createBook } from '../src/autotelic/book.js'
import { createJournal } from '../src/autotelic/reflect.js'

const OWNER = '10000001'
const BOT = '20000002'
let fake
let api
let dataDir
before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-persona-state-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    ext: { purpose: { enabled: true } },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9', dir: join(dataDir, 'no-snowluma') },
  }))
  fake = createFakeDsh({ brain: async () => '嗯' })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await fake.call('/persona/save', { id: 'shoko', name: '翔子', tags: [], body: '你是牧之原翔子。' })
})

after(() => {
  fake?.dispose()
  setTimeout(() => process.exit(0), 200).unref()
})

const use = async (id) => {
  const r = await fake.call('/persona/use', { id })
  assert.equal(r.json().ok, true, r.raw())
}
const shokoDir = (...parts) => join(dataDir, 'persona-data', 'shoko', ...parts)
// 「心里想要」附在本轮消息末尾（和心情一样），不进系统提示词，免得它一变整段缓存失效
const turn = async () => {
  const content = await api.modules.filter('prompt', [{ type: 'text', text: '【私聊】主人：在吗' }], { chat: { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }, sessionId: 's' })
  return content.map((c) => c.text).join('\n')
}
const drives = (dir, need) => {
  mkdirSync(join(dir, 'purpose'), { recursive: true })
  writeFileSync(join(dir, 'purpose', 'purpose-state.json'), JSON.stringify({ drives: { [need]: 0.9 } }))
}

test('心情跟着人格走：大肥鱼开心的原因不带到翔子身上，切回来还在', async () => {
  assert.equal(api.getConfig().persona.dataOwner, 'dafeiyu')
  api.mood.nudge(20, '主人夸她可爱')
  assert.match(api.mood.state().reason, /主人夸她可爱/)
  assert.ok(existsSync(join(dataDir, 'mood.json')), '根目录人格的心情还在老位置')
  await use('shoko')
  assert.doesNotMatch(api.mood.state().reason || '', /主人夸她可爱/)
  api.mood.nudge(-10, '下雨了')
  assert.ok(existsSync(shokoDir('mood.json')))
  await use('dafeiyu')
  assert.match(api.mood.state().reason, /主人夸她可爱/)
})

test('目的引擎的状态跟着人格走：「心里想要什么」只注入到自己身上', async () => {
  await use('dafeiyu')
  drives(dataDir, 'connect')
  assert.match(await turn(), /你最近心里比较想要：陪/)
  await use('shoko')
  assert.doesNotMatch(await turn(), /你最近心里比较想要/, '翔子还没有自己的目的状态')
  drives(shokoDir(), 'share')
  assert.match(await turn(), /你最近心里比较想要：分享/)
  await use('dafeiyu')
  assert.match(await turn(), /你最近心里比较想要：陪/)
})

test('「心里想要」附在本轮消息末尾，不进系统提示词；后台会话不加', async () => {
  await use('dafeiyu')
  drives(dataDir, 'connect')
  for (const kind of ['private', 'social', 'group_owner']) assert.doesNotMatch(fake.variables.get(`aurabot_rules_${kind}`)(), /心里比较想要/, kind)
  const content = await api.modules.filter('prompt', [{ type: 'text', text: '【私聊】主人：在吗' }], { chat: { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }, sessionId: 's' })
  assert.match(content.at(-1).text, /你最近心里比较想要：陪/, '放在最后')
  const system = [{ type: 'text', text: '后台任务' }]
  assert.deepEqual(await api.modules.filter('prompt', system, { chat: { kind: 'system', chatId: 'system:diary' }, sessionId: 's' }), system)
})

test('autotelic 账本按当时的文件取：换了人格就换一本，切回来接着记', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-ledger-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // v5：模块壳按 own() 的目录惰性建账本（getBook），人格一换目录一换就换一本——这里按同样口径验 book 本体
  const mkBook = (file) => createBook({ file, now: () => Date.now() })
  const fileA = join(dir, 'a', 'ledger.json')
  const bA = mkBook(fileA)
  bA.heartbeat('大肥鱼的一拍')
  const fileB = join(dir, 'b', 'ledger.json')
  const bB = mkBook(fileB)
  assert.equal(bB.meta().ticks.length, 0, '翔子的账本是空的')
  bB.heartbeat('翔子的一拍')
  const bA2 = mkBook(fileA)
  assert.deepEqual(bA2.meta().ticks.map((x) => x.outcome), ['大肥鱼的一拍'])
  assert.deepEqual(JSON.parse(readFileSync(fileB, 'utf8')).ticks.map((x) => x.outcome), ['翔子的一拍'])
})

test('autotelic 日志按当时的目录写', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-journal-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let base = join(dir, 'a')
  const journal = createJournal(() => base)
  journal.write('daily', '2026-11-13', '大肥鱼的一天')
  base = join(dir, 'b')
  assert.equal(journal.exists('daily', '2026-11-13'), false)
  base = join(dir, 'a')
  assert.equal(journal.read('daily', '2026-11-13'), '大肥鱼的一天')
})
