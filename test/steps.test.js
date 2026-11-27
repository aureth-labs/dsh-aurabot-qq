// 一轮多段正文的两个补法：每段都发（chat.everyStep）、从思考里捞定稿（chat.rescueFromThinking）。
// 两个开关都默认关，所以这里只测「打开以后按什么规则工作」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { takeInterim, reasoningOf, rescueFromThinking, everyStepMode, mergeStepText, similarText } from '../src/chat/steps.js'

const blank = () => ({ interimTurn: -1, interimText: '', interimStep: -1 })

test('每段都发：第一段没有上一段可发', () => {
  const st = blank()
  assert.equal(takeInterim(st, { turn: 1, step: 1, text: '第一句' }), null)
  assert.equal(st.interimText, '第一句')
  assert.equal(st.interimStep, 1)
})

test('每段都发：第二步时把上一段交出来', () => {
  const st = blank()
  takeInterim(st, { turn: 125, step: 1, text: '能接，而且不用动 ASR 主体：librosa 只负责算特征…' })
  assert.equal(takeInterim(st, { turn: 125, step: 2, text: '哦，原来夸的是「两条语音都读对了」' }), '能接，而且不用动 ASR 主体：librosa 只负责算特征…')
})

test('每段都发：三个 step 依次把前两段发出去，最后一段留给 turn/end', () => {
  const st = blank()
  assert.equal(takeInterim(st, { turn: 7, step: 1, text: 'A' }), null)
  assert.equal(takeInterim(st, { turn: 7, step: 2, text: 'B' }), 'A')
  assert.equal(takeInterim(st, { turn: 7, step: 3, text: 'C' }), 'B')
  assert.equal(st.interimText, 'C', '最后一段留在状态里，由 turn/end 发')
})

test('每段都发：同样的话不重复发', () => {
  const st = blank()
  takeInterim(st, { turn: 3, step: 1, text: '一样的话' })
  assert.equal(takeInterim(st, { turn: 3, step: 2, text: '一样的话' }), null)
})

test('每段都发：跨轮不发（上一轮最后一段已经发过了）', () => {
  const st = blank()
  takeInterim(st, { turn: 3, step: 1, text: '上一轮的话' })
  assert.equal(takeInterim(st, { turn: 4, step: 1, text: '这一轮的话' }), null)
  assert.equal(st.interimText, '这一轮的话')
})

test('每段都发：step 没递增就不发（同一步重复事件、或事件乱序）', () => {
  const st = blank()
  takeInterim(st, { turn: 5, step: 2, text: '第二段' })
  assert.equal(takeInterim(st, { turn: 5, step: 2, text: '第二段改了口' }), null)
  assert.equal(takeInterim(st, { turn: 5, step: 1, text: '更早的一段' }), null)
})

test('每段都发：空正文不动状态', () => {
  const st = blank()
  takeInterim(st, { turn: 9, step: 1, text: '有内容' })
  assert.equal(takeInterim(st, { turn: 9, step: 2, text: '   ' }), null)
  assert.equal(st.interimText, '有内容', '空的一段不该把上一段顶掉')
  assert.equal(st.interimStep, 1)
})

test('每段都发：没有 step 号（老事件）不发', () => {
  const st = blank()
  takeInterim(st, { turn: 11, step: 1, text: 'A' })
  assert.equal(takeInterim(st, { turn: 11, step: undefined, text: 'B' }), null)
})

test('思考：只取 reasoning 块，不混正文', () => {
  const message = { content: [{ type: 'reasoning', text: '先想一下' }, { type: 'text', text: '要说的话' }] }
  assert.equal(reasoningOf(message), '先想一下')
  assert.equal(reasoningOf({ content: [{ type: 'text', text: '只有正文' }] }), '')
  assert.equal(reasoningOf(null), '')
})

test('捞回定稿：turn 131 那种「草稿 → 自检 → 定稿」', () => {
  const thinking = [
    'Devil: 鲸汐动态都是宝 — their dynamic posts are treasures (full of memes/stickers).',
    '',
    'Reply: 那我得常去翻——上回在她专栏评论区捞着两张会动的（鲸浪小姐卷成一团、结尾那张蛋糕图），这次又是白米饭<sticker:开心>',
    '要不我隔几天去扫一次，把会动的都收进来？你看合适吗。',
    '',
    "Careful: don't overpromise; she posts 动态 (opus), stickers in 评论区.",
    '',
    '3 lines:',
    '那可得常去翻——上一回在她专栏评论区捞到两张会动的（卷成一团的鲸浪小姐、结尾那张蛋糕），这回又是白米饭配我<sticker:开心>',
    '她的东西有个好处：梗都摆得明白，一看就知道在玩什么',
    '要不我隔几天去扫一遍她的动态和评论区，把会动的都收着，收的时候顺手记清出处',
  ].join('\n')
  const out = rescueFromThinking(thinking)
  assert.match(out, /^那可得常去翻/, '要的是定稿那版，不是 Reply 草稿')
  assert.match(out, /顺手记清出处$/)
  assert.ok(!out.includes('Careful'), '自检的英文旁白不该带出去')
  assert.ok(!out.includes('Reply:'), '草稿不该带出去')
  assert.ok(!out.includes('Devil:'), '对谁说的旁白不该带出去')
})

