// 内置模块：QQ 专属基础工具（发送 QQ 卡片、读取聊天收到的文件）。
// 通用历史/搜索/发消息/发文件已拆分至跨平台内置模块 chat-tools。

import { defineTool, str } from '../../tools/tools.js'
import { readQqFile } from '../../features/qq-file.js'

function cardSegment(args) {
  const type = String(args.type || '').trim()
  if (!['share', 'music', 'location', 'contact', 'dice', 'rps'].includes(type)) return { error: 'type 要填 share、music、location、contact、dice 或 rps' }
  const has = (key) => args[key] !== undefined && args[key] !== null && String(args[key]).trim() !== ''
  // 网关会去读这些地址：只认网址，本机路径不能借卡片发出去
  for (const key of ['url', 'image', 'audio']) if (has(key) && !/^https?:\/\//i.test(String(args[key]).trim())) return { error: `${key} 要是 http 或 https 链接` }
  const data = {}
  const copy = (...keys) => { for (const key of keys) if (has(key)) data[key] = String(args[key]).trim() }
  const requireFields = (...keys) => keys.filter((key) => !has(key))
  let missing = []
  if (type === 'share') {
    missing = requireFields('url', 'title')
    copy('url', 'title', 'content', 'image')
  } else if (type === 'music') {
    missing = requireFields('music_type')
    const custom = String(args.music_type || '').trim() === 'custom' || !has('id')
    if (custom) missing.push(...requireFields('url', 'audio', 'title'))
    data.type = String(args.music_type || '').trim()
    if (custom) copy('url', 'audio', 'title', 'content', 'image')
    else copy('id')
  } else if (type === 'location') {
    missing = requireFields('lat', 'lon')
    if (!missing.length && (!Number.isFinite(Number(args.lat)) || Math.abs(Number(args.lat)) > 90 || !Number.isFinite(Number(args.lon)) || Math.abs(Number(args.lon)) > 180)) return { error: '位置的 lat 或 lon 超出范围' }
    copy('lat', 'lon', 'title', 'content')
  } else if (type === 'contact') {
    missing = requireFields('contact_type', 'id')
    if (!missing.length && (!['qq', 'group'].includes(args.contact_type) || !/^\d+$/.test(String(args.id)) || !Number.isSafeInteger(Number(args.id)) || Number(args.id) <= 0)) return { error: '联系人类型要填 qq 或 group，id 要填正整数' }
    data.type = String(args.contact_type || '')
    copy('id')
  }
  if (missing.length) return { error: '缺参数：' + missing.join('、') }
  return { segment: { type, data } }
}

export default {
  id: 'qq-tools',
  name: '基础 QQ 工具',
  version: '1.0.0',
  api: 2,
  platforms: ['qq'],
  description: '发送 QQ 专属卡片（qq_send_card：分享、音乐、位置、联系人、骰子、猜拳）；主人开口时读取聊天里发来的文本或图片文件（qq_read_file）',
  setup(api) {
    const { hub, onebot } = api.core
    const qqOnebot = {
      call: (action, params, opts) => (typeof api.native === 'function' ? api.native('qq', action, params, opts) : onebot.call(action, params, opts)),
      get state() { return api.core.onebot?.state },
    }
    api.tool(({ chat, level, sessionId }) => {
      if (chat.kind === 'system') return []
      const tools = [
        defineTool({
          name: 'qq_send_card',
          description: '向当前聊天发送分享、音乐、位置、联系人、骰子或猜拳。音乐的 music_type、联系人的 contact_type 对应卡片里的 type。',
          properties: {
            type: str('share / music / location / contact / dice / rps'),
            url: str('分享或自定义音乐的链接'), title: str('分享、音乐或位置的标题'),
            content: str('分享说明、音乐描述或位置地址'), image: str('分享或音乐的封面链接'),
            music_type: str('音乐平台类型；自定义音乐填 custom'), audio: str('自定义音乐的音频链接'),
            lat: { type: 'number', description: '位置纬度' }, lon: { type: 'number', description: '位置经度' },
            contact_type: str('联系人类型：qq 或 group'), id: str('平台音乐 ID、联系人 QQ 号或群号'),
          },
          required: ['type'],
          execute: async (args) => {
            const card = cardSegment(args)
            if (card.error) return { ok: false, message: card.error }
            const r = await hub.sendSegments(chat.chatId, [card.segment], `[卡片] ${card.segment.type}`, { throwOnError: true })
            if (!r) {
              const cfg = api.config()
              return { ok: false, message: !cfg.enabled ? '总开关关着，没发' : cfg.dryRun ? '试运行，只记了日志，没真发' : '卡片没发出去' }
            }
            return { ok: true, message: card.segment.type === 'share' && card.segment.data.image
              ? '分享卡片发出去了，封面没有作为单独的图片发送'
              : '卡片发出去了' }
          },
        }),
        // 读文件：别人发来的内容不可信，只有主人开口才读
        defineTool({
          name: 'qq_read_file',
          description: '读这个聊天里别人发来的文本或 JPG、PNG 图片文件（2MB 以内）。只有主人让你看的时候才用。name 填文件名，不填就读最新的一个。',
          properties: { name: str('可选：文件名，不填就读最新的') },
          required: [],
          render: (_args, value) => {
            const text = { type: 'text', text: (value.ok ? '' : '✗ ') + value.message }
            return value.ok && value.image?.attachment ? [text, value.image] : [text]
          },
          execute: async ({ name }) => {
            if (level !== 'full' && !hub.turnSendersAllOwner?.(sessionId)) return { ok: false, message: '只有主人让看时才能读文件' }
            const list = hub.recentFiles(chat.chatId)
            if (!list.length) return { ok: false, message: '这个聊天最近没收到文件（重启后记录会清空）' }
            const want = String(name || '').trim()
            const file = want ? list.findLast((f) => f.name === want) || list.findLast((f) => f.name.includes(want)) : list.at(-1)
            if (!file) return { ok: false, message: `没找到「${want}」，最近的文件有：${list.map((f) => f.name).join('、')}` }
            try {
              return await readQqFile({ onebot: qqOnebot, chat, file, dsh: api.dsh, canPreview: () => hub.canSeeImages?.(chat) })
            } catch (error) {
              if (error?.code === 'unsupported-action') return { ok: false, message: '当前 QQ 网关不支持读取聊天文件' }
              throw error
            }
          },
        }),
      ]
      return tools
    })
    return {}
  },
}
