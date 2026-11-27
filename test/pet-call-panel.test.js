// 面板集成：桌宠页独立的「语音对讲」配置卡 + /panel/pet/config 对讲键写入通道（pet 1.2.0）。
// 模块 settings 声明不渲染成表单，宿主这条白名单路由 + client.js 硬编码卡片是对讲设置能看见、
// 能存进去的两处关键拼图；第三处「不在对话框卡内部」由源码断言钉死（用户明确要求单独一块）。
// 与 1.1.2「打电话」相比：toggle 模式（按一下开始听、再按一下发送），新增 voiceHotkey，
// 删掉 callPttKey / callVadSilence 的写入（不再有 PTT 键与静音断句）。
// fake-dsh 模式；不引入新依赖。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'

const call = async (path, body) => (await fake.call(path, body)).json()

let mock
let fake
let api
let dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-voice-talk-panel-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    bridge: { dshTools: false, http: true, token: 'a'.repeat(32) },
  }))
  fake = createFakeDsh({ brain: async () => '嗯' })
  fake.ctx.webServer.port = 5101
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready.catch(() => {})
  await fake.call('/onebot/reconnect')
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const extPet = () => JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).ext?.pet || {}
// 面板是单文件源码软链（数据目录没有构建产物），只能在源码上断言。
const clientSrc = () => readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const hostSrc = () => readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')

