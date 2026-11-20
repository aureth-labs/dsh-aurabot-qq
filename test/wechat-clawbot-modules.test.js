// 个人微信 ClawBot 宿主扫码、配置脱敏、全模块兼容矩阵、工具面隔离与面板契约测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { publicConfig, mergeFromPanel } from '../src/core/config.js'

const QQ_LEAK_RE = /你现在在 QQ 上|发到 QQ|QQ 空间|<at:QQ号>|QQ 自带的小黄脸|<face:|<poke>|qq_chat_history|qq_get_profile|qq_send_avatar|qq_send_qzone|qq_api_find|qq_api_call|qq_import_stickers|qq_import_qq_stickers|不能碰 onebot|发 QQ 消息/

const until = async (predicate, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  assert.ok(predicate(), '等待条件超时')
}

function makeHostIlinkClient({ pollMsgs = [], autoRelease = true } = {}) {
  const calls = []
  let pollIdx = 0
  let qrPollStep = 0
  let bootstrapDone = false
  let waiters = []
  let pollReleased = autoRelease
  const flushPollWaiters = () => {
    if (!pollReleased || pollIdx >= pollMsgs.length || !waiters.length) return
    const w = waiters.shift()
    const msg = pollMsgs[pollIdx++]
    w.resolve({ status: 200, headers: {}, json: { ret: 0, get_updates_buf: `buf_${pollIdx}`, msgs: [msg] } })
  }
  return {
    calls,
    releasePoll() {
      pollReleased = true
      flushPollWaiters()
    },
    async request(req) {
      const url = String(req.url || '')
      const body = typeof req.body === 'string' && req.body ? JSON.parse(req.body) : null
      calls.push({ method: req.method, url, body })

      if (url.includes('/ilink/bot/get_bot_qrcode')) {
        return {
          status: 200,
          headers: {},
          json: { qrcode: 'host_qr_1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/hostqr1' },
        }
      }
      if (url.includes('/ilink/bot/get_qrcode_status')) {
        qrPollStep++
        if (qrPollStep === 1) return { status: 200, headers: {}, json: { status: 'wait' } }
        return {
          status: 200,
          headers: {},
          json: {
            status: 'confirmed',
            bot_token: 'wx_secret_token_do_not_expose',
            ilink_bot_id: 'wx_host_bot@im.bot',
            baseurl: 'https://ilinkai.weixin.qq.com',
            ilink_user_id: 'wxu_qr_scanner',
          },
        }
      }
      if (url.includes('/ilink/bot/getuploadurl')) {
        return { status: 200, headers: {}, json: { ret: 0, upload_param: `up_${calls.length}` } }
      }
      if (url.includes('/upload?')) {
        return { status: 200, headers: { 'x-encrypted-param': `eqp_${calls.length}` }, json: {}, text: '' }
      }
      if (url.includes('/ilink/bot/getconfig')) {
        return { status: 200, headers: {}, json: { ret: 0, typing_ticket: 'host_ticket' } }
      }
      if (url.includes('/ilink/bot/sendmessage')) {
        return { status: 200, headers: {}, json: { ret: 0, message_id: `wx_host_reply_${calls.length}` } }
      }
      if (url.includes('/ilink/bot/getupdates')) {
        if (!bootstrapDone) {
          bootstrapDone = true
          if (pollReleased && pollIdx < pollMsgs.length) {
            const msg = pollMsgs[pollIdx++]
            return { status: 200, headers: {}, json: { ret: 0, get_updates_buf: `buf_${pollIdx}`, msgs: [msg] } }
          }
          return { status: 200, headers: {}, json: { ret: 0, get_updates_buf: 'init_buf', msgs: [] } }
        }
        if (pollReleased && pollIdx < pollMsgs.length) {
          const msg = pollMsgs[pollIdx++]
          return { status: 200, headers: {}, json: { ret: 0, get_updates_buf: `buf_${pollIdx}`, msgs: [msg] } }
        }
        return await new Promise((resolve, reject) => {
          const w = { resolve, reject }
          waiters.push(w)
          req.signal?.addEventListener?.('abort', () => {
            waiters = waiters.filter((x) => x !== w)
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          }, { once: true })
        })
      }
      return { status: 404, headers: {}, json: { errcode: 404 }, text: '' }
    },
  }
}

