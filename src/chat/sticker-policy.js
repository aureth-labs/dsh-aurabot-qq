// 只看本段回复的文字/语音正文，不把表情名、图片地址和控制标签算成关键词。
// 实验性宽松匹配：宁可多放行；例如“地图”也会命中“图”，不是语义识别。
const KEYWORDS = [
  '图', '表情', '贴纸', '照片', '相片', '截图', '截屏', '动图', '梗图', '斗图',
  '一张', '这张', '那张', '几张', '两张', '多张', '来张', '发张', '整张', '换张',
  '一幅', '这幅', '那幅', '几幅', '一套', '这套', '那套',
  '看看', '看这', '看那', '看个', '看一', '瞧瞧', '瞅瞅', '瞅这',
  '给你看', '给大家看', '给你发', '发给你', '发你', '发个', '发一', '发来',
  '给你整', '整一个', '整一张', '来一个', '来个', '换一个', '换个', '安排一个',
  '送你', '送个', '收下', '收藏', '配个', '配一',
]
const ENGLISH = /\b(?:images?|pictures?|photos?|stickers?|memes?|gifs?|pics?|emojis?)\b/i

export function hasReplyStickerKeywords(items) {
  const body = items.filter((item) => item.kind === 'text' || item.kind === 'voice')
    .map((item) => String(item.value ?? '').replace(/<[^>]*>/g, '')).join('\n')
  return KEYWORDS.some((word) => body.includes(word)) || ENGLISH.test(body)
}

// 纯表情本身就是完整回复；实验模式下不把整轮回复抽没。空回复不算。
export function preserveReplyStickers(items) {
  return (items.length > 0 && items.every((item) => item.kind === 'sticker')) || hasReplyStickerKeywords(items)
}
