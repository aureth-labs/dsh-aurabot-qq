import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { ArchivedSessionGate } from 'dsh-probe-source/packages/api/session-controller/src/archived-session-gate.ts'
import { createSessionTestController } from 'dsh-probe-source/packages/api/session-controller/tests/test-remote.ts'
import { MockAdapter, textResponse, toolCallResponse } from 'dsh-probe-source/packages/core/agent-loop/tests/mock-adapter.ts'
import { registerSharedTurnGuard } from '../../src/chat/shared-turn-guard.js'
import { createHub } from '../../src/chat/hub.js'
import { normalize } from '../../src/core/config.js'
import { createGateway } from '../../src/gateway/index.js'
import { createIdentity } from '../../src/gateway/identity.js'
import { fixedSharedPrimary } from '../../src/gateway/shared-private-route.js'
import { checkMigrationPersistencePreflight, verifyPersistedInboxMessage } from '../../src/core/qq-gateway-migration.js'
import { makeFakeAdapter } from '../helpers/fake-adapter.js'

const fixtures: Array<{ ctx: Context; cwd: string }> = []
afterEach(async () => {
  for (const { ctx, cwd } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

function prompt(text: string, kind = 'user') {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind } })
}

async function mountAgentRuntime(ctx: Context, responses: ConstructorParameters<typeof MockAdapter>[0]) {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(responses)
  vi.spyOn(adapter, 'resolveModel').mockImplementation(async (provider, model) => ({
    provider, id: model, name: model, defaultMaxTokens: 128, context: { contextWindow: 4096 },
  }))
  ctx.llm.registerAdapter(['mock'], adapter)
  return adapter
}

async function harness({ instructions = false, responses = Array.from({ length: 16 }, () => textResponse('收到消息')) } = {}) {
  const ctx = new Context()
  const cwd = await mkdtemp(join(tmpdir(), 'aurabot-dsh-compat-'))
  fixtures.push({ ctx, cwd })
  vi.stubEnv('DSH_HOME', cwd)
  vi.stubEnv('DSH_AGENTS_HOME', cwd)
  const adapter = await mountAgentRuntime(ctx, responses)
  const archived: string[] = []
  ctx.provide('workspaceRegistry', { get archivedSessionIds() { return archived } } as never)
  await ctx.plugin(ArchivedSessionGate)
  if (instructions) {
    await writeFile(join(cwd, '.git'), '')
    await writeFile(join(cwd, 'AGENTS.md'), 'WORKSPACE-PROBE-INSTRUCTIONS')
    provideWorkingDirectoryFixture(ctx, cwd)
    await ctx.plugin(LocalFileSystem, { cwd })
    await ctx.plugin(AgentInstructions, { maxBytes: 4096 })
    await ctx.plugin(SkillRegistry)
    ctx.skills.register({
      name: 'aurabot-probe-skill', description: 'Local compatibility fixture.',
      source: 'runtime', provider: 'runtime', content: 'Probe fixture.',
    })
    await ctx.plugin(ToolSkill)
  }
  const agent = await ctx.agentLoop.create(SessionId('shared'), { provider: 'mock', model: 'mock' }, { cwd })
  const ordinary = await ctx.agentLoop.create(SessionId('ordinary'), { provider: 'mock', model: 'mock' }, { cwd })
  let active: { message: ReturnType<typeof prompt>; dshTurn?: number } | null = null
  const admitted = vi.fn()
  const rejected = vi.fn()
  const claimedKinds: string[] = []
  ctx.on('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
    if (subject !== agent) return
    claimedKinds.push(message.source.kind)
    if (active?.message.id === message.id) active.dshTurn = turn
  })
  return {
    ctx, cwd, agent, ordinary, adapter, archived, admitted, rejected, claimedKinds,
    install() {
      return registerSharedTurnGuard(ctx, {
        lookup: subject => subject === agent ? active : undefined,
        isAuthorized: () => true,
        onAccepted: admitted,
        onRejected: rejected,
      })
    },
    async platform(text: string) {
      const message = prompt(text, 'aurabot')
      active = { message }
      agent.followup(message)
      await agent.whenIdle()
      active = null
    },
  }
}

function lastOutcome(agent) {
  return agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind
}

it('blocks unregistered input before an active pressure-compaction hook and resumes a valid platform turn', async () => {
  const h = await harness()
  for (let index = 0; index < 4; index++) {
    h.agent.followup(prompt(`Earlier message ${index}. ` + 'previous conversation text '.repeat(250)))
    await h.agent.whenIdle()
  }
  await h.ctx.plugin(TokenMeter)
  await h.ctx.plugin(BasicCompaction, {
    thresholdRatio: 0.25, headroomTokens: 0, retainTokens: 160, maxTokens: 256,
    summarizationProvider: 'mock', summarizationModel: 'summary',
  })
  h.install()
  const before = h.adapter.requests.length
  h.agent.followup(prompt('local input'))
  await h.agent.whenIdle()
  expect(lastOutcome(h.agent)).toBe('blocked')
  expect(h.adapter.requests).toHaveLength(before)
  expect(h.agent.session.deriveMessages().some(message => JSON.stringify(message).includes('local input'))).toBe(false)

  await h.platform('registered platform input')
  expect(lastOutcome(h.agent)).toBe('completed')
  const requests = h.adapter.requests.slice(before)
  expect(requests.some(request => request.model === 'summary')).toBe(true)
  expect(requests.some(request => request.model === 'mock')).toBe(true)
  expect(JSON.stringify(requests)).not.toContain('local input')
})

it('supports host-generated instructions in claimed messages and from downstream', async () => {
  const h = await harness({ instructions: true })
  h.install()
  h.ordinary.followup(prompt('host context preparation'))
  await h.ordinary.whenIdle()
  const context = h.ordinary.session.deriveMessages().find(message => message.source.kind === 'agent-instructions')
  expect(context).toBeDefined()
  h.agent.inject(context!)
  await h.platform('first registered message')
  expect(lastOutcome(h.agent)).toBe('completed')
  expect(h.claimedKinds).toContain('agent-instructions')
  expect(JSON.stringify(h.adapter.requests[1].messages)).toContain('WORKSPACE-PROBE-INSTRUCTIONS')

  const other = await harness({ instructions: true })
  other.install()
  await other.platform('first step through downstream')
  expect(lastOutcome(other.agent)).toBe('completed')
  expect(JSON.stringify(other.adapter.requests[0].messages)).toContain('WORKSPACE-PROBE-INSTRUCTIONS')
  expect(JSON.stringify(other.adapter.requests[0].messages)).toContain('aurabot-probe-skill')
})

