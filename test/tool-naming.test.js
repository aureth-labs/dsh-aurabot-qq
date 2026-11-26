// 多平台工具命名规范与别名门禁测试（T3 收口：全内置模块与 group-admin 严格执行，无临时迁移白名单）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILTINS } from '../src/modules/index.js'
import { createModules } from '../src/core/modules.js'
import { createGateway } from '../src/gateway/index.js'
import { normalize } from '../src/core/config.js'
import { moduleOfTool } from '../src/core/usage.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { makeFakeAdapter } from './helpers/fake-adapter.js'
import { makeIdentity } from './gateway/helpers.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/
const PLATFORM_PREFIX_RE = /^(qq|feishu|qqbot|dingtalk|wecom)_/
const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }

assert.ok(BUILTINS.some((m) => m.id === 'group-admin'), 'group-admin 应已加入 BUILTINS')
const ALL_MODS = BUILTINS

/**
 * 跨平台模块里按平台显式门控的平台专属动作白名单：
 * 仅在对应平台（且满足能力）下挂载，严禁出现在其他平台工具面。
 */
const PLATFORM_GATED_IN_SHARED = new Map([
  ['qq_import_stickers', { moduleId: 'stickers', platform: 'qq' }],
])

const MODULE_FILES = new Map([
  ['stickers', 'src/modules/stickers/index.js'],
  ['voice', 'src/modules/voice/index.js'],
  ['mood', 'src/modules/mood/index.js'],
  ['memory', 'src/modules/memory/index.js'],
  ['chat-tools', 'src/modules/chat-tools/index.js'],
  ['qq-tools', 'src/modules/qq-tools/index.js'],
  ['qq-api', 'src/modules/qq-api/index.js'],
  ['imagegen', 'src/modules/imagegen/index.js'],
  ['diary', 'src/modules/diary/index.js'],
  ['qzone-social', 'src/modules/qzone-social/index.js'],
  ['purpose', 'src/modules/purpose/index.js'],
  ['autotelic', 'src/modules/autotelic/index.js'],
  ['bili', 'src/modules/bili/index.js'],
  ['song', 'src/modules/song/index.js'],
  ['profile', 'src/modules/profile/index.js'],
  ['contacts', 'src/modules/contacts/index.js'],
  ['video', 'src/modules/video/index.js'],
  ['group-admin', 'src/modules/group-admin/index.js'],
  ['image-recovery', 'src/modules/image-recovery/index.js'],
])

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof', 'in', 'instanceof', 'new', 'else', 'do', 'yield', 'await', 'of',
])

function skipWsAndComments(src, i) {
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue }
    if (src[i] === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i + 2)
      i = nl === -1 ? src.length : nl + 1
      continue
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    break
  }
  return i
}

function skipQuotedRange(src, start) {
  const quote = src[start]
  let i = start + 1
  let value = ''
  while (i < src.length) {
    const c = src[i]
    if (c === '\\' && i + 1 < src.length) {
      value += src[i + 1]
      i += 2
      continue
    }
    if (c === quote) return { next: i + 1, value }
    value += c
    i++
  }
  return { next: i, value }
}

function skipRegexRange(src, start) {
  let i = start + 1
  let inClass = false
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (c === '[' && !inClass) { inClass = true; i++; continue }
    if (c === ']' && inClass) { inClass = false; i++; continue }
    if (c === '/' && !inClass) {
      i++
      while (i < src.length && /[a-z]/i.test(src[i])) i++
      return i
    }
    if (c === '\n' || c === '\r') return start + 1
    i++
  }
  return i
}

