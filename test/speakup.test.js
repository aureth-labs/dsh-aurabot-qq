// 主动搭话：只看私聊的冷场时间（群里热闹不影响）、追问只追一次。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTestIdentity } from './helpers/identity.js'

let createSpeakUp
let normalize
const OWNER = '10000001'

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-speak-'))
  ;({ createSpeakUp } = await import('../src/features/companion.js'))
  ;({ normalize } = await import('../src/core/config.js'))
})

function setup(hubState, speakUp = {}, config = {}) {
  const pushed = []
  const cfg = normalize({ enabled: true, ...config, speakUp: { awakeFrom: 0, awakeTo: 24, minIntervalMinutes: 5, maxIntervalMinutes: 5, ...speakUp } })
  const identity = makeTestIdentity(OWNER)
  const hub = { ...hubState, pushToSession: async (chat, content) => pushed.push({ chat, text: content[0].text }) }
  const s = createSpeakUp({ getConfig: () => cfg, hub, log: { info() {} }, identity, routeOwner: () => identity.routeOwner() })
  return { s, pushed }
}
const min = 60_000

test('主人搭话和追话把已选路由交给共享入口', async () => {
  const calls = []
  const { s, pushed } = setup({
    pushProactiveToSession: async (...args) => calls.push(args),
    lastBotToOwner: { text: '晚饭吃了吗？' },
  })
  await s.fire()
  await s.fire('追话', { nudge: true })
  assert.equal(pushed.length, 0)
  assert.equal(calls.length, 2)
  for (const [chat, content, sender, opts] of calls) {
    assert.equal(chat.chatId, 'private:' + OWNER)
    assert.equal(sender, '')
    assert.equal(opts.route.chatId, chat.chatId)
    assert.equal(opts.route.blocked, false)
    assert.equal(content[0].type, 'text')
  }
  assert.match(calls[1][1][0].text, /轻轻追一句/)
})

test('共享主动搭话暂缓保留时机，真实送达才扣次数并防并发重复', async () => {
  const route = { chatId: 'feishu:private:ou_owner', fallbackUsed: true }
  const deferred = { ok: false, deferred: true, error: '备用账号已断开' }
  const started = Promise.withResolvers()
  const finish = Promise.withResolvers()
  let calls = 0
  const { s, pushed } = setup({
    resolveSharedProactiveRoute: () => route,
    async pushProactiveToSession(chat, _content, _sender, opts) {
      calls++
      assert.equal(chat.chatId, route.chatId)
      assert.equal(opts.route, route)
      if (calls === 1) {
        started.resolve()
        return finish.promise
      }
      opts.onDelivered()
      opts.onDelivered()
      return { ok: true, delivered: true }
    },
  }, { idleMinutes: 1, nudge: false }, { dryRun: false, multiPlatformPrivateSession: true })
  const scheduledAt = Date.now() - 1000
  writeFileSync(join(process.env.AURABOT_DATA_DIR, 'speakup.json'), JSON.stringify({
    day: new Date().toDateString(), count: 0, nextAt: scheduledAt, last: 0,
  }))

  const tick = s.tick()
  await started.promise
  await s.tick()
  assert.equal(calls, 1)
  assert.equal(s.state().count, 0)
  finish.resolve(deferred)
  await tick
  assert.equal(s.state().count, 0)
  assert.equal(s.state().nextAt, scheduledAt)

  await s.tick()
  assert.equal(calls, 2)
  assert.equal(pushed.length, 0)
  assert.equal(s.state().count, 1)
  assert.ok(s.state().nextAt > Date.now())
})

test('普通主动搭话只在稍后收到实际投递回执时扣次数', async () => {
  let receipt
  const { s } = setup({
    async pushProactiveToSession(_chat, _content, _sender, opts) { receipt = opts.onDelivered },
  }, { idleMinutes: 1, nudge: false }, { dryRun: false })
  writeFileSync(join(process.env.AURABOT_DATA_DIR, 'speakup.json'), JSON.stringify({
    day: new Date().toDateString(), count: 0, nextAt: Date.now() - 1000,
  }))
  await s.tick()
  assert.equal(s.state().count, 0)
  receipt()
  receipt()
  assert.equal(s.state().count, 1)
})

test('手动触发时直接回显无共享投递目标的暂缓结果', async () => {
  const { default: speakupModule } = await import('../src/modules/speakup/index.js')
  const routes = new Map()
  const deferred = { ok: false, chatId: '', deferred: true, retryable: true, reason: 'primary-offline', error: '共享主动搭话已暂缓' }
  const cfg = normalize({ enabled: true, multiPlatformPrivateSession: true })
  const hub = {
    resolveSharedProactiveRoute: () => deferred,
    async pushProactiveToSession(chat, content, _sender, { route }) {
      assert.equal(chat, null)
      assert.deepEqual(content, [])
      assert.equal(route, deferred)
      return deferred
    },
  }
  speakupModule.setup({
    config: () => cfg, core: { hub, mutes: { muted: () => false }, identity: makeTestIdentity(OWNER) },
    log: { info() {}, debug() {} }, use: () => null, every() {}, tool() {}, context() {},
    route: (path, handle) => routes.set(path, handle),
  })
  assert.deepEqual(await routes.get('/speakup/fire')(), {
    ok: false, deferred: true, retryable: true, reason: 'primary-offline', message: '共享主动搭话已暂缓',
  })
})

test('默认打开，只找主人私聊', () => {
  const c = normalize({}).speakUp
  assert.equal(c.enabled, true)
  assert.equal(c.nudge, true)
})

test('群里一直很热闹也不妨碍她私聊找你', async () => {
  const { s, pushed } = setup({ lastOwnerChatAt: Date.now() - 120 * min, lastChatAt: Date.now(), lastBotToOwner: { at: Date.now() - 120 * min, text: '晚安' } })
  await s.tick() // 第一次只排时间
  const st = s.state()
  st.nextAt = Date.now() - 1
  writeFileSync(join(process.env.AURABOT_DATA_DIR, 'speakup.json'), JSON.stringify(st))
  await s.tick()
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].chat.chatId, 'private:' + OWNER)
  assert.match(pushed[0].text, /由头/)
})

test('她问了一句你没回：追问一次，不会反复追', async () => {
  const realRandom = Math.random
  Math.random = () => 0.1
  try {
    const asked = { at: Date.now() - 20 * min, text: '你今天去哪玩了？' }
    const { s, pushed } = setup({ lastOwnerChatAt: Date.now() - 25 * min, lastChatAt: 0, lastBotToOwner: asked }, { idleMinutes: 600 })
    await s.tick()
    await s.tick()
    assert.equal(pushed.length, 1)
    assert.match(pushed[0].text, /追一句/)
  } finally {
    Math.random = realRandom
  }
})

test('她最后一句不是问题，就不追问', async () => {
  const { s, pushed } = setup({ lastOwnerChatAt: Date.now() - 25 * min, lastChatAt: 0, lastBotToOwner: { at: Date.now() - 20 * min, text: '好哦' } }, { idleMinutes: 600 })
  await s.tick()
  assert.equal(pushed.length, 0)
})
