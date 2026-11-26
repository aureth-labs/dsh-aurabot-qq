import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPurpose, purposeConfig } from '../src/purpose/module.js'
import purposeModule from '../src/modules/purpose/index.js'
import { makeTestIdentity } from './helpers/identity.js'

const route = { chatId: 'feishu:private:ou_owner', fallbackUsed: true }
const deferred = { ok: false, deferred: true, retryable: true, reason: 'primary-offline', error: '共享主动搭话已暂缓' }

function setup(overrides = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-purpose-shared-'))
  const identity = makeTestIdentity('ou_owner', 'feishu')
  const cfg = {
    enabled: true,
    multiPlatformPrivateSession: true,
    speakUp: { enabled: true, awakeFrom: 0, awakeTo: 24, minIntervalMinutes: 5, maxIntervalMinutes: 5, nudge: false },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
  }
  const hub = {
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    resolveSharedProactiveRoute: () => route,
    async runSystemTurn() { assert.fail('共享回合不走系统会话') },
    async runTurnInChat() { assert.fail('共享回合不走普通私聊') },
    async deliver() { assert.fail('共享回合不直接投递') },
    ...overrides,
  }
  const log = { info() {}, warn() {}, debug() {} }
  const p = createPurpose({
    getConfig: () => cfg,
    hub, identity, log,
    mood: () => null,
    memory: () => ({ list: () => [{ id: 'one', text: '主人喜欢在周末做手工', importance: 0.9, at: Date.now() }] }),
    personaText: () => '喜欢逛公园和旅行',
  })
  return { p, cfg, hub, identity, log }
}

test('共享主动搭话暂缓保留时机，只按真实投递扣次且挡住同时点击', async () => {
  const started = Promise.withResolvers()
  const finish = Promise.withResolvers()
  let calls = 0
  const { p } = setup({
    async pushProactiveToSession(chat, content, senderId, opts) {
      calls++
      assert.equal(chat.chatId, route.chatId)
      assert.equal(opts.route, route)
      assert.equal(opts.noTools, true)
      assert.equal(opts.proactiveCause, 'purpose')
      assert.equal(senderId, '')
      assert.equal(content[0].type, 'text')
      if (calls === 1) {
        started.resolve()
        return finish.promise
      }
      const outgoing = opts.transformReply('给你看看我的新画\n【内部备忘】别直接告诉主人')
      assert.equal(outgoing, '给你看看我的新画')
      return { ok: true, delivered: true }
    },
  })
  const file = join(process.env.AURABOT_DATA_DIR, 'purpose', 'purpose-state.json')
  const nextAt = p.state().nextFireAt
  const keep = JSON.parse(readFileSync(file, 'utf8'))
  keep.nextFireAt = Date.now() - 1000
  writeFileSync(file, JSON.stringify(keep))
  const pending = p.fire()
  await started.promise
  assert.equal((await p.fire()).outcome, 'skipped-busy')
  assert.equal(p.state().countToday, 0)
  finish.resolve(deferred)
  const result = await pending
  assert.equal(result.outcome, 'deferred')
  assert.equal(result.reason, deferred.reason)
  assert.equal(p.state().countToday, 0)
  assert.equal(p.state().nextFireAt, keep.nextFireAt)
  assert.ok(nextAt !== keep.nextFireAt)
  assert.equal((await p.fire()).outcome, 'sent')
  assert.equal(calls, 2)
  assert.equal(p.state().countToday, 1)
})

test('手动触发回显无共享投递目标，保留旧开关语义', async () => {
  const { p, cfg, hub, identity, log } = setup({ resolveSharedProactiveRoute: () => ({ ...deferred, chatId: '' }) })
  assert.equal((await p.fire()).outcome, 'deferred')
  const routes = new Map()
  purposeModule.setup({
    config: () => cfg,
    settings: () => cfg.ext.purpose,
    core: { hub, identity, mutes: { muted: () => false } },
    log, use: () => null, every() {}, tool() {}, context() {}, on() {},
    route: (path, handle) => routes.set(path, handle),
  })
  assert.deepEqual(await routes.get('/purpose/fire')(), {
    ok: false, deferred: true, retryable: true, reason: 'primary-offline', message: '共享主动搭话已暂缓',
  })
  assert.equal(purposeConfig({ enabled: true, speakUp: { enabled: false } }).enabled, false)
})