test('对讲引擎枚举 / RVC 开关：枚举限定 native|sovits|voice（talkMode 兼容 toggle|free|ptt），布尔透传，坏值不落盘', async () => {
  const r = await call('/panel/pet/config', {
    callEngine: 'sovits', callTalkMode: 'toggle', callRvc: true, callEngineFoo: 1,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  const pet = extPet()
  assert.equal(pet.callEngine, 'sovits')
  assert.equal(pet.callTalkMode, 'toggle')
  assert.equal(pet.callRvc, true)
  assert.equal(pet.callEngineFoo, undefined, '未知键不收')
  // 类型/枚举不对 → 一条都没写，明确拒绝（不污染已有值）
  const bad = await call('/panel/pet/config', { callEngine: 'doubao', callTalkMode: 1, callRvc: 'yes' })
  assert.equal(bad.ok, false)
  assert.equal(extPet().callEngine, 'sovits', '非法枚举不覆盖旧值')
  // 复原
  await call('/panel/pet/config', { callEngine: 'native', callTalkMode: 'toggle', callRvc: false })
})

test('触发热键 voiceHotkey：trim + 截断到 40，空串合法（= 不启用）', async () => {
  await call('/panel/pet/config', { voiceHotkey: '  Alt+Space  ' })
  assert.equal(extPet().voiceHotkey, 'Alt+Space')
  // 超长截断到 40
  const long = 'Ctrl+' + 'x'.repeat(100)
  await call('/panel/pet/config', { voiceHotkey: long })
  assert.equal(extPet().voiceHotkey.length, 40)
  // 清空：空串能落盘，面板才能把热键关掉
  await call('/panel/pet/config', { voiceHotkey: '' })
  assert.equal(extPet().voiceHotkey, '')
})

test('对讲文本键：音色 ≤60、两个 deviceId ≤200，trim 后落盘，空串合法', async () => {
  await call('/panel/pet/config', {
    callRvcVoice: '  小鱼  ',
    callMicDeviceId: 'mic-' + 'x'.repeat(250), // 截到 200
    callSpeakerDeviceId: '  spk-1  ',
  })
  const pet = extPet()
  assert.equal(pet.callRvcVoice, '小鱼')
  assert.equal(pet.callMicDeviceId.length, 200, '麦克风 deviceId 截到 200')
  assert.equal(pet.callSpeakerDeviceId, 'spk-1')
  // 空串能落盘
  await call('/panel/pet/config', { callRvcVoice: '', callMicDeviceId: '', callSpeakerDeviceId: '' })
  const empty = extPet()
  assert.equal(empty.callRvcVoice, '')
  assert.equal(empty.callMicDeviceId, '')
  assert.equal(empty.callSpeakerDeviceId, '')
})

test('对讲服务地址：sovitsUrl / callAsrUrl 只收 http(s)（留空回落内置默认），file:// 不收', async () => {
  await call('/panel/pet/config', { sovitsUrl: ' https://gpts.local:9880/ ', callAsrUrl: 'http://127.0.0.1:8000' })
  assert.equal(extPet().sovitsUrl, 'https://gpts.local:9880/')
  assert.equal(extPet().callAsrUrl, 'http://127.0.0.1:8000')
  // 非法协议：字段被忽略 → 不覆盖旧值
  const r = await call('/panel/pet/config', { sovitsUrl: 'file:///etc/passwd' })
  assert.equal(r.ok, false, '唯一字段非法 → 没有可保存的字段')
  assert.equal(extPet().sovitsUrl, 'https://gpts.local:9880/', '非法地址不能覆盖旧值')
  // 超长地址：先截断到 300 再校验
  const long = 'https://x.local/' + 'a'.repeat(400)
  await call('/panel/pet/config', { callAsrUrl: long })
  assert.equal(extPet().callAsrUrl.length, 300)
  // 留空 = 回落默认，能落盘
  await call('/panel/pet/config', { sovitsUrl: '', callAsrUrl: '' })
  assert.equal(extPet().sovitsUrl, '')
  assert.equal(extPet().callAsrUrl, '')
})

test('对讲数字：一次最多字数 20~300，越界钳制、类型不对忽略；没有说完判定秒数', async () => {
  await call('/panel/pet/config', { callMaxChars: 3 })
  assert.equal(extPet().callMaxChars, 20, '低于下限钳到 20')
  await call('/panel/pet/config', { callMaxChars: 9999 })
  assert.equal(extPet().callMaxChars, 300, '高于上限钳到 300')
  const bad = await call('/panel/pet/config', { callMaxChars: 'many' })
  assert.equal(bad.ok, false, '字符串数字不收')
  assert.equal(extPet().callMaxChars, 300, '坏值不覆盖旧值')
})

// 取宿主白名单路由的代码段（去掉 // 注释，避免说明「不再写入 PTT」的文字干扰断言）
const hostWhitelistCode = () => {
  const host = hostSrc()
  const section = host.slice(host.indexOf("route('/panel/pet/config'"), host.indexOf("route('/panel/pet/whisper'"))
  return section.replace(/\/\/[^\r\n]*/g, '')
}

test('toggle 模式删掉的键：callPttKey / callVadSilence 不再写入（单独发或夹带合法键都不落盘）', async () => {
  const before = extPet()
  // 单独发 → 没有可保存的字段
  const r = await call('/panel/pet/config', { callPttKey: 'Ctrl+Shift+Space', callVadSilence: 0.3 })
  assert.equal(r.ok, false, 'PTT 键 / 说完判定秒数已不是合法配置键')
  // 夹带合法键：合法键落盘，被删的键不出现
  await call('/panel/pet/config', { callMaxChars: 120, callPttKey: 'F12', callVadSilence: 4.2 })
  const after = extPet()
  assert.equal(after.callMaxChars, 120)
  assert.equal(after.callPttKey, before.callPttKey, 'callPttKey 不被写入')
  assert.equal(after.callVadSilence, before.callVadSilence, 'callVadSilence 不被写入')
  // 宿主源码白名单的代码里也不该再出现这两个键
  const whitelist = hostWhitelistCode()
  assert.ok(!whitelist.includes('callPttKey'), '宿主白名单不再登记 callPttKey')
  assert.ok(!whitelist.includes('callVadSilence'), '宿主白名单不再登记 callVadSilence')
})

test('面板入口：新卡标题「语音对讲」、热键控件、asrReady 提示，且不在对话框卡内部', () => {
  const src = clientSrc()
  // 新卡是桌宠页里单独一块 Card，不是对话框卡内部的 Row
  assert.match(src, /h\(Card, \{ title: '语音对讲'/, '桌宠页得有一张独立的「语音对讲」卡')
  assert.ok(!/h\(Card, \{ title: '打电话'/.test(src), '旧的「打电话」卡标题必须删掉')
  // 对话框卡从 chatCfg ? h('div' 开始，到天气城市那行的 '))) : null' 结束；
  // 语音对讲卡必须在这之后（即不在对话框卡内部）
  const chatStart = src.indexOf("chatCfg ? h('div'")
  const chatEnd = src.indexOf("chatCfg.weather ?", chatStart)
  const talkCard = src.indexOf("h(Card, { title: '语音对讲'")
  assert.ok(chatStart >= 0 && chatEnd > chatStart, '对话框卡锚点还在')
  assert.ok(talkCard > chatEnd, '语音对讲卡在对话框卡之后，不能塞进对话框卡里')
  // 触发热键控件：默认 Alt+Space + 「按一下开始听、再按一下发送」提示 + voiceHotkey 写入
  assert.ok(src.includes("placeholder: 'Alt+Space'"), '热键输入框要有 Alt+Space 默认值提示')
  assert.match(src, /按一下开始听、再按一下发送/, '热键提示要说明 toggle 用法')
  assert.ok(src.includes('voiceHotkey:'), '热键写入走 voiceHotkey')
  // asrReady 状态提示：false 时红字显示 asrReason，并带人话兜底文案
  assert.ok(src.includes('callCfg.asrReady'), '面板要从 pet.voiceTalk 读 asrReady')
  assert.ok(src.includes('callCfg.asrReason'), '面板要显示 asrReason')
  assert.ok(src.includes('#d9534f'), 'asrReady=false 时用红字')
  assert.match(src, /本地识别未连通，请配 faster-whisper 或开 DSH 语音输入/, '要有识别未连通的人话提示')
  // 从 pet.voiceTalk 读，兼容 pet.call；缺失值用安全默认值仍渲染
  assert.ok(src.includes('pet?.voiceTalk'), '优先读 pet.voiceTalk')
  assert.ok(src.includes('pet?.call'), '兼容 pet.call')
  assert.ok(src.includes('CALL_DEFAULTS'), '缺失值要有安全默认值')
  // 卡里读这些字段（含设备只读显示）
  for (const field of ['hotkey', 'engine', 'rvc', 'rvcVoice', 'maxChars', 'asrUrl', 'sovitsUrl', 'micDeviceId', 'speakerDeviceId', 'asrReady', 'asrReason']) {
    assert.ok(src.includes('callCfg.' + field) || src.includes("cacVal('" + field + "')"), `语音对讲卡缺字段 ${field} 的读取/展示`)
  }
  // 7 个用户可改的写入键都要真的发到宿主白名单通道（saveCall 的 patch 里）；
  // 两个 deviceId 是客户端上报存的，面板只读显示当前值；asrReady/asrReason 是只读状态。
  for (const key of ['voiceHotkey', 'callEngine', 'sovitsUrl', 'callRvc', 'callRvcVoice', 'callMaxChars', 'callAsrUrl']) {
    assert.ok(src.includes(key), `面板缺 ${key} 的写入`)
    assert.match(src, new RegExp(key + '[:\\s]'), `${key} 要出现在 saveCall 的 patch 里`)
  }
  // 已删除的 PTT / 静音断句概念不能出现在面板里（历史注释也不留）
  assert.ok(!src.includes('callPttKey'), '面板不再写 callPttKey')
  assert.ok(!src.includes('callVadSilence'), '面板不再写 callVadSilence')
  assert.ok(!src.includes("title: '打电话'"), '面板不再有「打电话」卡')
  // 宿主白名单登记对讲键：原 11 键 - 2（PTT/VAD）+ 1（voiceHotkey）= 10 键。
  // 含 voiceHotkey、不含 callPttKey / callVadSilence。
  const whitelist = hostWhitelistCode()
  for (const key of ['callEngine', 'callTalkMode', 'callRvc', 'callRvcVoice', 'voiceHotkey', 'callAsrUrl', 'sovitsUrl', 'callMaxChars', 'callMicDeviceId', 'callSpeakerDeviceId']) {
    assert.ok(whitelist.includes(key), `host.js /panel/pet/config 白名单缺 ${key}`)
  }
  assert.ok(!whitelist.includes('callPttKey'), '白名单不该有 callPttKey')
  assert.ok(!whitelist.includes('callVadSilence'), '白名单不该有 callVadSilence')
})
