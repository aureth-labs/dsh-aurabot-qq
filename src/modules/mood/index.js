// 内置模块：心情。聊天让她开心或低落，心情影响她发表情、发语音的频率和回复快慢，也会写进她的上下文。
// 导出 createMood 的返回值：nudge(变化, 原因, chatId?)、label()、state()、effects()、contextLine(chat)、observe()、judge()。

import { createMood } from '../../features/mood.js'

/**
 * 事件里的说话人标签：主人用主人名，其他人用「群名片/昵称(QQ)」。
 * QQ 号能区分同名/改过群名片的群友，避免心情记录把「谁干的」记混。
 */
function speakerLabel(a, cfg) {
  if (a.owner) return cfg.ownerName || a.nickname || '主人'
  const nick = String(a.nickname || '').trim()
  const qq = String(a.userId || '').trim()
  if (nick && qq) return `${nick}(${qq})`
  return nick || (qq ? `QQ ${qq}` : '有人')
}

export default {
  id: 'mood',
  name: '心情',
  version: '1.0.0',
  description: '她的心情：会随聊天起伏，影响表情 / 语音频率和回复快慢',
  tab: 'mood',
  files: ['features/mood.js', 'features/mood-context.js', 'features/mood-emotions.js'],
  setup(api) {
    const mood = createMood({ getConfig: api.config, dsh: api.dsh, log: api.log })
    // 理由的相对时间每轮变化，和相关记忆一样放进本轮消息，避免上下文快照膨胀（#79）。
    // 带上当前 chat：只在原因所属的聊天里显示「因为…」，别的私聊/群不继承（#273）。
    api.on('prompt', (content, { chat }) => {
      if (chat.kind === 'system') return content
      const line = mood.contextLine(chat)
      return line ? [...content, { type: 'text', text: line }] : content
    })
    api.on('activity', (a) => {
      const cfg = api.config()
      if (a.kind === 'in' && a.text) mood.observe(a.text, speakerLabel(a, cfg), { direct: a.direct, owner: a.owner, chatId: a.chatId })
      if (a.kind === 'silent' && a.text && cfg.mood.judge) mood.observe(a.text, speakerLabel(a, cfg), { silent: true, chatId: a.chatId })
      // 模型判心情（开了才判）：系统提醒开头的是她自己主动找人
      if (a.kind === 'out' && a.reply && !String(a.chatId).startsWith('system:')) {
        const speakUp = String(a.userText).startsWith('【系统提醒')
        mood.judge({ userText: a.userText, reply: a.reply, who: String(a.chatId).startsWith('group:') ? '群里的人' : String(a.chatId) === `private:${cfg.ownerQQ}` ? cfg.ownerName || '主人' : '对方', origin: speakUp ? 'speak-up' : 'user', chatId: a.chatId }).catch(() => {})
      }
    })
    // 心情历史单独取：/state 只带摘要，避免面板轮询把最多 200 条历史一起传
    api.route('/mood/history', async () => ({ ok: true, history: mood.state().history || [] }))
    // 心情项（情绪向量）单独取：面板「此刻的情绪」按需拉，不塞进 /state 轮询。
    // 与 /mood/history 同一口径：/state 只给摘要（emotionsItems 已随 state 下发，这里是完整版）。
    api.route('/mood/emotions', async () => {
      const s = mood.state()
      return { ok: true, items: s.emotionsItems, vector: s.emotions, at: s.emotionsAt, top: s.emotionTop }
    })
    return mood
  },
}
