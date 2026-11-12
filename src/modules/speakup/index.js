// 内置模块：主动搭话。主人一阵子没找她时，她会在私聊里主动找主人聊几句（群里不会）。

import { createSpeakUp } from '../../features/companion.js'
import { defineTool, str } from '../../tools/tools.js'

export default {
  id: 'speakup',
  name: '主动搭话',
  version: '1.0.0',
  description: '主人一阵子没理她时，在私聊里主动找主人说话',
  tab: 'speakup',
  files: ['features/companion.js'],
  setup(api) {
    const { hub, mutes } = api.core
    const speakUp = createSpeakUp({ getConfig: api.config, hub, log: api.log, isMuted: (chatId) => mutes.muted(chatId), memory: () => api.use('memory') })
    api.every(60_000, () => (api.core.onebot?.state && api.core.onebot.state !== 'connected' ? undefined : speakUp.tick()), '主动搭话')
    const ownerChat = (chat) => chat?.kind === 'private' && String(chat.userId) === String(api.config().ownerQQ)
    // 工具常驻在主人私聊里；开关关着时执行层如实拒绝，避免开关切换后旧会话少了工具。
    api.tool(({ chat }) => {
      if (!ownerChat(chat) || api.config().speakUp?.enabled === false) return []
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
            const cfg = api.config()
            if (!cfg.speakUp?.reminderEnabled) return { ok: false, message: '小闹钟没开启' }
            return speakUp.addReminder(at, note)
          },
        }),
        defineTool({
          name: 'qq_close_reminder',
          description: '关闭一个自己设的小闹钟。id 用运行时「她的小闹钟」列表里的编号。',
          properties: { id: str('要关闭的小闹钟 id') },
          required: ['id'],
          execute: ({ id }) => {
            if (!ownerChat(chat)) return { ok: false, message: '只有主人能用小闹钟' }
            return speakUp.closeReminder(id)
          },
        }),
      ]
    })
    api.context(({ chat }) => {
      if (!ownerChat(chat) || api.config().speakUp?.reminderEnabled !== true) return ''
      const list = speakUp.reminders()
      if (!list.length) return ''
      return '【她的小闹钟】\n' + list.map((r) => `- ${r.id}｜${r.atText}｜${r.note}`).join('\n') + '\n要关闭某条用 qq_close_reminder。'
    })
    api.route('/speakup/reminder/close', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      return speakUp.closeReminder(body?.id)
    })
    api.route('/speakup/fire', async () => {
      if (!api.config().enabled) return { ok: false, message: '先打开总开关' }
      await speakUp.fire('手动')
      return { ok: true, message: '叫她去找你了' }
    })
    return speakUp
  },
}
