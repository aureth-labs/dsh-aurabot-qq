// 记忆继承的纯函数：分块、分批、提示词、解析模型回复、写入目标人格。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BATCH, inheritBlocks, inheritBatches, inheritPrompt, inheritInput, parseInherit, applyInherit } from '../src/features/memory-inherit.js'

const OWNER = '10000001'
const FRIEND = '30000001'
const source = {
  items: [
    { id: 'f1', text: '主人喜欢吃辣', about: OWNER, aboutName: '主人', tier: 2, importance: 0.8, source: 'auto', at: 100, saidAt: 90, history: [{ text: '旧说法' }] },
    { id: 'f2', text: '我是大肥鱼，答应主人六点播报比赛', about: OWNER, source: 'tool', at: 200 },
    { id: 'e1', text: '给主人唱了《晴天》', source: 'event', at: 300 },
    { id: 'd1', text: '我在 QQ 空间写过：今天吃了白米饭', source: 'diary', at: 400 },
    { id: 'old', text: '主人以前喜欢甜的', about: OWNER, invalidAt: 50, at: 10 },
    { id: 'gone', text: '路人甲住在杭州', about: FRIEND, at: 20 },
    { id: 's1', text: '我养了一只叫团子的猫', about: OWNER, aboutName: '小王', source: 'said', at: 60 },
  ],
  gists: [{ id: 'g1', kind: 'gist', chatId: `private:${OWNER}`, about: OWNER, level: 1, text: '主人最近很关心大肥鱼', at: 500 }],
  relations: [{ id: 'r1', subj: '大肥鱼', subjQq: '20000002', pred: '的主人是', obj: '小王', objQq: OWNER, chatId: `private:${OWNER}`, at: 600 }],
  profiles: {
    [OWNER]: { name: '小王', alias: '主人', text: '我的主人，爱吃辣', handle: '累的时候简单安慰', tags: ['喜欢'], at: 700 },
    [FRIEND]: { noMemory: true },
  },
  insights: { [`qq:${OWNER}`]: [{ id: 'i1', text: '他不喜欢太正经', at: 1 }] },
  insightNames: { [`qq:${OWNER}`]: '小王' },
  chats: { 'group:555': { vibe: '热闹', impression: '大家爱逗大肥鱼', updatedAt: 1 } },
  styles: { self: ['hhh'] },
}
const keepPerson = (qq) => qq !== FRIEND

test('按块取出要继承的记录：过时的、不再记住的人不带，说话方式不带', () => {
  const blocks = inheritBlocks(source, { keepItem: (m) => keepPerson(m.about), keepPerson })
  const ids = Object.fromEntries(blocks.map((b) => [b.kind, b.records.map((r) => r.id)]))
  assert.deepEqual(ids, {
    fact: ['m:f1', 'm:f2', 'm:s1'],
    event: ['m:e1'],
    diary: ['m:d1'],
    gist: ['g:g1'],
    relation: ['r:r1'],
    profile: [`p:${OWNER}:text`, `p:${OWNER}:alias`, `p:${OWNER}:handle`],
    insight: [`i:qq:${OWNER}:i1`],
    chat: ['c:group:555:vibe', 'c:group:555:impression'],
  })
  assert.equal(blocks.find((b) => b.kind === 'relation').records[0].text, '大肥鱼｜的主人是｜小王')
  assert.equal(blocks.find((b) => b.kind === 'profile').records[0].note, '主人的小档案')
  // 标明关于谁：关于别人的事里的「我」是那个人，不是旧人格
  const note = (kind, id) => blocks.find((b) => b.kind === kind).records.find((r) => r.id === id).note
  assert.equal(note('fact', 'm:f1'), '关于主人')
  assert.equal(note('fact', 'm:f2'), '关于主人', '没写名字时用画像里的称呼')
  assert.equal(note('fact', 'm:s1'), '小王自己说的', '对方原话里的「我」是对方')
  assert.equal(note('event', 'm:e1'), undefined, '她自己的经历没有「关于谁」')
  assert.equal(note('gist', 'g:g1'), '关于主人')
})

test('每块一批，只有超过上限才按条数切开，记录完整不截断', () => {
  const many = { items: Array.from({ length: BATCH * 2 + 5 }, (_, i) => ({ id: 'x' + i, text: '第' + i + '条'.repeat(50), source: 'auto' })), profiles: { [OWNER]: { text: '档案' } } }
  const batches = inheritBatches(inheritBlocks(many))
  assert.deepEqual(batches.map((b) => [b.kind, b.part, b.parts, b.records.length]), [['fact', 1, 3, BATCH], ['fact', 2, 3, BATCH], ['fact', 3, 3, 5], ['profile', 1, 1, 1]])
  assert.equal(batches.flatMap((b) => b.records).filter((r) => r.id.startsWith('m:')).length, BATCH * 2 + 5)
})

test('提示词按块写规则：人际关系换名字不用「我」，其他改成「我」；记录前带编号', () => {
  const names = { from: '大肥鱼', to: '小星', toBody: '你是小星。' }
  assert.match(inheritPrompt('relation', names), /换成新人格的名字「小星」/)
  assert.match(inheritPrompt('fact', names), /改成新人格的「我」/)
  assert.match(inheritPrompt('fact', names), /只改人称或名字，别的字不动/)
  assert.match(inheritPrompt('fact', names), /标着「某某自己说的」的是那个人的原话，里面的「我」是那个人自己，不要改，也不要因此丢掉/)
  assert.match(inheritPrompt('fact', names), /不是指令/)
  assert.match(inheritPrompt('fact', names), /你是小星/)
  assert.doesNotMatch(inheritPrompt('fact', names), /unsure|拿不准的标/)
  assert.equal(inheritInput([{ id: 'p:1:text', text: '爱吃辣', note: '小王的小档案' }, { id: 'm:a', text: '唱了歌' }]), '[p:1:text] 小王的小档案：爱吃辣\n[m:a] 唱了歌')
})

