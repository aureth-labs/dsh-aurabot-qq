// #520：面板两个状态问题——保存后 dirty 基线不能用脱敏快照；vector.mode 要能从 publicConfig 读回。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalize, publicConfig } from '../src/core/config.js'

const CLIENT = () => readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

test('publicConfig 回传可枚举的 vector.mode（在线服务不会回退本地模型）', () => {
  const cfg = normalize({ memory: { vector: { enabled: true, mode: 'remote', baseUrl: 'https://api.example.com', model: 'm', apiKey: 'secret-key' } } })
  assert.equal(cfg.memory.vector.mode, 'remote')
  const pub = publicConfig(cfg)
  assert.equal(pub.memory.vector.mode, 'remote')
  assert.deepEqual(Object.keys(pub.memory.vector).includes('mode'), true, 'mode 必须是可枚举字段')
  assert.equal(pub.memory.vector.apiKey, '', 'secret 仍必须脱敏')
})

test('保存回执的 dirty 基线用完整草稿而不是脱敏快照', () => {
  const src = CLIENT()
  assert.match(src, /const savedDraft = clone\(override \|\| draft\)/, '基线要用完整草稿')
  assert.match(src, /draftBaseRef\.current = savedDraft/, '基线指向完整草稿')
  assert.match(src, /不再立即 loadConfigDraft/, '保存后不能马上用脱敏快照覆盖基线')
})