async function bootHost(t, { cfg, opts = {}, brain }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-wx-host-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  const prevWs = process.env.AURABOT_WORKSPACE
  const prevGlobal = globalThis.aurabot
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(cfg))

  const fake = createFakeDsh({ brain: brain || (async () => '好的收到啦') })
  const host = await import('../src/host.js')
  const app = host.apply(fake.ctx, opts)
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
  return { fake, app, dataDir }
}

test('宿主机扫码登录接口：自动写入凭证并连接，绝不在配置接口或日志中回传 botToken 原文', async (t) => {
  const wechatClient = makeHostIlinkClient()
  const { fake, app } = await bootHost(t, {
    cfg: {
      enabled: true,
      dryRun: false,
      setupDone: true,
      platforms: { qq: { enabled: false } },
    },
    opts: { wechatClient },
  })

  const qrStart = (await fake.call('/platforms/wechat-clawbot/qr/start', { instance: 'wechat-clawbot' })).json()
  assert.equal(qrStart.ok, true, qrStart.message)
  assert.ok(qrStart.sessionId)
  assert.ok(qrStart.qrDataUri.startsWith('data:image/svg+xml;base64,'))

  const qrWait = (await fake.call('/platforms/wechat-clawbot/qr/status', { sessionId: qrStart.sessionId })).json()
  assert.equal(qrWait.ok, true)
  assert.equal(qrWait.state, 'wait')

  const qrConfirmed = (await fake.call('/platforms/wechat-clawbot/qr/status', { sessionId: qrStart.sessionId })).json()
  assert.equal(qrConfirmed.ok, true, qrConfirmed.message)
  assert.equal(qrConfirmed.state, 'confirmed')
  assert.equal(qrConfirmed.botId, 'wx_host_bot@im.bot')
  assert.ok(!JSON.stringify(qrConfirmed).includes('wx_secret_token_do_not_expose'), '确认响应严禁包含 botToken 原文')

  // 网关实例已启用并连上，configs 只暴露 botTokenSet=true，不回传 botToken 原文
  const platRes = (await fake.call('/platforms')).json()
  const inst = (platRes.instances || []).find((x) => x.instance === 'wechat-clawbot')
  assert.ok(inst)
  assert.equal(inst.enabled, true)
  assert.equal(inst.state, 'connected')
  assert.equal(inst.self?.account, 'wx_host_bot@im.bot')
  assert.equal(wechatClient.calls.filter((c) => c.url.includes('/ilink/bot/getconfig')).length, 0, '扫码连接启动阶段不应调用 getconfig')
  assert.equal(platRes.configs?.['wechat-clawbot']?.botTokenSet, true)
  assert.equal(platRes.configs?.['wechat-clawbot']?.botToken, '')
  assert.ok(!JSON.stringify(platRes).includes('wx_secret_token_do_not_expose'), '/platforms 不得泄漏 botToken 原文')

  // 面板保存其他设置且留空 botToken 时，原有 botToken 不被清空
  const savedOther = (await fake.call('/platforms/settings', { instance: 'wechat-clawbot', patch: { maxTextChars: 1500 } })).json()
  assert.equal(savedOther.configs?.['wechat-clawbot']?.botTokenSet, true)
  assert.equal(app.getConfig().platforms?.['wechat-clawbot']?.botToken, 'wx_secret_token_do_not_expose')
  assert.equal(app.getConfig().platforms?.['wechat-clawbot']?.maxTextChars, 1500)

  // publicConfig + mergeFromPanel 单项往返校验
  const pub = publicConfig(app.getConfig())
  assert.equal(pub.platforms['wechat-clawbot'].botToken, '')
  assert.equal(pub.platforms['wechat-clawbot'].botTokenSet, true)
  const merged = mergeFromPanel(app.getConfig(), pub)
  assert.equal(merged.platforms['wechat-clawbot'].botToken, 'wx_secret_token_do_not_expose')
  assert.equal(merged.platforms['wechat-clawbot'].botTokenSet, undefined)
})

