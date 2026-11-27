// 内置模块：好友 / 加群申请与白名单。
//  · qq_list_friend_requests：列出收到过的好友申请（QQ 号未知、被 QQ 过滤的也会列出来），按序号 / flag 处理。
//  · qq_handle_friend_request：通过 / 拒绝别人加她为好友的申请（SnowLuma：set_friend_add_request；被 QQ 过滤的「可能认识的人」走 set_doubt_friends_add_request）。
//  · qq_whitelist：听主人的话把 QQ 号 / 群号加进、移出白名单（allow.private / allow.groups），写进配置并保存。
// 「她主动加别人为好友」没做：SnowLuma（v2.2.0）没有这个接口，维护者明确说公开版不会加（SnowLuma#480）。
// 好友申请 / 加群申请 / 白名单工具共用「处理好友申请」这一档权限（面板「权限」页）：off 关 / owner 仅主人私聊（默认）/ all 所有人。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { defineTool, str, bool, int } from '../../tools/tools.js'
import { profileToolVisible, profilePermits } from '../../chat/access.js'
import { groupSettingsTool } from './group-settings.js'

const PENDING_MAX = 50
const ID_RE = /^\d{5,12}$/
const UNKNOWN_REQUEST_LABEL = '未知QQ（由QQ过滤）'

/** 取纯数字号码；不像 QQ 号 / 群号的返回空串。 */
export function cleanId(v) {
  const s = String(v ?? '').replace(/\D/g, '')
  return ID_RE.test(s) ? s : ''
}

/** 申请人的 QQ 号是否未知：SnowLuma 把 uid 解析不成 QQ 号时会给 user_id=0。 */
export function isUnknownUser(v) {
  return !v || String(v) === '0'
}

/** 给主人看的申请人称呼：未知的 QQ 号由 QQ 过滤，没法显示号码。 */
export function requestLabel(userId) {
  return isUnknownUser(userId) ? UNKNOWN_REQUEST_LABEL : `QQ ${userId}`
}

/** 白名单增删的纯逻辑：返回 { ok, message, next? }。next = 改完后的这张表（没变化时不给）。 */
export function planWhitelist(cfg, { action, kind, id }) {
  const act = String(action || '').trim().toLowerCase()
  if (!['add', 'remove'].includes(act)) return { ok: false, message: 'action 只能是 add 或 remove' }
  const k = String(kind || '').trim().toLowerCase()
  if (!['private', 'group'].includes(k)) return { ok: false, message: 'kind 只能是 private（私聊的人）或 group（群）' }
  const n = cleanId(id)
  if (!n) return { ok: false, message: '号码不对：要 5~12 位数字的 QQ 号 / 群号' }
  const label = k === 'private' ? 'QQ' : '群'
  const listName = k === 'private' ? '私聊白名单' : '群白名单'
  if (k === 'private' && n === String(cfg.ownerQQ || '')) {
    return act === 'remove'
      ? { ok: false, message: '主人不能被移出私聊白名单' }
      : { ok: true, message: '主人本来就能私聊，不用加白名单' }
  }
  if (k === 'private' && act === 'add' && n === String(cfg.botQQ || '')) return { ok: false, message: '这是我自己的号，不用加' }
  const list = (k === 'private' ? cfg.allow?.private : cfg.allow?.groups) || []
  const has = list.map(String).includes(n)
  const modeNote = k === 'group' && (cfg.group?.moduleOnlyGroups || []).includes(n) ? '；仍为仅模块，@ 也不触发 AI。要恢复 AI 聊天，请修改群响应模式' : ''
  if (act === 'add') {
    if (has) return { ok: true, message: `${label} ${n} 已经在${listName}里了${modeNote}` }
    return { ok: true, changed: true, message: `${label} ${n} 加进${listName}了${modeNote}`, next: [...list.map(String), n] }
  }
  if (!has) return { ok: true, message: `${label} ${n} 本来就不在${listName}里` }
  return { ok: true, changed: true, message: `${label} ${n} 从${listName}移出了`, next: list.map(String).filter((x) => x !== n) }
}

