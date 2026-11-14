// 内置模块：生图。她能画图发到聊天里（OpenAI 兼容的生图服务，或「本地接口」里接的 SD WebUI / ComfyUI）。

import { readFileSync } from 'node:fs'
import { privateCapabilityAllowed } from '../../chat/access.js'
import { createImageGen, drawResultBlocks, drawToolMessage, imageToolBlock, resolveDrawImage } from '../../features/imagegen.js'
import { listPaintings, openPaintFolder, paintingPath, rememberPainting, removePainting, savePainting } from '../../features/paintings.js'
import { defineTool, str } from '../../tools/tools.js'
import { SIZE_OPTIONS } from '../../features/image-shape.js'
import { dataDir } from '../../core/store.js'
import { mimeOf } from '../../chat/inbound.js'
import { mergeFromPanel } from '../../core/config.js'
import { redact } from '../../core/redact.js'

function reason(error) { if (error?.imageStatus) return `接口返回 HTTP ${error.imageStatus}`; if (error?.imageNetworkFailure) return error.name === 'TimeoutError' ? '连接超时' : '连接失败'; const m = String(error?.message || ''); if (m.includes('不支持参考图')) return '该模型不支持参考图'; if (m.includes('登录')) return '订阅登录不可用'; return '生图请求失败' }

