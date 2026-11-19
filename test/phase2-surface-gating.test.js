import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { makeFakeAdapter } from './helpers/fake-adapter.js'

const QQ_LEAK_RE = /你现在在 QQ 上|发到 QQ|QQ 空间|<at:QQ号>|QQ 自带的小黄脸|<face:|<poke>|qq_chat_history|qq_get_profile|qq_send_avatar|qq_send_qzone|qq_api_find|qq_api_call|qq_import_qq_stickers|不能碰 onebot|发 QQ 消息/

const until = async (predicate, ms = 4000) => {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  assert.ok(predicate(), '等待条件超时')
}

async function bootHost(t, { cfg, userModCode = '' }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-surface-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  const prevWs = process.env.AURABOT_WORKSPACE
  const prevGlobal = globalThis.aurabot
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  if (userModCode) {
    mkdirSync(join(dataDir, 'modules', 'p2g-probe'), { recursive: true })
    writeFileSync(join(dataDir, 'modules', 'p2g-probe', 'index.mjs'), userModCode)
  }
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(cfg))

  const fake = createFakeDsh({ brain: async () => '收到' })
  const warns = []
  const origWarn = fake.ctx.logger.warn
  fake.ctx.logger.warn = (...a) => {
    warns.push(a.map(String).join(' '))
    return origWarn?.(...a)
  }
  const host = await import('../src/host.js')
  const app = host.apply(fake.ctx)
  t.after(async () => {
    fake.dispose()
    await app.gateway?.stopAll?.()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
    if (prevWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = prevWs
    if (prevGlobal === undefined) delete globalThis.aurabot
    else globalThis.aurabot = prevGlobal
  })
  await app.ready
  return { fake, app, warns, dataDir }
}

test('PR-2G 场景1：纯 Feishu 环境下所有非工具面（rule / context / command / prompt）绝不出现 QQ 专属内容', async (t) => {
  const { fake, app, warns } = await bootHost(t, {
    cfg: {
      enabled: true,
      dryRun: false,
      setupDone: true,
      ownerName: '阿白',
      merge: { enabled: false },
      allow: { private: ['feishu:private:ou_owner'], groups: ['feishu:group:oc_g1'] },
      platforms: { qq: { enabled: false }, feishu: { enabled: true } },
      stickers: { enabled: true, collect: true, faces: true },
      qqApi: { enabled: true },
      diary: { enabled: true },
      ext: { purpose: { enabled: true } },
    },
    userModCode: `export default {
      id: 'p2g-probe', name: '探测命令', api: 3, platforms: ['*'],
      setup(api) {
        api.command({ name: 'qqonlycmd', platforms: ['qq'], desc: 'QQ专属命令', run: () => 'qq-cmd' })
        api.command({ name: 'fscmd', platforms: ['feishu'], desc: '飞书专属命令', run: () => 'fs-cmd' })
        api.command({ name: 'unicmd', platforms: ['*'], desc: '全平台命令', run: () => 'uni-cmd' })
        api.context({ platforms: ['qq'], fn: () => 'QQ专属上下文泄露' })
        api.context({ platforms: ['feishu'], fn: () => '飞书可用上下文' })
      },
    }`,
  })

  app.gateway.identity.claimOwner('feishu', 'ou_owner')
  await app.gateway.stopAll()
  let fsAdapter = null
  app.gateway.register(() => (fsAdapter = makeFakeAdapter({
    id: 'feishu',
    caps: { image: true, file: true, voice: 'native', video: true, sticker: false, poke: false, history: false, features: { 'media.fetch': true, 'sticker.collect': false } },
  })))
  await app.gateway.sync()

  // 1) QQ 专属模块应均处于未运行状态
  for (const id of ['diary', 'profile', 'qq-api', 'group-admin', 'qq-tools', 'contacts', 'qzone-social']) {
    const row = app.modules.status().find((m) => m.id === id)
    assert.ok(!row || row.running === null, `${id} 在纯 Feishu 下不应运行`)
  }
  assert.equal(warns.filter((w) => w.includes('api.rule')).length, 0)

  // 2) 4 档全局 preset 变量均不得含 QQ 专属提示
  for (const varName of ['aurabot_rules_private', 'aurabot_rules_social', 'aurabot_rules_autotelic', 'aurabot_rules_group_owner']) {
    const text = fake.variables.get(varName)()
    assert.doesNotMatch(text, QQ_LEAK_RE, `${varName} 不得泄漏 QQ 内容：\n${text}`)
  }

  // 3) Feishu 会话 context（模块 + host QQ 会话规则提供者）不得含 QQ 内容
  const fsCtx = app.hub ? app.modules.contextFor({ chat: { chatId: 'feishu:private:ou_owner', kind: 'private', platform: 'feishu', userId: 'ou_owner' }, level: 'full' }) : ''
  assert.match(fsCtx, /飞书可用上下文/)
  assert.doesNotMatch(fsCtx, /QQ专属上下文泄露/)
  assert.doesNotMatch(fsCtx, QQ_LEAK_RE)

  // 4) 真正走一条飞书入站消息，验证完整回合里的 ctxText / 命令面无 QQ 内容
  fsAdapter.pushInbound({
    chat: { id: 'ou_owner', kind: 'private', name: '阿白' },
    sender: { account: 'ou_owner', name: '阿白', isOwner: true, person: 'p-owner' },
    messageId: 'om_fs_1',
    at: Date.now(),
    text: '在飞书聊聊',
    parts: [{ type: 'text', text: '在飞书聊聊' }],
  })
  await until(() => fake.turns.length >= 1)
  assert.doesNotMatch(fake.turns[0].ctxText, QQ_LEAK_RE)
  assert.match(fake.turns[0].ctxText, /飞书可用上下文/)

  // 5) 命令过滤：/help 与 /modules/simulate 不出现 /diary 与 qqonlycmd
  const fsCmds = app.modules.commands({ platform: 'feishu', chatId: 'feishu:private:ou_owner' }).map((c) => c.name)
  assert.ok(fsCmds.includes('fscmd'))
  assert.ok(fsCmds.includes('unicmd'))
  assert.ok(!fsCmds.includes('qqonlycmd'))

  const helpSim = (await fake.call('/modules/simulate', { as: 'owner', kind: 'private', platform: 'feishu', text: '/diary' })).json()
  assert.match(helpSim.steps.join('\n'), /没有模块接管/, '纯飞书下 /diary 不应被识别成有效内置命令')

  // /help 实际回执：不含「空间日记」与「QQ 号」
  fsAdapter.pushInbound({
    chat: { id: 'ou_owner', kind: 'private', name: '阿白' },
    sender: { account: 'ou_owner', name: '阿白', isOwner: true, person: 'p-owner' },
    messageId: 'om_fs_help',
    at: Date.now(),
    text: '/help',
    parts: [{ type: 'text', text: '/help' }],
  })
  await until(() => fsAdapter.sent?.some((s) => s.message?.parts?.some((p) => String(p.text || '').includes('主人命令'))))
  const helpOut = fsAdapter.sent.find((s) => s.message?.parts?.some((p) => String(p.text || '').includes('主人命令'))).message.parts.map((p) => p.text).join('\n')
  assert.doesNotMatch(helpOut, /\/diary|空间日记|QQ 号/)
  assert.match(helpOut, /\/fscmd/)
  assert.doesNotMatch(helpOut, /\/qqonlycmd/)
})