it('rejects mixed claims, then accepts the next platform message without retaining the blocked content', async () => {
  const h = await harness()
  h.install()
  h.agent.inject(prompt('local addition'))
  await h.platform('old platform input')
  expect(lastOutcome(h.agent)).toBe('blocked')
  expect(h.rejected).toHaveBeenCalledTimes(1)
  expect(h.adapter.requests).toHaveLength(0)
  await h.platform('new platform input')
  expect(lastOutcome(h.agent)).toBe('completed')
  expect(JSON.stringify(h.adapter.requests)).not.toMatch(/local addition|old platform input/)
})

it('preserves ordinary and archived behavior, then removes the guard when disposed', async () => {
  const h = await harness()
  const dispose = h.install()
  h.ordinary.followup(prompt('ordinary input'))
  await h.ordinary.whenIdle()
  expect(lastOutcome(h.ordinary)).toBe('completed')
  h.archived.push(h.agent.id)
  await h.platform('archived input')
  expect(lastOutcome(h.agent)).toBe('blocked')
  expect(h.admitted).not.toHaveBeenCalled()
  expect(h.adapter.requests).toHaveLength(1)

  h.archived.length = 0
  dispose()
  h.agent.followup(prompt('local input after removal'))
  await h.agent.whenIdle()
  expect(lastOutcome(h.agent)).toBe('completed')
  expect(h.adapter.requests).toHaveLength(2)
})

it('keeps direct QQ on ordinary DSH and OneBot replies when the saved shared switch is on', async () => {
  const h = await harness({ responses: [textResponse('直连普通回复'), textResponse('混合接入普通回复')] })
  vi.stubEnv('AURABOT_DATA_DIR', h.cwd)
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const identity = createIdentity({ dataDir: join(h.cwd, 'identity'), log })
  const owner = identity.claimOwner('qq', '10001')
  identity.link('bridge', 'owner_b', owner, 'owner')
  const cfg = normalize({
    enabled: true, dryRun: false, ownerLevel: 'social', ownerQQ: '10001', ownerPersonId: owner, botQQ: '20001',
    ownerAuthorization: { owner, revision: '11111111-2222-4333-8444-555555555555' },
    multiPlatformPrivateSession: true,
    ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '10001' },
    platforms: { bridge: { enabled: true } },
    workspaceDir: h.cwd, merge: { enabled: false }, voice: { enabled: false },
    stickers: { enabled: false, collect: false }, chat: { thinkingGuard: { enabled: false } },
  })
  const legacy = { instance: 'qq', platform: 'qq', legacy: true, state: 'connected' }
  h.ctx.workspaceRegistry.list = () => [{ id: 'workspace', path: h.cwd }]
  const create = vi.fn(async () => ({ sessionId: h.ordinary.id }))
  const fork = vi.fn()
  h.ctx.provide('sessionController', {
    create, fork, rename: vi.fn(),
    resolveAgent: async id => ({ agent: h.ctx.agents.get(id) }),
  } as never)
  const onebot = { call: vi.fn(async () => ({ message_id: 1 })) }
  const gateway = createGateway({
    config: { platforms: { bridge: cfg.platforms.bridge } },
    dataDir: (...path) => join(h.cwd, ...path), identity, log,
  })
  gateway.register(() => makeFakeAdapter({ id: 'bridge' }))
  let gatewayReady = false
  const hub = createHub({
    dsh: h.ctx, getConfig: () => cfg, log, onebot, identity,
    resolveSharedPrimary: () => fixedSharedPrimary({
      cfg, identity, instances: gatewayReady ? [legacy, ...gateway.instances()] : [legacy],
    }),
  })
  const off = h.ctx.on('session/event', hub.onSessionEvent)
  const sendQq = (message_id: number, text: string) => hub.onMessage({
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    user_id: 10001, self_id: 20001, message_id,
    sender: { user_id: 10001, nickname: '主人' }, message: [{ type: 'text', data: { text } }],
  })
  const replies = () => onebot.call.mock.calls.filter(([action]) => action === 'send_private_msg')
  try {
    expect(hub.sharedStatus()).toMatchObject({ enabled: true, available: false, reason: 'gateway-required' })
    await sendQq(1001, '旧直连私聊照常回复')
    await vi.waitFor(() => expect(replies()).toHaveLength(1))
    expect(JSON.stringify(replies()[0][1])).toContain('直连普通回复')

    await gateway.sync()
    gatewayReady = true
    hub.setGateway(gateway)
    expect(hub.sharedStatus()).toMatchObject({ enabled: true, available: false, reason: 'gateway-required' })
    cfg.ownerPrimary = { mode: 'fixed', platform: 'bridge', instance: 'bridge', account: 'owner_b' }
    hub.refreshSharedConfig()
    expect(hub.sharedStatus()).toMatchObject({ enabled: true, available: true })
    await sendQq(1002, '启用网关后旧直连私聊仍照常回复')
    await vi.waitFor(() => expect(replies()).toHaveLength(2))
    expect(JSON.stringify(replies()[1][1])).toContain('混合接入普通回复')
    expect(create).toHaveBeenCalledTimes(1)
    expect(fork).not.toHaveBeenCalled()
    expect(hub.sharedStatus().state).toBe('uninitialized')
  } finally {
    off()
    hub.dispose()
    await gateway.stopAll()
    identity.close?.()
  }
}, 15_000)

