// #256：Codex 生图模型名只校验格式，不再按固定白名单静默改成 gpt-image-2。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from '../src/core/config.js'

const codexModel = (model) => normalize({ imageGen: { provider: 'codex', codex: { model } } }).imageGen.codex.model

test('预设之外的合法模型名原样保留', () => {
  for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.6-flare', 'example-future-model', 'openai/gpt-image-3', 'my-model_v2.1']) {
    assert.equal(codexModel(model), model)
  }
})

test('空值或格式非法才回到默认，不静默换到别的可用模型', () => {
  for (const model of ['', '   ', 'has space', '-leading', 'x'.repeat(120), '<script>']) {
    assert.equal(codexModel(model), 'gpt-image-2', JSON.stringify(model))
  }
})

test('预设仍然可用', () => {
  for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst']) assert.equal(codexModel(model), model)
})
