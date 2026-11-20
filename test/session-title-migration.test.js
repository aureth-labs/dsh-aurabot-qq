// U1：旧版本给 system 标题重复拼平台前缀（QQ · QQ · …），启动迁移必须只修坏形状。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

test('迁移旧会话标题：重复 QQ 前缀 / 非 QQ 的 QQ 前缀会被修正，正常标题不动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-title-'))
  const prev = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  try {
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
      chats: {
        'system:bili': { title: 'QQ · QQ · 刷B站', sessionId: 's1', sessions: { live: 's1' } },
        'system:diary': { title: 'QQ · 空间日记', sessionId: 's2', sessions: { live: 's2' } },
        'feishu:private:ou_owner': { title: 'QQ · 主人私聊', sessionId: 's3', sessions: { live: 's3' } },
        'wechat-clawbot:private:wxu_owner': { title: 'wechat-clawbot 私聊 · 微信主人', sessionId: 's6', sessions: { live: 's6' } },
        'wechat-clawbot:group:wg1': { title: 'wechat-clawbot 群 · 微信群', sessionId: 's7', sessions: { live: 's7' } },
        'private:1481236341': { title: 'QQ · 主人私聊', sessionId: 's4', sessions: { live: 's4' } },
        'system:custom': { title: '我手动改的名字', sessionId: 's5', sessions: { live: 's5' } },
      },
    }), 'utf8')
    const fake = createFakeDsh({ brain: async () => '' })
    const cfg = { ownerQQ: '1481236341', ownerName: '主人', enabled: false }
    const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, platformLabel: (p) => ({ qq: 'QQ', feishu: '飞书', 'wechat-clawbot': '微信（ClawBot）' })[p] || p, log: { debug() {}, info() {}, warn() {}, error() {} } })
    try {
      const result = await hub.migrateLegacyTitles()
      const saved = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))
      assert.equal(saved.chats['system:bili'].title, 'QQ · 刷B站')
      assert.equal(saved.chats['system:diary'].title, 'QQ · 空间日记')
      assert.equal(saved.chats['feishu:private:ou_owner'].title, '飞书 · 主人私聊')
      assert.equal(saved.chats['wechat-clawbot:private:wxu_owner'].title, '微信（ClawBot） 私聊 · 微信主人')
      assert.equal(saved.chats['wechat-clawbot:group:wg1'].title, '微信（ClawBot） 群 · 微信群')
      assert.equal(saved.chats['private:1481236341'].title, 'QQ · 主人私聊')
      assert.equal(saved.chats['system:custom'].title, '我手动改的名字')
      assert.equal(result.changed, true)
    } finally {
      hub.dispose()
      fake.dispose()
    }
  } finally {
    if (prev === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prev
  }
})