function skipCodeToken(src, i, canRegex) {
  const ch = src[i]
  if (/\s/.test(ch)) return { next: i + 1, canRegex, kind: 'ws' }
  if (ch === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i + 2)
    return { next: nl === -1 ? src.length : nl + 1, canRegex, kind: 'comment' }
  }
  if (ch === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2)
    return { next: end === -1 ? src.length : end + 2, canRegex, kind: 'comment' }
  }
  if (ch === '/' && canRegex) return { next: skipRegexRange(src, i), canRegex: false, kind: 'regex' }
  if (ch === '\'' || ch === '"') {
    const q = skipQuotedRange(src, i)
    return { next: q.next, canRegex: false, kind: 'string', value: q.value }
  }
  if (ch === '`') {
    let p = i + 1
    while (p < src.length) {
      if (src[p] === '\\') { p += 2; continue }
      if (src[p] === '`') return { next: p + 1, canRegex: false, kind: 'template' }
      if (src[p] === '$' && src[p + 1] === '{') {
        p = skipBracedBlock(src, p + 2)
        continue
      }
      p++
    }
    return { next: p, canRegex: false, kind: 'template' }
  }
  return null
}

function skipBracedBlock(src, startAfterOpen) {
  let depth = 1
  let i = startAfterOpen
  let canRegex = true
  while (i < src.length && depth > 0) {
    const skipped = skipCodeToken(src, i, canRegex)
    if (skipped) {
      i = skipped.next
      canRegex = skipped.canRegex
      continue
    }
    const ch = src[i]
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++
      canRegex = REGEX_PRECEDING_KEYWORDS.has(src.slice(i, j))
      i = j
      continue
    }
    if (ch === '{') { depth++; canRegex = true; i++; continue }
    if (ch === '}') { depth--; canRegex = false; i++; continue }
    canRegex = '([,;:=!&|^~+-*%<>?'.includes(ch)
    i++
  }
  return i
}

/**
 * 平衡括号词法扫描器：从源码中提取所有 `defineTool({ ... })` 顶层属性 `name`。
 * 跳过注释、字符串、模板字面量、正则与嵌套属性对象，不依赖固定字符窗口长度。
 */
export function extractDefinedToolNamesFromSource(src) {
  const names = []
  let i = 0
  let canRegex = true
  while (i < src.length) {
    const skipped = skipCodeToken(src, i, canRegex)
    if (skipped) {
      i = skipped.next
      canRegex = skipped.canRegex
      continue
    }
    if (/[A-Za-z_$]/.test(src[i])) {
      let j = i + 1
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++
      const word = src.slice(i, j)
      if (word === 'defineTool') {
        const parenIdx = skipWsAndComments(src, j)
        if (src[parenIdx] === '(') {
          const braceIdx = skipWsAndComments(src, parenIdx + 1)
          if (src[braceIdx] === '{') {
            let depth = 1
            let p = braceIdx + 1
            let expectKey = true
            let innerCanRegex = true
            let extracted = false
            while (p < src.length && depth > 0) {
              const s = skipCodeToken(src, p, innerCanRegex)
              if (s) {
                p = s.next
                innerCanRegex = s.canRegex
                continue
              }
              const ch = src[p]
              if (depth === 1 && expectKey && /[A-Za-z_$]/.test(ch)) {
                let k = p + 1
                while (k < src.length && /[A-Za-z0-9_$]/.test(src[k])) k++
                const key = src.slice(p, k)
                const colonIdx = skipWsAndComments(src, k)
                if (src[colonIdx] === ':') {
                  if (key === 'name' && !extracted) {
                    const valIdx = skipWsAndComments(src, colonIdx + 1)
                    if (src[valIdx] === '\'' || src[valIdx] === '"') {
                      const q = skipQuotedRange(src, valIdx)
                      names.push(q.value)
                      extracted = true
                      p = q.next
                      expectKey = false
                      innerCanRegex = false
                      continue
                    }
                  }
                  p = colonIdx + 1
                  expectKey = false
                  innerCanRegex = true
                  continue
                }
                p = k
                if (REGEX_PRECEDING_KEYWORDS.has(key)) innerCanRegex = true
                else innerCanRegex = false
                continue
              }
              if (/[A-Za-z_$]/.test(ch)) {
                let k = p + 1
                while (k < src.length && /[A-Za-z0-9_$]/.test(src[k])) k++
                innerCanRegex = REGEX_PRECEDING_KEYWORDS.has(src.slice(p, k))
                p = k
                continue
              }
              if (ch === '{') {
                depth++
                if (depth === 2) expectKey = false
                innerCanRegex = true
                p++
                continue
              }
              if (ch === '}') {
                depth--
                innerCanRegex = false
                p++
                continue
              }
              if (depth === 1 && ch === ',') expectKey = true
              else if (depth === 1 && !/\s/.test(ch)) expectKey = false
              innerCanRegex = '([,;:=!&|^~+-*%<>?'.includes(ch)
              p++
            }
            i = p
            canRegex = false
            continue
          }
        }
      }
      canRegex = REGEX_PRECEDING_KEYWORDS.has(word)
      i = j
      continue
    }
    canRegex = '([,;:=!&|^~+-*%<>?'.includes(src[i])
    i++
  }
  return names
}