it('queues two platforms on one DSH session and preserves reply credentials for slow tools and failures', async () => {
  const h = await harness({
    responses: [
      toolCallResponse('first-call', 'record_shared_probe', {}), textResponse('收到 QQ 消息'),
      toolCallResponse('slow-call', 'record_shared_probe', {}), textResponse('收到微信消息'),
      textResponse('平台离线时生成的回复'), textResponse('收到重发的消息'),
    ],
  })
  vi.stubEnv('AURABOT_DATA_DIR', h.cwd)
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const identity = createIdentity({ dataDir: join(h.cwd, 'identity'), log })
  const owner = identity.claimOwner('qq', '10001')
  identity.link('wechat-clawbot', 'owner_wx', owner, 'owner')
  const revision = '11111111-2222-4333-8444-555555555555'
  const cfg = normalize({
    enabled: true, dryRun: false, ownerLevel: 'social', ownerPersonId: owner, ownerQQ: '10001',
    ownerAuthorization: { owner, revision }, multiPlatformPrivateSession: true,
    ownerPrimary: { platform: 'qq', instance: 'qq', account: '10001' },
    platforms: { qq: { enabled: true }, 'wechat-clawbot': { enabled: true } },
    workspaceDir: h.cwd, merge: { enabled: false }, voice: { enabled: false },
    stickers: { enabled: true, collect: false, autoChance: 0 }, chat: { thinkingGuard: { enabled: false } },
  })
  let clock = Date.now()
  const replyWindowMs = 60_000
  const gateway = createGateway({ config: cfg, dataDir: (...path) => join(h.cwd, ...path), identity, log, now: () => clock })
  const send = vi.spyOn(gateway, 'send')
  const qq = makeFakeAdapter({ id: 'qq', self: { account: '20001' }, caps: { proactive: 'free', replyWindowMs } })
  const wx = makeFakeAdapter({ id: 'wechat-clawbot', caps: { proactive: 'none' } })
  gateway.register(() => qq)
  gateway.register(() => wx)
  await gateway.sync()
  const create = vi.fn(async () => {
    const sessionId = SessionId('session-shared-platforms')
    await h.ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: h.cwd })
    return { sessionId }
  })
  h.ctx.provide('sessionController', {
    create, fork: vi.fn(), rename: vi.fn(),
    resolveAgent: async id => ({ agent: h.ctx.agents.get(id) }),
  } as never)
  h.ctx.workspaceRegistry.list = () => [{ id: 'workspace', path: h.cwd }]
  const executions: string[] = []
  const hub = createHub({
    dsh: h.ctx, getConfig: () => cfg, log, gateway, identity,
    stickers: {
      match: (name: string) => ({ name, md5: 'probe-sticker' }),
      partFor: () => ({ type: 'sticker', media: { id: 'probe-sticker' } }),
    },
    resolveSharedPrimary: () => fixedSharedPrimary({ cfg, identity, instances: gateway.instances() }),
    buildTools: ({ chat }) => [{
      ...defineContentToolFixture({
        name: 'record_shared_probe', description: 'Record one local test observation.', parameters: {},
        async execute() {
          executions.push(chat.chatId)
          if (chat.chatId.startsWith('wechat-clawbot:')) {
            await vi.waitFor(() => expect(wx.sent.some(record => record.payload.parts[0].type === 'sticker')).toBe(true), { timeout: 5000 })
          }
          return [{ type: 'text', text: 'recorded' }]
        },
      }),
      slow: chat.chatId.startsWith('wechat-clawbot:') ? '仍在处理\n<sticker:测试表情>' : false,
    }],
  })
  const off = h.ctx.on('session/event', hub.onSessionEvent)
  const submitted: Promise<unknown>[] = []
  const stop = gateway.onMessage(message => { submitted.push(hub.onGatewayMessage(message)) })
  try {
    qq.pushInbound({
      messageId: 'qq-in', at: clock, chat: { kind: 'private', id: '10001' },
      sender: { account: '10001', name: 'QQ 主人' }, parts: [{ type: 'text', text: 'QQ 这边说话' }],
    })
    wx.pushInbound({
      messageId: 'wx-in', chat: { kind: 'private', id: 'owner_wx' },
      sender: { account: 'owner_wx', name: '微信主人' }, parts: [{ type: 'text', text: '微信这边说话' }],
    })
    await vi.waitFor(() => expect(submitted).toHaveLength(2))
    await Promise.all(submitted)
    expect(log.warn.mock.calls.filter(([message]) => !message.includes('工作区授权'))).toEqual([])
    expect(create).toHaveBeenCalledTimes(1)
    expect(h.adapter.requests).toHaveLength(4)
    expect(executions).toEqual(['qq:private:10001', 'wechat-clawbot:private:owner_wx'])
    expect(JSON.stringify(h.adapter.requests[2].messages)).toContain('QQ 这边说话')
    expect(qq.sent.map(record => record.payload.inResponseTo)).toEqual(['qq-in'])
    expect(wx.sent.map(record => [record.payload.chat.id, record.payload.inResponseTo])).toEqual([
      ['owner_wx', 'wx-in'], ['owner_wx', 'wx-in'], ['owner_wx', 'wx-in'],
    ])
    const wxReplies = send.mock.calls.filter(([message]) => message.chatId === 'wechat-clawbot:private:owner_wx')
    expect(wxReplies.slice(0, 2)).toMatchObject([
      [{ inResponseTo: 'wx-in', sensitive: true }, { replyGuard: expect.any(Function) }],
      [{ inResponseTo: 'wx-in', sensitive: true }, { replyGuard: expect.any(Function) }],
    ])
    expect(qq.sent[0].payload.parts[0].text).toBe('收到 QQ 消息')
    expect(wx.sent[0].payload.parts[0]).toMatchObject({ type: 'text', text: '仍在处理' })
    expect(wx.sent[1].payload.parts[0].type).toBe('sticker')
    expect(wx.sent[2].payload.parts[0].text).toBe('收到微信消息')
    const agent = h.ctx.agents.get(SessionId('session-shared-platforms'))!
    agent.followup(prompt('local input after the two platform turns'))
    await agent.whenIdle()
    expect(lastOutcome(agent)).toBe('blocked')
    expect(h.adapter.requests).toHaveLength(4)

    agent.inject(prompt('unregistered input queued in the shared agent'))
    const nextWx = (messageId: string) => wx.pushInbound({
      messageId, chat: { kind: 'private', id: 'owner_wx' },
      sender: { account: 'owner_wx', name: '微信主人' }, parts: [{ type: 'text', text: '同一条微信消息' }],
    })
    nextWx('wx-mixed')
    await vi.waitFor(() => expect(submitted).toHaveLength(3))
    await submitted[2]
    expect(h.adapter.requests).toHaveLength(4)
    expect(wx.sent.slice(3).map(record => record.payload.inResponseTo)).toEqual(['wx-mixed'])
    expect(wx.sent[3].payload.parts[0].text).toContain('请重新发送')
    expect(send.mock.calls.find(([message]) => message.inResponseTo === 'wx-mixed')).toMatchObject([
      { chatId: 'wechat-clawbot:private:owner_wx', sensitive: true }, { replyGuard: expect.any(Function) },
    ])

    // A platform with proactive sends enabled would otherwise accept the expired receipt.
    agent.inject(prompt('unregistered input before an expired platform reply'))
    qq.pushInbound({
      messageId: 'qq-expired', at: clock, chat: { kind: 'private', id: '10001' },
      sender: { account: '10001', name: 'QQ 主人' }, parts: [{ type: 'text', text: '将过期的 QQ 消息' }],
    })
    clock += replyWindowMs + 1
    await vi.waitFor(() => expect(submitted).toHaveLength(4))
    await submitted[3]
    expect(h.adapter.requests).toHaveLength(4)
    expect(send.mock.calls.find(([message]) => message.inResponseTo === 'qq-expired')).toMatchObject([
      { chatId: 'qq:private:10001', sensitive: true }, { replyGuard: expect.any(Function) },
    ])
    expect(qq.sent.map(record => record.payload.inResponseTo)).toEqual(['qq-in'])
    expect(gateway.outbox.status().count).toBe(0)
    expect(hub.sharedStatus().lastDeliveryFailure).toEqual({
      at: expect.any(Number), platform: 'qq', kind: 'failure-notice', reason: 'reply-expired',
    })

    agent.inject(prompt('unregistered input before offline receipt'))
    nextWx('wx-offline-notice')
    wx.disconnect()
    await vi.waitFor(() => expect(submitted).toHaveLength(5))
    await submitted[4]
    expect(h.adapter.requests).toHaveLength(4)
    expect(hub.sharedStatus().lastDeliveryFailure).toEqual({
      at: expect.any(Number), platform: 'wechat-clawbot', kind: 'failure-notice', reason: 'offline',
    })
    expect(gateway.outbox.status().count).toBe(0)
    wx.reconnect()

    nextWx('wx-offline-reply')
    wx.disconnect()
    await vi.waitFor(() => expect(submitted).toHaveLength(6))
    await submitted[5]
    expect(h.adapter.requests).toHaveLength(5)
    const lastFailure = hub.sharedStatus().lastDeliveryFailure
    expect(lastFailure).toEqual({
      at: expect.any(Number), platform: 'wechat-clawbot', kind: 'reply', reason: 'offline',
    })
    expect(hub.sharedStatus('debug').lastDeliveryFailure).toBeUndefined()
    expect(gateway.outbox.status().count).toBe(0)
    wx.reconnect()

    nextWx('wx-resend')
    await vi.waitFor(() => expect(submitted).toHaveLength(7))
    await submitted[6]
    expect(h.adapter.requests).toHaveLength(6)
    expect(wx.sent.slice(3).map(record => record.payload.inResponseTo)).toEqual(['wx-mixed', 'wx-resend'])
    expect(JSON.stringify(h.adapter.requests[5].messages)).not.toContain('unregistered input')
    expect(hub.sharedStatus().lastDeliveryFailure).toEqual(lastFailure)
    hub.invalidateSharedSource('wechat-clawbot', 'owner_wx')
    expect(hub.sharedStatus().lastDeliveryFailure).toBeUndefined()
  } finally {
    stop()
    off()
    hub.dispose()
    await gateway.stopAll()
    identity.close?.()
  }
}, 15_000)