test('PR-2G 场景2：QQ + Feishu 双平台共存下，全局 preset / Feishu 会话零泄漏且 QQ 会话保留 QQ 上下文', async (t) => {
  const { fake, app, warns } = await bootHost(t, {
    cfg: {
      enabled: true,
      dryRun: false,
      setupDone: true,
      ownerQQ: '10000001',
      botQQ: '20000002',
      ownerName: '阿白',
      merge: { enabled: false },
      allow: { private: ['10000001', 'feishu:private:ou_owner'], groups: ['777', 'feishu:group:oc_g1'] },
      platforms: { qq: { enabled: true }, feishu: { enabled: true } },
      stickers: { enabled: true, collect: true, faces: true },
      qqApi: { enabled: true },
      diary: { enabled: true },
    },
    userModCode: `export default {
      id: 'p2g-probe', name: '探测命令', api: 3, platforms: ['*'],
      setup(api) {
        api.command({ name: 'qqonlycmd', platforms: ['qq'], desc: 'QQ专属命令', run: () => 'qq-cmd' })
        api.command({ name: 'fscmd', platforms: ['feishu'], desc: '飞书专属命令', run: () => 'fs-cmd' })
        api.command({ name: 'unicmd', platforms: ['*'], desc: '全平台命令', run: () => 'uni-cmd' })
        api.rule(() => '共享无平台约束规则')
      },
    }`,
  })

  const ownerPerson = app.gateway.identity.owner() || app.gateway.identity.claimOwner('qq', '10000001')
  app.gateway.identity.link('feishu', 'ou_owner', ownerPerson, 'manual')
  await app.gateway.stopAll()
  let fsAdapter = null
  app.gateway.register(() => (fsAdapter = makeFakeAdapter({
    id: 'feishu',
    self: { account: 'cli_bot', name: '大肥鱼' },
    caps: { image: true, file: true, voice: 'native', sticker: false, poke: false, history: false, features: { 'media.fetch': true, 'sticker.collect': false, 'sticker.sync.native': false } },
  })))
  await app.gateway.sync()

  // 1) diary / profile / qq-api 已迁入 api.context，双平台下不应出现 api.rule 跨平台泄漏警告
  const ruleWarns = warns.filter((w) => w.includes('api.rule') || w.includes('禁止') || w.includes('泄漏'))
  assert.deepEqual(ruleWarns, [], `双平台不应产生内置模块 api.rule 警告：${ruleWarns.join(' | ')}`)

  // 2) 4 档共享全局 preset 变量不得含 QQ 专属提示，同时包含跨平台共享规则
  for (const varName of ['aurabot_rules_private', 'aurabot_rules_social', 'aurabot_rules_autotelic', 'aurabot_rules_group_owner']) {
    const text = fake.variables.get(varName)()
    assert.doesNotMatch(text, QQ_LEAK_RE, `${varName} 在双平台共享 preset 中不得出现 QQ 专属指示：\n${text}`)
    assert.match(text, /共享无平台约束规则/)
  }

  // 3) 飞书入站回合：ctxText 不得含 QQ 专属内容（diary/profile/qq-api/qqSessionRules/<face:>/<at:QQ>/<poke>/qq_chat_history/qq_import_qq_stickers）
  fsAdapter.pushInbound({
    chat: { id: 'ou_owner', kind: 'private', name: '阿白' },
    sender: { account: 'ou_owner', name: '阿白', isOwner: true, person: 'p-owner' },
    messageId: 'om_dual_1',
    at: Date.now(),
    text: '飞书这边聊聊',
    parts: [{ type: 'text', text: '飞书这边聊聊' }],
  })
  await until(() => fake.turns.length >= 1)
  const fsTurn = fake.turns[0]
  assert.doesNotMatch(fsTurn.ctxText, QQ_LEAK_RE, `飞书回合 ctxText 不得含 QQ 内容：\n${fsTurn.ctxText}`)
  assert.doesNotMatch(fsTurn.ctxText, /chat_history|发 QQ 空间说说|当前是 QQ 会话|qq_import_qq_stickers/)

  // 4) QQ 主人私聊入站回合：ctxText 应完整拿到 profile / diary / qq-api / qqSessionRulesText
  await app.hub.onMessage({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: 20000002,
    user_id: 10000001,
    message_id: 901,
    sender: { user_id: 10000001, nickname: '阿白' },
    message: [{ type: 'text', data: { text: 'QQ 这边聊聊' } }],
  })
  await until(() => fake.turns.length >= 2)
  const qqTurn = fake.turns[1]
  assert.match(qqTurn.ctxText, /qq_get_profile/, 'QQ 主人私聊应保留 profile 上下文')
  assert.match(qqTurn.ctxText, /发 QQ 空间说说/, 'QQ 主人私聊应保留 diary 上下文')
  assert.match(qqTurn.ctxText, /QQ 上想做的事.*qq_api_find/, 'QQ 主人私聊应保留 full qq-api 上下文')
  const qqGroupCtx = app.modules.contextFor({
    chat: { chatId: 'qq:group:777', kind: 'group', groupId: '777', platform: 'qq', userId: '30000003' },
    level: 'social',
  })
  assert.match(qqGroupCtx, /别人只能查当前这个群/, 'QQ 群应拿 social qq-api 上下文')
  assert.doesNotMatch(qqGroupCtx, /qq_get_profile|发 QQ 空间说说/, 'QQ 群不应拿到仅主人私聊上下文')
  assert.match(qqTurn.ctxText, /<at:QQ号>/, 'QQ 会话应通过 session context 拿到 QQ 语法提示')
  assert.match(qqTurn.ctxText, /<face:/, 'QQ 会话应通过 session context 拿到小黄脸提示')
  assert.match(qqTurn.ctxText, /chat_history/, 'QQ 会话应按能力拿到 chat_history 提示')
  assert.doesNotMatch(qqTurn.ctxText, /qq_chat_history/, '会话提示应使用跨平台权威名 chat_history')
  assert.match(qqTurn.ctxText, /<poke>/, 'QQ 会话应拿到戳一戳提示')

  // 5) 双平台命令过滤
  assert.deepEqual(
    app.modules.commands({ platform: 'feishu', chatId: 'feishu:private:ou_owner' }).map((c) => c.name).sort(),
    ['fscmd', 'unicmd'],
  )
  assert.deepEqual(
    app.modules.commands({ platform: 'qq', chatId: 'qq:private:10000001' }).map((c) => c.name).sort(),
    ['qqonlycmd', 'unicmd'],
  )
})