function extractDefinedToolNames(relPath) {
  return extractDefinedToolNamesFromSource(readFileSync(join(ROOT, relPath), 'utf8'))
}

function makeFullHarness(t, { builtins = ALL_MODS, platforms = null, adapters = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-tool-naming-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  const prevGlobal = globalThis.aurabot
  process.env.AURABOT_DATA_DIR = dir

  const platCfg = platforms || {
    qq: { enabled: true },
    feishu: { enabled: true },
    qqbot: { enabled: true },
  }
  const gw = createGateway({
    config: { platforms: platCfg },
    dataDir: (...p) => join(dir, 'gw', ...p),
    http: { route: () => () => {} },
    identity: makeIdentity({
      qq: ['10000001'],
      feishu: ['ou_owner'],
      qqbot: ['openid_owner'],
    }),
    log: noopLog,
    replyHoldMs: 20,
  })
  const specs = adapters || [
    { id: 'qq', platform: 'qq', caps: { image: true, voice: true, file: true, history: true, forward: true, proactive: 'full', nativeApi: true } },
    { id: 'feishu', platform: 'feishu', caps: { image: true, voice: true, file: true, history: true, forward: false, proactive: 'full' } },
    { id: 'qqbot', platform: 'qqbot', caps: { image: true, voice: false, file: false, history: false, forward: false, proactive: 'none', groupAdmin: true } },
  ]
  for (const s of specs) gw.register(() => makeFakeAdapter(s))

  let cfg = normalize({
    enabled: true,
    dryRun: false,
    botQQ: '20000002',
    ownerQQ: '10000001',
    allow: { groups: ['123456', 'feishu:group:oc_1', 'qqbot:group:g_1'], private: ['10000001', 'feishu:private:ou_owner'] },
    stickers: { enabled: true, autoCollect: 'owner' },
    imagegen: { enabled: true, apiKey: 'k', model: 'm' },
    bili: { enabled: true },
    speakUp: { enabled: true, reminderEnabled: true },
    diary: { enabled: true },
    autotelic: { enabled: true },
    group: { crossRead: 'group' },
  })
  cfg.platforms = platCfg
  const getConfig = () => cfg
  const setConfig = (next) => { cfg = next; return cfg }
  const dsh = createFakeDsh({ brain: async () => 'ok' })
  const hub = {
    sendText: async () => ({ message_id: 's1' }),
    sendImage: async () => ({ message_id: 's2' }),
    sendFile: async () => ({ message_id: 's3' }),
    sendVoiceFile: async () => ({ message_id: 's4' }),
    sendSegments: async () => ({ message_id: 's5' }),
    deliver: async () => ({ message_id: 's6' }),
    runSystemTurn: async () => 'ok',
    subagentFor: () => () => 'ok',
    turnSendersAllOwner: () => true,
    turnSenders: () => ['10000001'],
    recentMedia: () => [{ kind: 'image', url: 'https://example.com/a.png' }],
    recentPaintings: () => [{ id: '#1', path: join(dir, 'p1.png') }],
    chatGroups: async () => [],
    addPending: () => {},
  }
  const onebot = {
    state: 'connected',
    call: async () => ({}),
  }
  const mods = createModules({
    ctx: dsh.ctx,
    core: {
      hub,
      onebot,
      gateway: gw,
      identity: makeIdentity({ qq: ['10000001'], feishu: ['ou_owner'], qqbot: ['openid_owner'] }),
      local: { active: () => true, url: () => 'http://127.0.0.1:1', authHeaders: () => ({}) },
      groupRoles: { peek: () => 'admin', get: async () => 'admin' },
      mutes: { muted: () => false },
      ask: async () => '',
      history: { search: () => [] },
    },
    getConfig,
    setConfig,
    logger: noopLog,
    version: '1.3.0-test',
    builtins,
  })
  t.after(async () => {
    mods.dispose()
    await gw.stopAll()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
    if (prevGlobal === undefined) delete globalThis.aurabot
    else globalThis.aurabot = prevGlobal
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  return { mods, gw, cfg, getConfig, setConfig, dir }
}

test('静态工具清单：格式合法、全局唯一、跨平台模块无新增平台前缀、平台专属模块带平台前缀', () => {
  const seenCanonicals = new Map() // toolName -> moduleId
  const seenAliases = new Map() // alias -> moduleId

  for (const mod of ALL_MODS) {
    const rel = MODULE_FILES.get(mod.id)
    assert.ok(rel, `模块 ${mod.id} 应在 MODULE_FILES 中登记`)
    const defined = extractDefinedToolNames(rel)
    const plats = Array.isArray(mod.platforms) && mod.platforms.length ? mod.platforms : ['qq']
    const isShared = plats.includes('*') || plats.length > 1
    const singlePlatform = !isShared ? plats[0] : null

    for (const name of defined) {
      assert.match(name, TOOL_NAME_RE, `模块 ${mod.id} 工具名「${name}」不符合 snake_case 规范（禁止斜杠/大写/空白）`)

      const prev = seenCanonicals.get(name)
      assert.equal(prev, undefined, `工具名「${name}」在模块 ${prev} 与 ${mod.id} 之间重复`)
      seenCanonicals.set(name, mod.id)

      if (isShared) {
        if (PLATFORM_PREFIX_RE.test(name)) {
          const gated = PLATFORM_GATED_IN_SHARED.get(name)
          const allowedByGate = gated && gated.moduleId === mod.id
          assert.ok(
            allowedByGate,
            `跨平台模块 ${mod.id} (platforms=${JSON.stringify(plats)}) 不得包含平台前缀工具名「${name}」`,
          )
        }
      } else if (singlePlatform) {
        assert.ok(
          name.startsWith(`${singlePlatform}_`),
          `平台专属模块 ${mod.id} (platforms=${JSON.stringify(plats)}) 的工具「${name}」应以 ${singlePlatform}_ 开头`,
        )
      }
    }

    if (mod.toolAliases) {
      for (const [alias, target] of Object.entries(mod.toolAliases)) {
        assert.match(alias, TOOL_NAME_RE, `模块 ${mod.id} 别名「${alias}」格式不合法`)
        assert.match(target, TOOL_NAME_RE, `模块 ${mod.id} 别名目标「${target}」格式不合法`)
        assert.notEqual(alias, target, `模块 ${mod.id} 别名「${alias}」不能指向自身`)
        assert.ok(defined.includes(target), `模块 ${mod.id} 别名「${alias}」指向的目标「${target}」不在本模块工具清单内`)
        const prevAlias = seenAliases.get(alias)
        assert.equal(prevAlias, undefined, `别名「${alias}」在模块 ${prevAlias} 与 ${mod.id} 之间重复`)
        seenAliases.set(alias, mod.id)
      }
    }
  }

  for (const [alias, modId] of seenAliases.entries()) {
    assert.equal(seenCanonicals.has(alias), false, `模块 ${modId} 别名「${alias}」不能与权威工具名重名`)
  }
})

test('运行时工具面：纯 Feishu / 纯 QQ / QQBot 均无重名、模型不见旧别名、跨平台模块无平台泄露', async (t) => {
  const { mods, gw } = makeFullHarness(t)
  await gw.sync()
  await mods.boot()

  const aliases = mods.toolAliases()
  const aliasSet = new Set(Object.keys(aliases))
  assert.ok(aliasSet.size >= 4, '至少应合并 chat-tools 的 4 个工具别名')

  const contexts = [
    { label: 'qq-private', where: { chat: { chatId: 'qq:private:10000001', platform: 'qq', kind: 'private', userId: '10000001' }, level: 'full', sessionId: 's-qq-p' } },
    { label: 'qq-group', where: { chat: { chatId: 'qq:group:123456', platform: 'qq', kind: 'group', groupId: '123456', userId: '10000001' }, level: 'full', sessionId: 's-qq-g' } },
    { label: 'feishu-private', where: { chat: { chatId: 'feishu:private:ou_owner', platform: 'feishu', kind: 'private', userId: 'ou_owner' }, level: 'full', sessionId: 's-fs-p' } },
    { label: 'feishu-group', where: { chat: { chatId: 'feishu:group:oc_1', platform: 'feishu', kind: 'group', groupId: 'oc_1', userId: 'ou_owner' }, level: 'social', sessionId: 's-fs-g' } },
    { label: 'qqbot-group', where: { chat: { chatId: 'qqbot:group:g_1', platform: 'qqbot', kind: 'group', groupId: 'g_1', userId: 'openid_owner' }, level: 'full', sessionId: 's-qb-g' } },
  ]

  for (const { label, where } of contexts) {
    const tools = mods.buildTools(where)
    const names = tools.map((x) => x.name)
    assert.equal(new Set(names).size, names.length, `${label} 工具面存在重复工具名`)

    for (const name of names) {
      assert.match(name, TOOL_NAME_RE, `${label} 工具名「${name}」不合法`)
      assert.equal(aliasSet.has(name), false, `${label} 模型工具面不应直接暴露旧别名「${name}」`)
    }

    if (where.chat.platform !== 'qq') {
      for (const name of names) {
        assert.equal(
          name.startsWith('qq_'),
          false,
          `${label} 非 QQ 平台工具面严禁出现 qq_* 工具「${name}」`,
        )
      }
      for (const [gatedName, spec] of PLATFORM_GATED_IN_SHARED.entries()) {
        if (spec.platform !== where.chat.platform) {
          assert.equal(names.includes(gatedName), false, `${label} 不应暴露 ${spec.platform} 专属门控工具「${gatedName}」`)
        }
      }
    }
  }

  // 所有已登记别名：当 canonical 在当前会话可用时 resolveTool 命中；不可用时返回 undefined
  const fsWhere = contexts.find((c) => c.label === 'feishu-private').where
  const fsNames = new Set(mods.buildTools(fsWhere).map((x) => x.name))
  for (const [alias, target] of Object.entries(aliases)) {
    const resolved = mods.resolveTool(fsWhere, alias)
    if (fsNames.has(target)) {
      assert.equal(resolved?.name, target, `feishu-private resolveTool(${alias}) 应解析为 ${target}`)
    } else {
      assert.equal(resolved, undefined, `feishu-private canonical ${target} 不可用时，resolveTool(${alias}) 应返回 undefined`)
    }
  }
})

test('createModules 别名与权威名启动校验：冲突阻断、跨模块隔离、平台门控与停止清理', async (t) => {
  const modA = {
    id: 'mod-a',
    name: '模块A',
    version: '1.0.0',
    api: 3,
    platforms: ['*'],
    toolAliases: { legacy_alpha: 'alpha_tool' },
    setup(api) {
      api.tool(api.defineTool({ name: 'alpha_tool', description: 'alpha', execute: async () => ({ ok: true }) }))
    },
  }
  const modDupAlias = {
    id: 'mod-dup-alias',
    name: '重复别名',
    version: '1.0.0',
    api: 3,
    platforms: ['*'],
    toolAliases: { legacy_alpha: 'beta_tool' },
    setup(api) {
      api.tool(api.defineTool({ name: 'beta_tool', description: 'beta', execute: async () => ({ ok: true }) }))
    },
  }
  const modCrossTarget = {
    id: 'mod-cross-target',
    name: '跨模块目标',
    version: '1.0.0',
    api: 3,
    platforms: ['*'],
    toolAliases: { steal_alpha: 'alpha_tool' },
    setup(api) {
      api.tool(() => [api.defineTool({ name: 'gamma_tool', description: 'gamma', execute: async () => ({ ok: true }) })])
    },
  }
  const modDupCanonical = {
    id: 'mod-dup-canonical',
    name: '重复权威名',
    version: '1.0.0',
    api: 3,
    platforms: ['*'],
    setup(api) {
      api.tool(api.defineTool({ name: 'alpha_tool', description: 'dup', execute: async () => ({ ok: true }) }))
    },
  }
  const modMissingTarget = {
    id: 'mod-missing-target',
    name: '目标缺失',
    version: '1.0.0',
    api: 3,
    platforms: ['*'],
    toolAliases: { old_ghost: 'ghost_tool' },
    setup(api) {
      api.tool(api.defineTool({ name: 'real_tool', description: 'real', execute: async () => ({ ok: true }) }))
    },
  }
  const modQqOnly = {
    id: 'mod-qq-only',
    name: '仅QQ',
    version: '1.0.0',
    api: 3,
    platforms: ['qq'],
    toolAliases: { old_qq_ping: 'qq_ping' },
    setup(api) {
      api.tool(api.defineTool({ name: 'qq_ping', description: '仅 QQ', execute: async () => ({ ok: true }) }))
    },
  }

  const { mods, gw } = makeFullHarness(t, {
    builtins: [modA, modDupAlias, modCrossTarget, modDupCanonical, modMissingTarget, modQqOnly],
  })
  await gw.sync()
  await mods.boot()

  assert.equal(mods.has('mod-a'), true, 'mod-a 应正常启动')
  assert.equal(mods.has('mod-qq-only'), true, 'mod-qq-only 应正常启动')
  assert.equal(mods.has('mod-dup-alias'), false, '重复别名模块应启动失败')
  assert.equal(mods.has('mod-cross-target'), false, '指向其他模块 canonical 的别名模块应启动失败')
  assert.equal(mods.has('mod-dup-canonical'), false, '重复 canonical 工具名模块应启动失败')
  assert.equal(mods.has('mod-missing-target'), false, '别名目标不存在的模块应启动失败')

  const qqWhere = { chat: { chatId: 'qq:private:10000001', platform: 'qq', kind: 'private' }, level: 'full', sessionId: 's1' }
  const fsWhere = { chat: { chatId: 'feishu:private:ou_owner', platform: 'feishu', kind: 'private' }, level: 'full', sessionId: 's2' }

  assert.equal(mods.resolveTool(qqWhere, 'legacy_alpha')?.name, 'alpha_tool')
  assert.equal(mods.resolveTool(fsWhere, 'legacy_alpha')?.name, 'alpha_tool')
  assert.equal(mods.resolveTool(qqWhere, 'old_qq_ping')?.name, 'qq_ping')
  assert.equal(mods.resolveTool(fsWhere, 'old_qq_ping'), undefined, 'QQ 专属工具在飞书不可用时，其旧别名也不应解析')

  // 运行时跨模块动态防穿透：即便动态 builder 模块试图用别名指向别的模块动态工具，也必须被拒绝
  const modDynOwner = {
    id: 'mod-dyn-owner',
    name: '动态拥有者',
    version: '1.0.0',
    api: 3,
    platforms: ['*'],
    setup(api) {
      api.tool(() => [api.defineTool({ name: 'dyn_secret', description: 'secret', execute: async () => ({ ok: true }) })])
    },
  }
  const modDynThief = {
    id: 'mod-dyn-thief',
    name: '动态越权',
    version: '1.0.0',
    api: 3,
    platforms: ['*'],
    toolAliases: { steal_dyn: 'dyn_secret' },
    setup(api) {
      api.tool(() => [])
    },
  }
  const h2 = makeFullHarness(t, { builtins: [modDynOwner, modDynThief] })
  await h2.gw.sync()
  await h2.mods.boot()
  assert.equal(h2.mods.resolveTool(qqWhere, 'steal_dyn'), undefined, '动态工具别名绝不能跨模块解析到其他模块的 canonical')

  // stop 后别名清理
  mods.stop('mod-a')
  assert.equal(mods.toolAliases().legacy_alpha, undefined, 'stop 后应清理该模块登记的别名')
  assert.equal(mods.resolveTool(qqWhere, 'legacy_alpha'), undefined)
})

test('usage.moduleOfTool 覆盖已迁移工具的权威名与旧别名', () => {
  for (const name of [
    'send_sticker', 'list_stickers', 'edit_sticker', 'collect_sticker', 'save_sticker', 'add_sticker', 'qq_import_stickers',
    'qq_send_sticker', 'qq_list_stickers', 'qq_edit_sticker', 'qq_collect_sticker', 'qq_save_sticker', 'qq_add_sticker', 'qq_import_qq_stickers',
  ]) {
    assert.equal(moduleOfTool(name), '表情包', `${name} 应归属 表情包`)
  }
  assert.equal(moduleOfTool('draw_image'), '生图')
  assert.equal(moduleOfTool('qq_draw_image'), '生图')
  assert.equal(moduleOfTool('generate_video'), '生视频')
  assert.equal(moduleOfTool('qq_generate_video'), '生视频')
  assert.equal(moduleOfTool('song_cover'), '翻唱')
  assert.equal(moduleOfTool('qq_song_cover'), '翻唱')
  assert.equal(moduleOfTool('set_reminder'), '主动搭话')
  assert.equal(moduleOfTool('close_reminder'), '主动搭话')
  assert.equal(moduleOfTool('qq_set_reminder'), '主动搭话')
  assert.equal(moduleOfTool('qq_close_reminder'), '主动搭话')
  assert.equal(moduleOfTool('bili_send_shot'), '刷 B 站')
  assert.equal(moduleOfTool('bili_list_shots'), '刷 B 站')
  assert.equal(moduleOfTool('qq_send_shot'), '刷 B 站')
  assert.equal(moduleOfTool('qq_list_shots'), '刷 B 站')
  assert.equal(moduleOfTool('group_admin'), '群管')
  assert.equal(moduleOfTool('qq_group_admin'), '群管')
})

test('extractDefinedToolNamesFromSource：支持超长前置字段并忽略注释与嵌套 properties.name', () => {
  const longPadding = '说明'.repeat(200)
  const sample = `
    // defineTool({ name: 'commented_out_tool' })
    /* defineTool({ name: 'block_commented_tool' }) */
    api.defineTool({
      description: '${longPadding}',
      properties: {
        name: str(' nested field named name '),
        query: str('regex test /a{1,2}/i'),
      },
      execute: async ({ name }) => {
        const inner = { name: 'inner_obj_name' }
        return { ok: Boolean(name && inner) }
      },
      name: 'delayed_top_level_tool',
    })
  `
  assert.deepEqual(extractDefinedToolNamesFromSource(sample), ['delayed_top_level_tool'])
})