export default {
  id: 'contacts',
  name: '好友申请与白名单',
  version: '1.0.0',
  description: '处理好友申请、加群申请和邀请，改私聊 / 群白名单；主人私聊可管理群接话与旁听；权限在「权限」页',
  setup(api) {
    const { hub, onebot } = api.core
    const pendingFile = () => api.dataDir('friend-requests.json')
    const groupPendingFile = () => api.dataDir('group-requests.json')

    const loadPending = () => {
      try {
        const f = pendingFile()
        if (!existsSync(f)) return []
        const j = JSON.parse(readFileSync(f, 'utf8'))
        // userId 可以是 '0'（未知 QQ）：只要 flag 在就保留，不然被 QQ 过滤的申请会整条消失。
        return Array.isArray(j) ? j.filter((x) => x && x.flag) : []
      } catch (error) { return [] }
    }
    const savePending = (list) => {
      try { writeFileSync(pendingFile(), JSON.stringify(list.slice(-PENDING_MAX))) } catch (error) { api.log.warn('存好友申请出错：', error.message) }
    }

    const loadGroupPending = () => {
      try {
        const f = groupPendingFile()
        if (!existsSync(f)) return []
        const j = JSON.parse(readFileSync(f, 'utf8'))
        return Array.isArray(j) ? j.filter((x) => x && x.flag && ['add', 'invite'].includes(x.subType)) : []
      } catch (error) { return [] }
    }
    const saveGroupPending = (list) => {
      try { writeFileSync(groupPendingFile(), JSON.stringify(list.slice(-PENDING_MAX))) } catch (error) { api.log.warn('存加群申请出错：', error.message) }
    }
    const groupRequestText = (r, botQQ) => {
      const user = r.userId ? `QQ ${r.userId}` : '未知用户'
      const group = r.groupId ? `群 ${r.groupId}` : '未知群'
      if (r.subType === 'add') return `${user} 申请加入${group}`
      const invited = r.invitedId ? (r.invitedId === String(botQQ) ? '我' : `QQ ${r.invitedId}`) : '成员'
      return `${user} 邀请${invited}加入${group}`
    }
    const groupInFlight = new Set()

    const onGroupRequest = (ev) => {
      if (!ev.flag || !['add', 'invite'].includes(ev.sub_type)) return
      const userId = String(ev.user_id || '')
      const groupId = String(ev.group_id || '')
      const list = loadGroupPending()
      if (list.some((x) => x.flag === String(ev.flag))) return
      const req = { flag: String(ev.flag), subType: ev.sub_type, userId, groupId, invitedId: String(ev.invited_id || ''), comment: String(ev.comment || '').slice(0, 80), at: Date.now() }
      list.push(req)
      saveGroupPending(list)
      const cfg = api.config()
      if (cfg.ownerQQ && (cfg.profilePerms?.qqFriendRequest || 'owner') !== 'off') {
        const note = req.comment ? `，验证消息：「${req.comment}」` : ''
        api.sendText(`private:${cfg.ownerQQ}`, `${groupRequestText(req, cfg.botQQ)}${note}。可以让我列出待处理的加群申请并通过或拒绝。`).catch(() => {})
      }
    }

    // 好友申请事件：只记下来（flag 必须原样用，不能自己拼），再给主人提一句
    api.on('onebot', (ev) => {
      if (!ev || ev.post_type !== 'request') return
      if (ev.request_type === 'group') return onGroupRequest(ev)
      if (ev.request_type !== 'friend' || !ev.flag) return
      // SnowLuma 解析不出 QQ 号时 user_id 会是 0（比如被 QQ 过滤的「可能认识的人」）：
      // 这种申请也要记下来，flag 就是底层能直接处理的 uid，丢了主人就没法代为通过。
      const userId = String(ev.user_id || '0')
      const list = loadPending()
      const isNew = !list.some((x) => x.flag === String(ev.flag))
      if (isNew) {
        list.push({ flag: String(ev.flag), userId, comment: String(ev.comment || '').slice(0, 80), at: Date.now() })
        savePending(list)
      }
      const cfg = api.config()
      if (isNew && cfg.ownerQQ && (cfg.profilePerms?.qqFriendRequest || 'owner') !== 'off') {
        const note = ev.comment ? `，验证消息：「${String(ev.comment).slice(0, 80)}」` : ''
        const how = isUnknownUser(userId)
          ? `现在它是第 ${list.length} 个待处理申请，跟我说「通过第 ${list.length} 个」或「拒绝第 ${list.length} 个」就行。`
          : `要通过就跟我说「通过 ${userId}」，不想加说「拒绝 ${userId}」。`
        api.sendText(`private:${cfg.ownerQQ}`, `有人想加我好友：${requestLabel(userId)}${note}。${how}`).catch(() => {})
      }
    })

    const guarded = (key, chat, sessionId, run) => async (args) => {
      const cfg = api.config()
      const p = profilePermits(cfg, key, chat, hub.turnSendersAllOwner(sessionId))
      if (!p.ok) return p
      return run(args, cfg)
    }

    const groupOwner = (chat) => chat.kind === 'private' && Boolean(api.config().ownerQQ) && String(chat.userId) === String(api.config().ownerQQ)
    const guardedGroup = (chat, sessionId, run) => guarded('qqFriendRequest', chat, sessionId, async (args, cfg) => {
      if (!groupOwner(chat) || !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人私聊才能处理加群申请' }
      return run(args, cfg)
    })

    /** 收到过的事件转成统一形状（userId 未知时保留 '0'）。 */
    const asEventCandidate = (x) => ({ via: 'event', flag: String(x.flag), userId: isUnknownUser(x.userId) ? '0' : String(x.userId), comment: String(x.comment || '') })

    /** QQ 过滤的「可能认识的人」：uid 就是 set_friend_add_request / set_doubt_friends_add_request 的 flag。 */
    async function loadDoubtCandidates(pending) {
      let doubt = []
      try { doubt = (await onebot.call('get_doubt_friends_add_request', { count: 50 }, { timeoutMs: 15000 })) || [] } catch (error) { doubt = [] }
      if (!Array.isArray(doubt)) doubt = []
      const seen = new Set(pending.map((x) => x.flag))
      const out = []
      for (const d of doubt) {
        if (!d || !d.uid) continue
        const flag = String(d.uid)
        if (seen.has(flag)) continue // 已经作为事件收到过，别列两遍
        seen.add(flag)
        out.push({ via: 'doubt', flag, userId: isUnknownUser(d.user_id) ? '0' : String(d.user_id), comment: String(d.msg || d.message || '').slice(0, 80) })
      }
      return out
    }

    /**
     * 找要处理的那条申请：先看收到过的事件，再看 QQ 过滤掉的「可能认识的人」。
     * 支持按 QQ 号（qq）、原样 flag、序号（index，从 1 开始；先事件后 QQ 过滤列表）找。
     */
    async function findRequest({ qq = '', flag = '', index = 0 } = {}) {
      const pending = loadPending().map(asEventCandidate)
      const pick = (list) => flag
        ? list.find((x) => x.flag === String(flag))
        : index
          ? list[index - 1]
          : qq
            ? list.find((x) => x.userId === qq)
            : (list.length === 1 ? list[0] : null)
      const hit = pick(pending)
      if (hit) return { ok: true, ...hit }
      if (!flag && !index && !qq && pending.length > 1) {
        return { ok: false, message: `有 ${pending.length} 个待处理的申请：${pending.map((x) => requestLabel(x.userId)).join('、')}。说清楚是哪个 QQ 号，或说第几个/flag` }
      }
      const doubt = await loadDoubtCandidates(pending)
      // 序号接着事件列表往后排，和 qq_list_friend_requests 的列表一致
      const doubtHit = index ? doubt[index - pending.length - 1] || null : pick(doubt)
      if (doubtHit) return { ok: true, ...doubtHit }
      if (!flag && !index && !qq && doubt.length > 1) {
        return { ok: false, message: `有 ${doubt.length} 个被 QQ 过滤的申请：${doubt.map((x) => requestLabel(x.userId)).join('、')}。说清楚是哪个 QQ 号，或说第几个/flag` }
      }
      const what = flag ? `flag ${flag}` : index ? `第 ${index} 个` : qq ? `QQ ${qq}` : ''
      return { ok: false, message: what ? `没找到 ${what} 的好友申请（没收到过，QQ 过滤的列表里也没有）` : '现在没有待处理的好友申请' }
    }

    api.tool(({ chat, sessionId }) => {
      if (chat.kind !== 'private' && chat.kind !== 'group') return []
      const cfg = api.config()
      const tools = []
      if (profileToolVisible(cfg, 'qqFriendRequest', chat)) {
        tools.push(defineTool({
          name: 'qq_list_friend_requests',
          description: '列出收到过、尚未处理的好友申请（包括 QQ 号未知、被 QQ 过滤的申请），处理时使用列表里的序号或 flag。',
          execute: guarded('qqFriendRequest', chat, sessionId, async () => {
            const pending = loadPending().map(asEventCandidate)
            const list = [...pending, ...(await loadDoubtCandidates(pending))]
            return {
              ok: true,
              message: list.length
                ? list.map((r, i) => `${i + 1}. ${requestLabel(r.userId)}${r.comment ? `，验证消息：「${r.comment}」` : ''}（flag: ${r.flag}）`).join('\n')
                : '现在没有待处理的好友申请',
            }
          }),
        }))
        tools.push(defineTool({
          name: 'qq_handle_friend_request',
          description: '通过或拒绝别人加你为好友的申请。可以用 qq（申请人的 QQ 号）、flag（待处理列表里的原样 flag）或 index（第几个，从 1 开始）指定；只有一个待处理申请时可不填。approve 填 true 通过、false 拒绝。你不能主动加别人为好友。',
          properties: { qq: str('申请人的 QQ 号，可不填'), flag: str('待处理列表里的原样 flag，可不填'), index: int('待处理列表里的序号（从 1 开始），可不填'), approve: bool('true 通过，false 拒绝') },
          required: ['approve'],
          execute: guarded('qqFriendRequest', chat, sessionId, async ({ qq, flag, index, approve }, c) => {
            if (typeof approve !== 'boolean') return { ok: false, message: 'approve 要写 true（通过）或 false（拒绝）' }
            const rawQq = String(qq ?? '').trim()
            const wantQq = rawQq ? cleanId(rawQq) : ''
            if (rawQq && !wantQq) return { ok: false, message: 'QQ 号不对：要 5~12 位数字' }
            const wantFlag = String(flag ?? '').trim()
            let wantIndex = 0
            if (index !== undefined && index !== null && String(index).trim() !== '') {
              wantIndex = Number(index)
              if (!Number.isInteger(wantIndex) || wantIndex < 1) return { ok: false, message: '序号要写从 1 开始的整数' }
            }
            if ([wantQq, wantFlag, wantIndex].filter(Boolean).length > 1) return { ok: false, message: 'qq、flag、序号只填一个就行' }
            const req = await findRequest({ qq: wantQq, flag: wantFlag, index: wantIndex })
            if (!req.ok) return req
            const verb = approve ? '通过' : '拒绝'
            const label = requestLabel(req.userId)
            if (c.dryRun) return { ok: true, message: `试运行：本来要${verb} ${label} 的好友申请` }
            try {
              if (req.via === 'event') await onebot.call('set_friend_add_request', { flag: req.flag, approve }, { timeoutMs: 15000 })
              else await onebot.call('set_doubt_friends_add_request', { flag: req.flag, approve }, { timeoutMs: 15000 })
            } catch (error) {
              return { ok: false, message: `${verb} ${label} 的好友申请没成功：${error.message}` }
            }
            // 只按 flag 删：未知 QQ 的 userId 都是 '0'，按 userId 删会把别的申请一起删掉
            savePending(loadPending().filter((x) => x.flag !== req.flag))
            return { ok: true, message: `已${verb} ${label} 的好友申请` }
          }),
        }))
      }
      if (groupOwner(chat) && profileToolVisible(cfg, 'qqFriendRequest', chat)) {
        tools.push(defineTool({
          name: 'qq_list_group_requests',
          description: '列出收到过、尚未处理的加群申请和邀请，处理时使用列表中的 flag。',
          execute: guardedGroup(chat, sessionId, async (_args, c) => {
            const list = loadGroupPending()
            return { ok: true, message: list.length ? list.map((r) => `${groupRequestText(r, c.botQQ)}${r.comment ? `，验证消息：「${r.comment}」` : ''}（flag: ${r.flag}）`).join('\n') : '现在没有待处理的加群申请或邀请' }
          }),
        }))
        tools.push(defineTool({
          name: 'qq_handle_group_request',
          description: '通过或拒绝收到过的加群申请或邀请。flag 从待处理列表原样取得，只有一条时可不填；approve 填 true 或 false，拒绝时可填 reason。',
          properties: { flag: str('待处理列表里的 flag，可不填'), approve: bool('true 通过，false 拒绝'), reason: str('拒绝原因，可不填') },
          required: ['approve'],
          execute: guardedGroup(chat, sessionId, async ({ flag, approve, reason }, c) => {
            if (typeof approve !== 'boolean') return { ok: false, message: 'approve 要写 true（通过）或 false（拒绝）' }
            const list = loadGroupPending()
            const wanted = String(flag ?? '')
            if (!wanted && list.length > 1) return { ok: false, message: '有多条待处理的加群申请，请先列出并指定 flag' }
            const req = wanted ? list.find((x) => x.flag === wanted) : list[0]
            if (!req) return { ok: false, message: '没找到这条待处理的加群申请或邀请' }
            const verb = approve ? '通过' : '拒绝'
            const label = groupRequestText(req, c.botQQ)
            if (c.dryRun) return { ok: true, message: `试运行：本来要${verb}「${label}」` }
            if (groupInFlight.has(req.flag)) return { ok: false, message: '这条申请正在处理' }
            groupInFlight.add(req.flag)
            try {
              await onebot.call('set_group_add_request', { flag: req.flag, sub_type: req.subType, approve, ...(reason && !approve ? { reason: String(reason) } : {}) }, { timeoutMs: 15000 })
              saveGroupPending(loadGroupPending().filter((x) => x.flag !== req.flag))
              return { ok: true, message: `已${verb}「${label}」` }
            } catch (error) {
              return { ok: false, message: `${verb}「${label}」没成功：${error.message}` }
            } finally { groupInFlight.delete(req.flag) }
          }),
        }))
      }
      if (profileToolVisible(cfg, 'whitelist', chat)) tools.push(defineTool({
        name: 'qq_whitelist',
        description: '改白名单：action 填 add（加进）或 remove（移出），kind 填 private（某个 QQ 号可以私聊你）或 group（允许群消息交给模块；是否 AI 接话另看群响应模式），id 填 QQ 号或群号。主人不能被移出。群模式用 qq_group_settings 查询或修改；仅模块限制不因重新加白而解除。',
        properties: { action: str('add 加进 / remove 移出'), kind: str('private 私聊的人 / group 群'), id: str('QQ 号或群号（数字）') },
        required: ['action', 'kind', 'id'],
        execute: guarded('whitelist', chat, sessionId, async (args, c) => {
          const plan = planWhitelist(c, args)
          if (!plan.ok || !plan.changed) return plan
          if (c.dryRun) return { ok: true, message: `试运行：本来要${plan.message}` }
          const key = String(args.kind).trim().toLowerCase() === 'private' ? 'private' : 'groups'
          // 用保存那一刻最新的配置再算一遍，免得盖掉面板刚改的
          let result = plan
          api.setConfig((cur) => {
            result = planWhitelist(cur, args)
            if (!result.ok || !result.changed) return cur
            return { ...cur, allow: { ...cur.allow, [key]: result.next } }
          })
          return { ok: result.ok, message: result.message }
        }),
      }))
      const groupSettings = groupSettingsTool(api, { chat, sessionId })
      if (groupSettings) tools.push(groupSettings)
      return tools
    })
    return {}
  },
}
