// 多平台共享会话 · 记忆整理统一方案（P0–P4 完整覆盖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import { createMemoryStore, extractionMask, compressionClusters, NATIVE_MEMORY_VIEW } from '../src/features/memory.js'
import { memoryPlatforms } from '../src/features/memory-rules.js'
import { readMemoryState, writeMemoryState } from './helpers/memory-state.js'
import { makeTestIdentity } from './helpers/identity.js'

const DAY_MS = 86400_000
const log = { info() {}, warn() {}, debug() {} }
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function makeMockDsh(handler) {
  const calls = []
  const dsh = {
    get: () => null,
    llm: {
      async *stream({ system, messages }) {
        const text = messages?.[0]?.content?.[0]?.text || ''
        calls.push({ system: String(system || ''), text: String(text) })
        const reply = await handler({ system: String(system || ''), text: String(text), index: calls.length })
        yield { type: 'text-delta', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
    },
  }
  return { dsh, calls }
}

function setupStore(t, { cfgPatch = {}, identity = makeTestIdentity('1481236341', 'qq', { personId: 'p-owner001' }), llmHandler, useRealHub = false, initialState = null, processed = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-shared-mem-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  if (initialState || processed) {
    writeMemoryState(dir, { items: [], ...(initialState || {}), ...(processed ? { processed } : {}) })
  }
  const cfg = normalize({
    enabled: true,
    ownerQQ: '1481236341',
    ownerName: '主人',
    botQQ: '999000',
    model: { provider: 'p', model: 'm' },
    memory: {
      enabled: true,
      dailyConsolidate: true,
      consolidateTimes: [],
      extractIdleMinutes: 30,
      extractMinLines: 20,
      extractDailyBatches: 24,
      keepChatlogDays: -1,
      gistEnabled: true,
      vector: { enabled: false },
      rerank: { enabled: false },
      ...(cfgPatch.memory || {}),
    },
    ...cfgPatch,
  })
  cfg.memory.consolidateTimes = Array.isArray(cfgPatch.memory?.consolidateTimes) ? [...cfgPatch.memory.consolidateTimes] : []
  const { dsh, calls } = makeMockDsh(llmHandler || (({ system }) => {
    if (system.includes('整理长期记忆')) return { facts: [] }
    if (system.includes('整理自己的记忆')) return { text: '聊了日常安排' }
    if (system.includes('回顾自己')) return { insights: [], style: [] }
    if (system.includes('同一件事')) return { merges: [] }
    if (system.includes('概括成 1~2 句')) return { text: '主人一直很关心技术进度和生活作息。' }
    return '[]'
  }))

  const rowsByDay = new Map()
  let rev = 1
  const resetAts = new Map()
  const hub = useRealHub
    ? createHub({ dsh, getConfig: () => cfg, log, identity, routeOwner: identity?.routeOwner, defaultPlatform: 'qq', onebot: {}, stickers: {}, tts: {} })
    : {
        chatLogDays: () => [...rowsByDay.keys()].sort(),
        chatLogOf: (day) => rowsByDay.get(day) || [],
        deleteChatLog: (day) => { rowsByDay.delete(day); rev++ },
        chatLogRevision: () => rev,
        refreshFriends: async () => {},
        sessions: () => ({}),
        groupNames: new Map(),
        memoryResetAt: (id) => resetAts.get(id) || 0,
        forgetChatLog: (target, query = '') => {
          let marked = 0
          for (const [day, list] of rowsByDay.entries()) {
            for (const row of list) {
              if (!row.forgottenAt && (row.chatId === target || row.chatId === `qq:${target}` || `qq:${row.chatId}` === target) && (!query || String(row.text || '').includes(query))) {
                row.forgottenAt = Date.now()
                marked++
              }
            }
          }
          if (marked) rev++
          return marked
        },
      }

  const make = () => createMemoryStore({ dsh, getConfig: () => cfg, hub, log, identity, directory: dir })
  let mem = make()
  t.after(() => {
    mem.close()
    if (useRealHub) hub.dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    dir, cfg, identity, hub, calls, rowsByDay,
    get mem() { return mem },
    reopen() { mem.close(); mem = make(); return mem },
    pushRow(day, row) {
      if (!rowsByDay.has(day)) rowsByDay.set(day, [])
      rowsByDay.get(day).push(row)
      rev++
    },
    readState: () => readMemoryState(dir),
  }
}

test('P0-1：飞书 ou_... 与企微/钉钉/QQBot 非纯数字账号全链路整理、空闲提炼与 reflect 不丢失', async (t) => {
  const identity = makeTestIdentity('1481236341', 'qq', { personId: 'p-owner001' })
  const feishuFriend = identity.resolve('feishu', 'ou_friend_abc')
  const wecomFriend = identity.resolve('wecom', 'wc_staff_01')
  const dtFriend = identity.resolve('dingtalk', 'dt_user_02')
  const qbFriend = identity.resolve('qqbot', 'qb_openid_03')

  const day = dayKey(new Date(Date.now() - 2 * DAY_MS))
  const tOld = Date.now() - 3 * 3600_000
  const s = setupStore(t, {
    identity,
    cfgPatch: {
      memory: { keepChatlogDays: 0, keepChatlogSet: true, extractMinLines: 2 },
      platforms: {
        feishu: { enabled: true, selfId: 'cli_feishu_bot_1' },
        wecom: { enabled: true, selfId: 'wecom_bot_1' },
      },
    },
    llmHandler: ({ system, text }) => {
      if (system.includes('整理长期记忆')) {
        if (text.includes('ou_friend_abc')) {
          return {
            facts: [
              { op: 'add', text: '阿飞喜欢喝乌龙茶', about: '阿飞', speaker: 'ou_friend_abc', about_qq: 'ou_friend_abc', status: 'fact', importance: 0.7, tier: 2, said: '12:00' },
              { op: 'add', text: '机器人自己不该被提炼', about: '机器人', speaker: 'cli_feishu_bot_1', about_qq: 'cli_feishu_bot_1', status: 'fact' },
            ],
            people: [{ qq: 'ou_friend_abc', alias: { text: '阿飞', speaker: 'ou_friend_abc', quote: '叫我阿飞就行' } }],
            relations: [{ subj: '阿飞', subj_qq: 'ou_friend_abc', pred: '的同事是', obj: '小李', obj_qq: '', speaker: 'ou_friend_abc', quote: '小李是我同事' }],
          }
        }
        if (text.includes('wc_staff_01')) return { facts: [{ op: 'add', text: '企微同事常用 Go', speaker: 'wc_staff_01', about_qq: 'wc_staff_01' }] }
        if (text.includes('dt_user_02')) return { facts: [{ op: 'add', text: '钉钉同事喜欢滑雪', speaker: 'dt_user_02', about_qq: 'dt_user_02' }] }
        if (text.includes('qb_openid_03')) return { facts: [{ op: 'add', text: 'QQBot 用户在深圳', speaker: 'qb_openid_03', about_qq: 'qb_openid_03' }] }
        return { facts: [] }
      }
      if (system.includes('回顾自己')) return { insights: ['对方说话礼貌'], style: ['句尾常加好滴'] }
      if (system.includes('整理自己的记忆')) return { text: '和阿飞聊了乌龙茶与同事小李。' }
      return '[]'
    },
  })

  s.pushRow(day, { t: tOld, chatId: 'feishu:private:ou_friend_abc', who: '阿飞', uid: 'ou_friend_abc', text: '叫我阿飞就行，我喜欢喝乌龙茶，小李是我同事' })
  s.pushRow(day, { t: tOld + 1000, chatId: 'feishu:private:ou_friend_abc', who: '机器人', uid: 'cli_feishu_bot_1', text: '我是机器人自发言，不能当成阿飞的事实' })
  s.pushRow(day, { t: tOld + 2000, chatId: 'feishu:private:ou_friend_abc', who: 'bot', text: '记下了' })
  s.pushRow(day, { t: tOld + 3000, chatId: 'wecom:private:wc_staff_01', who: '张三', uid: 'wc_staff_01', text: '我平时写 Go' })
  s.pushRow(day, { t: tOld + 4000, chatId: 'wecom:private:wc_staff_01', who: '张三', uid: 'wc_staff_01', text: 'Go 编译很快' })
  s.pushRow(day, { t: tOld + 5000, chatId: 'dingtalk:private:dt_user_02', who: '李四', uid: 'dt_user_02', text: '我冬天喜欢滑雪' })
  s.pushRow(day, { t: tOld + 6000, chatId: 'dingtalk:private:dt_user_02', who: '李四', uid: 'dt_user_02', text: '每年都去崇礼' })
  s.pushRow(day, { t: tOld + 7000, chatId: 'qqbot:private:qb_openid_03', who: '王五', uid: 'qb_openid_03', text: '我在深圳南山' })
  s.pushRow(day, { t: tOld + 8000, chatId: 'qqbot:private:qb_openid_03', who: '王五', uid: 'qb_openid_03', text: '这边天气挺暖和' })

  // 先用 extractIdle（tick）验证带平台前缀规范地址不会再被正则跳过
  await s.mem.tick()

  const items = s.mem.list('')
  assert.ok(items.some((m) => m.text === '阿飞喜欢喝乌龙茶' && m.about === feishuFriend), '飞书非数字账号应入库并映射到 PersonId')
  assert.ok(!items.some((m) => m.text.includes('机器人自己不该被提炼')), '平台 selfId 应被排除出 human 与事实')
  assert.ok(items.some((m) => m.text === '企微同事常用 Go' && m.about === wecomFriend))
  assert.ok(items.some((m) => m.text === '钉钉同事喜欢滑雪' && m.about === dtFriend))
  assert.ok(items.some((m) => m.text === 'QQBot 用户在深圳' && m.about === qbFriend))

  const state = s.readState()
  assert.equal(state.profiles?.[feishuFriend]?.alias, '阿飞', '非数字平台人物印象应正常写入')
  assert.ok(state.relations?.some((r) => r.subjQq === feishuFriend && r.pred === '的同事是' && r.obj === '小李'), '关系应映射成 PersonId')
  assert.ok(state.insights?.[feishuFriend]?.some((x) => x.text === '对方说话礼貌'), '三段式地址 reflect 不应因 split 错位')
  assert.equal(state.reflectedAt?.['feishu:private:ou_friend_abc'] > 0, true)

  // 验证历史天数触发 compressChatlog 时，summarizeChat 与 memoryPlatforms 正常兼容规范多平台地址
  s.cfg.memory.keepChatlogDays = 0
  await s.mem.consolidate()
  const summarizeCall = s.calls.find((c) => c.system.includes('整理自己的记忆'))
  assert.ok(summarizeCall && summarizeCall.text.includes('用户(ou_friend_abc)'), 'summarizeChat 应保留非数字 uid 标签')
  assert.equal(s.mem.gists().some((g) => g.chatId === 'feishu:private:ou_friend_abc'), true)
  assert.deepEqual(memoryPlatforms({ chatId: 'feishu:private:ou_other' }), ['feishu'])
})

test('P0-1：多平台规范群聊 feishu:group:oc_1 的 extractionMask 与规范/裸ID配置兼容', () => {
  const gid = 'oc_multi_group_1'
  const normGroup = `feishu:group:${gid}`
  const rows = [
    { chatId: normGroup, who: '路人', uid: 'ou_stranger', text: '普通闲聊', t: 1000 },
    { chatId: normGroup, who: '同学', uid: 'ou_classmate', text: '提及你了', t: 200_000, direct: true },
  ]
  const relevantMask = Array.from(extractionMask(rows, { memory: { groupExtraction: {} } }, () => 'ou_owner'))
  assert.deepEqual(relevantMask, [0, 1], '多平台群默认仅选相关对话')
  const allByCanon = Array.from(extractionMask(rows, { memory: { groupExtraction: { [normGroup]: 'all' } } }, () => 'ou_owner'))
  const allByBare = Array.from(extractionMask(rows, { memory: { groupExtraction: { [gid]: 'all' } } }, () => 'ou_owner'))
  assert.deepEqual(allByCanon, [1, 1])
  assert.deepEqual(allByBare, [1, 1])
})

test('P1/P2：开启 multiPlatformPrivateSession 时跨平台主人私聊合批提炼、跨平台修订旧事实并保持群与非主人严格隔离', async (t) => {
  const sharedIdentity = {
    owner: () => 'p-owner001',
    isOwner: (p) => p === 'p-owner001',
    isValid: (v) => typeof v === 'string' && (/^p-/.test(v) || /^\d+$/.test(v)),
    lookup: (plat, acc) => {
      if (plat === 'qq' && acc === '1481236341') return 'p-owner001'
      if (plat === 'feishu' && acc === 'ou_owner_fs') return 'p-owner001'
      if (plat === 'feishu' && acc === 'ou_other') return 'p-friend001'
      return null
    },
    accountsOf: (person) => {
      if (person === 'p-owner001') return [{ platform: 'qq', account: '1481236341' }, { platform: 'feishu', account: 'ou_owner_fs' }]
      if (person === 'p-friend001') return [{ platform: 'feishu', account: 'ou_other' }]
      return []
    },
    accountOn: (person, plat) => {
      if (person === 'p-owner001') return plat === 'feishu' ? 'ou_owner_fs' : plat === 'qq' ? '1481236341' : null
      if (person === 'p-friend001' && plat === 'feishu') return 'ou_other'
      return null
    },
  }

  let outId = ''
  const storeCtx = setupStore(t, {
    identity: sharedIdentity,
    cfgPatch: {
      multiPlatformPrivateSession: true,
      ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '1481236341' },
    },
    llmHandler: ({ system, text }) => {
      if (system.includes('整理长期记忆')) {
        if (text.includes('[feishu]') && text.includes('其实我搬到上海住了')) {
          return {
            facts: [
              { op: 'outdated', id: outId, text: '主人现在住在上海', about: '主人', speaker: 'ou_owner_fs', about_qq: 'ou_owner_fs', status: 'fact', tier: 3 },
              { op: 'add', text: '主人下周去北京出差', about: '主人', speaker: '1481236341', about_qq: '1481236341', status: 'fact', tier: 2 },
            ],
          }
        }
        if (text.includes('ou_other')) {
          // 即使非主人或群试图越权修订主人事实，也应被 canRevise 拦截
          return {
            facts: [
              { op: 'outdated', id: outId, text: '越权篡改主人记忆', about: '主人', speaker: 'ou_other', about_qq: 'ou_other', status: 'fact' },
              { op: 'add', text: '朋友小张喜欢跑步', about: '小张', speaker: 'ou_other', about_qq: 'ou_other', status: 'fact' },
            ],
          }
        }
        if (text.includes('群里约定周会')) {
          return {
            facts: [
              { op: 'outdated', id: outId, text: '群里越权篡改主人', about: '主人', speaker: '1481236341', about_qq: '1481236341' },
              { op: 'add', text: '每周五下午开周会', scope: 'group', speaker: 'ou_other' },
            ],
          }
        }
        return { facts: [] }
      }
      if (system.includes('回顾自己')) return { insights: ['主人行程多变'], style: ['常跨平台接续对话'] }
      return '[]'
    },
  })

  // 预置旧平台记忆（刻意用旧数字 about='1481236341' 与 qq:private:1481236341，验证跨平台兼容修订）
  const seeded = storeCtx.mem.add({ text: '主人目前在杭州工作', about: '1481236341', aboutName: '主人', chatId: 'qq:private:1481236341', speaker: '1481236341', status: 'fact', source: 'auto' })
  outId = seeded.id

  const today = dayKey()
  const baseT = Date.now() - 10_000
  storeCtx.pushRow(today, { t: baseT, chatId: 'qq:private:1481236341', who: '主人', uid: '1481236341', text: '下周要去北京出差' })
  storeCtx.pushRow(today, { t: baseT + 500, chatId: 'feishu:private:ou_other', who: '小张', uid: 'ou_other', text: '我喜欢跑步' })
  storeCtx.pushRow(today, { t: baseT + 1000, chatId: 'feishu:group:oc_team', who: '小张', uid: 'ou_other', text: '群里约定周会改周五', direct: true })
  storeCtx.pushRow(today, { t: baseT + 2000, chatId: 'feishu:private:ou_owner_fs', who: '主人', uid: 'ou_owner_fs', text: '其实我搬到上海住了' })

  const b = await storeCtx.mem.backlog()
  const ownerRow = b.chats.find((c) => c.scope === 'owner:p-owner001')
  assert.ok(ownerRow, 'backlog 应把主人多平台私聊聚合成一条')
  assert.equal(ownerRow.id, 'qq:private:1481236341', 'id 必须保持合法 canonical chatId')
  assert.equal(ownerRow.name, '主人 · 多平台私聊')
  assert.deepEqual(ownerRow.sources, ['feishu:private:ou_owner_fs', 'qq:private:1481236341'])
  assert.equal(ownerRow.pending, 2)
  assert.equal(b.chats.filter((c) => c.scope === 'owner:p-owner001').length, 1)

  const res = await storeCtx.mem.consolidate({ includeToday: true })
  assert.equal(res.ok, true)

  const extractCalls = storeCtx.calls.filter((c) => c.system.includes('整理长期记忆'))
  const ownerExtractCalls = extractCalls.filter((c) => c.text.includes('下周要去北京出差') || c.text.includes('其实我搬到上海住了'))
  assert.equal(ownerExtractCalls.length, 1, 'QQ 与飞书主人私聊必须合入同一批次，不拆两批')
  assert.match(ownerExtractCalls[0].text, /\[qq\].*下周要去北京出差/)
  assert.match(ownerExtractCalls[0].text, /\[feishu\].*其实我搬到上海住了/)
  assert.doesNotMatch(ownerExtractCalls[0].text, /群里约定周会|我喜欢跑步/, '主人批次绝不能混入群聊或非主人发言')

  const reflectCalls = storeCtx.calls.filter((c) => c.system.includes('回顾自己') && c.text.includes('上海'))
  assert.equal(reflectCalls.length, 1, '主人多平台私聊同一天 reflect 只执行一次')

  const live = storeCtx.mem.list('').filter((m) => !m.invalidAt)
  const shanghai = live.find((m) => m.text === '主人现在住在上海')
  const beijing = live.find((m) => m.text === '主人下周去北京出差')
  assert.ok(shanghai, '飞书新消息应通过 outdated 更新旧 QQ 事实')
  assert.equal(shanghai.chatId, 'qq:private:1481236341', '新记忆 chatId 必须是合法 canonicalOwnerChatId，不得写 owner:')
  assert.doesNotMatch(shanghai.chatId, /^owner:/)
  assert.deepEqual(shanghai.via, ['qq', 'feishu'])
  assert.ok(beijing)
  assert.deepEqual(beijing.via, ['qq', 'feishu'])
  assert.equal(storeCtx.mem.list('').find((m) => m.id === outId).invalidAt > 0, true, '旧 QQ 事实应被标为过时')
  assert.ok(!live.some((m) => m.text.includes('越权篡改')), '非主人与群聊绝不允许篡改主人记忆')

  // 两端主人私聊 recall 均可见
  assert.ok(storeCtx.mem.recall('上海住哪', { where: 'feishu:private:ou_owner_fs' }).some((h) => h.it.text === '主人现在住在上海'))
  assert.ok(storeCtx.mem.recall('上海住哪', { where: 'qq:private:1481236341' }).some((h) => h.it.text === '主人现在住在上海'))
  assert.ok(!storeCtx.mem.recall('上海', { where: 'feishu:group:oc_team' }).some((h) => h.it.text.includes('上海')), '群聊不能召回主人私聊记忆')
})

test('P1-1 & P1-4：旧 processed.chats 物理行迁移不重复提炼；重启幂等；关闭共享开关时保持独立整理', async (t) => {
  const sharedIdentity = makeTestIdentity('1481236341', 'qq', { personId: 'p-owner001' })
  sharedIdentity.resolve('feishu', 'ou_owner_fs')
  // 让同一个 p-owner001 绑定两账号
  const origLookup = sharedIdentity.lookup
  const id2 = {
    ...sharedIdentity,
    lookup: (p, a) => (p === 'feishu' && a === 'ou_owner_fs') ? 'p-owner001' : origLookup(p, a),
    accountsOf: (p) => p === 'p-owner001'
      ? [{ platform: 'qq', account: '1481236341' }, { platform: 'feishu', account: 'ou_owner_fs' }]
      : sharedIdentity.accountsOf(p),
  }

  const yesterday = dayKey(new Date(Date.now() - DAY_MS))
  const s = setupStore(t, {
    identity: id2,
    cfgPatch: {
      multiPlatformPrivateSession: true,
      ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '1481236341' },
    },
    processed: {
      [yesterday]: {
        offset: 0,
        end: 240,
        chats: { 'qq:private:1481236341': 2, 'feishu:private:ou_owner_fs': 1 },
        idle: [],
      },
    },
  })

  const baseT = Date.now() - DAY_MS
  s.pushRow(yesterday, { t: baseT + 1, chatId: 'qq:private:1481236341', who: '主人', uid: '1481236341', text: '旧QQ-1-已提炼' })
  s.pushRow(yesterday, { t: baseT + 2, chatId: 'feishu:private:ou_owner_fs', who: '主人', uid: 'ou_owner_fs', text: '旧飞书-1-已提炼' })
  s.pushRow(yesterday, { t: baseT + 3, chatId: 'qq:private:1481236341', who: '主人', uid: '1481236341', text: '旧QQ-2-已提炼' })
  s.pushRow(yesterday, { t: baseT + 4, chatId: 'qq:private:1481236341', who: '主人', uid: '1481236341', text: '新QQ-3-待提炼' })
  s.pushRow(yesterday, { t: baseT + 5, chatId: 'feishu:private:ou_owner_fs', who: '主人', uid: 'ou_owner_fs', text: '新飞书-2-待提炼' })

  const beforeState = s.readState()
  const b1 = await s.mem.backlog()
  assert.equal(b1.pending, 2, 'backlog 应跳过旧 chats 游标覆盖的行')
  assert.equal(b1.batches, 1)
  assert.deepEqual(s.readState(), beforeState, '查看 backlog 不应修改持久化状态')

  await s.mem.consolidate()
  const ext1 = s.calls.filter((c) => c.system.includes('整理长期记忆'))
  assert.equal(ext1.length, 1)
  assert.doesNotMatch(ext1[0].text, /旧QQ-1|旧QQ-2|旧飞书-1/, '迁移后绝不重提炼历史前缀行')
  assert.match(ext1[0].text, /新QQ-3-待提炼/)
  assert.match(ext1[0].text, /新飞书-2-待提炼/)

  // 重启 + 再切换开关再重启，都不应重提炼
  s.reopen()
  await s.mem.consolidate()
  assert.equal(s.calls.filter((c) => c.system.includes('整理长期记忆')).length, 1, '重启后不重复提炼')

  s.cfg.multiPlatformPrivateSession = false
  s.reopen()
  await s.mem.consolidate()
  assert.equal(s.calls.filter((c) => c.system.includes('整理长期记忆')).length, 1, '关闭共享开关后也不重复提炼')

  // 验证 multiPlatformPrivateSession: false 时新写入的主人各平台流水分别独立提炼
  const today = dayKey()
  s.pushRow(today, { t: Date.now() - 1000, chatId: 'qq:private:1481236341', who: '主人', uid: '1481236341', text: '关开关QQ消息' })
  s.pushRow(today, { t: Date.now() - 900, chatId: 'feishu:private:ou_owner_fs', who: '主人', uid: 'ou_owner_fs', text: '关开关飞书消息' })
  const bOff = await s.mem.backlog()
  assert.equal(bOff.chats.length, 2, '关闭共享开关时各平台分别显示')
  assert.equal(bOff.chats.some((c) => c.scope), false)
  await s.mem.consolidate({ includeToday: true })
  const extOff = s.calls.filter((c) => c.system.includes('整理长期记忆')).slice(1)
  assert.equal(extOff.length, 2, '关闭共享开关时分两批独立提炼')
})

test('Phase 2：extractIdle 共享范围遵循跨平台共同空闲时间（任一平台刚聊过都不提前拆批）', async (t) => {
  const sharedIdentity = {
    owner: () => 'p-owner001',
    isOwner: (p) => p === 'p-owner001',
    isValid: (v) => typeof v === 'string',
    lookup: (p, a) => ((p === 'qq' && a === '1481') || (p === 'feishu' && a === 'ou_1')) ? 'p-owner001' : null,
    accountsOf: (p) => p === 'p-owner001' ? [{ platform: 'qq', account: '1481' }, { platform: 'feishu', account: 'ou_1' }] : [],
    accountOn: (p, plat) => p === 'p-owner001' ? (plat === 'feishu' ? 'ou_1' : '1481') : null,
  }
  const s = setupStore(t, {
    identity: sharedIdentity,
    cfgPatch: {
      multiPlatformPrivateSession: true,
      ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '1481' },
      memory: { shortTerm: false, extractIdleMinutes: 30, extractMinLines: 4 },
    },
  })
  const today = dayKey()
  const now = Date.now()
  s.pushRow(today, { t: now - 45 * 60_000, chatId: 'qq:private:1481', who: '主人', uid: '1481', text: 'QQ 一' })
  s.pushRow(today, { t: now - 44 * 60_000, chatId: 'qq:private:1481', who: '主人', uid: '1481', text: 'QQ 二' })
  s.pushRow(today, { t: now - 43 * 60_000, chatId: 'qq:private:1481', who: '主人', uid: '1481', text: 'QQ 三' })
  const recentFeishu = { t: now - 5 * 60_000, chatId: 'feishu:private:ou_1', who: '主人', uid: 'ou_1', text: '飞书刚接的话' }
  s.pushRow(today, recentFeishu)

  await s.mem.tick()
  assert.equal(s.calls.length, 0, '虽然 QQ 已安静 43 分钟，但飞书 5 分钟前还在聊，不应提前切段提炼')

  // 等飞书也进入 40 分钟空闲后触发
  recentFeishu.t = now - 40 * 60_000
  await s.mem.tick()
  const ext = s.calls.filter((c) => c.system.includes('整理长期记忆'))
  assert.equal(ext.length, 1, '全部平台都空闲后合批提炼一次')
  assert.match(ext[0].text, /\[qq\].*QQ 一/)
  assert.match(ext[0].text, /\[feishu\].*飞书刚接的话/)
})

test('Phase 3：跨平台日梗概合一、add 去重、合并压缩与「忘掉」防从另一平台流水复活、previewNativeNotes', async (t) => {
  const sharedIdentity = {
    owner: () => 'p-owner001',
    isOwner: (p) => p === 'p-owner001',
    isValid: (v) => typeof v === 'string',
    lookup: (p, a) => ((p === 'qq' && a === '1481') || (p === 'feishu' && a === 'ou_1')) ? 'p-owner001' : (p === 'feishu' && a === 'ou_2') ? 'p-other' : null,
    accountsOf: (p) => p === 'p-owner001' ? [{ platform: 'qq', account: '1481' }, { platform: 'feishu', account: 'ou_1' }] : [],
    accountOn: (p, plat) => p === 'p-owner001' ? (plat === 'feishu' ? 'ou_1' : '1481') : null,
  }
  const s = setupStore(t, {
    identity: sharedIdentity,
    cfgPatch: {
      multiPlatformPrivateSession: true,
      ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '1481' },
      memory: { keepChatlogDays: 0, keepChatlogSet: true, mergeGroups: true, compress: true, compressAfterDays: 7 },
    },
    llmHandler: ({ system, text }) => {
      if (system.includes('整理长期记忆')) {
        if (text.includes('黑凤梨')) return { facts: [{ op: 'add', text: '主人喜欢黑凤梨', about: '主人', speaker: '1481', about_qq: '1481' }] }
        return { facts: [] }
      }
      if (system.includes('整理自己的记忆')) return { text: '今天和主人聊了旅行和摄影安排。' }
      if (system.includes('同一件事')) {
        const ids = [...text.matchAll(/#([a-z0-9-]+)/gi)].map((m) => m[1])
        return ids.length >= 2 ? { merges: [{ ids: ids.slice(0, 2), text: '主人喜欢凌晨写代码并喝黑咖啡' }] } : { merges: [] }
      }
      if (system.includes('概括成 1~2 句')) return { text: '主人习惯在深夜专注编程，生活节奏很有规律。' }
      return '[]'
    },
  })

  // 1. add() 跨平台去重
  const a1 = s.mem.add({ text: '主人每天早起都会冲一杯手冲黑咖啡', about: '1481', chatId: 'qq:private:1481', speaker: '1481', source: 'tool' })
  const a2 = s.mem.add({ text: '主人每天早起都会冲一杯手冲黑咖啡', about: 'p-owner001', chatId: 'feishu:private:ou_1', speaker: 'p-owner001', source: 'tool', via: 'feishu' })
  assert.ok(a1.id)
  assert.equal(a2.updated, a1.id, '跨平台同义主人事实应当去重更新而不是新增')

  // 2. previewNativeNotes 跨平台兼容
  const preview = s.mem[NATIVE_MEMORY_VIEW]('feishu:private:ou_1')
  assert.ok(preview && preview.items.some((it) => it.id === a1.id), '从飞书侧 previewNativeNotes 也能看到归属主人的笔记')

  // 3. 「忘掉」同步标记 QQ 与飞书流水，阻止下次整理从 QQ 旧流水复活
  const today = dayKey()
  s.pushRow(today, { t: Date.now() - 2000, chatId: 'qq:private:1481', who: '主人', uid: '1481', text: '我特别爱吃黑凤梨' })
  s.pushRow(today, { t: Date.now() - 1000, chatId: 'feishu:private:ou_1', who: '主人', uid: 'ou_1', text: '黑凤梨真的很甜' })
  const forgotRes = s.mem.handleCommand({ kind: 'private', platform: 'feishu', chatId: 'feishu:private:ou_1', userId: 'ou_1' }, '忘掉 黑凤梨')
  assert.equal(forgotRes.ok, true)
  assert.equal(forgotRes.marked, 2, '飞书发出忘掉指令后应同步标记 QQ 与飞书流水')
  await s.mem.consolidate({ includeToday: true })
  assert.equal(s.mem.list('').filter((m) => m.text.includes('黑凤梨')).length, 0, '跨平台标忘后再次整理不得复活已忘事实')

  // 4. compressChatlog 当日合集日梗概 + 两端 recall
  const oldDay = dayKey(new Date(Date.now() - 3 * DAY_MS))
  const t3 = Date.now() - 3 * DAY_MS
  s.pushRow(oldDay, { t: t3, chatId: 'qq:private:1481', who: '主人', uid: '1481', text: '周末计划去旅行' })
  s.pushRow(oldDay, { t: t3 + 1000, chatId: 'feishu:private:ou_1', who: '主人', uid: 'ou_1', text: '记得带相机拍风景' })
  await s.mem.consolidate()
  assert.equal(s.mem.gists().length, 1, '主人 QQ+飞书同一天应只生成 1 条日梗概')
  assert.deepEqual(s.mem.gists()[0].via, ['qq', 'feishu'])
  assert.ok(s.mem.recall('旅行摄影', { where: 'feishu:private:ou_1' }).some((h) => h.it.kind === 'gist' && h.it.text.includes('旅行和摄影')))
  assert.ok(s.mem.recall('旅行摄影', { where: 'qq:private:1481' }).some((h) => h.it.kind === 'gist' && h.it.text.includes('旅行和摄影')))

  // 5. mergeGroups 与 compressionClusters 跨平台合簇且不混入群/非主人
  const old20 = Date.now() - 20 * DAY_MS
  for (const [cid, abt, txt] of [
    ['qq:private:1481', '1481', '主人经常熬夜调试代码'],
    ['qq:private:1481', '1481', '主人夜间常喝一杯美式咖啡'],
    ['feishu:private:ou_1', 'p-owner001', '主人习惯深夜看技术文档'],
    ['feishu:private:ou_1', 'p-owner001', '主人夜里会写自动化脚本'],
  ]) {
    s.mem.add({ text: txt, about: abt, chatId: cid, speaker: abt, source: 'auto', importance: 0.4, saidAt: old20 })
  }
  s.mem.add({ text: '群里大家喜欢吃火锅', scope: 'group', chatId: 'feishu:group:oc_team', source: 'auto', importance: 0.4, saidAt: old20 })
  const mg = await s.mem.mergeGroups()
  assert.equal(mg.merged, 1, '跨平台主人低权重事实应合并到同一组并掉重复条目')
  await s.mem.consolidate({ includeToday: true })
  const clusters = compressionClusters([
    { id: 'c1', text: '事件一', about: '1481', source: 'auto', chatId: 'qq:private:1481', saidAt: old20, at: old20 },
    { id: 'c2', text: '事件二', about: '1481', source: 'auto', chatId: 'qq:private:1481', saidAt: old20, at: old20 },
    { id: 'c3', text: '事件三', about: 'p-owner001', source: 'auto', chatId: 'feishu:private:ou_1', saidAt: old20, at: old20 },
    { id: 'c4', text: '事件四', about: 'p-owner001', source: 'auto', chatId: 'feishu:private:ou_1', saidAt: old20, at: old20 },
    { id: 'g1', text: '群事件', scope: 'group', about: '', source: 'auto', chatId: 'feishu:group:oc_team', saidAt: old20, at: old20 },
  ], { now: Date.now(), afterDays: 7, ownerCluster: { matches: (m) => m.scope !== 'group' && m.chatId !== 'feishu:group:oc_team', chatId: 'qq:private:1481', about: 'p-owner001' } })
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].ids.length, 4)
  assert.ok(!clusters[0].ids.includes('g1'), '群记忆绝不能混入主人压缩簇')
})

