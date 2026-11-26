// 记忆继承接口：计划 → 一批批交给模型改人称 → 提交勾选的；来源人格的记忆不动，切了人格就作废。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
let fake
let api
let reply = 'normal' // 假模型这次怎么回
const asked = []

// 假模型：只认继承的提示词，把每条记录按「我是大肥鱼，答应 → 我答应过」「大肥鱼说话 → 丢掉」处理
async function* stream({ system, messages }) {
  const text = messages[0].content[0].text
  let out = '[]'
  if (system.includes('换人格时整理记忆')) {
    asked.push({ system, text })
    if (reply === 'garbage') out = '我看不懂'
    else {
      const rows = [...text.matchAll(/^\[([^\]]+)\] (?:[^：\n]{1,24}：)?(.*)$/gm)].map(([, id, t]) => {
        if (t.includes('说话爱用')) return { id, op: 'drop', reason: '旧人格的口癖' }
        if (t.startsWith('我是大肥鱼，')) return { id, op: 'rewrite', text: t.replace('我是大肥鱼，答应', '我答应过'), reason: '改人称' }
        return { id, op: 'keep', reason: '和旧人格无关' }
      })
      out = JSON.stringify(reply === 'skip-one' ? rows.slice(1) : rows)
    }
  }
  yield { type: 'text-delta', text: out }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

before(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-inherit-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9', dir: join(dataDir, 'no-snowluma') },
  }))
  fake = createFakeDsh({ brain: async () => '嗯' })
  fake.ctx.llm.stream = stream
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await fake.call('/persona/save', { id: 'xiaoxing', name: '小星', tags: [], body: '你是小星，温柔安静。' })
  // 大肥鱼（根目录人格）攒下的记忆
  for (const text of ['主人喜欢吃辣', '我是大肥鱼，答应主人六点播报比赛', '大肥鱼说话爱用 hhh']) {
    assert.equal((await fake.call('/memory/add', { text, about: OWNER, aboutName: '主人' })).json().ok, true)
  }
  assert.equal((await fake.call('/profiles/save', { qq: OWNER, text: '小王，我的主人，爱吃辣' })).json().ok, true)
  assert.equal((await fake.call('/persona/use', { id: 'xiaoxing' })).json().ok, true)
})

after(() => {
  fake?.dispose()
  setTimeout(() => process.exit(0), 200).unref()
})

const call = async (path, body) => (await fake.call(path, body)).json()
const memories = async () => (await call('/memories')).items.filter((m) => !m.invalidAt).map((m) => m.text)
async function runAll(plan) {
  const results = []
  for (let index = 0; index < plan.batches.length; index++) {
    const r = await call('/memory/inherit/batch', { from: plan.from, to: plan.to, index })
    assert.equal(r.ok, true, JSON.stringify(r))
    results.push(...r.results)
  }
  return results
}

test('计划：按块列出要整理的，给出调用次数和 token 粗估；不能从自己继承', async () => {
  const plan = await call('/memory/inherit/plan', { from: 'dafeiyu' })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  assert.deepEqual([plan.from, plan.to, plan.fromName, plan.toName], ['dafeiyu', 'xiaoxing', '大肥鱼', '小星'])
  assert.deepEqual(plan.batches.map((b) => [b.label, b.count]), [['记忆', 3], ['人物档案', 1]])
  assert.equal(plan.records, 4)
  assert.equal(plan.calls, 2)
  assert.ok(plan.tokens > 0)
  assert.equal((await call('/memory/inherit/plan', { from: 'xiaoxing' })).ok, false)
  assert.equal((await call('/memory/inherit/plan', { from: 'nobody' })).ok, false)
})

test('整理：提示词按块写、带新人格设定；人称改了、旧人格的口癖丢了', async () => {
  asked.length = 0
  const plan = await call('/memory/inherit/plan', { from: 'dafeiyu' })
  const results = await runAll(plan)
  assert.equal(asked.length, 2, '一块一次')
  assert.match(asked[0].system, /旧人格叫「大肥鱼」，新人格叫「小星」/)
  assert.match(asked[0].system, /你是小星/)
  const byText = Object.fromEntries(results.map((r) => [r.text, r]))
  assert.equal(byText['我是大肥鱼，答应主人六点播报比赛'].next, '我答应过主人六点播报比赛')
  assert.equal(byText['大肥鱼说话爱用 hhh'].op, 'drop')
  assert.equal(byText['主人喜欢吃辣'].op, 'keep')
  assert.deepEqual(await memories(), [], '只是预览，小星还什么都没有')
})

test('提交：只存勾选的，字段照抄；大肥鱼的记忆不动；重复提交不重复', async () => {
  const plan = await call('/memory/inherit/plan', { from: 'dafeiyu' })
  const picks = (await runAll(plan)).filter((r) => r.op === 'keep' || r.op === 'rewrite').map((r) => ({ id: r.id, text: r.next }))
  const r = await call('/memory/inherit/commit', { from: 'dafeiyu', to: 'xiaoxing', items: picks })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.added, 3)
  assert.deepEqual((await memories()).sort(), ['主人喜欢吃辣', '我答应过主人六点播报比赛'].sort())
  const promise = (await call('/memories')).items.find((m) => m.text === '我答应过主人六点播报比赛')
  assert.equal(promise.about, OWNER)
  assert.equal(promise.from.persona, 'dafeiyu')
  assert.ok((await call('/profiles')).list.some((p) => p.qq === OWNER && /爱吃辣/.test(p.text)), '人物档案也继承了')
  const again = await call('/memory/inherit/commit', { from: 'dafeiyu', to: 'xiaoxing', items: picks })
  assert.equal(again.added, 0)
  assert.equal((await memories()).length, 2)
  assert.equal((await call('/persona/use', { id: 'dafeiyu' })).ok, true)
  assert.deepEqual((await memories()).sort(), ['主人喜欢吃辣', '我是大肥鱼，答应主人六点播报比赛', '大肥鱼说话爱用 hhh'].sort(), '来源人格不动')
  assert.equal((await call('/persona/use', { id: 'xiaoxing' })).ok, true)
})

test('模型漏掉的条目标成 missing 带原文；回复不是 JSON 这一批算失败，可以重试', async () => {
  const plan = await call('/memory/inherit/plan', { from: 'dafeiyu' })
  reply = 'skip-one'
  const first = await call('/memory/inherit/batch', { from: plan.from, to: plan.to, index: 0 })
  assert.equal(first.results[0].op, 'missing')
  assert.equal(first.results[0].next, first.results[0].text)
  reply = 'garbage'
  const bad = await call('/memory/inherit/batch', { from: plan.from, to: plan.to, index: 0 })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /记忆这一批没整理成/)
  reply = 'normal'
  assert.equal((await call('/memory/inherit/batch', { from: plan.from, to: plan.to, index: 0 })).ok, true)
})

test('过程中切了人格：批次和提交都拒绝，不会写进别的人格', async () => {
  const plan = await call('/memory/inherit/plan', { from: 'dafeiyu' })
  assert.equal((await call('/persona/use', { id: 'dafeiyu' })).ok, true)
  assert.equal((await call('/memory/inherit/batch', { from: plan.from, to: plan.to, index: 0 })).ok, false)
  const r = await call('/memory/inherit/commit', { from: plan.from, to: plan.to, items: [{ id: 'm:x', text: '不该写进来' }] })
  assert.equal(r.ok, false)
  assert.match(r.message, /人格已经切换了/)
  assert.ok(!(await memories()).includes('不该写进来'))
})
