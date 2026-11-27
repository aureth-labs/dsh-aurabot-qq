import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { apply } from '../src/host.js'
import { OneBotError } from '../src/onebot/client.js'
import { NATIVE_MEMORY_VIEW } from '../src/features/memory.js'
import { personaScope } from '../src/persona/personas.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

const BOT = '20000002', OWNER = '10000001', CHAT = `private:${OWNER}`
const OTHER_CHAT = 'private:10000003', GROUP = 'group:30000004'
const PERSONA = 'dafeiyu', OTHER_PERSONA = 'beta-other'

function moduleFixture(dir, id) {
  const path = join(dir, 'modules', id)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'index.mjs'), `export default { id: '${id}', setup(api) {
    const events = []
    api.on('chat/delivery', event => events.push(event))
    return { core: api.core, events }
  } }`)
}

async function setup(t, { connect = false, safeMode = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-persona-memory-'))
  const env = { AURABOT_DATA_DIR: root, AURABOT_WORKSPACE: join(root, 'workspace') }
  const before = Object.keys(env).map(key => [key, process.env[key]])
  Object.assign(process.env, env)
  const fake = createFakeDsh({ brain: async () => '' })
  const mock = connect ? await startMockOneBot({ selfId: BOT }) : null
  t.after(async () => {
    fake.dispose()
    await mock?.close()
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })
  for (const id of ['persona-memory', 'observer-one', 'observer-two']) moduleFixture(root, id)
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    enabled: connect, dryRun: !connect, setupDone: true, safeMode, ownerQQ: OWNER, botQQ: BOT,
    persona: { current: PERSONA, dataOwner: PERSONA },
    snowluma: { autoStart: false, autoAttach: false, dir: join(root, 'no-snowluma'),
      httpUrl: mock?.httpUrl, wsUrl: mock?.wsUrl, httpToken: mock?.token, wsToken: mock?.token },
    modules: { bili: { enabled: false } }, memory: { enabled: true, auto: false },
  }))
  const app = apply(fake.ctx)
  await app.ready
  const reconnect = async () => {
    const response = (await fake.call('/onebot/reconnect')).json()
    assert.equal(response.ok, true, response.message)
  }
  if (connect) await reconnect()
  return { app, mock, reconnect, root }
}

test('the host loader offers a read-only page to persona-memory and keeps native memory active', async (t) => {
  const { app } = await setup(t)
  const core = app.modules.use('persona-memory').core
  const bridge = core.personaMemoryBridge
  assert.equal(bridge.state, 'preview')
  assert.deepEqual(bridge.capabilities, ['native-memory-view', 'confirmed-delivery'])
  for (const name of ['root', 'bind', 'activate', 'clearSessions']) assert.ok(!(name in bridge), name)
  assert.equal(Object.getPrototypeOf(core), null)
  assert.equal(core.hub.subagentFor, undefined)
  for (const id of ['observer-one', 'observer-two']) {
    const observer = app.modules.use(id).core
    assert.equal(observer.personaMemoryBridge, undefined)
    assert.equal(Object.getOwnPropertyDescriptor(observer, 'personaMemoryBridge'), undefined)
    assert.equal(Object.getPrototypeOf(observer), null)
  }

  const native = app.memory
  const first = native.add({ chatId: CHAT, about: OWNER, text: '主人偏好淡一点的茶' })
  const second = native.add({ chatId: CHAT, text: '主人今天提到去看了画展' })
  native.add({ chatId: OTHER_CHAT, text: '隐私：另一段私聊' })
  native.add({ chatId: GROUP, text: '另一个群' })
  native.add({ chatId: CHAT, about: '10000003', text: '别人的资料' })
  native.add({ text: '还没有认领的资料' })
  native.add({ chatId: CHAT, validUntil: Date.now() - 1000, text: '已经过期的记忆' })
  personaScope.run(OTHER_PERSONA, () => native.add({ chatId: CHAT, text: '同一聊天的另一个角色' }))
  assert.ok(first.id && second.id)
  for (const chatId of [OTHER_CHAT, GROUP, `qq:${CHAT}`, '', '../../memory.sqlite']) {
    assert.throws(() => bridge.readNativeMemory(chatId), /不在记忆预览范围/)
  }
  const page = bridge.readNativeMemory(CHAT, { limit: 1 })
  const tail = bridge.readNativeMemory(CHAT, { offset: page.nextOffset })
  assert.deepEqual(new Set([...page.items, ...tail.items].map(item => item.id)), new Set([first.id, second.id]))
  assert.deepEqual(Object.keys(page.items[0]), ['id', 'text', 'at'])
  assert.equal(tail.nextOffset, null)
  assert.throws(() => { page.items[0].text = '修改' }, TypeError)
  assert.equal(app.memory, native)
  assert.ok(native.list('').some(row => row.id === first.id))
  assert.equal(native[NATIVE_MEMORY_VIEW], undefined)
  assert.equal(NATIVE_MEMORY_VIEW in native, false)
  app.modules.stop('memory')
  assert.equal(bridge.readNativeMemory(CHAT), null)
  await app.modules.reload('memory')
  assert.equal(bridge.readNativeMemory(CHAT).items.length, 2)
  app.modules.stop('persona-memory')
  assert.equal(core.personaMemoryBridge, undefined)
  assert.deepEqual(bridge.capabilities, [])
  assert.throws(() => bridge.readNativeMemory(CHAT), /实例已停止/)
  assert.equal(app.modules.running('memory'), 'builtin')
})