test('契约与 UI：memory.js / memory-rules.js 不硬编码平台名；Backlog 组件隐藏 owner 前缀且支持规范三段式地址', () => {
  const memSrc = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  const rulesSrc = readFileSync(new URL('../src/features/memory-rules.js', import.meta.url), 'utf8')
  assert.equal(/\bsourceLabelOf\b/.test(memSrc), false, '禁止在 memory.js 硬编码平台中文名映射函数')
  assert.equal(/['"](?:feishu|wecom|dingtalk|wechat-clawbot|qqbot|onebot|snowluma)['"]/.test(memSrc), false)
  assert.equal(/['"](?:qq|feishu|wecom|dingtalk|wechat-clawbot|qqbot|onebot|snowluma)['"]/.test(rulesSrc), false)

  // 用与 panel-stage2.test.js 相同的 vm 沙箱渲染真实 MemoryBacklog 组件
  const clientSrc = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = '    exports.apply = apply'
  let hook = 0
  let fetched = {
    ok: true,
    total: 40,
    pending: 33,
    outOfScope: 0,
    oldest: '2026-11-26',
    used: 1,
    limit: 24,
    at: Date.now(),
    chats: [
      { id: 'qq:private:1481236341', scope: 'owner:p-owner001', name: '主人 · 多平台私聊', sources: ['feishu:private:ou_owner', 'qq:private:1481236341'], pending: 31 },
      { id: 'feishu:group:oc_123', name: 'feishu:group:oc_123', pending: 2 },
    ],
  }
  let currentData = null
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'fragment',
    Component: class {},
    useState: (init) => {
      const idx = hook++
      if (idx === 0) return [currentData, (v) => { currentData = v }]
      if (idx === 1) return ['', () => {}]
      return [false, () => {}]
    },
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const env = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ json: async () => fetched }),
    window: { __ModuleLoader__: { load(value) { env.loader = value } } },
    setTimeout, clearTimeout, setInterval, clearInterval, URL,
  }
  new Script(
    clientSrc.replace(marker, '    exports.panelTest = { MemoryBacklog }\n' + marker),
    { filename: 'client/client.js' },
  ).runInNewContext(env)
  assert.ok(env.loader, 'client.js 应通过 ModuleLoader 注册')
  const { MemoryBacklog } = env.loader.factory(() => React).panelTest

  const expand = (node) => {
    if (node == null || typeof node === 'boolean') return []
    if (typeof node === 'string' || typeof node === 'number') return [String(node)]
    if (Array.isArray(node)) return node.flatMap(expand)
    if (typeof node.type === 'function') {
      const kids = [].concat(node.children ?? []).filter((c) => c !== undefined)
      const merged = Object.assign({}, node.props, kids.length || !node.props?.children ? { children: kids.length ? kids : node.props?.children } : {})
      return expand(node.type(merged))
    }
    return [node.children, node.props?.children].flatMap(expand)
  }
  // 模拟点「查看待整理流水」
  hook = 0
  const initialTree = MemoryBacklog()
  const btn = (function findBtn(n) {
    if (!n || typeof n !== 'object') return null
    if (Array.isArray(n)) { for (const x of n) { const hit = findBtn(x); if (hit) return hit } return null }
    if (typeof n.props?.onClick === 'function') return n
    return findBtn([n.children, n.props?.children])
  })(initialTree)
  assert.ok(btn)
  // 直接触发刷新并重渲染
  currentData = fetched
  hook = 0
  const rendered = expand(MemoryBacklog()).join(' ')
  assert.match(rendered, /主人 · 多平台私聊/)
  assert.match(rendered, /飞书 \/ QQ/)
  assert.doesNotMatch(rendered, /owner:p-owner001/, '界面不得暴露内部 owner: 前缀')
  assert.match(rendered, /群 飞书 oc_123/)
})

test('§9.3 只读审计 auditShared：零写盘零模型调用，准确报告来源分布、更新候选、合并/压缩清单且群隔离', async (t) => {
  const sharedIdentity = {
    owner: () => 'p-owner001',
    isOwner: (p) => p === 'p-owner001',
    isValid: (v) => typeof v === 'string',
    lookup: (p, a) => ((p === 'qq' && a === '1481') || (p === 'feishu' && a === 'ou_1')) ? 'p-owner001' : (p === 'feishu' && a === 'ou_2') ? 'p-other' : null,
    accountsOf: (p) => p === 'p-owner001' ? [{ platform: 'qq', account: '1481' }, { platform: 'feishu', account: 'ou_1' }] : [],
    accountOn: (p, plat) => p === 'p-owner001' ? (plat === 'feishu' ? 'ou_1' : '1481') : null,
  }
  const s = setupStore(t, {
    identity: sharedIdentity,
    cfgPatch: {
      multiPlatformPrivateSession: true,
      ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '1481' },
      memory: { mergeGroups: true, compress: true, compressAfterDays: 7 },
    },
  })

  const old20 = Date.now() - 20 * DAY_MS
  const softA = s.mem.add({ text: '主人周末去公园散步', about: '1481', chatId: 'qq:private:1481', speaker: '1481', source: 'auto', importance: 0.4, saidAt: old20 })
  const softB = s.mem.add({ text: '主人晚饭后常去滨江走路', about: '1481', chatId: 'qq:private:1481', speaker: '1481', source: 'auto', importance: 0.4, saidAt: old20 })
  const softC = s.mem.add({ text: '主人最近在学羽毛球', about: 'p-owner001', chatId: 'feishu:private:ou_1', speaker: 'p-owner001', source: 'auto', importance: 0.4, saidAt: old20 })
  const softD = s.mem.add({ text: '主人每周六上午打球', about: 'p-owner001', chatId: 'feishu:private:ou_1', speaker: 'p-owner001', source: 'auto', importance: 0.4, saidAt: old20 })
  // 永久记忆（tier: 0）与高重要度（>= 0.85）绝不进入 plannedMerges / plannedCompressions
  const perm = s.mem.add({ text: '主人约定每年纪念日一起吃蛋糕', about: 'p-owner001', chatId: 'qq:private:1481', speaker: '1481', source: 'auto', importance: 0.9, tier: 0, saidAt: old20 })
  // 群聊和非主人绝对不能混入主人范围
  const grp = s.mem.add({ text: '群里每天晚上玩游戏', scope: 'group', chatId: 'feishu:group:oc_team', source: 'auto', importance: 0.4, saidAt: old20 })
  const friend = s.mem.add({ text: '小张喜欢骑行', about: 'p-other', chatId: 'feishu:private:ou_2', speaker: 'ou_2', source: 'auto', importance: 0.4, saidAt: old20 })

  const today = dayKey()
  s.pushRow(today, { t: Date.now() - 2000, chatId: 'qq:private:1481', who: '主人', uid: '1481', text: '今天在QQ上聊天' })
  s.pushRow(today, { t: Date.now() - 1000, chatId: 'feishu:private:ou_1', who: '主人', uid: 'ou_1', text: '刚才切飞书了' })

  const stateBefore = s.readState()
  const callsBefore = s.calls.length
  const audit = await s.mem.auditShared()

  assert.deepEqual(s.readState(), stateBefore, 'auditShared 必须严格只读，不得修改 rev 或落盘状态')
  assert.equal(s.calls.length, callsBefore, 'auditShared 不得触发任何模型调用')
  assert.equal(audit.sharedEnabled, true)
  assert.equal(audit.canonicalChatId, 'qq:private:1481')
  assert.equal(audit.backfill.autoEnabled, false)
  assert.equal(audit.platformStats.find((p) => p.platform === 'qq')?.episodes, 1)
  assert.equal(audit.platformStats.find((p) => p.platform === 'feishu')?.episodes, 1)

  // 规范多平台 chatId 不得退化成 unknown
  assert.equal(audit.factsByPlatform.some((p) => p.platform === 'unknown'), false, '规范地址记忆不得计为 unknown')
  assert.equal(audit.factsByPlatform.find((p) => p.platform === 'qq')?.live, 3)
  assert.equal(audit.factsByPlatform.find((p) => p.platform === 'feishu')?.live, 4)

  // 更新候选仅包含主人私聊且排除群和非主人
  const candIds = new Set(audit.candidateUpdates.items.map((x) => x.id))
  assert.equal(audit.candidateUpdates.total, 5)
  assert.ok(candIds.has(softA.id) && candIds.has(softC.id) && candIds.has(perm.id))
  assert.ok(!candIds.has(grp.id) && !candIds.has(friend.id), '群聊和非主人事实不得进入主人更新候选')

  // plannedMerges 与 plannedCompressions 准确包含跨平台低权重主人簇，不含永久记忆和群记忆
  assert.equal(audit.plannedMerges.ownerGroups, 1)
  assert.equal(audit.plannedMerges.groupLeakCount, 0)
  const mgIds = new Set(audit.plannedMerges.groups[0].items.map((x) => x.id))
  assert.deepEqual([...mgIds].sort(), [softA.id, softB.id, softC.id, softD.id].sort())
  assert.ok(!mgIds.has(perm.id) && !mgIds.has(grp.id))

  assert.equal(audit.plannedCompressions.ownerClusters, 1)
  assert.equal(audit.plannedCompressions.groupLeakCount, 0)
  const cmpIds = new Set(audit.plannedCompressions.clusters[0].items.map((x) => x.id))
  assert.deepEqual([...cmpIds].sort(), [softA.id, softB.id, softC.id, softD.id].sort())
  assert.ok(!cmpIds.has(perm.id) && !cmpIds.has(grp.id))
})

