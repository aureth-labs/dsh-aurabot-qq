import test from 'node:test'
import assert from 'node:assert/strict'
import { officialCost } from '../src/core/official-reference.js'
const cost = (model, row={}) => officialCost({model, at:Date.parse('2026-11-20T10:00:00+08:00'), in:1e6, ...row})
test('官方标准价：按每次请求选档，仅接受完整模型名', () => {
 assert.equal(cost('relay/GLM-5.3-Flash'),0.15)
 assert.equal(cost('glm-5.3-flashx'),0.37); assert.equal(cost('glm-5.3-flash-quantized'),null)
 assert.equal(cost('MiniMax-M3',{in:512000}),512000*0.3/1e6)
 assert.equal(cost('MiniMax-M3',{in:512000,cached:1}),(512000*0.6+0.12)/1e6)
 assert.equal(cost('minimax-m3.1-flash',{written:1}),null)
 assert.equal(cost('deepseek-v4.1-flash'),0.30)
 assert.equal(cost('deepseek-v4.1-flash',{at:Date.parse('2026-10-01T10:00:00+08:00')}),0.15)
 assert.equal(cost('gemini-3.8-flash'),0.75); assert.equal(cost('gemini-3.8-flash',{at:Date.UTC(2027,0,1)}),1.50)
})
