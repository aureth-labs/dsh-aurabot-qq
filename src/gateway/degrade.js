// Aurabot 多平台 · 出站降级（G1 产出）
// 契约来源：src/gateway/contracts.d.ts（Caps / InstanceConfig.caps 注释）；
// 降级表：docs/CONTRACTS.md §七.2 —— 降级只在网关，规则只有这一张表，
//   平台端收到的 parts 里不会有它声明不支持的类型，中枢不写平台判断。
//
// 设计说明：
//   - 纯函数：degrade(parts, replyTo, caps, opts?) → { parts, replyTo, degraded }。
//     第 4 个参数可选（不影响三参调用）：{ instance, proactive } ——
//     instance 用于抛 SendError 时填实例名；proactive 标记这条是不是主动消息
//     （没有 inResponseTo，或 inResponseTo 已过被动回复时限），proactive='none'
//     的平台收到主动消息时在这里抛 'proactive-not-allowed'（网关不把它入队）。
//   - file 超过 maxFileBytes：抛 SendError('not-sent', code:'too-large')。
//   - 降级后 parts 空了：抛 SendError('not-sent', code:'nothing-to-send')，不调平台端。
//   - face 在 Caps 里没有对应键（平台端总能收文字），约定 caps.face === false 表示
//     这个平台端不想收 face，此时换文字「[名字]」；未声明（undefined）一律保留。

import { makeSendError } from './errors.js'

/** voice 能力的强弱序：native > file > false，只能往弱改 */
const VOICE_RANK = { native: 2, file: 1, false: 0 }
/** proactive 能力的强弱序：free > limited > none，只能往弱改 */
const PROACTIVE_RANK = { free: 2, limited: 1, none: 0 }

/**
 * 按降级表把 parts / replyTo 改写成这个平台收得下的形状。
 * @param {import('./contracts.d.ts').Part[]} parts
 * @param {string=} replyTo
 * @param {import('./contracts.d.ts').Caps} caps 已叠加配置的能力表（实例的最终 caps）
 * @param {{ instance?: string, proactive?: boolean }=} opts
 * @returns {{ parts: import('./contracts.d.ts').Part[], replyTo: string|undefined, degraded: string[] }}
 */
export function degrade(parts, replyTo, caps, opts = {}) {
  const { instance = '', proactive = false } = opts
  const degraded = []

  // 主动消息，平台 proactive='none'：不调平台端，抛 not-sent（网关不入队——过了时限补发也没用）
  if (proactive && caps.proactive === 'none') {
    throw makeSendError('not-sent', 'proactive-not-allowed', instance, '该平台只能被动回复，这条是主动消息')
  }

  const out = []
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== 'object') continue
    switch (part.type) {
      case 'text':
        out.push(part)
        break
      case 'voice': {
        // 'file'：当音频文件发（平台端负责转成文件），保留原样
        if (caps.voice === 'native' || caps.voice === 'file') out.push(part)
        else degraded.push('voice dropped') // false：丢掉
        break
      }
      case 'sticker': {
        if (caps.sticker) out.push(part)
        else if (caps.image) {
          out.push({ type: 'image', media: part.media })
          degraded.push('sticker→image')
        } else degraded.push('sticker dropped')
        break
      }
      case 'image':
        if (caps.image) out.push(part)
        else degraded.push('image dropped')
        break
      case 'video':
        if (caps.video) out.push(part)
        else degraded.push('video dropped')
        break
      case 'file': {
        if (!caps.file) { degraded.push('file dropped'); break }
        const size = Number(part.media?.size) || 0
        if (caps.maxFileBytes > 0 && size > caps.maxFileBytes) {
          throw makeSendError('not-sent', 'too-large', instance, `文件 ${size} 字节超过该平台上限 ${caps.maxFileBytes}`)
        }
        out.push(part)
        break
      }
      case 'mention': {
        if (part.account === 'all') {
          if (caps.mentionAll) out.push(part)
          else {
            out.push({ type: 'text', text: '@全体成员 ' })
            degraded.push('mentionAll→text')
          }
        } else if (caps.mention) {
          out.push(part)
        } else {
          out.push({ type: 'text', text: `@${part.name || part.account} ` })
          degraded.push('mention→text')
        }
        break
      }
      case 'poke':
        if (caps.poke) out.push(part)
        else degraded.push('poke dropped')
        break
      case 'face': {
        if (caps.face === false) {
          out.push({ type: 'text', text: `[${part.name}]` })
          degraded.push('face→text')
        } else {
          out.push(part)
        }
        break
      }
      case 'card': {
        if (caps.card) out.push(part)
        else {
          // 换成文字：text，有 url 就接在后面
          out.push({ type: 'text', text: `${part.text || ''}${part.url ? ' ' + part.url : ''}` })
          degraded.push('card→text')
        }
        break
      }
      case 'forward':
        // 出站方向没有 caps 键（forwardExpand 是收方向的），原样交给平台端
        out.push(part)
        break
      case 'other':
        out.push(part)
        break
      default:
        // 认不出的类型：宁可不发也不让平台端收到违约 parts
        degraded.push(`unknown part (${part.type}) dropped`)
        break
    }
  }

  // replyTo：平台不支持引用回复就去掉，照常发
  if (replyTo && !caps.quoteReply) {
    replyTo = undefined
    degraded.push('quoteReply dropped')
  }

  // 降级后空了：不调平台端
  if (!out.length) {
    throw makeSendError('not-sent', 'nothing-to-send', instance, '降级后没有可发送的内容')
  }

  return { parts: out, replyTo, degraded }
}

export { VOICE_RANK, PROACTIVE_RANK }