test('只读审计分批统计平台流水，扫描期间收到消息则丢弃旧审计结果', async (t) => {
  const s = setupStore(t)
  const today = dayKey()
  const row = { t: Date.now(), chatId: 'qq:private:1481236341', who: '主人', uid: '1481236341', text: '测试消息' }
  for (let i = 0; i < 80; i++) s.pushRow(today, { ...row })
  const read = s.hub.chatLogOf
  let reads = 0
  t.mock.method(s.hub, 'chatLogOf', day => {
    const rows = read(day)
    if (++reads === 2) setImmediate(() => s.pushRow(today, { ...row }))
    return rows
  })
  assert.equal(await s.mem.auditShared(), null, '统计期间流水发生变化时不返回混合快照')
  const audit = await s.mem.auditShared()
  assert.equal(audit.platformStats.find((p) => p.platform === 'qq')?.episodes, 81)
})

test('审阅意见 P1：主人多平台私聊中「关于朋友」的事实独立成簇压缩，与主人簇及群/非主人严格隔离', async (t) => {
  const sharedIdentity = {
    owner: () => 'p-owner001',
    isOwner: (p) => p === 'p-owner001',
    isValid: (v) => typeof v === 'string' && (/^p-/.test(v) || /^\d+$/.test(v)),
    lookup: (p, a) => ((p === 'qq' && a === '1481') || (p === 'feishu' && a === 'ou_1')) ? 'p-owner001' : (p === 'feishu' && a === 'ou_2') ? 'p-friend001' : null,
    accountsOf: (p) => p === 'p-owner001' ? [{ platform: 'qq', account: '1481' }, { platform: 'feishu', account: 'ou_1' }] : (p === 'p-friend001' ? [{ platform: 'feishu', account: 'ou_2' }] : []),
    accountOn: (p, plat) => p === 'p-owner001' ? (plat === 'feishu' ? 'ou_1' : '1481') : null,
  }
  let compressPromptCount = 0
  const s = setupStore(t, {
    identity: sharedIdentity,
    cfgPatch: {
      multiPlatformPrivateSession: true,
      ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '1481' },
      memory: { compress: true, compressAfterDays: 7, mergeGroups: true },
    },
    llmHandler: ({ system, text }) => {
      if (system.includes('概括成 1~2 句')) {
        compressPromptCount++
        if (text.includes('张三')) return { text: '主人经常在聊天里提起好朋友张三很靠谱，俩人平时常一起打球吃宵夜。' }
        return { text: '主人平时喜欢早睡早起喝手冲咖啡，周末爱去公园散步放风。' }
      }
      return '[]'
    },
  })

  const old20 = Date.now() - 20 * DAY_MS
  // 主人在 QQ 和飞书私聊里分别提起的「关于张三」的 4 条低权重旧事实
  const f1 = s.mem.add({ text: '张三上周请主人吃了一顿火锅', about: 'p-friend001', aboutName: '张三', chatId: 'qq:private:1481', speaker: '1481', source: 'auto', importance: 0.4, saidAt: old20 })
  const f2 = s.mem.add({ text: '张三周末陪主人去羽毛球馆打球', about: 'p-friend001', aboutName: '张三', chatId: 'qq:private:1481', speaker: '1481', source: 'auto', importance: 0.4, saidAt: old20 })
  const f3 = s.mem.add({ text: '张三新买了一把尤尼克斯球拍', about: 'p-friend001', aboutName: '张三', chatId: 'feishu:private:ou_1', speaker: 'p-owner001', source: 'auto', importance: 0.4, saidAt: old20 })
  const f4 = s.mem.add({ text: '张三最近晚上常和主人约宵夜', about: 'p-friend001', aboutName: '张三', chatId: 'feishu:private:ou_1', speaker: 'p-owner001', source: 'auto', importance: 0.4, saidAt: old20 })

  // 主人自己的 4 条低权重旧事实（混有旧数字 about='1481' 与 p-owner001）
  const o1 = s.mem.add({ text: '主人周末喜欢去西湖边散步', about: '1481', aboutName: '主人', chatId: 'qq:private:1481', speaker: '1481', source: 'auto', importance: 0.4, saidAt: old20 })
  const o2 = s.mem.add({ text: '主人每天早上习惯喝黑咖啡', about: '1481', aboutName: '主人', chatId: 'qq:private:1481', speaker: '1481', source: 'auto', importance: 0.4, saidAt: old20 })
  const o3 = s.mem.add({ text: '主人最近坚持十一点前睡觉', about: 'p-owner001', aboutName: '主人', chatId: 'feishu:private:ou_1', speaker: 'p-owner001', source: 'auto', importance: 0.4, saidAt: old20 })
  const o4 = s.mem.add({ text: '主人周日会在家看一部老电影', about: 'p-owner001', aboutName: '主人', chatId: 'feishu:private:ou_1', speaker: 'p-owner001', source: 'auto', importance: 0.4, saidAt: old20 })

  // 群聊与张三本人非主人私聊中的事实（不得混入任何 owner 压缩簇）
  const g1 = s.mem.add({ text: '张三在群里组织周六桌游局', scope: 'group', chatId: 'feishu:group:oc_team', about: '', source: 'auto', importance: 0.4, saidAt: old20 })
  const nonOwner = s.mem.add({ text: '张三自己说过最讨厌下雨天打车', about: 'p-friend001', aboutName: '张三', chatId: 'feishu:private:ou_2', speaker: 'ou_2', source: 'auto', importance: 0.4, saidAt: old20 })

  const audit = await s.mem.auditShared()
  assert.equal(audit.plannedCompressions.ownerClusters, 2, '主人与张三应分别进入各自的 owner 压缩簇')
  assert.equal(audit.plannedCompressions.groupLeakCount, 0)
  const friendCluster = audit.plannedCompressions.clusters.find((c) => c.about === 'p-friend001')
  const ownerCluster = audit.plannedCompressions.clusters.find((c) => c.about === 'p-owner001')
  assert.ok(friendCluster && ownerCluster, '主人簇与朋友簇必须同时存在且不合并成空 about')
  assert.equal(friendCluster.chatId, 'qq:private:1481')
  assert.deepEqual(friendCluster.items.map((x) => x.id).sort(), [f1.id, f2.id, f3.id, f4.id].sort())
  assert.deepEqual(ownerCluster.items.map((x) => x.id).sort(), [o1.id, o2.id, o3.id, o4.id].sort())
  assert.ok(!friendCluster.items.some((x) => x.id === g1.id || x.id === nonOwner.id), '群聊和非主人私聊不得混入主人侧朋友压缩簇')

  const cr = await s.mem.compressDetails({ maxCalls: 4 })
  assert.equal(compressPromptCount, 2)
  assert.equal(cr.created, 2)

  const live = s.mem.list('').filter((m) => !m.invalidAt)
  const friendAbs = live.find((m) => m.source === 'abstract' && m.about === 'p-friend001')
  const ownerAbs = live.find((m) => m.source === 'abstract' && m.about === 'p-owner001')
  assert.ok(friendAbs && friendAbs.chatId === 'qq:private:1481')
  assert.ok(ownerAbs && ownerAbs.chatId === 'qq:private:1481')
  assert.equal(live.some((m) => m.id === g1.id), true, '群记忆未被误压缩')
  assert.equal(live.some((m) => m.id === nonOwner.id), true, '非主人私聊记忆未被误压缩')

  // 两端主人私聊都可召回该长期印象，非主人私聊绝不可召回
  assert.ok(s.mem.recall('张三 靠谱 宵夜', { where: 'feishu:private:ou_1' }).some((h) => h.it.id === friendAbs.id))
  assert.ok(s.mem.recall('张三 靠谱 宵夜', { where: 'qq:private:1481' }).some((h) => h.it.id === friendAbs.id))
  assert.equal(s.mem.recall('张三 靠谱 宵夜', { where: 'feishu:private:ou_2' }).some((h) => h.it.id === friendAbs.id), false, '主人侧对朋友的长期印象不得泄漏到非主人私聊')
  assert.equal(s.mem.recall('张三 靠谱 宵夜', { where: 'feishu:group:oc_team' }).some((h) => h.it.id === friendAbs.id), false, '主人侧对朋友的长期印象不得泄漏到群聊')
})

