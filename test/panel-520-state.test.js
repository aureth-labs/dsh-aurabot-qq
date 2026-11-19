// #520：面板两个状态问题——保存后 dirty 基线不能用脱敏快照；vector.mode 要能从 publicConfig 读回。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { commitConfig, loadConfig, mergeFromPanel, normalize, publicConfig, saveConfig } from '../src/core/config.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  assert.match(src, /let savedDraft = maskSecretFields\(clone\(override \|\| draft\)\)/, '基线用完整草稿并清空 secret 原文')
  assert.match(src, /draftBaseRef\.current = savedDraft/, '基线指向完整草稿')
  assert.match(src, /for \(const dots of committed\) savedDraft = setPath/, '已提交字段以服务端归一化快照为准')
  assert.match(src, /不再立即 loadConfigDraft/, '保存后不能马上用脱敏快照覆盖基线')
})


test('vector.mode 真的落盘：mergeFromPanel 后 commitConfig 返回 local，config.json 带 mode，重载仍 local', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-520-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  try {
    process.env.AURABOT_DATA_DIR = dir
    const base = normalize({ ownerQQ: '10001', memory: { vector: { enabled: true, baseUrl: 'https://example.invalid/v1', model: 'm', apiKey: 'k' } } })
    assert.equal(base.memory.vector.mode, 'remote')
    const incoming = structuredClone(publicConfig(base))
    incoming.memory.vector.mode = 'local'
    const merged = mergeFromPanel(base, incoming)
    const saved = commitConfig(merged, base)
    assert.equal(saved.memory.vector.mode, 'local', 'commitConfig 不能把只改模式的提交当成没变化')
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    assert.equal(raw.memory.vector.mode, 'local', 'config.json 必须带 mode')
    assert.equal(loadConfig().memory.vector.mode, 'local', '重载后仍是 local')
    // 只改无关字段再保存，不能把 local 推回 remote（deepMerge structuredClone 会丢非枚举 mode）
    const later = mergeFromPanel(saved, { ownerName: '测试改名' })
    const saved2 = commitConfig(later, saved)
    assert.equal(saved2.memory.vector.mode, 'local', '无关字段局部保存后 mode 仍 local')
    assert.equal(loadConfig().memory.vector.mode, 'local', '重载仍 local')
  } finally {
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    rmSync(dir, { recursive: true, force: true })
  }
})

test('显式 local 模式不会回退远端（隐私承诺）', () => {
  const src = readFileSync(new URL('../src/features/memory-vector.js', import.meta.url), 'utf8')
  assert.match(src, /if \(hasBase && c\.mode !== 'local'\) return createVectorIndex/)
  assert.match(src, /hasBase && c\.mode !== 'local' \? createVectorIndex/)
})

test('保存回执同步 *Set 标志并在在途草稿里清掉已提交的旧 secret', () => {
  const src = CLIENT()
  assert.match(src, /copySecretFlags\(savedDraft, snap\)/)
  assert.match(src, /maskSecretFields\(next, draft\)/)
})

test('旧客户端只传 baseUrl（不带 mode）仍能切到在线服务', () => {
  const base = normalize({ ownerQQ: '10001', memory: { vector: { enabled: true } } })
  assert.equal(base.memory.vector.mode, 'local')
  assert.equal(base.memory.vector.modeExplicit, false)
  const merged = mergeFromPanel(base, { memory: { vector: { enabled: true, baseUrl: 'https://example.invalid/v1', model: 'test' } } })
  assert.equal(merged.memory.vector.mode, 'remote', '老调用体没有 mode 时应按 baseUrl 推 remote')
})

test('在途编辑回执也同步 *Set 标志，避免假 dirty', () => {
  assert.match(CLIENT(), /copySecretFlags\(next, snap\)/)
})

test('默认 local 不写盘、旧客户端只传 baseUrl 仍能切在线', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-520b-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  try {
    process.env.AURABOT_DATA_DIR = dir
    const base = normalize({ ownerQQ: '10001' })
    assert.equal(base.memory.vector.mode, 'local')
    assert.equal(base.memory.vector.modeExplicit, false)
    saveConfig(base, base)
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    assert.equal(Object.hasOwn(raw.memory.vector, 'mode'), false, '默认 local 不该写盘')
    const merged = mergeFromPanel(base, { memory: { vector: { enabled: true, baseUrl: 'https://example.invalid/v1', model: 'test' } } })
    const saved = commitConfig(merged, base)
    assert.equal(saved.memory.vector.mode, 'remote', '旧客户端 baseUrl 应推 remote')
    assert.equal(loadConfig().memory.vector.mode, 'remote')
  } finally {
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    rmSync(dir, { recursive: true, force: true })
  }
})