test('safe mode hides the bridge and keeps the builtin memory provider', async (t) => {
  const { app } = await setup(t, { safeMode: true })
  assert.equal(app.modules.has('persona-memory'), false)
  assert.equal(app.modules.running('memory'), 'builtin')
  assert.equal(typeof app.memory.add, 'function')
})

test('confirmed OneBot sends and successful outbox flushes notify only the active exact-chat instance', { timeout: 20_000 }, async (t) => {
  const { app, mock, reconnect, root } = await setup(t, { connect: true })
  const target = app.modules.use('persona-memory')
  const bridge = target.core.personaMemoryBridge
  const receipts = []
  for (const id of [OTHER_CHAT, GROUP]) assert.throws(() => bridge.onDelivery(id, () => {}), /不在记忆预览范围/)
  bridge.onDelivery(CHAT, (receipt) => receipts.push(receipt))
  assert.throws(() => bridge.onDelivery(CHAT, () => {}), /已订阅/)

  // Exercise the real hub and queue. Only inject the failure and the result's message ID.
  const call = app.onebot.call
  let failNext = false, gatewayId = -908
  app.onebot.call = async (action, params, options) => {
    if (action !== 'send_private_msg') return call(action, params, options)
    if (failNext) {
      failNext = false
      throw new OneBotError(action, { message: 'fixture is temporarily disconnected' }, { transport: true })
    }
    const result = await call(action, params, options)
    return { ...result, message_id: gatewayId }
  }
  const send = (chatId, text, options) => app.hub.sendSegments(chatId, [{ type: 'text', data: { text } }], text, options)
  await send(CHAT, '私聊回执')
  await send(CHAT, '重复的网关编号')
  await send(OTHER_CHAT, '另一位联系人')
  await send(GROUP, '另一个群')
  gatewayId = -901
  await personaScope.run(OTHER_PERSONA, () => send(CHAT, '另一个人格'))
  gatewayId = -902
  await send(CHAT, '敏感回执', { sensitive: true })
  app.modules.emit('chat/delivery', { chatId: CHAT, messageId: 'forged' })
  assert.deepEqual(receipts.map(r => r.messageId), ['-908'])
  assert.deepEqual(Object.keys(receipts[0]).sort(), ['at', 'chatId', 'messageId', 'originId', 'platform', 'status'])
  assert.ok(Object.isFrozen(receipts[0]))

  const queueFile = join(root, 'outbox', 'queue.json')
  for (const messageId of [-908, -909]) {
    gatewayId = messageId
    failNext = true
    const text = `成功补发 ${messageId}`
    assert.equal((await send(CHAT, text)).queued, true)
    const previous = receipts.length
    assert.equal(JSON.parse(readFileSync(queueFile, 'utf8'))[0].chatId, CHAT)
    await reconnect()
    for (let i = 0; i < 80 && JSON.parse(readFileSync(queueFile, 'utf8')).length; i++) await wait(50)
    assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).length, 0)
    assert.equal(mock.calls.filter(({ action, params }) => action === 'send_private_msg' &&
      params.message?.[0]?.data?.text === text).length, 1)
    assert.equal(receipts.length, previous + Number(messageId === -909))
  }
  assert.deepEqual(receipts.map(r => r.messageId), ['-908', '-909'])
  for (const id of ['persona-memory', 'observer-one', 'observer-two']) {
    assert.deepEqual(app.modules.use(id).events, [])
  }

  failNext = true
  assert.equal((await send(CHAT, '旧实例还没补发')).queued, true)
  app.modules.stop('persona-memory')
  assert.throws(() => bridge.onDelivery(CHAT, () => {}), /实例已停止/)
  await app.modules.reload('persona-memory')
  const next = []
  app.modules.use('persona-memory').core.personaMemoryBridge.onDelivery(CHAT, receipt => next.push(receipt))
  gatewayId = -910
  await reconnect()
  for (let i = 0; i < 80 && JSON.parse(readFileSync(queueFile, 'utf8')).length; i++) await wait(50)
  assert.equal(JSON.parse(readFileSync(queueFile, 'utf8')).length, 0)
  assert.deepEqual(next, [])
  await send(CHAT, '新实例发送')
  assert.deepEqual(next.map(r => r.messageId), ['-910'])
  const replacement = app.modules.use('persona-memory').core
  app.setConfig({ ...app.getConfig(), safeMode: true })
  assert.equal(replacement.personaMemoryBridge, undefined)
  gatewayId = -911
  await send(CHAT, '切到安全模式')
  assert.deepEqual(next.map(r => r.messageId), ['-910'])
  assert.deepEqual(receipts.map(r => r.messageId), ['-908', '-909'])
})
