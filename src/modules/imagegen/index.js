// 内置模块：生图。她能画图发到聊天里（OpenAI 兼容的生图服务，或「本地接口」里接的 SD WebUI / ComfyUI）。

import { readFileSync } from 'node:fs'
import { privateCapabilityAllowed } from '../../chat/access.js'
import { createImageGen, drawResultBlocks, drawToolMessage, imageToolBlock, resolveDrawImages, isUnsupportedReference, isSingleReferenceOnly, fetchOpenAIModels } from '../../features/imagegen.js'
import { listPaintings, openPaintFolder, paintingPath, rememberPainting, removePainting, savePainting } from '../../features/paintings.js'
import { defineTool, str, int } from '../../tools/tools.js'
import { SIZE_OPTIONS } from '../../features/image-shape.js'
import { dataDir } from '../../core/store.js'
import { mimeOf } from '../../chat/inbound.js'
import { drawFormat, gifFrameCount } from '../../features/image-format.js'
import { mergeFromPanel } from '../../core/config.js'
import { redact } from '../../core/redact.js'

function reason(error) { if (error?.gifRequestError) return error.message; if (error?.imageStatus) return `接口返回 HTTP ${error.imageStatus}`; if (error?.imageNetworkFailure) return error.name === 'TimeoutError' ? '连接超时' : '连接失败'; const m = String(error?.message || ''); if (m.includes('不支持参考图')) return '该模型不支持参考图'; if (m.includes('登录')) return '订阅登录不可用'; return '生图请求失败' }

