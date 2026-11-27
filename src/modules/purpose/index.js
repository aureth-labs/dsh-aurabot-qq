// 内置模块：目的引擎（主动搭话的新引擎，P1 起【默认开】，见 docs/SPEAKUP-INTO-PURPOSE-PLAN.md §3）。
// 像人一样定期主动找主人搭话：素材（记忆 + 聊天流水）→ 目标假设（带归属/置信度/风险）
// → 选一个目的 → 生成一句话 → 投递私聊。
//
// 与「主动搭话」（speakup）的关系（P1 迁移期）：speakup 模块仍在跑，但目的引擎开着时
// companion 会自动让位（既有软互斥），主动搭话实际由目的引擎承担；醒着窗口/白名单等
// 共享键仍冻结在 speakUp.*（Q3/Q4 拍板），由目的引擎维护。迁移说明见 docs/PURPOSE_MODULE_API.md。
//
// 薄壳只做注册；引擎在 src/purpose/engine.js（纯函数），接线在 src/purpose/module.js。

import { createPurpose } from '../../purpose/module.js'
import { defineTool, str } from '../../tools/tools.js'

export default {
  id: 'purpose',
  name: '目的引擎',
  version: '1.0.0',
  description: '像人一样主动找主人搭话：攒素材 → 记观察 → 立目标假设 → 挑一个候选，到点了才来找你。默认开启（主动搭话已并入目的引擎）；显式关过的不会被默认值洗回。',
  tab: 'speakup',
  files: ['purpose/engine.js', 'purpose/module.js'],
  defaults: {
    // P1/Q1 拍板：新装也默认开启。modules.js 的 defaults 填充只补「缺失键」，
    // 用户显式写过的 enabled:false 不会被这里的 true 洗掉（运行期语义在 purposeConfig 再兜一层：
    // ext.purpose.enabled 缺省视为开、显式 false 尊重）。
    enabled: true,
    minMaterials: 2, // 素材少于这个数（也没有惦记的事/人格卡）就不硬找话
    initialDelayMinutes: 15, // 启动后的第一枪延迟
    maxCandidates: 6,
    promptMaxChars: 16000,
  },
  settings: [
    { key: 'enabled', label: '启用目的引擎', type: 'boolean', hint: '默认开（主动搭话已并入目的引擎）。关掉后她不会再主动找你；开着时旧的「主动搭话」会自动让位，不会两套同时打扰' },
    { key: 'minMaterials', label: '最少素材数', type: 'number', min: 0, max: 20, hint: '低于这个数且没有惦记的事/人格卡时，这轮不硬找话' },
    { key: 'initialDelayMinutes', label: '启动延迟（分钟）', type: 'number', min: 1, max: 720, hint: '插件启动后第一次主动搭话前先等多久' },
    { key: 'maxCandidates', label: '候选方向数', type: 'number', min: 3, max: 10 },
  ],
  setup(api) {
    // ---------- P1 播种（方案 §3.1，只发生一次） ----------
    // 老用户（speakUp.enabled=true、ext.purpose.enabled 从未显式设置）升级瞬间由
    // defaults 填充把 enabled 补成 true；这里负责把「这次是无感迁移」记下来：
    // 写播种标记 seededFromSpeakup + 打一行迁移日志，之后重启不再重复。
    // 显式关过（ext.purpose.enabled === false）的不覆盖、不打标、不再提示。
    const seedCfg = api.config()
    const seedExt = (seedCfg.ext && seedCfg.ext.purpose) || {}
    if (seedCfg.speakUp?.enabled === true && seedExt.enabled !== false && !seedExt.seededFromSpeakup) {
      try {
        api.setConfig({ ext: { purpose: { enabled: true, seededFromSpeakup: true } } })
        api.log.info('主动搭话已并入目的引擎，已为你开启目的引擎（醒着时间/频率/白名单都沿用原设置）')
      } catch (error) {
        api.log.warn('播种目的引擎开关失败（不影响本轮运行）：', error?.message)
      }
    }
    const purpose = createPurpose({
      getConfig: api.config,
      setConfig: api.setConfig,
      hub: api.core.hub,
      log: api.log,
      isMuted: (chatId) => { try { return api.core.mutes.muted(chatId) } catch { return false } },
      mood: () => api.use('mood'),
      memory: () => api.use('memory'),
      // 载体分发用（面板里 carrier=pet 时推桌宠气泡；桌宠没开是 null，按离线回落处理）
      pet: () => api.use('pet'),
      // 素材口：浏览型模块（rss-reader「自主上网」等）的素材按需取用；没装/没开是 null。
      use: (id) => api.use(id),
      personaText: () => { try { return api.core.personas?.current?.() || '' } catch { return '' } },
    })
    // P4：接住原 speakup 壳的「网关未连接不空跑」守卫（scheduler-gateway-idle.test.js 锁的行为）——
    // 网关没连上时 tick 跑了只会白白触发请求和日志（小闹钟触发也走 pushToSession → 网关）。
    // 守卫要网关感知（与 bili 同款）：先看多平台网关的实例状态（飞书等平台在跑时不该被
    // QQ onebot 的状态一票否决），没有网关实例再回落 QQ onebot 状态。
    // 背景（2026-11-18 实测报障）：裸读 api.core.onebot.state 在「宿主直连 QQ」+
    // 多平台配置共存（platforms 里 qq 显式 disabled、别的实例键存在）时，部分宿主版本
    // 的模块作用域会把这个快照判成 stopped —— 网关明明连着，定时任务却被静默跳过，
    // 且不打任何日志（状态文件不写、日志零记录），用户看到的就是「到点不来找」。
    const gatewayIdle = () => {
      const insts = api.core.gateway?.instances?.()
      if (Array.isArray(insts) && insts.some((s) => s?.enabled && s.caps !== null)) {
        return !insts.some((s) => s?.enabled && s.state === 'connected')
      }
      return Boolean(api.core.onebot?.state && api.core.onebot.state !== 'connected')
    }
    api.every(60_000, () => (gatewayIdle() ? undefined : purpose.tick()), '目的引擎')
    // ---------- 她的小闹钟（P2b 自 speakup 迁入，Q2 拍板） ----------
    // 工具常驻在主人私聊里；「小闹钟」开关（speakUp.reminderEnabled，键冻结 Q3 口径）关着时
    // 执行层如实拒绝。数据兼容读旧 speakup-reminders.json、新写 purpose/reminders.json。
    const ownerChat = (chat) => chat?.kind === 'private' && String(chat.userId) === String(api.config().ownerQQ)
    api.tool(({ chat }) => {
      if (!ownerChat(chat) || ((api.config().ext && api.config().ext.purpose) || {}).enabled === false) return []
      return [
        defineTool({
          name: 'qq_set_reminder',
          description: '给未来的自己定一个小闹钟。到时间系统会提醒你主动找主人说话。at 必须是 yyyy-mm-dd HH:MM（本地时间），note 是到时要提醒自己的内容/由头。只用于主人私聊；面板里的小闹钟开关关着时不能用。',
          properties: {
            at: str('时间，格式 yyyy-mm-dd HH:MM，例如 2026-11-12 17:30'),
            note: str('到时要提醒自己什么，例如「问主人晚饭吃了没」'),
          },
          required: ['at', 'note'],
          execute: ({ at, note }) => {
            if (!ownerChat(chat)) return { ok: false, message: '只有主人能用小闹钟' }
            return purpose.addReminder(at, note)
          },
        }),
        defineTool({
          name: 'qq_close_reminder',
          description: '关闭一个自己设的小闹钟。id 用运行时「她的小闹钟」列表里的编号。',
          properties: { id: str('要关闭的小闹钟 id') },
          required: ['id'],
          execute: ({ id }) => {
            if (!ownerChat(chat)) return { ok: false, message: '只有主人能用小闹钟' }
            return purpose.closeReminder(id)
          },
        }),
      ]
    })
    api.context(({ chat }) => {
      if (!ownerChat(chat) || api.config().speakUp?.reminderEnabled !== true) return ''
      const list = purpose.reminders()
      if (!list.length) return ''
      return '【她的小闹钟】\n' + list.map((r) => `- ${r.id}｜${r.atText}｜${r.note}`).join('\n') + '\n要关闭某条用 qq_close_reminder。'
    })
    api.route('/purpose/reminder/close', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      return purpose.closeReminder(body?.id)
    })
    api.route('/purpose/fire', async () => {
      if (!api.settings().enabled) return { ok: false, message: '目的引擎没开（主动搭话页可以打开）' }
      const r = await purpose.fire('手动')
      if (!r) return { ok: false, message: '没有结果' }
      if (r.outcome === 'sent') return { ok: true, message: '已经去找你了' }
      if (r.outcome === 'silent') return { ok: true, message: '她这轮想了想，决定不说（不硬发）' }
      if (r.outcome === 'muted') return { ok: false, message: '主人在私聊里让她闭嘴了' }
      if (r.outcome === 'disabled') return { ok: false, message: '目的引擎开关是关的' }
      return { ok: true, message: `这轮结束：${r.outcome}` }
    })
    api.route('/purpose/status', async () => ({ ok: true, status: purpose.status(), state: purpose.state() }))
    api.route('/purpose/preview', async () => ({ ok: true, preview: await purpose.preview() }))
    // 代发决断面：宿主投递器在 broker 档发送前调用（见 purpose/module.js 的 brokerReview）。
    // 模块不直接用它；host.js 的 wirePolicySources 经 use('purpose') 取到。
    // （createPurpose 返回的对象方法都走闭包，无 this 依赖，直接透传即可。）
    // 引擎自发发言的 §5.3 私有凭据注入点：宿主把 purpose 策略源对象交给引擎，
    // 引擎投递时经 deliver 的 enginePolicy 路径 reserve/commit，不再被包装层门闸二次拦。
    // 驱动向量 → 提示层：把「最近比较想要什么」轻描淡写地附在本轮消息末尾（引擎关着时返回空）。
    // 和心情一样不进系统提示词：它会随驱动变化，放在开头一变就让整段历史的前缀缓存失效。
    api.on('prompt', (content, { chat }) => {
      if (chat.kind === 'system') return content
      const line = purpose.drivesRule()
      return line ? [...content, { type: 'text', text: line }] : content
    })
    return purpose
  },
}