it('routes owner speakup through ordinary, fallback, live shared and normalized debug sessions', async () => {
  const h = await harness({ responses: [
    textResponse('普通 QQ 搭话'), textResponse('备用飞书搭话'), textResponse('收到飞书消息'),
    toolCallResponse('proactive-tool', 'speakup_probe', {}), textResponse('第一条主动消息'),
    textResponse('无法投递的消息'), textResponse('投递前失去主动能力'), textResponse('调试搭话'), textResponse(''),
    () => { throw new Error('模型生成失败') }, 'hang', 'hang',
  ] })
  vi.stubEnv('AURABOT_DATA_DIR', h.cwd)
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const identity = createIdentity({ dataDir: join(h.cwd, 'identity'), log })
  const owner = identity.claimOwner('qq', '10001')
  identity.link('feishu', 'owner_f', owner, 'owner')
  let cfg = normalize({
    enabled: true, dryRun: false, ownerPersonId: owner, ownerQQ: '10001',
    ownerAuthorization: { owner, revision: '11111111-2222-4333-8444-555555555555' },
    ownerPrimary: { platform: 'qq', instance: 'qq', account: '10001', fallback: true },
    platforms: { qq: { enabled: true }, feishu: { enabled: true } },
    workspaceDir: h.cwd, merge: { enabled: false }, voice: { enabled: false }, stickers: { enabled: false }, chat: { thinkingGuard: { enabled: false } },
  })
  const gateway = createGateway({ config: cfg, dataDir: (...path) => join(h.cwd, ...path), identity, log })
  const qq = makeFakeAdapter({ id: 'qq', caps: { proactive: 'free' } })
  const feishu = makeFakeAdapter({ id: 'feishu' })
  gateway.register(() => qq)
  gateway.register(() => feishu)
  await gateway.sync()
  let created = 0
  const newAgent = async () => {
    const sessionId = SessionId('proactive-' + (++created))
    await h.ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: h.cwd })
    return { sessionId }
  }
  h.ctx.provide('sessionController', {
    create: newAgent, fork: newAgent, rename: vi.fn(),
    resolveAgent: async id => ({ agent: h.ctx.agents.get(id) }),
  } as never)
  h.ctx.workspaceRegistry.list = () => [{ id: 'workspace', path: h.cwd }]
  const prompts: string[] = []
  let allowOrdinary = false
  const sendHook = vi.fn()
  const tool = vi.fn(async () => [{ type: 'text', text: '允许' }])
  const hub = createHub({
    dsh: h.ctx, getConfig: () => cfg, log, gateway, identity,
    resolveSharedPrimary: () => fixedSharedPrimary({ cfg, identity, instances: gateway.instances() }),
    hooks: {
      prompt(content, ctx) {
        prompts.push(ctx.sessionId)
        return allowOrdinary || ctx.proactive || ctx.senderId === 'owner_f' ? content : null
      },
      send: sendHook,
    },
    buildTools: () => [defineContentToolFixture({ name: 'speakup_probe', description: 'probe', parameters: {}, execute: tool })],
  })
  const off = h.ctx.on('session/event', hub.onSessionEvent)
  const delivered = vi.fn()
  const ended = vi.fn()
  const sessionFile = join(h.cwd, 'sessions.json')
  const readMap = async () => JSON.parse(await readFile(sessionFile, 'utf8'))
  const push = (chatId = 'qq:private:10001', route = {}) => hub.pushProactiveToSession({
    chatId, kind: 'private', platform: chatId.split(':')[0], userId: chatId.split(':')[2],
  }, [{ type: 'text', text: '系统主动搭话' }], '', { route: { chatId, ...route }, onDelivered: delivered, onTurnEnd: ended })
  try {
    gateway.noteSeen(owner, 'feishu:private:owner_f', Date.now())
    expect(gateway.routeTo(owner)).toBe('feishu:private:owner_f')
    cfg.multiPlatformPrivateSession = true
    cfg.enabled = false
    await expect(push()).resolves.toMatchObject({ ok: false })
    expect(prompts).toEqual([])
    expect(h.adapter.requests).toEqual([])
    expect(qq.sent).toEqual([])
    expect(feishu.sent).toEqual([])
    cfg.enabled = true
    ended.mockClear()
    cfg.multiPlatformPrivateSession = false
    expect(hub.sharedStatus().state).toBe('uninitialized')
    const ordinaryBaseline = (await readMap()).multiPrivate.sessions.live
    allowOrdinary = true
    await push()
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1))
    expect(ended.mock.lastCall?.[0]).toMatchObject({ ok: true })
    expect(delivered).toHaveBeenCalledTimes(1)
    expect(qq.sent.map(x => x.payload)).toMatchObject([
      { chat: { kind: 'private', id: '10001' }, parts: [{ type: 'text', text: '普通 QQ 搭话' }] },
    ])
    expect(feishu.sent).toEqual([])
    expect(JSON.stringify(h.ctx.sessions.get(SessionId(prompts[0]))?.deriveMessages())).toContain('系统主动搭话')
    expect((await readMap()).multiPrivate.sessions.live).toEqual(ordinaryBaseline)
    allowOrdinary = false
    cfg.multiPlatformPrivateSession = true
    cfg.dryRun = true
    await push()
    cfg.dryRun = false
    await push(undefined, { blocked: true })
    hub.refreshSharedConfig()
    const liveBeforeFallback = (await readMap()).multiPrivate.sessions.live
    qq.disconnect()
    expect(cfg.ownerPrimary.fallback).toBe(true)
    expect(gateway.instances().find(instance => instance.instance === 'qq')?.state).toBe('disconnected')
    const fallback = gateway.routeTo(owner)
    expect(fallback).toBe('feishu:private:owner_f')
    allowOrdinary = true
    await push(fallback!, { fallbackUsed: true })
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(2))
    expect(ended.mock.lastCall?.[0]).toMatchObject({ ok: true })
    expect(delivered).toHaveBeenCalledTimes(2)
    expect(feishu.sent.map(x => x.payload)).toMatchObject([
      { chat: { kind: 'private', id: 'owner_f' }, parts: [{ type: 'text', text: '备用飞书搭话' }] },
    ])
    expect(qq.sent).toHaveLength(1)
    expect(JSON.stringify(h.ctx.sessions.get(SessionId(prompts.at(-1)!))?.deriveMessages())).toContain('系统主动搭话')
    expect(prompts.at(-1)).not.toBe(prompts[0])
    expect((await readMap()).multiPrivate.sessions.live).toEqual(liveBeforeFallback)
    allowOrdinary = false
    qq.reconnect()
    const cap = vi.spyOn(gateway, 'caps').mockReturnValueOnce({ proactive: 'none' } as never)
    await push()
    cap.mockRestore()
    expect(prompts).toHaveLength(5)
    expect(hub.sharedStatus().state).toBe('uninitialized')
    expect(delivered).toHaveBeenCalledTimes(2)
    const map = await readMap()
    map.multiPrivate.sessions.live.state = 'paused'
    await writeFile(sessionFile, JSON.stringify(map))
    await push()
    expect(prompts.at(-1)).toBe(prompts[0])
    expect(hub.sharedStatus().state).toBe('paused')
    // Start from an empty shared branch so this fixture needs no persisted parent.
    hub.resetShared(['live', 'debug'], 'empty')
    let inbound: Promise<unknown> | undefined
    const stop = gateway.onMessage(message => { inbound = hub.onGatewayMessage(message) })
    try {
      feishu.pushInbound({ messageId: 'recent-feishu', chat: { kind: 'private', id: 'owner_f' },
        sender: { account: 'owner_f' }, parts: [{ type: 'text', text: '从飞书接续会话' }] })
      await vi.waitFor(() => expect(inbound).toBeDefined())
      await inbound
    } finally { stop() }
    await push()
    expect(tool).toHaveBeenCalledTimes(1)
    expect(delivered).toHaveBeenCalledTimes(3)
    expect(qq.sent.map(x => x.payload.inResponseTo)).toEqual([undefined, undefined])
    const live = prompts.at(-1)
    const failedSend = vi.spyOn(gateway, 'send').mockRejectedValueOnce(new Error('发送失败'))
    await push()
    expect(ended.mock.calls.at(-1)?.[0]).toMatchObject({ ok: false })
    expect(delivered).toHaveBeenCalledTimes(3)
    expect(failedSend).toHaveBeenCalledTimes(1)
    failedSend.mockRestore()

    // The primary was eligible through generation and lost proactive capability during send preparation.
    const send = vi.spyOn(gateway, 'send')
    const requestsBeforeCapsChange = h.adapter.requests.length
    const endsBeforeCapsChange = ended.mock.calls.length
    sendHook.mockClear()
    sendHook.mockImplementationOnce(() => { qq.setCaps({ proactive: 'none' }) })
    try {
      await expect(push()).resolves.toMatchObject({ ok: false })
      expect(sendHook).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled()
      expect(ended).toHaveBeenCalledTimes(endsBeforeCapsChange + 1)
      expect(ended.mock.lastCall?.[0]).toMatchObject({ ok: false })
      expect(h.adapter.requests).toHaveLength(requestsBeforeCapsChange + 1)
      expect(delivered).toHaveBeenCalledTimes(3)
      expect(qq.sent).toHaveLength(2)
      expect(feishu.sent).toHaveLength(2)
      expect(gateway.outbox.status().count).toBe(0)
    } finally {
      send.mockRestore()
      qq.setCaps({ proactive: 'free' })
    }

    cfg = normalize({ ...cfg, debug: true })
    expect(cfg.dryRun).toBe(true)
    hub.refreshSharedConfig()
    await push()
    const debug = prompts.at(-1)!
    expect(debug).not.toBe(live)
    expect((await readMap()).multiPrivate.sessions.debug.sessionId).toBe(debug)
    expect((await readMap()).multiPrivate.sessions.live.sessionId).toBe(live)
    const debugEvents = h.ctx.sessions.get(SessionId(debug))?.snapshotEvents()
    expect(debugEvents).toContainEqual(expect.objectContaining({
      type: 'user/message', data: expect.objectContaining({ source: expect.objectContaining({ kind: 'aurabot-proactive' }) }),
    }))
    expect(JSON.stringify(debugEvents)).toContain('调试搭话')
    expect(ended.mock.lastCall?.[0]).toMatchObject({ ok: true })
    expect(delivered).toHaveBeenCalledTimes(3)
    expect(qq.sent).toHaveLength(2)
    cfg = normalize({ ...cfg, debug: false, dryRun: false })
    hub.refreshSharedConfig()

    const endsBeforeSilence = ended.mock.calls.length
    const requestsBeforeSilence = h.adapter.requests.length
    await expect(push()).resolves.toEqual({ ok: true })
    expect(h.adapter.requests).toHaveLength(requestsBeforeSilence + 1)
    expect(ended).toHaveBeenCalledTimes(endsBeforeSilence + 1)
    expect(ended.mock.lastCall).toEqual([{ ok: true }])
    expect(delivered).toHaveBeenCalledTimes(3)
    expect(qq.sent).toHaveLength(2)
    expect(feishu.sent).toHaveLength(2)
    const requestsBeforeFailure = h.adapter.requests.length
    await push()
    expect(ended.mock.lastCall?.[0]).toMatchObject({ ok: false })
    expect(h.adapter.requests).toHaveLength(requestsBeforeFailure + 1)

    const interrupt = async (change: () => void) => {
      const requests = h.adapter.requests.length
      const outcomes = ended.mock.calls.length
      const pending = push()
      try {
        await vi.waitFor(() => expect(h.adapter.requests).toHaveLength(requests + 1), { timeout: 5000 })
      } finally { change() }
      await expect(pending).resolves.toMatchObject({ ok: false })
      expect(ended).toHaveBeenCalledTimes(outcomes + 1)
      expect(h.adapter.requests).toHaveLength(requests + 1)
    }
    await interrupt(() => {
      cfg.multiPlatformPrivateSession = false
      hub.refreshSharedConfig()
    })
    cfg.multiPlatformPrivateSession = true
    hub.refreshSharedConfig()
    // The cancelled turn is beyond the previous checkpoint. Use a fresh branch for the reset scenario.
    hub.resetShared(['live'], 'empty')
    await interrupt(() => hub.resetShared(['live'], 'empty'))
    expect(hub.sharedStatus().state).toBe('uninitialized')
    expect((await readMap()).multiPrivate.retiredSessions[prompts.at(-1)!]).toMatchObject({ mode: 'live' })
    expect(delivered).toHaveBeenCalledTimes(3)
    expect(qq.sent).toHaveLength(2)
    expect(feishu.sent.map(x => x.payload.inResponseTo)).toEqual([undefined, 'recent-feishu'])
    expect(gateway.outbox.status().count).toBe(0)
  } finally {
    off()
    hub.dispose()
    await gateway.stopAll()
    identity.close?.()
  }
}, 30_000)