export default {
  id: 'imagegen',
  name: '生图',
  version: '1.0.0',
  description: '画一张图发到聊天里（qq_draw_image）',
  tab: 'imagegen',
  files: ['features/imagegen.js', 'features/image-format.js', 'features/image-shape.js', 'features/paintings.js', 'features/codex-auth.js', 'features/codex-image.js'],
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
    api.route('/image/models', accountAction(async (req) => {
      const body = await api.core.http.body(req)
      if (!body?.imageGen || typeof body.imageGen !== 'object') return { ok: false, message: '缺少生图配置' }
      const config = mergeFromPanel(api.config(), { imageGen: body.imageGen }); const c = config.imageGen
      if (c.provider === 'custom') return { ok: false, message: '自定义接口没有统一的模型列表接口，请手动填写模型名' }
      if (c.provider === 'codex') return { ok: false, message: 'Codex 订阅不需要填模型名，也不能按服务地址拉模型列表' }
      try {
        const models = await fetchOpenAIModels({ baseUrl: c.baseUrl, apiKey: c.apiKey })
        return { ok: true, models }
      } catch (error) {
        let message = redact(error?.message || String(error))
        if (c.apiKey) message = message.split(c.apiKey).join('***')
        return { ok: false, message }
      }
    }))
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
    // 也不能只看内置开关：本地接口（local.image）和外部生图模块（dsh-image）都能单独接管生图，
    // 它们能用时同样要挂工具，否则配好了却「工具清单里没有画图工具」（#47）。
    const canDraw = () => {
      const c = api.config().imageGen
      if (c && c.enabled) return true
      try { if (local?.active?.('image')) return true } catch (error) {}
      try { if (external && external.ready && external.ready()) return true } catch (error) {}
      return false
    }
    // 编号只指向已收到的短期缓存，不另建图库、不抓取模型提供的消息 ID。
    api.on?.('prompt', (content, { chat }) => {
      if (chat.kind === 'system' || !canDraw()) return content
      const recent = hub.recentMedia?.(chat.chatId) || []
      const labeled = content.flatMap((block) => {
        if (block.type !== 'image') return [block]
        const item = recent.find((x) => /^-?[1-9]\d*$/.test(x.messageId || '') && block.name === `qqref-${x.messageId}-${x.imageIndex}`)
        return item ? [{ type: 'text', text: `【聊天图片 msg:${item.messageId}:${item.imageIndex}，发送者 QQ ${item.userId}】` }, block] : [block]
      })
      return [...labeled, { type: 'text', text: '新画以请求者指定的人物或作品为准，旁人的图片只是聊天背景，不把其中的人物或外形写进新画。对方要照某张图画或修改它时，优先用目标图旁的 msg 编号；没有编号才用明确指向目标的 quote/last。要改的原图不明确或缺失时，请对方引用它，不能省略参考图生成一张新图来代替。' }]
    })
    api.tool(({ chat, sessionId }) => ((chat.kind !== 'system' && canDraw()) ? defineTool({
      name: 'qq_draw_image',
      description: '画一张或多张图并发到当前 QQ 聊天里。prompt 详细描述画面；可以用 image 参考当前聊天最近收到的图（last）、引用消息里的图（quote）或自己画作的文件名来改画；画自己时 image 填 self，优先参考人设图，不支持时按外貌文字生成；想同时参考多张图时用 images（最多 16 张，MiniMax H3 改画时最有用）；shape 可按用途选择方图、竖图、横图或宽幅；size 可显式指定常用尺寸（含 2K/4K），不填就沿用 shape / 面板默认；count 是本次画几张（1~10，仅 MiniMax H3 支持）。画好会直接发出去，并给你画作编号（换头像、收成表情时用这个编号）。回复里简单说一句就行。群聊和私聊都支持绘图，权限由工具按本轮请求检查。有新的明确绘图请求时应调用工具，不要沿用旧轮次的拒绝结论。失败时区分权限不足、缺少参考图和生成失败，按实际返回说明，不要把权限不足说成必须私聊。',
      properties: {
        prompt: str('画面描述'),
        format: { type: 'string', enum: ['static', 'gif'], description: '默认 static 静态图。只有对方明确要求 GIF、动图或让画面动起来时才用 gif（需面板开启），并在 prompt 描述动作和循环。普通画画、动态姿势仍用静态。GIF 默认小尺寸、8 帧约 1.6 秒，不要为普通回复擅自改成动图' },
        notice: str('结合对方的要求和当前对话写一句自然简短的回应，开始画图前会直接发送'),
        image: str('可选参考图：self（自己/人设图）= 当前人格形象；last = 当前聊天最近收到的一张图；quote = 当前聊天引用消息里的图；或图库中的画作文件名。禁止本地路径、网址。优先填目标图旁提供的 msg:消息号:图片序号，以绑定具体图片。quote 用于引用带图的消息，引用机器人的文字回复不等于引用原图；只有确定最近一张就是目标图时才用 last。不确定就请对方引用目标原图。'),
        images: { type: 'array', items: { type: 'string' }, maxItems: 16, description: '仅填写用户要求使用的参考图，按图 1、图 2 的顺序列出 msg 编号、图库文件名或 last / quote，并在 prompt 说明各图用途。不要附带无关聊天图片。通常与 image 二选一；同时填写时 image 是第一张，images 依次接在后面。不支持多图时会报错，不会少用几张代替' },
        shape: { type: 'string', enum: ['square', 'portrait', 'landscape', 'wide'], description: 'square 方图 1:1；portrait 竖图 2:3；landscape 横图 3:2；wide 宽幅 16:9。可不填' },
        size: { type: 'string', enum: SIZE_OPTIONS, description: '可选尺寸，例如 2048x2048（2K）、4096x4096（4K）；优先于 shape / 面板默认，不填沿用原逻辑' },
        count: int('一次生成几张，1~10，默认 1；目前只有 MiniMax H3 接法支持多张'),
      },
      required: ['prompt', 'notice'],
      // 能看图时把原图放进工具结果（image 块），她当轮就能看见自己画了什么
      render: drawResultBlocks,
      execute: async ({ prompt, format, shape, image, images, count, size, notice }) => {
        const cfg = api.config()
        const ownerRequest = hub.turnSendersAllOwner(sessionId) || (chat.kind === 'group' && hub.turnDirectFromOwner?.(sessionId))
        if (cfg.imageGen.ownerOnly && !ownerRequest && !privateCapabilityAllowed(cfg, chat, 'image')) return { ok: false, message: '本轮未获绘图授权（当前开启了“只给主人画”），尚未开始生成。群聊也能画：请主人在群里直接 @ 我提出请求，改图时同时引用目标原图；多人同时提出请求时请分开发送。私聊也需要授权，转私聊不会自动放行。后续新请求会重新检查权限。' }
        try { drawFormat(format) } catch (error) { return { ok: false, message: error.message } }
        if (format === 'gif' && !api.config().imageGen.allowGif) return { ok: false, message: 'GIF 动图还没开启，请主人在生图设置中打开「允许按需生成 GIF」' }
        // 工具常驻，真正能不能画在执行时判断（Codex 登录状态可能刚变过）
        if (!gen.enabled()) return { ok: false, message: gen.notReadyReason() || '生图还没配置好' }
        const self = typeof image === 'string' && /^(self|自己|人设图)$/i.test(image.trim())
        if (((image && !self) || (Array.isArray(images) && images.length)) && cfg.imageGen.img2img === false) return { ok: false, message: '参考图功能已关闭' }
        const startedAt = Date.now()
        if (self && images != null && (!Array.isArray(images) || images.length)) return { ok: false, message: 'image=self 不能同时指定 images；请分别选择人设图或明确的参考图列表' }
        const explicitRefs = self ? [] : await resolveDrawImages({ image, images }, { hub, chat })
        if (explicitRefs.length > 1) {
          const limit = await gen.referenceLimit()
          if (explicitRefs.length > limit) return { ok: false, message: `本次指定了 ${explicitRefs.length} 张参考图，当前接法${limit ? `最多支持 ${limit} 张` : '不支持参考图'}。未开始生成，也没有减少参考图或改用文字生成。` }
        }
        const text = typeof notice === 'string' ? notice.trim().slice(0, 200) : ''
        // 画前提示是「她这个回合正在做的事」的进度说明，与最终回复是同一轮的产物。
        // 显式声明 turnNotice：宿主据此在回合内直发（不经代发决断），否则慢工具兜底会在 1.5s 后
        // 先把同一句发出去、9s 后代发决断再发一遍（2026-11-18 主人私聊实测）。
        // 其余模块不声明这个标记，仍一律走代发决断。
        const NOTICE_OPTS = { turnNotice: true }
        let acknowledged = text ? await hub.sendText(chat.chatId, text, undefined, undefined, undefined, NOTICE_OPTS) : null
        // 「正在做」提示已经以 notice 发出去了：立刻登记，hub 的慢工具兜底（1.5s 定时器）就不再发
        // 她当轮正文——否则 notice 和兜底各发一遍，同样的话出现两次（2026-11-18 主人私聊实测）。
        if (acknowledged && typeof hub.markSlowNotice === 'function') hub.markSlowNotice(sessionId)
        const simulatedNotice = () => acknowledged === null && Boolean(cfg.debug || cfg.dryRun)
        if (!acknowledged && !simulatedNotice()) acknowledged = await hub.sendText(chat.chatId, '好，我来画。', undefined, undefined, undefined, NOTICE_OPTS)
        if (!acknowledged && !simulatedNotice()) return { ok: false, message: '没能发送画图回复，请检查 QQ 网关' }
        const progress = async (error, retrying) => {
          const issue = reason(error); const facts = retrying ? '刚才失败，正在尝试下一个备用模型，结果尚未确定' : '生图最终失败，没有图片'
          const fallback = retrying ? '刚才没画出来，我换个模型再试试。' : '这次没画出来，我先停下了。'
          let message = ''; let timer
          try { message = String(await Promise.race([api.core.ask({ model: hub.modelFor(chat), system: `${api.core.personas?.current?.() || ''}\n根据事实写一句自然简短的聊天回复，不编造原因，不说已经画好。只输出回复。`, text: `对方说：${String(hub.lastTextOf(sessionId) || '').slice(0, 500)}\n之前回复：${text}\n事实：${facts}；问题：${issue}。`, maxTokens: 100 }), new Promise(resolve => { timer = setTimeout(() => resolve(''), 6000) })]) || '').trim().slice(0, 200) } catch (e) { api.log.debug('生成生图进度回复失败：', e.message) } finally { clearTimeout(timer) }
          try { const sent = await hub.sendText(chat.chatId, `${message || fallback}（${issue}）`); if (!sent && message) await hub.sendText(chat.chatId, `${fallback}（${issue}）`) } catch (e) { api.log.debug('生图进度回复没发出去：', e.message) }
        }
        let references = []
        let fullPrompt = String(prompt || '')
        let fallback = ''
        let selectedCount = 0
        if (self) {
          const look = api.core.personas?.look?.(sessionId) || {}
          const appearance = typeof look.appearance === 'string' ? look.appearance.trim() : ''
          if (appearance) fullPrompt = `角色外貌：${appearance}\n画面要求：${fullPrompt}`
          const selected = Array.isArray(look.references) ? look.references : look.image ? [{ image: look.image, note: '' }] : []
          selectedCount = selected.length
          const limit = await gen.referenceLimit()
          references = selected.slice(0, limit)
          if (selected.length > references.length && references.length) fallback = `当前服务最多支持 ${limit} 张参考图，已使用所选图片中的前 ${references.length} 张。`
          else if (!references.length && (selected.length || appearance)) fallback = appearance
            ? '本次未使用人设图，仅按外貌文字生成，形象一致性有限。'
            : '本次未使用人设图，且未配置外貌描述，仅按画面提示生成，形象一致性有限。'
        } else {
          references = explicitRefs.map(image => ({ image, note: '' }))
        }
        const generate = () => {
          const notes = references.map((ref, index) => ref.note ? `参考图 ${index + 1} 备注：${JSON.stringify(ref.note)}` : '').filter(Boolean)
          const actualPrompt = notes.length ? `${fullPrompt}\n图片备注（仅作造型说明，按画面要求选择合适造型，不混合互斥服装）：\n${notes.join('\n')}` : fullPrompt
          return gen.generate(actualPrompt, { format, shape, size, count, onRetry: ({ error }) => progress(error, true), ...(references.length > 1 ? { images: references.map((ref) => ref.image) } : { image: references[0]?.image || null }) })
        }
        let buf
        try {
          try { buf = await generate() }
          catch (error) {
            // 仅明确能力错误触发参考图降级；其他失败沿用备用服务与通知逻辑。
            if (!self || !references.length) throw error
            const smallerLimit = isSingleReferenceOnly(error) ? 1 : error?.code === 'REFERENCE_LIMIT' ? error.referenceLimit : 0
            if (Number.isInteger(smallerLimit) && smallerLimit > 0 && smallerLimit < references.length) {
              references = references.slice(0, smallerLimit)
              fallback = smallerLimit === 1 ? '服务仅支持单张参考图，本次使用已开启图片中的第一张。' : `服务最多支持 ${smallerLimit} 张参考图，本次使用已开启图片中的前 ${smallerLimit} 张。`
              try { buf = await generate() }
              catch (singleError) { if (!isUnsupportedReference(singleError)) throw singleError }
            } else if (!isUnsupportedReference(error)) throw error
            if (!buf) {
              references = []
              fallback = '服务不支持参考图，本次按文字生成，形象一致性有限。'
              buf = await generate()
            }
          }
        }
        catch (error) { await progress(error, false); return { ok: false, message: `生图失败：${reason(error)}。已尝试告知对方，请结合情况回应，不要说画好了。` } }
        const bufs = (Array.isArray(buf) ? buf : [buf]).filter((item) => Buffer.isBuffer(item) && item.length)
        if (!bufs.length) { await progress(new Error('生图接口没有返回图片'), false); return { ok: false, message: '生图失败：生图接口没有返回图片。已尝试告知对方，请结合情况回应，不要说画好了。' } }
        const sent = await hub.sendSegments(chat.chatId, bufs.map((item) => ({ type: 'image', data: { file: 'base64://' + item.toString('base64') } })), `[生图] ${String(prompt).slice(0, 30)}`)
        // 调试 / 试运行下本来就不真发（sendSegments 只记日志、返回 null）：
        // 这一轮仍算画好了 —— 存盘、给编号、能看图，只是 QQ 里收不到；不能当失败。
        // 只有 null 才是“试运行/调试拦下”；明确的 false 仍按发送失败处理。
        const simulated = sent === null && Boolean(cfg.debug || cfg.dryRun)
        if (!sent && !simulated) return { ok: false, message: '画好了，但没有发到 QQ（请检查网关）' }
        const saved = bufs.map((item) => savePainting(item, String(prompt || ''))).filter(Boolean)
        for (const path of saved) api.log.debug(`生图已存盘：${path}`)
        try { const refNote = references.length ? `参考了${references.length === 1 ? '一张图' : references.length + ' 张图'}画了${bufs.length > 1 ? bufs.length + ' 张' : '一张'}` : (bufs.length > 1 ? `按提示词画了 ${bufs.length} 张` : '按提示词画了一张图'); memory.addEvent?.({ text: `${refNote}：${String(prompt).slice(0, 120)}（提示词不一定等于实际画面）`, about: chat.kind === 'private' ? chat.userId : '', tags: ['画画'], importance: 0.4 }) }
        catch (error) { api.log.warn('生图已发送，但经历没记下来：', error.message) }
        let visual = (await hub.canSeeImages(chat)) === true
        // 「让她画完自己看一眼」是总开关：关掉就当没视觉能力处理 —— 不给图、也不给路径。
        const seeOwn = api.config().imageGen.seeOwn !== false
        // 只有明确能看图的模型才把图交给它；纯文本模型只拿文字，不会崩。
        // 图要先缩、再登记成 DSH 附件块 —— 直接塞 base64 会让下一轮请求整轮失败（实测）
        let img = null
        if (visual && seeOwn) {
          img = await imageToolBlock(api.dsh, bufs[0], { ffmpegPath: api.config().bili && api.config().bili.ffmpegPath })
          if (!img) {
            // 图没给成：如实说看不了，别让她照着提示词编画面细节
            visual = false
            api.log.debug('这次生图没把图交给模型（缩图/登记失败），只给文字')
          }
        }
        const shown = Boolean(img)
        const animated = bufs.length === 1 && mimeOf(bufs[0]) === 'image/gif' && gifFrameCount(bufs[0]) > 1
        let message
        if (!visual) message = drawToolMessage({ visual: false })
        else if (!seeOwn) message = drawToolMessage({ visual: true, seeOwn: false })
        else if (!shown) message = drawToolMessage({ visual: false })
        else message = drawToolMessage({ visual: true, seeOwn: true })
        // 画作编号：换头像 / 收表情时用编号，别用路径（路径只在图真的交出去时才附带）。
        // 编号按「最新 = #1」：saved 是从旧到新，所以反过来排。
        for (const path of saved) rememberPainting(chat.chatId, path)
        const indexes = saved.map((_, i) => saved.length - i)
        const out = {
          ok: true,
          message,
          prompt: String(prompt || ''),
          count: bufs.length,
          referenceCount: references.length,
          bytes: bufs.reduce((n, item) => n + item.length, 0),
          elapsedMs: Date.now() - startedAt,
          ...(saved[0] ? { path: saved[0] } : {}),
          ...(saved.length > 1 ? { paths: saved } : {}),
        }
        if (fallback) out.message += '\n' + fallback
        if (self) {
          out.referenceCount = references.length
          out.selectedReferenceCount = selectedCount
          if (references.length) out.message += `\n本次实际使用 ${references.length} 张人设图作为参考。`
        }
        if (bufs.length > 1) out.message += `\n这次一共画了 ${bufs.length} 张。`
        if (animated) { out.format = 'gif'; out.frames = gifFrameCount(bufs[0]); out.message += `\n这是 GIF 动图（${out.frames} 帧）；若给了你预览，它只含第一帧，不代表完整动作。` }
        if (img) out.image = img
        if (indexes.length && saved.length) out.message += `\n画作编号 ${indexes.filter(Boolean).map((n) => '#' + n).join('、')}（想换头像、收成表情时用这个编号）`
        if (simulated) out.message += '\n（试运行/调试：这些图没真发到 QQ，只在本地存下了）'
        // 只有**图真的交给模型了**才把本地路径告诉她（#59）：收录表情包 / 存素材 / qq_add_sticker 用；
        // 看不了图或开关关着时不给路径，免得她知道路径就去读图，绕开「不给看」的判断。
        if (shown && saved.length) out.message += `\n已保存到本机：${saved.join('、')}（要收录表情包、存素材时可以用这个路径）`
        return out
      },
    }) : []))
    return gen
  },
}
