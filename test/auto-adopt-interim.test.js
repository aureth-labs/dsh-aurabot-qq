// #585 遗留边界：'auto' 模式下一轮先说话（分条），随后调了工具（翻成并条）——
// 第一段还没发出去，必须收进 mergedText，不能整段丢。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adoptInterim, mergeStepText, everyStepMode } from '../src/chat/steps.js'

const st = (patch = {}) => ({ interimTurn: -1, interimText: '', interimStep: -1, ...patch })

test("'auto'：先有一段的轮次，遇工具调用后按并条处理（前提）", () => {
  const s = { sawToolCall: true }
  assert.equal(everyStepMode('auto', s), false)
})

test('同轮待发的那段会被收回来，并清掉 interim', () => {
  const s = st({ interimTurn: 3, interimText: '第一段：我先说一句', interimStep: 1 })
  const adopted = adoptInterim(s, { turn: 3, step: 2 })
  assert.equal(adopted, '第一段：我先说一句')
  assert.equal(s.interimText, '')
  assert.equal(s.interimStep, -1)
  // 并进 mergedText 后，最终回复两段都在
  assert.equal(mergeStepText(adopted, '第二段：工具跑完了'), '第一段：我先说一句\n\n第二段：工具跑完了')
})

test('不是同一轮、没有待发文本、或当前步不比它新时不收', () => {
  assert.equal(adoptInterim(st({ interimTurn: 2, interimText: '旧轮', interimStep: 1 }), { turn: 3, step: 2 }), '')
  assert.equal(adoptInterim(st({ interimTurn: 3, interimText: '', interimStep: 1 }), { turn: 3, step: 2 }), '')
  assert.equal(adoptInterim(st({ interimTurn: 3, interimText: '同一步', interimStep: 2 }), { turn: 3, step: 2 }), '')
})

test('收过一次后再收是空的（不会重复并进最终回复）', () => {
  const s = st({ interimTurn: 3, interimText: '一段', interimStep: 1 })
  assert.equal(adoptInterim(s, { turn: 3, step: 2 }), '一段')
  assert.equal(adoptInterim(s, { turn: 3, step: 3 }), '')
})