it('forks only the confirmed legacy prefix with the real DSH controller and restores the same child from disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aurabot-dsh-fork-'))
  vi.stubEnv('AURABOT_DATA_DIR', root)
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('DSH_AGENTS_HOME', root)
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const identity = createIdentity({ dataDir: join(root, 'identity'), log })
  const owner = identity.claimOwner('qq', '10001')
  identity.link('wechat-clawbot', 'owner_wx', owner, 'owner')
  const cfg = normalize({
    enabled: true, dryRun: false, ownerLevel: 'social', ownerPersonId: owner, ownerQQ: '10001',
    ownerAuthorization: { owner, revision: '11111111-2222-4333-8444-555555555555' },
    multiPlatformPrivateSession: true,
    ownerPrimary: { platform: 'qq', instance: 'qq', account: '10001' },
    platforms: { qq: { enabled: true }, 'wechat-clawbot': { enabled: true } },
    workspaceDir: root, merge: { enabled: false }, voice: { enabled: false },
    stickers: { enabled: false, collect: false }, chat: { thinkingGuard: { enabled: false } },
  })
  const sessionsPath = join(root, 'sessions.json')
  const readMap = async () => JSON.parse(await readFile(sessionsPath, 'utf8'))
  const model = { provider: 'mock', model: 'mock' }
  const start = async (ctx: Context) => {
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'session-logs'), compression: 'none' })
    const adapter = await mountAgentRuntime(ctx, Array.from({ length: 12 }, (_, i) => textResponse('模型回执 ' + i)))
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'storage') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(WorkspaceRegistry)
    await ctx.plugin(ArchivedSessionGate)
    await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 80, maxTitleBytes: 100 })
    createSessionTestController(ctx, { defaultModelSelection: () => model, cwd: root })
    const gateway = createGateway({ config: cfg, dataDir: (...path) => join(root, ...path), identity, log })
    const qq = makeFakeAdapter({ id: 'qq', self: { account: '20001' } })
    const wx = makeFakeAdapter({ id: 'wechat-clawbot', caps: { proactive: 'none' } })
    gateway.register(() => qq)
    gateway.register(() => wx)
    await gateway.sync()
    const hub = createHub({
      dsh: ctx, getConfig: () => cfg, log, identity, gateway,
      resolveSharedPrimary: () => fixedSharedPrimary({ cfg, identity, instances: gateway.instances() }),
    })
    let off: (() => void) | undefined
    const submitted: Promise<unknown>[] = []
    const stop = gateway.onMessage(message => { submitted.push(hub.onGatewayMessage(message)) })
    return {
      adapter, hub, qq, wx,
      trackOutput() {
        off = ctx.on('session/event', hub.onSessionEvent)
      },
      async send(platform: 'qq' | 'wx', messageId: string, text: string) {
        const account = platform === 'qq' ? '10001' : 'owner_wx'
        const platformAdapter = platform === 'qq' ? qq : wx
        const before = submitted.length
        platformAdapter.pushInbound({
          messageId, chat: { kind: 'private', id: account }, sender: { account, name: '主人' },
          parts: [{ type: 'text', text }],
        })
        await vi.waitFor(() => expect(submitted).toHaveLength(before + 1))
        await submitted[before]
      },
      async close() {
        stop()
        off?.()
        hub.dispose()
        await gateway.stopAll()
      },
    }
  }

  let ctx = new Context()
  let host: Awaited<ReturnType<typeof start>> | undefined
  try {
    const sourceId = SessionId('ordinary-legacy-qq')
    await writeFile(sessionsPath, JSON.stringify({
      chats: { 'private:10001': { sessionId: sourceId, level: 'social', preset: 'aurabot-social', title: '旧主账号私聊' } },
    }))
    host = await start(ctx)
    const workspace = await ctx.workspaceRegistry.create(root)
    const ordinary = await ctx.agentLoop.create(sourceId, model, { cwd: workspace.path })
    await ctx.workspaceRegistry.get(workspace.id)!.attachSession(sourceId)
    ordinary.followup(prompt('已核对的旧 QQ 历史'))
    await ordinary.whenIdle()
    expect(await ctx.sessions.flush(ordinary.session)).toBe(true)

    expect(host.hub.sharedStatus()).toMatchObject({ legacyHistoryAvailable: true, legacyHistoryChanged: false })
    const review = await host.hub.prepareLegacyHistory('live')
    expect(review).toMatchObject({ ok: true, sessionId: sourceId, title: '旧主账号私聊' })
    expect(await host.hub.confirmLegacyHistory('live', 'wrong-token')).toMatchObject({ ok: false })
    ordinary.followup(prompt('核对后追加的普通私聊'))
    await ordinary.whenIdle()
    expect(await host.hub.confirmLegacyHistory('live', review.token)).toMatchObject({ ok: true })
    expect(await host.hub.confirmLegacyHistory('live', review.token)).toMatchObject({ ok: false })
    expect(host.hub.sharedStatus().legacyHistoryAvailable).toBe(false)
    expect(await host.hub.prepareLegacyHistory('live')).toMatchObject({ ok: false })
    expect((await readMap()).chats['private:10001'].sessionOwners.live.legacyPrefix.atSeq).toBe(review.atSeq)

    await host.close()
    await ctx.fiber.dispose()
    host = undefined
    ctx = new Context()
    host = await start(ctx)
    expect(ctx.sessions.get(sourceId)).toBeUndefined()
    host.trackOutput()
    await host.send('qq', 'fork-qq', '共享中的 QQ 消息')
    await host.send('wx', 'fork-wx', '共享中的微信消息')
    const delivered = vi.fn()
    const ended = vi.fn()
    const primaryChat = { chatId: 'private:10001', kind: 'private', userId: '10001' }
    await host.hub.pushProactiveToSession(primaryChat, [{ type: 'text', text: '主动搭话专用提示' }], '', {
      route: { chatId: 'qq:private:10001' }, onDelivered: delivered, onTurnEnd: ended,
    })
    expect(ended.mock.calls).toEqual([[{ ok: true }]])
    expect(delivered).toHaveBeenCalledTimes(1)
    const { sessionId: childId, verifiedThroughSeq } = (await readMap()).multiPrivate.sessions.live
    const child = ctx.sessions.get(childId)!
    expect((await readMap()).multiPrivate.sessions.live).toMatchObject({ state: 'active', baseSessionId: sourceId })
    expect(child.header.parentSession).toBe(sourceId)
    expect(child.inheritedEventCount).toBe(review.atSeq + 1)
    expect(ctx.workspaceRegistry.get(workspace.id)?.sessionIds).toContain(childId)
    expect(child.snapshotEvents().findLast(event => event.type === 'session/title')?.data.title).toBe('多平台 · 主人私聊')
    expect(child.eventAt(verifiedThroughSeq)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(JSON.stringify(host.adapter.requests.at(-1)?.messages)).toContain('已核对的旧 QQ 历史')
    expect(JSON.stringify(host.adapter.requests.at(-1)?.messages)).not.toContain('核对后追加的普通私聊')
    expect(child.snapshotEvents()).toContainEqual(expect.objectContaining({
      type: 'user/message', data: expect.objectContaining({ source: {
        kind: 'aurabot-proactive', form: 'proactive', proactive: true, speaker: { role: 'owner', chat: 'private' },
      } }),
    }))
    expect(host.qq.sent.map(record => record.payload.inResponseTo)).toEqual(['fork-qq', undefined])
    expect(host.wx.sent.map(record => record.payload.inResponseTo)).toEqual(['fork-wx'])

    await host.close()
    await ctx.fiber.dispose()
    host = undefined
    ctx = new Context()
    host = await start(ctx)
    host.trackOutput()
    expect(ctx.sessions.get(childId)).toBeUndefined()
    expect(ctx.workspaceRegistry.get(workspace.id)?.sessionIds).toContain(childId)
    await host.send('wx', 'cold-wx', '冷恢复后的微信消息')
    expect(host.qq.sent).toEqual([])
    expect(host.wx.sent.map(record => record.payload.inResponseTo)).toEqual(['cold-wx'])
    expect(ctx.sessions.get(childId)?.header.parentSession).toBe(sourceId)
    const restoredMessages = JSON.stringify(host.adapter.requests.at(-1)?.messages)
    expect(restoredMessages).toContain('共享中的 QQ 消息')
    expect(restoredMessages).toContain('共享中的微信消息')
    expect(restoredMessages).toContain('主动搭话专用提示')
    const recoveredMap = await readMap()
    expect(recoveredMap.multiPrivate.sessions.live).toMatchObject({ sessionId: childId, state: 'active' })
    const recoveredCheckpoint = recoveredMap.multiPrivate.sessions.live.verifiedThroughSeq
    expect(recoveredCheckpoint).toBeGreaterThan(verifiedThroughSeq)
    expect(host.hub.sharedStatus().legacyHistoryAvailable).toBe(false)

    const unverifiedText = '崩溃前完成但核验点未落盘的主动搭话'
    await host.hub.pushProactiveToSession(primaryChat, [{ type: 'text', text: unverifiedText }], '', {
      route: { chatId: 'qq:private:10001' },
    })
    const proactiveCheckpoint = (await readMap()).multiPrivate.sessions.live.verifiedThroughSeq
    expect(proactiveCheckpoint).toBeGreaterThan(recoveredCheckpoint)

    // Keep DSH's persisted proactive turn and rewind only Aurabot's checkpoint to the preceding turn.
    await host.close()
    await ctx.fiber.dispose()
    host = undefined
    await writeFile(sessionsPath, JSON.stringify(recoveredMap))
    ctx = new Context()
    host = await start(ctx)
    host.trackOutput()
    const retryText = '重启后尝试继续共享会话'
    await host.send('wx', 'unverified-recovery', retryText)
    expect(host.hub.sharedStatus()).toMatchObject({ state: 'paused', pauseReason: 'restored-history-unverified' })
    const pausedChild = ctx.sessions.get(childId)!
    expect(pausedChild.eventAt(proactiveCheckpoint)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'completed' } },
    })
    expect(pausedChild.snapshotEvents().filter(event => event.seq > recoveredCheckpoint)).toContainEqual(expect.objectContaining({
      type: 'user/message', data: expect.objectContaining({
        source: expect.objectContaining({ kind: 'aurabot-proactive' }),
        content: expect.arrayContaining([{ type: 'text', text: unverifiedText }]),
      }),
    }))
    expect(JSON.stringify(pausedChild.deriveMessages())).not.toContain(retryText)
    await vi.waitFor(() => expect(host?.adapter.requests).toHaveLength(1))
    const ordinaryMessages = JSON.stringify(host.adapter.requests[0].messages)
    expect(ordinaryMessages).toContain(retryText)
    expect(ordinaryMessages).not.toContain(unverifiedText)
    expect(host.qq.sent).toEqual([])
    expect((await readMap()).multiPrivate.sessions.live).toMatchObject({
      sessionId: childId, verifiedThroughSeq: recoveredCheckpoint,
    })
    host.hub.resetShared(['live'], 'empty')
    await vi.waitFor(async () => {
      expect((await readMap()).multiPrivate.retiredSessions[childId].archiveState).toBe('archived')
    })
    expect(ctx.workspaceRegistry.archivedSessionIds).toContain(childId)

    // A saved fingerprint for a changed prefix requires an explicit new review.
    const stale = await readMap()
    stale.chats['private:10001'].sessionOwners.live.legacyPrefix.fingerprint = 'previous-prefix'
    await writeFile(sessionsPath, JSON.stringify(stale))
    host.hub.resetShared(['live'], 'inherit')
    await host.send('wx', 'changed-legacy', '历史变化后的微信消息')
    expect(host.hub.sharedStatus()).toMatchObject({
      emptyReason: 'legacy-prefix-changed', legacyHistoryAvailable: true, legacyHistoryChanged: true,
    })
    const updatedReview = await host.hub.prepareLegacyHistory('live')
    expect(updatedReview.ok).toBe(true)
    expect(await host.hub.confirmLegacyHistory('live', updatedReview.token)).toMatchObject({ ok: true })
    expect(host.hub.sharedStatus().legacyHistoryAvailable).toBe(false)

    cfg.ownerAuthorization = { owner, revision: '22222222-2222-4333-8444-555555555555' }
    host.hub.refreshSharedConfig()
    expect(host.hub.sharedStatus()).toMatchObject({ sourceAuthorizationChanged: true, legacyHistoryAvailable: false })
    expect(await host.hub.prepareLegacyHistory('live')).toMatchObject({ ok: false })
  } finally {
    try {
      await host?.close()
      await ctx.fiber.dispose()
    } finally {
      identity.close?.()
      await rm(root, { recursive: true, force: true })
    }
  }
}, 30_000)

