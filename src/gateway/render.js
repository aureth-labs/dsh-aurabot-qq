// Aurabot 多平台 · 入站文字渲染（G1 产出）
// 契约来源：src/gateway/contracts.d.ts（InboundMessage.text / wakeText 注释）；
// 口径来源：docs/CONTRACTS.md §六.2 —— text / wakeText 只由这里生成，所有平台同一套口径，
//   以 beta 的 src/chat/inbound.js parseMessageEvent 现在的输出为准：
//     图片「[图片]」、表情包 label 或「[表情包]」、视频「[视频]」、文件「[文件 名字]」、
//     合并转发「[合并转发]」、戳一戳「[戳一戳]」、@别人「@名字 」、@全体「@全体成员 」。
//   语音条照 beta 的做法不产出文字（parseMessageEvent 的 record 段只收集不进 texts）。
//   wakeText = 去掉 @全体成员 之后的文字（判断「是不是在叫她」用）。
// 纯函数：不查身份、不判断「回不回」，只做翻译。

/**
 * 把 parts 拼成给模型看的文字。
 * @param {import('./contracts.d.ts').Part[]} parts
 * @returns {{ text: string, wakeText: string }}
 */
export function renderParts(parts) {
  const texts = []
  const atAllIndexes = new Set() // 「@全体成员 」占的槽位，wakeText 要去掉
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== 'object') continue
    switch (part.type) {
      case 'text':
        texts.push(String(part.text ?? ''))
        break
      case 'mention':
        if (part.account === 'all') {
          atAllIndexes.add(texts.length)
          texts.push('@全体成员 ')
        } else {
          texts.push(`@${part.name || part.account} `)
        }
        break
      case 'image':
        texts.push('[图片]')
        break
      case 'sticker':
        // 有平台给的文字说明（如「[啊？]」）就写说明，没有写「[表情包]」
        texts.push(part.label ? String(part.label) : '[表情包]')
        break
      case 'voice':
        // 照 beta 口径：语音条不进文字
        break
      case 'video':
        texts.push('[视频]')
        break
      case 'file':
        texts.push(`[文件 ${part.media?.name || ''}]`)
        break
      case 'face':
        // 平台内置小表情已换成名字；带结果值（骰子点数等）写成「[名字：值]」，照 beta 的骰子写法
        texts.push(part.value !== undefined && part.value !== null && String(part.value) !== '' ? `[${part.name}：${String(part.value)}]` : `[${part.name}]`)
        break
      case 'card':
        // 平台端已读出的卡片占位文字（如「[分享卡片（B站）：标题 url]」），原样放
        texts.push(String(part.text || ''))
        break
      case 'forward':
        texts.push('[合并转发]')
        break
      case 'poke':
        texts.push('[戳一戳]')
        break
      case 'other':
        texts.push(String(part.text || ''))
        break
      default:
        break
    }
  }
  const join = (list) => list.join('').replace(/\s+\n/g, '\n').trim()
  const text = join(texts)
  const wakeText = atAllIndexes.size ? join(texts.filter((_t, i) => !atAllIndexes.has(i))) : text
  return { text, wakeText }
}