test('捞回定稿：没有定稿标记就不发（宁可不发也不发草稿）', () => {
  assert.equal(rescueFromThinking('Reply: 随便回一句\n\nCareful: 别乱说'), '')
  assert.equal(rescueFromThinking('只有内心独白，没有定稿'), '')
  assert.equal(rescueFromThinking(''), '')
  assert.equal(rescueFromThinking(null), '')
})

test('捞回定稿：中文行数标记也认', () => {
  const thinking = 'Reply: 草稿一版\n\n三行：\n第一句\n第二句\n第三句'
  assert.equal(rescueFromThinking(thinking), '第一句\n第二句\n第三句')
})

test('捞回定稿：定稿后面又跟了自检，要截掉', () => {
  const thinking = '2 lines:\n甲\n乙\n\nCareful: 别过头'
  assert.equal(rescueFromThinking(thinking), '甲\n乙')
})

test('捞回定稿：多个定稿标记时取最后一个', () => {
  const thinking = '3 lines:\n旧的一版\n\n后来改成：\n2 lines:\n新的一版上\n新的一版下'
  assert.equal(rescueFromThinking(thinking), '新的一版上\n新的一版下')
})

test("每段都发='auto'：纯对话轮照常分条（本轮没有工具调用）", () => {
  assert.equal(everyStepMode('auto', { sawToolCall: false }), true)
})

test("每段都发='auto'：这一轮调过工具就不分条（过程话并进最终回复）", () => {
  const st = { sawToolCall: true }
  assert.equal(everyStepMode('auto', st), false)
  // 老事件里没有这个字段时按「没调过工具」处理
  assert.equal(everyStepMode('auto', {}), true)
})

test("每段都发：true/false 语义不变，'auto' 之外的字符串按关闭处理", () => {
  assert.equal(everyStepMode(true, {}), true)
  assert.equal(everyStepMode(false, {}), false)
  assert.equal(everyStepMode(undefined, {}), false)
  assert.equal(everyStepMode('on', {}), true, "非空字符串仍是旧行为（Boolean('on')=true）")
})

test('不分条时的攒段：两段都留下，用空行分开（工具轮丢中间段那次现场）', () => {
  const a = '是我发的，不是子代理。那是我自己整理后发出去的。'
  const b = '证据站得住，不过有一条推理我还没完全接受。'
  const merged = mergeStepText(mergeStepText('', a), b)
  assert.ok(merged.includes('是我发的'), '前一段不能丢')
  assert.ok(merged.includes('证据站得住'), '后一段也要在')
  assert.equal(merged, `${a}\n\n${b}`)
})

test('不分条时的攒段：重复段不重复拼', () => {
  assert.equal(mergeStepText('A 段', 'A 段'), 'A 段')
  assert.equal(mergeStepText('前一句。后一句。', '后一句。'), '前一句。后一句。')
  assert.equal(mergeStepText('短的旧稿', '长的旧稿短的旧稿'), '长的旧稿短的旧稿', '后一段已包含前一段时取后一段')
})

test('近似判定：同一份结果复述两遍 → 高相似，真补充 → 低相似', () => {
  const a = '核完了：四篇里一共 117 条能核对的事实，对上 103 条，部分对 8 条，对不上 4 条，本机查不到 2 条。'
  const b = '核对完了，报告在报告.md。一共核了 117 条，对上 103 条，部分对 8 条，对不上 4 条，本机查不到 2 条。'
  const c = '另外还有一条我拿不准：8.18 那天日记里写的天气和你说的对不上。'
  assert.ok(similarText(a, b) >= 0.45, `复述应高相似，实际 ${similarText(a, b).toFixed(2)}`)
  assert.ok(similarText(a, c) < 0.45, `补充应低相似，实际 ${similarText(a, c).toFixed(2)}`)
  assert.equal(similarText(a, a), 1)
  assert.equal(similarText('', a), 0)
})