it('verifies persisted agent/inbox/spliced events through real DSH JsonlSessionPersistence before model step finishes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aurabot-dsh-inbox-proof-'))
  const ctxMemOnly = new Context()
  const ctxPersist = new Context()
  fixtures.push({ ctx: ctxMemOnly, cwd })
  try {
    vi.stubEnv('DSH_HOME', cwd)
    vi.stubEnv('DSH_AGENTS_HOME', cwd)
    // 1) 无 sessionPersistence 时即使挂载了 SessionStore（flush 返回 true）也必须被 preflight 拒绝
    await mountAgentRuntime(ctxMemOnly, [textResponse('ok')])
    expect(await checkMigrationPersistencePreflight(ctxMemOnly)).toMatchObject({
      ok: false,
      reason: 'missing-session-persistence',
    })

    // 2) 真实 JsonlSessionPersistence：模型 step 阻塞时，followup + flush 后只读句柄能查到 agent/inbox/spliced.data.inserted[].id
    await ctxPersist.plugin(JsonlSessionPersistence, { root: join(cwd, 'session-logs'), compression: 'none' })
    const adapter = await mountAgentRuntime(ctxPersist, [textResponse('模型最终响应')])
    let releaseModelStep!: () => void
    const modelGate = new Promise<void>(resolve => { releaseModelStep = resolve })
    const origStream = adapter.stream.bind(adapter)
    adapter.stream = async function* (req, opts) {
      await modelGate
      yield* origStream(req, opts)
    }

    const sessionId = SessionId('migration-proof-session')
    const agent = await ctxPersist.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd })
    expect(await checkMigrationPersistencePreflight(ctxPersist, { sessionId })).toMatchObject({ ok: true })

    const baselineSeq = agent.session.seq
    const msg = prompt('真实 DSH 持久化收件箱验证', 'aurabot')
    agent.followup(msg)
    await ctxPersist.sessions.flush(agent.session)

    // 此时模型尚未响应、turn 仍未结束，只读句柄必须能查到 agent/inbox/spliced inserted[].id
    const proof = await verifyPersistedInboxMessage(ctxPersist, {
      sessionId,
      baselineSeq,
      messageId: msg.id,
    })
    expect(proof.ok).toBe(true)

    // 错误 ID 不应误报 accepted
    const miss = await verifyPersistedInboxMessage(ctxPersist, {
      sessionId,
      baselineSeq,
      messageId: 'non-existent-message-id',
    })
    expect(miss.ok).toBe(false)

    releaseModelStep()
    await agent.whenIdle()
  } finally {
    await ctxPersist.fiber.dispose().catch(() => {})
  }
}, 20_000)