test('纯 wechat-clawbot 运行时：19 模块矩阵、tool/context 无 QQ 泄漏、端到端私聊闭环与双平台隔离', async (t) => {
  const wechatClient = makeHostIlinkClient({
    autoRelease: false,
    pollMsgs: [{
      message_id: 'wx_e2e_1',
      from_user_id: 'wxu_owner',
      from_user_name: '微信主人',
      message_type: 1,
      create_time_ms: Date.now(),
      context_token: 'ctx_e2e_1',
      item_list: [{ type: 1, text_item: { text: '在微信里测试一下' } }],
    }],
  })

  const { fake, app, dataDir } = await bootHost(t, {
    cfg: {
      enabled: true,
      dryRun: false,
      setupDone: true,
      ownerName: '主人',
      allow: { private: ['wechat-clawbot:private:wxu_owner'], groups: [] },
      platforms: {
        qq: { enabled: false },
        'wechat-clawbot': { enabled: true, botToken: 'wx_live_secret_999', botId: 'wx_bot@im.bot' },
      },
      stickers: { enabled: true, collect: true, faces: true },
      qqApi: { enabled: true },
      diary: { enabled: true },
      ext: { purpose: { enabled: true } },
    },
    opts: { wechatClient },
    brain: async ({ text }) => `微信收到：${text.slice(0, 20)}`,
  })

  app.gateway.identity.claimOwner('wechat-clawbot', 'wxu_owner')
  wechatClient.releasePoll()

  // 1) group-admin 与 6 个 QQ 专属模块在纯 wechat-clawbot 下均不得运行
  const statuses = app.modules.status()
  for (const id of ['group-admin', 'qq-tools', 'qq-api', 'profile', 'contacts', 'diary', 'qzone-social']) {
    const row = statuses.find((m) => m.id === id)
    assert.ok(!row || row.running === null, `${id} 在纯 wechat-clawbot 下不应运行`)
  }
  for (const id of ['stickers', 'voice', 'mood', 'memory', 'chat-tools', 'imagegen', 'speakup', 'purpose', 'autotelic', 'bili', 'song', 'video']) {
    const row = statuses.find((m) => m.id === id)
    assert.equal(row?.running, 'builtin', `${id} 应在纯 wechat-clawbot 下正常运行`)
  }

  // 2) stickers 不出现 qq_import_stickers；chat-tools 不挂载 chat_history；全程无 qq_* 与 QQ 话术泄漏
  const wxChat = { chatId: 'wechat-clawbot:private:wxu_owner', kind: 'private', platform: 'wechat-clawbot', userId: 'wxu_owner' }
  const wxTools = app.modules.buildTools({ chat: wxChat, level: 'full', sessionId: 's-wx-p' }).map((x) => x.name)
  assert.ok(!wxTools.includes('qq_import_stickers'), 'stickers 不得暴露 qq_import_stickers')
  assert.ok(!wxTools.includes('chat_history'), 'history=false 时不得挂载 chat_history')
  assert.ok(!wxTools.includes('group_admin'), 'wechat-clawbot 不得挂载 group_admin')
  assert.ok(wxTools.includes('send_sticker'), 'stickers 通用工具应存在')
  assert.ok(wxTools.includes('send_message'), 'chat-tools send_message 应存在')
  assert.ok(wxTools.includes('search_chatlog'), 'chat-tools 本地 search_chatlog 应存在')
  for (const name of wxTools) {
    assert.ok(!name.startsWith('qq_'), `wechat-clawbot 会话工具面不得出现 qq_ 前缀工具：${name}`)
  }

  for (const varName of ['aurabot_rules_private', 'aurabot_rules_social', 'aurabot_rules_autotelic', 'aurabot_rules_group_owner']) {
    const text = fake.variables.get(varName)()
    assert.doesNotMatch(text, QQ_LEAK_RE, `${varName} 不得泄漏 QQ 内容`)
  }
  const wxCtx = app.modules.contextFor({ chat: wxChat, level: 'full' })
  assert.doesNotMatch(wxCtx, QQ_LEAK_RE, 'wechat-clawbot 上下文不得泄漏 QQ 内容')

  // 3) 等到 1:1 真实入站消息经过 hub 走完并调用 iLink sendmessage 回发（携带 context_token）
  await until(() => wechatClient.calls.some((c) => c.url.includes('/ilink/bot/sendmessage')))
  const sent = wechatClient.calls.find((c) => c.url.includes('/ilink/bot/sendmessage'))
  assert.equal(sent.body.msg.to_user_id, 'wxu_owner')
  assert.equal(sent.body.msg.context_token, 'ctx_e2e_1')
  assert.match(sent.body.msg.item_list[0].text_item.text, /微信收到：/)

  // 3.5) 宿主机注入 allowedLocalDirs：工作区内文件放行，工作区/dataDir 之外的本地绝对路径在 adapter 层拦截
  const allowedWsFile = join(dataDir, 'ws', 'host-allowed.txt')
  writeFileSync(allowedWsFile, 'host allowed payload')
  const outsideSiblingDir = mkdtempSync(join(tmpdir(), 'aurabot-wx-outside-'))
  const outsideHostFile = join(outsideSiblingDir, 'host-secret.txt')
  writeFileSync(outsideHostFile, 'host secret payload')
  const allowedSend = await app.gateway.send({
    chatId: 'wechat-clawbot:private:wxu_owner',
    inResponseTo: 'wx_e2e_1',
    parts: [{ type: 'file', media: { path: allowedWsFile, name: 'host-allowed.txt' } }],
  })
  assert.ok(allowedSend.messageId)
  await assert.rejects(
    () => app.gateway.send({
      chatId: 'wechat-clawbot:private:wxu_owner',
      inResponseTo: 'wx_e2e_1',
      parts: [{ type: 'file', media: { path: outsideHostFile, name: 'host-secret.txt' } }],
    }),
    (e) => e.certainty === 'not-sent' && e.code === 'local-path-blocked',
    '宿主机注入的 allowedLocalDirs 应拦截工作区与 dataDir 之外的本地路径',
  )

  // 4) 开启 QQ 共存后工具面仍严格隔离，logs 里不出现 botToken 原文
  app.setConfig({
    ...app.getConfig(),
    enabled: true,
    botQQ: '20000001',
    ownerQQ: '10000001',
    platforms: {
      qq: { enabled: true },
      'wechat-clawbot': { enabled: true, botToken: 'wx_live_secret_999', botId: 'wx_bot@im.bot' },
    },
  })
  await app.modules.sync()
  const wxToolsDual = app.modules.buildTools({ chat: wxChat, level: 'full', sessionId: 's-wx-dual' }).map((x) => x.name)
  const qqToolsDual = app.modules.buildTools({ chat: { chatId: 'qq:group:555', kind: 'group', groupId: '555', platform: 'qq', userId: '10000001' }, level: 'full', sessionId: 's-qq-dual' }).map((x) => x.name)
  assert.ok(!wxToolsDual.includes('qq_import_stickers'))
  assert.ok(!wxToolsDual.includes('group_admin'))
  assert.ok(wxToolsDual.every((n) => !n.startsWith('qq_')))
  assert.ok(qqToolsDual.includes('group_admin'))
  assert.ok(!JSON.stringify(fake.logs).includes('wx_live_secret_999'), '日志不得泄漏 wx_live_secret_999')
})

test('面板源码契约：PLATFORM_NAMES、设置向导与扫码组件接好 wechat-clawbot', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')
  assert.ok(client.includes("'wechat-clawbot': '微信 ClawBot'"))
  assert.ok(host.includes("'wechat-clawbot': '微信 ClawBot'"))
  assert.ok(client.includes('function WechatClawbotQrBox'))
  assert.ok(client.includes("post('/platforms/wechat-clawbot/qr/start'"))
  assert.ok(client.includes("post('/platforms/wechat-clawbot/qr/status'"))
  assert.ok(host.includes("route('/platforms/wechat-clawbot/qr/start'"))
  assert.ok(host.includes("route('/platforms/wechat-clawbot/qr/status'"))
})