test('审阅意见 P2：安全优先拦截未在本批出现的陌生非数字 about_qq 与短数字噪音，绝不回退默认对象', async (t) => {
  const identity = makeTestIdentity('1481236341', 'qq', { personId: 'p-owner001' })
  const validFriend = identity.resolve('feishu', 'ou_friend_present')
  const day = dayKey()
  const s = setupStore(t, {
    identity,
    llmHandler: ({ system }) => {
      if (system.includes('整理长期记忆')) {
        return {
          facts: [
            { op: 'add', text: '陌生非数字账号幻觉事实', about: '路人', speaker: 'ou_friend_present', about_qq: 'ou_unseen_stranger', status: 'fact' },
            { op: 'add', text: '短数字编号幻觉事实', about: '路人', speaker: 'ou_friend_present', about_qq: '123', status: 'fact' },
            { op: 'add', text: '本批在场好友合法事实', about: '在场友', speaker: 'ou_friend_present', about_qq: 'ou_friend_present', status: 'fact' },
          ],
        }
      }
      return '[]'
    },
  })

  s.pushRow(day, { t: Date.now() - 2000, chatId: 'feishu:private:ou_friend_present', who: '在场友', uid: 'ou_friend_present', text: '今天天气真不错' })
  await s.mem.consolidate({ includeToday: true })

  const items = s.mem.list('')
  assert.equal(items.some((m) => m.text.includes('陌生非数字账号幻觉事实')), false, '未在本批出现的陌生非数字 about_qq 必须直接丢弃')
  assert.equal(items.some((m) => m.text.includes('短数字编号幻觉事实')), false, '未在目录且不足 5 位的数字 about_qq 必须直接丢弃')
  assert.equal(items.some((m) => m.text === '本批在场好友合法事实' && m.about === validFriend), true)
})