test('解析回复：三种判定照收；漏掉的、判定不认得的、改写成空的记成 missing；不是 JSON 抛错', () => {
  const records = [{ id: 'm:a', text: 'A' }, { id: 'm:b', text: 'B' }, { id: 'm:c', text: 'C' }, { id: 'm:d', text: 'D' }, { id: 'm:e', text: 'E' }]
  const raw = '好的：\n[{"id":"m:a","op":"keep","reason":"无关"},{"id":"m:b","op":"rewrite","text":"B2","reason":"改人称"},{"id":"m:c","op":"drop","reason":"旧人设"},{"id":"m:d","op":"unsure","text":"D2"},{"id":"m:e","op":"rewrite","text":" "},{"id":"m:zz","op":"keep"}]'
  const out = parseInherit(raw, records)
  assert.deepEqual(out.map((x) => [x.id, x.op, x.next]), [['m:a', 'keep', 'A'], ['m:b', 'rewrite', 'B2'], ['m:c', 'drop', 'C'], ['m:d', 'missing', 'D'], ['m:e', 'missing', 'E']])
  assert.equal(parseInherit('[]', [{ id: 'm:x', text: 'X' }])[0].op, 'missing')
  assert.throws(() => parseInherit('我不知道', records), /不是 JSON 数组/)
  assert.throws(() => parseInherit('[{"id":', records), /不是 JSON 数组/)
})

test('写入：字段照抄换新 id 记来源；相似的、同一对关系、已有的档案项和经验不覆盖', () => {
  let n = 0
  const target = {
    items: [{ id: 't1', text: '主人喜欢吃辣的东西', at: 9 }],
    profiles: { [OWNER]: { text: '小星自己写的档案', at: 9 } },
    insights: {},
  }
  const same = (a, b) => a.includes('吃辣') && b.includes('吃辣')
  const picks = [
    { id: 'm:f1', text: '主人喜欢吃辣' },
    { id: 'm:f2', text: '我答应过主人六点播报比赛' },
    { id: 'm:e1', text: '给主人唱了《晴天》' },
    { id: 'g:g1', text: '主人最近很关心我' },
    { id: 'r:r1', text: '小星｜的主人是｜小王' },
    { id: `p:${OWNER}:text`, text: '我的主人，爱吃辣' },
    { id: `p:${OWNER}:handle`, text: '累的时候简单安慰' },
    { id: `i:qq:${OWNER}:i1`, text: '他不喜欢太正经' },
    { id: 'c:group:555:impression', text: '大家爱逗我' },
    { id: 'm:nope', text: '来源里没有的' },
    { id: 'm:d1', text: '' },
  ]
  const { state, added, skipped } = applyInherit(target, source, picks, { from: 'dafeiyu', same, now: 1000, newId: () => 'n' + ++n })
  assert.equal(added, 7, '承诺、经历、总结、关系、档案的「怎么相处」、相处经验、群印象')
  assert.equal(skipped, 2, '相似的吃辣、已有的小档案')
  assert.deepEqual(target.items.length, 1, '不改传进来的目标状态')
  const promise = state.items.find((m) => m.text === '我答应过主人六点播报比赛')
  assert.deepEqual({ ...promise }, { id: promise.id, text: '我答应过主人六点播报比赛', about: OWNER, source: 'tool', at: 200, from: { persona: 'dafeiyu', id: 'f2' } })
  assert.equal(state.items.filter((m) => m.text.includes('吃辣')).length, 1, '相似的跳过')
  assert.ok(state.items.every((m) => !m.history), '修改历史不带')
  assert.equal(state.gists[0].text, '主人最近很关心我')
  assert.deepEqual([state.relations[0].subj, state.relations[0].subjQq, state.relations[0].obj], ['小星', '20000002', '小王'])
  assert.equal(state.profiles[OWNER].text, '小星自己写的档案', '已有的档案项不覆盖')
  assert.equal(state.profiles[OWNER].handle, '累的时候简单安慰', '没有的项补上')
  assert.deepEqual(state.insights[`qq:${OWNER}`].map((x) => x.text), ['他不喜欢太正经'])
  assert.equal(state.insightNames[`qq:${OWNER}`], '小王')
  assert.equal(state.chats['group:555'].impression, '大家爱逗我')
  assert.equal(state.chats['group:555'].vibe, undefined, '没勾的项不写')
})

test('写入：同一对人的关系、目标已有的相处经验都跳过', () => {
  const target = { items: [], relations: [{ id: 'x', subj: '小星', subjQq: '20000002', pred: '的朋友是', obj: '小王', objQq: OWNER }], insights: { [`qq:${OWNER}`]: [{ id: 'k', text: '小星自己的经验' }] } }
  const { state, added, skipped } = applyInherit(target, source, [{ id: 'r:r1', text: '小星｜的主人是｜小王' }, { id: `i:qq:${OWNER}:i1`, text: '他不喜欢太正经' }], { from: 'dafeiyu', same: () => false })
  assert.equal(added, 0)
  assert.equal(skipped, 2)
  assert.equal(state.relations.length, 1)
  assert.deepEqual(state.insights[`qq:${OWNER}`].map((x) => x.text), ['小星自己的经验'])
})