export default {
  id: 'imagegen',
  name: '生图',
  version: '1.0.0',
  api: 2,
  platforms: ['*'],
  description: '画一张图发到聊天里（qq_draw_image）',
  tab: 'imagegen',
  files: ['features/imagegen.js', 'features/image-shape.js', 'features/paintings.js', 'features/codex-auth.js', 'features/codex-image.js'],
  setup(api) {
    const { hub, local } = api.core
    const memory = api.lazy('memory')
    // 外部生图模块（例如社区库的「生图 · DSH 已接入模型」）：装了且自己选了模型就由它先接管。
    // 用 lazy 拿，模块后装 / 重载都能跟上；没装时这里恒为 null，行为与改动前一致。
    const external = api.lazy('dsh-image')
    const gen = createImageGen({
      getConfig: api.config,
      log: api.log,
      local,
      dsh: api.dsh,
      upstream: Object.assign(
        (prompt, opts) => (external && external.generate ? external.generate(prompt, opts) : null),
        // ready() 必须同步且不联网：只回答「这个模块现在愿不愿意接管」。
        { ready: () => Boolean(external && external.ready && external.ready()) },
      ),
    })
    const auth = gen.codexAuth
    api.onDispose?.(() => gen.dispose())
    api.context?.(({ chat }) => {
      if (!gen.enabled() || !privateCapabilityAllowed(api.config(), chat, 'image')) return ''
      return '当前私聊对象已经获得主人的画图授权。对方请求画图时可以直接使用 qq_draw_image；之前说过的权限限制已更新，以当前授权为准。'
    })
    const accountAction = (fn) => async (req) => {
      if (req?.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(String(req.headers?.['content-type'] || ''))) return { ok: false, message: '账号操作需要 POST JSON 请求' }
      return fn(req)
    }
    api.route('/image/test', accountAction(async (req) => {
      const body = await api.core.http.body(req)
      if (!body?.imageGen || typeof body.imageGen !== 'object') return { ok: false, message: '缺少生图配置' }
      const config = mergeFromPanel(api.config(), { imageGen: body.imageGen }); const c = config.imageGen
      if (body.id) {
        const e = c.fallbacks.find(e => e.id === body.id)
        if (!e || !e.model) return { ok: false, message: '请填写备用模型' }
        c.provider = e.provider
        if (e.provider === 'codex') c.codex.model = e.model
        else Object.assign(c, { baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model })
      }
      c.enabled = true; c.fallbackEnabled = false
      const test = createImageGen({ getConfig: () => config, log: api.log, codexAuth: auth }); const start = Date.now()
      try { await test.generate('一只蓝色小鱼的简洁插画'); return { ok: true, message: `生图成功，耗时 ${((Date.now() - start) / 1000).toFixed(1)} 秒` } }
      catch (error) { let message = redact(error?.message || String(error)); for (const key of [c.apiKey, ...c.fallbacks.map(e => e.apiKey)]) if (key) message = message.split(key).join('***'); return { ok: false, message: `测试失败：${message}` } }
    }))
    api.route('/image/codex/status', async () => ({ ok: true, ...auth.status(), login: auth.loginStatus(), callback: { port: auth.callbackPort?.() || 1455, available: await auth.callbackPortUsable?.() } }))
    api.route('/image/codex/login', accountAction(async () => ({ ok: true, ...(await auth.startLogin()), ...auth.loginStatus() })))
    api.route('/image/codex/login/status', async () => ({ ok: true, ...auth.loginStatus(), ...auth.status() }))
    api.route('/image/codex/complete', accountAction(async (req) => {
      const body = await api.core.http.body(req)
      const credential = await auth.completeLogin(String(body?.input || ''))
      // 登录状态变了：已经挂好的会话要重挂一次，工具里才能立刻用（面板直输不经过 mount）
      try { hub.remountAll?.('ChatGPT 订阅已登录') } catch (error) { api.log.debug('重挂工具失败：', error.message) }
      return { ok: true, email: credential.email || '', accountId: credential.accountId || '' }
    }))
    api.route('/image/codex/cancel', accountAction(async () => ({ ok: true, ...auth.cancelLogin('已取消') })))
    api.route('/image/codex/logout', accountAction(async () => {
      const r = auth.logout()
      try { hub.remountAll?.('ChatGPT 订阅已登出') } catch (error) { api.log.debug('重挂工具失败：', error.message) }
      return { ok: true, ...r }
    }))

    // 她的画作：面板底下的图库（直接读存图目录，可以单张删、开文件夹）
    api.route('/image/gallery', async (req) => {
      const q = api.core.http.query(req)
      const limit = q && q.limit ? Number(q.limit) : api.config().imageGen.galleryShown
      return { ok: true, ...listPaintings({ limit }), dir: dataDir('imagegen') }
    })
    api.route('/image/gallery/image', async (req, res) => {
      const p = paintingPath(api.core.http.query(req).file)
      if (!p) return api.core.http.send(res, 404, '')
      const buf = readFileSync(p)
      api.core.http.send(res, 200, buf, String(mimeOf(buf) || 'image/png'))
    })
    api.route('/image/gallery/delete', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      return removePainting(String((b && b.file) || ''))
    })
    api.route('/image/open-folder', async () => openPaintFolder())

    // 生图模块开着就把工具挂上；「没开启 / 没填地址 / Codex 没登录」在执行时再如实提示。
    // 不能按登录状态决定挂不挂：Codex 订阅常是「先开会话、后登录」，那样工具会缺失（unknown tool）。
    api.tool(({ chat, sessionId }) => ((api.config().imageGen.enabled && chat.kind !== 'system') ? defineTool({
      name: 'qq_draw_image',
      description: '画一张图并发到当前 QQ 聊天里。prompt 详细描述画面；可以用 image 参考当前聊天最近收到的图（last）、引用消息里的图（quote）或自己画作的文件名来改画；shape 可按用途选择方图、竖图、横图或宽幅；size 可显式指定常用尺寸（含 2K/4K），不填就沿用 shape / 面板默认。画好会直接发出去，并给你一个画作编号（换头像、收成表情时用这个编号）。回复里简单说一句就行。',
      properties: {
        prompt: str('画面描述'),
        notice: str('结合对方的要求和当前对话写一句自然简短的回应，开始画图前会直接发送'),
        image: str('可选参考图：last = 当前聊天最近收到的一张图；quote = 当前聊天引用消息里的图；或图库中的画作文件名。禁止本地路径、网址'),
        shape: { type: 'string', enum: ['square', 'portrait', 'landscape', 'wide'], description: 'square 方图 1:1；portrait 竖图 2:3；landscape 横图 3:2；wide 宽幅 16:9。可不填' },
        size: { type: 'string', enum: SIZE_OPTIONS, description: '可选尺寸，例如 2048x2048（2K）、4096x4096（4K）；优先于 shape / 面板默认，不填沿用原逻辑' },
      },
      required: ['prompt', 'notice'],
      // 能看图时把原图放进工具结果（image 块），她当轮就能看见自己画了什么
      render: drawResultBlocks,
      execute: async ({ prompt, shape, image, size, notice }) => {
        const cfg = api.config()
        const ownerRequest = hub.turnSendersAllOwner(sessionId) || (chat.kind === 'group' && hub.turnDirectFromOwner?.(sessionId))
        if (cfg.imageGen.ownerOnly && !ownerRequest && !privateCapabilityAllowed(cfg, chat, 'image')) return { ok: false, message: '画图只给主人画哦；群里请主人单独 @ 我或引用回复我提出请求，多人同时提出请求时请分开发送。' }
        // 工具常驻，真正能不能画在执行时判断（Codex 登录状态可能刚变过）
        if (!gen.enabled()) return { ok: false, message: gen.notReadyReason() || '生图还没配置好' }
        if (image && cfg.imageGen.img2img === false) return { ok: false, message: '参考图功能已关闭' }
        const startedAt = Date.now()
        const reference = await resolveDrawImage(image, { hub, chat })
        const text = typeof notice === 'string' ? notice.trim().slice(0, 200) : ''
        let acknowledged = text ? await hub.sendText(chat.chatId, text) : null
        const simulatedNotice = () => acknowledged === null && Boolean(cfg.debug || cfg.dryRun)
        if (!acknowledged && !simulatedNotice()) acknowledged = await hub.sendText(chat.chatId, '好，我来画。')
        if (!acknowledged && !simulatedNotice()) return { ok: false, message: '没能发送画图回复，请检查 QQ 网关' }
        const progress = async (error, retrying) => {
          const issue = reason(error); const facts = retrying ? '刚才失败，正在尝试下一个备用模型，结果尚未确定' : '生图最终失败，没有图片'
          const fallback = retrying ? '刚才没画出来，我换个模型再试试。' : '这次没画出来，我先停下了。'
          let message = ''; let timer
          try { message = String(await Promise.race([api.core.ask({ model: hub.modelFor(chat), system: `${api.core.personas?.current?.() || ''}\n根据事实写一句自然简短的聊天回复，不编造原因，不说已经画好。只输出回复。`, text: `对方说：${String(hub.lastTextOf(sessionId) || '').slice(0, 500)}\n之前回复：${text}\n事实：${facts}；问题：${issue}。`, maxTokens: 100 }), new Promise(resolve => { timer = setTimeout(() => resolve(''), 6000) })]) || '').trim().slice(0, 200) } catch (e) { api.log.debug('生成生图进度回复失败：', e.message) } finally { clearTimeout(timer) }
          try { const sent = await hub.sendText(chat.chatId, `${message || fallback}（${issue}）`); if (!sent && message) await hub.sendText(chat.chatId, `${fallback}（${issue}）`) } catch (e) { api.log.debug('生图进度回复没发出去：', e.message) }
        }
        let buf
        try { buf = await gen.generate(String(prompt || ''), { shape, image: reference, size, onRetry: ({ error }) => progress(error, true) }) }
        catch (error) { await progress(error, false); return { ok: false, message: `生图失败：${reason(error)}。已尝试告知对方，请结合情况回应，不要说画好了。` } }
        const note = `[生图] ${String(prompt).slice(0, 30)}`
        const sent = typeof api.sendParts === 'function'
          ? await api.sendParts(chat.chatId, [{ type: 'image', base64: buf.toString('base64') }], { note })
          : await hub.sendSegments(chat.chatId, [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], note)
        // 调试 / 试运行下本来就不真发（只记日志、返回 null）：
        // 这一轮仍算画好了 —— 存盘、给编号、能看图，只是聊天里收不到；不能当失败。
        // 只有 null 才是“试运行/调试拦下”；明确的 false 仍按发送失败处理。
        const simulated = sent === null && Boolean(cfg.debug || cfg.dryRun)
        const isQq = !api.platformOf || api.platformOf(chat.chatId) === 'qq'
        if (!sent && !simulated) return { ok: false, message: isQq ? '画好了，但没有发到 QQ（请检查网关）' : '画好了，但没能发出去（请检查网关）' }
        const saved = savePainting(buf, String(prompt || ''))
        if (saved) api.log.debug(`生图已存盘：${saved}`)
        try { memory.addEvent?.({ text: reference ? `参考了一张图画了：${String(prompt).slice(0, 120)}（提示词不一定等于实际画面）` : `按提示词画了一张图（不一定等于实际画面）：${String(prompt).slice(0, 120)}`, about: chat.kind === 'private' ? chat.userId : '', tags: ['画画'], importance: 0.4 }) }
        catch (error) { api.log.warn('生图已发送，但经历没记下来：', error.message) }
        let visual = (await hub.canSeeImages(chat)) === true
        // 「让她画完自己看一眼」是总开关：关掉就当没视觉能力处理 —— 不给图、也不给路径。
        const seeOwn = api.config().imageGen.seeOwn !== false
        // 只有明确能看图的模型才把图交给它；纯文本模型只拿文字，不会崩。
        // 图要先缩、再登记成 DSH 附件块 —— 直接塞 base64 会让下一轮请求整轮失败（实测）
        let img = null
        if (visual && seeOwn) {
          img = await imageToolBlock(api.dsh, buf, { ffmpegPath: api.config().bili && api.config().bili.ffmpegPath })
          if (!img) {
            // 图没给成：如实说看不了，别让她照着提示词编画面细节
            visual = false
            api.log.debug('这次生图没把图交给模型（缩图/登记失败），只给文字')
          }
        }
        const shown = Boolean(img)
        let message
        if (!visual) message = drawToolMessage({ visual: false })
        else if (!seeOwn) message = drawToolMessage({ visual: true, seeOwn: false })
        else if (!shown) message = drawToolMessage({ visual: false })
        else message = drawToolMessage({ visual: true, seeOwn: true })
        // 画作编号：换头像 / 收表情时用编号，别用路径（路径只在图真的交出去时才附带）
        const index = saved ? rememberPainting(chat.chatId, saved) : 0
        const out = {
          ok: true,
          message,
          prompt: String(prompt || ''),
          bytes: buf.length,
          elapsedMs: Date.now() - startedAt,
          ...(saved ? { path: saved } : {}),
        }
        if (img) out.image = img
        if (index && saved) out.message += `\n画作编号 #${index}（想换头像、收成表情时用这个编号）`
        if (simulated) out.message += '\n（试运行/调试：这张图没真发到 QQ，只在本地存下了）'
        // 只有**图真的交给模型了**才把本地路径告诉她（#59）：收录表情包 / 存素材 / qq_add_sticker 用；
        // 看不了图或开关关着时不给路径，免得她知道路径就去读图，绕开「不给看」的判断。
        if (shown && saved) out.message += `\n已保存到本机：${saved}（要收录表情包、存素材时可以用这个路径）`
        return out
      },
    }) : []))
    return gen
  },
}
