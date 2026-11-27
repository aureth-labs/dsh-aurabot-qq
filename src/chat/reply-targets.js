/**
 * Resolve reply markers using the same numbered-message snapshot as the prompt.
 * Pure: does not send messages, look up members, or change the parsed items.
 * userId also applies to the text fallback when voice synthesis fails.
 */
export function resolveReplyTargets(items, { refs = {}, autoReply, canSendSticker = () => true } = {}) {
  const explicit = items.some(item => item.replyTo)
  const first = items.findIndex(item => ['text', 'voice', 'image'].includes(item.kind) ||
    (item.kind === 'sticker' && canSendSticker(item.value)))
  return items.map((item, index) => {
    const selected = item.replyTo ? refs[item.replyTo] : (!explicit && index === first ? autoReply : null)
    return {
      replyId: selected?.mid,
      userId: selected && (selected.direct || autoReply?.uid === selected.uid) ? selected.uid : undefined,
      sourceUserId: selected?.uid,
      unresolvedReply: item.replyTo && !selected?.mid ? String(item.replyTo) : undefined,
    }
  })
}
