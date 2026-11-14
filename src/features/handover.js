// F2：同一个人在另一个平台第一次私聊时，用他在那边的私聊流水生成一段交接摘要。
// 只做私聊；不带群聊、不带别人的私聊，也不把摘要当成当前聊天里说过的话。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { askModel } from '../core/llm.js'
import { cleanText } from '../core/text.js'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { formatChatId, normalizeChatId, parseChatId } from '../gateway/address.js'
import { clockLabel } from '../chat/reply.js'

const MAX_ROWS = 40
const KEEP_DAYS = 7
const DONE_FILE = 'handover.json'

const two = (n) => String(n).padStart(2, '0')
const dayKey = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`

function readChatlogRows(now = Date.now()) {
  const dir = dataDir('chatlog')
  let files = []
  try { files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-KEEP_DAYS) } catch { return [] }
  const rows = []
  for (const file of files) {
    let lines = []
    try { lines = readFileSync(join(dir, file), 'utf8').split(/\r?\n/) } catch { continue }
    for (const line of lines) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (!row || row.who !== 'user' || typeof row.text !== 'string' || !row.text.trim()) continue
      if (!Number.isFinite(Number(row.t)) || now - Number(row.t) > KEEP_DAYS * 86400_000) continue
      rows.push(row)
    }
  }
  return rows.sort((a, b) => Number(a.t) - Number(b.t))
}

function privateChatIds(identity, person) {
  const out = new Map()
  for (const account of identity?.accountsOf?.(person) || []) {
    if (!account?.platform || !account?.account) continue
    const canonical = formatChatId({ instance: account.platform, kind: 'private', id: account.account })
    if (!canonical) continue
    out.set(normalizeChatId(canonical), account.platform)
    const legacy = `private:${account.account}`
    if (normalizeChatId(legacy) === normalizeChatId(canonical)) out.set(legacy, account.platform)
  }
  return out
}

/**
 * @param {object} options
 * @param {object} options.dsh DSH context
 * @param {Function} options.getConfig
 * @param {object} options.identity
 * @param {object} [options.log]
 * @param {Function} [options.ask] 测试注入；默认 askModel
 */
export function createHandover({ dsh, getConfig, identity, log = console, ask = askModel } = {}) {
  const file = () => dataDir(DONE_FILE)
  const load = () => readJson(file(), () => ({}))
  const save = (value) => writeJson(file(), value)

  async function contextFor(person, platform, chatId) {
    const cfg = getConfig?.() || {}
    if (!person || !platform || !chatId) return ''
    if (cfg.memory?.enabled === false) return ''
    // F2 第一版只给主人做交接；其他用户以后由设置打开。
    if (!identity?.isOwner?.(person)) return ''
    const key = `${person}|${platform}`
    const done = load()
    if (done[key]) return ''
    const ids = privateChatIds(identity, person)
    const current = normalizeChatId(chatId)
    const rows = readChatlogRows().filter((row) => {
      const norm = normalizeChatId(row.chatId)
      return norm && norm !== current && ids.has(norm) && ids.get(norm) !== platform
    })
    if (!rows.length) return ''
    const lines = rows.slice(-MAX_ROWS).map((row) => `${clockLabel(Number(row.t))} ${String(row.text).slice(0, 300)}`)
    const prompt = `这是同一个人「${cfg.ownerName || '主人'}」在另一个平台和你的私聊片段。请用三到五句写一段交接摘要，方便你在新平台接着聊：\n` +
      `- 只根据下面的片段；不要编造，不要提编号、平台名或“根据记录”\n` +
      `- 不要包含任何群聊、别人私聊的内容\n` +
      `- 写成“你记得的印象”，不是复述原话\n\n` +
      lines.join('\n')
    let text = ''
    try {
      text = cleanText(await ask(dsh, {
        system: '你是 Aurabot 的记忆整理器，只输出一段简短、自然的中文摘要。',
        text: prompt,
        maxTokens: 400,
      }))
    } catch (error) {
      log.warn?.('生成交接摘要失败：', error?.message || error)
      return ''
    }
    if (!text) return ''
    done[key] = Date.now()
    try { save(done) } catch (error) { log.warn?.('保存交接摘要标记失败：', error?.message || error) }
    return `【从别处带来的印象，不是这个聊天里说过的话】\n${text}`
  }

  return { contextFor }
}