test('PR-2G 场景3：纯 qq#2（无默认 qq）与 qq+qq#2 双实例共存时，<poke> 仅对默认 qq 会话注入而不混入 qq#2', async (t) => {
  // 3A) 纯 qq#2-only（qq.enabled=false，qq#2.enabled=true）
  const pureQq2 = await bootHost(t, {
    cfg: {
      enabled: true,
      dryRun: false,
      setupDone: true,
      ownerQQ: '10000001',
      botQQ: '20000002',
      ownerName: '阿白',
      merge: { enabled: false },
      allow: { private: ['qq#2:private:10000001', '10000001'], groups: [] },
      platforms: { qq: { enabled: false }, 'qq#2': { enabled: true, platform: 'qq' } },
      stickers: { enabled: true, faces: true },
    },
  })
  await pureQq2.app.gateway.stopAll()
  let qq2Adapter = null
  pureQq2.app.gateway.register(() => (qq2Adapter = makeFakeAdapter({
    id: 'qq',
    self: { account: '20000099', name: '小鱼二号' },
    caps: { image: true, file: true, voice: 'native', sticker: true, poke: false, history: true },
  })))
  await pureQq2.app.gateway.sync()

  for (const varName of ['aurabot_rules_private', 'aurabot_rules_social', 'aurabot_rules_group_owner']) {
    const text = pureQq2.fake.variables.get(varName)()
    assert.doesNotMatch(text, /<poke>|想戳回去/, `纯 qq#2 下 ${varName} 不得写 <poke>`)
    assert.match(text, /<face:|<at:QQ号>/, '纯 qq#2 仍保留通用 QQ 规则')
  }
  qq2Adapter.pushInbound({
    chat: { id: '10000001', kind: 'private', name: '阿白' },
    sender: { account: '10000001', name: '阿白', isOwner: true },
    messageId: 'qq2_only_1',
    at: Date.now(),
    text: '在吗二号',
    parts: [{ type: 'text', text: '在吗二号' }],
  })
  await until(() => pureQq2.fake.turns.length >= 1)
  assert.doesNotMatch(pureQq2.fake.turns[0].ctxText, /<poke>|会变成 QQ 的戳一戳/)
  assert.match(pureQq2.fake.turns[0].ctxText, /chat_history/, '开启 history 的 qq#2 会话通过 chat-tools 上下文拿到 chat_history 提示')

  // 3B) qq + qq#2 双实例共存：共享全局 preset 无 <poke>；默认 qq 会话拿 <poke>，qq#2 不拿
  const dualQq = await bootHost(t, {
    cfg: {
      enabled: true,
      dryRun: false,
      setupDone: true,
      ownerQQ: '10000001',
      botQQ: '20000002',
      ownerName: '阿白',
      merge: { enabled: false },
      allow: { private: ['10000001', 'qq#2:private:10000001'], groups: [] },
      platforms: { qq: { enabled: true }, 'qq#2': { enabled: true, platform: 'qq' } },
      stickers: { enabled: true, faces: true },
    },
  })
  const ownerP = dualQq.app.gateway.identity.owner() || dualQq.app.gateway.identity.claimOwner('qq', '10000001')
  assert.ok(ownerP)
  await dualQq.app.gateway.stopAll()
  let qq2b = null
  dualQq.app.gateway.register(() => (qq2b = makeFakeAdapter({
    id: 'qq',
    self: { account: '20000099', name: '小鱼二号' },
    caps: { image: true, file: true, voice: 'native', sticker: true, poke: false, history: true },
  })))
  await dualQq.app.gateway.sync()

  assert.doesNotMatch(dualQq.fake.variables.get('aurabot_rules_private')(), /<poke>|想戳回去/)
  assert.doesNotMatch(dualQq.fake.variables.get('aurabot_rules_social')(), /<poke>|想戳回去/)

  await dualQq.app.hub.onMessage({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: 20000002,
    user_id: 10000001,
    message_id: 902,
    sender: { user_id: 10000001, nickname: '阿白' },
    message: [{ type: 'text', data: { text: '默认号在吗' } }],
  })
  await until(() => dualQq.fake.turns.length >= 1)
  assert.match(dualQq.fake.turns[0].ctxText, /<poke>/, '默认 qq 会话仍应通过会话上下文拿到 <poke>')

  qq2b.pushInbound({
    chat: { id: '10000001', kind: 'private', name: '阿白' },
    sender: { account: '10000001', name: '阿白', isOwner: true },
    messageId: 'qq2_dual_1',
    at: Date.now(),
    text: '二号在吗',
    parts: [{ type: 'text', text: '二号在吗' }],
  })
  await until(() => dualQq.fake.turns.length >= 2)
  assert.doesNotMatch(dualQq.fake.turns[1].ctxText, /<poke>|会变成 QQ 的戳一戳/, 'qq#2 会话不得收到 <poke> 指引')
})
