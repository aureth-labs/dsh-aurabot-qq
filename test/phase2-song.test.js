import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTestIdentity } from './helpers/identity.js'

let songModule
let failPrompt
let recordSungEvent
let normalize

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-phase2-song-'))
  const mod = await import('../src/modules/song/index.js')
  songModule = mod.default
  failPrompt = mod.failPrompt
  recordSungEvent = mod.recordSungEvent
  ;({ normalize } = await import('../src/core/config.js'))
})

test('PR-2C: onSung 按 parseChatId + identity.lookup 记录飞书/QQ 私聊与群聊经历', () => {
  const identity = makeTestIdentity('ou_owner_fs', 'feishu')
  const friendPid = identity.resolve('feishu', 'ou_friend')
  const events = []
  const moods = []
  const emitted = []
  const deps = {
    cfg: { ownerName: '阿白' },
    identity,
    mood: { nudge: (n, why) => moods.push({ n, why }) },
    memory: { addEvent: (e) => events.push(e) },
    emit: (ev, payload) => emitted.push({ ev, payload }),
  }

  recordSungEvent({ ...deps, title: '小幸运', chatId: 'feishu:private:ou_owner_fs' })
  assert.equal(events[0].text, '给阿白唱了《小幸运》')
  assert.equal(events[0].about, identity.owner())
  assert.equal(events[0].chatId, 'feishu:private:ou_owner_fs')

  recordSungEvent({ ...deps, title: '稻香', chatId: 'feishu:private:ou_friend' })
  assert.equal(events[1].text, '给对方唱了《稻香》')
  assert.equal(events[1].about, friendPid)

  recordSungEvent({ ...deps, title: '晴天', chatId: 'feishu:group:oc_g1' })
  assert.equal(events[2].text, '给群里唱了《晴天》')
  assert.equal(events[2].about, '')
  assert.equal(events[2].chatId, 'feishu:group:oc_g1')
  assert.equal(emitted.length, 3)
  assert.equal(moods.length, 3)
})

test('PR-2C: failPrompt 不包含 QQ 专属字样', () => {
  const p = failPrompt('小幸运', '环境未安装')
  assert.doesNotMatch(p, /QQ/i)
})

test('PR-2C: deliverVoice 按能力走 voice Part 或显式降级 file Part，无语音无文件能力时拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-song-deliver-'))
  const audioFile = join(dir, 'cover.mp3')
  writeFileSync(audioFile, Buffer.from('ID3-fake-mp3'))

  const sentParts = []
  const sentTexts = []
  let capsNow = { voice: 'native', file: true }
  let dropVoice = false
  let toolBuilder = null
  const routes = new Map()
  const cfg = normalize({ enabled: true, song: { enabled: true, ownerOnly: true } })
  const identity = makeTestIdentity('ou_owner', 'feishu')

  const studio = songModule.setup({
    config: () => cfg,
    lazy: () => ({}),
    log: { info() {}, warn() {}, debug() {} },
    caps: () => capsNow,
    sendParts: async (chatId, parts, opts) => {
      sentParts.push({ chatId, parts, opts })
      if (dropVoice && parts[0]?.type === 'voice') return { messageId: '', degraded: ['voice dropped'] }
      return { messageId: 'om_voice_1' }
    },
    tool: (fn) => { toolBuilder = fn },
    route: (path, fn) => routes.set(path, fn),
    core: {
      hub: {
        turnSendersAllOwner: () => true,
        sendText: async (chatId, text) => { sentTexts.push({ chatId, text }); return { messageId: 'om_txt' } },
        sendVoiceFile: async () => { throw new Error('网关下不应直接退回 legacy sendVoiceFile') },
      },
      local: { active: () => false },
      identity,
      http: { query: () => ({}), body: async () => ({ song: '小幸运', chatId: 'feishu:private:ou_owner' }), send() {} },
    },
  })

  // 1) voice='native' -> 发送 voice Part
  await studio.deliverVoice('feishu:private:ou_owner', audioFile, '[翻唱] 小幸运')
  assert.equal(sentParts[0].parts[0].type, 'voice')
  assert.equal(sentParts[0].parts[0].media.name, 'cover.mp3')

  // 2) caps.voice=false, caps.file=true -> 明示降级为 file Part 并附提示，工具返回也提示降级
  capsNow = { voice: false, file: true }
  const chat = { chatId: 'feishu:private:ou_owner', platform: 'feishu', kind: 'private', userId: 'ou_owner' }
  const tool = toolBuilder({ chat, sessionId: 's-fs' })
  const execDegraded = await tool.execute({ song: '稻香' })
  // Note: song.request 会在未安装 rvc 时返回 ok:false；验证有权限有文件能力时不因缺少语音而被挡在前置能力校验
  assert.notEqual(execDegraded.message, '当前平台不支持发送语音或音频文件，无法在这里发翻唱')

  await studio.deliverVoice('feishu:private:ou_owner', audioFile, '[翻唱] 稻香')
  assert.equal(sentParts[1].parts[0].type, 'file')
  assert.match(sentTexts.at(-1).text, /改发音频文件/)

  // 3) 网关运行期降级 voice dropped -> 改发 file Part
  capsNow = { voice: 'native', file: true }
  dropVoice = true
  await studio.deliverVoice('feishu:private:ou_owner', audioFile, '[翻唱] 晴天')
  assert.equal(sentParts.at(-1).parts[0].type, 'file')

  // 4) 无 voice 也无 file 能力 -> 工具与面板试唱直接拒收，deliverVoice 抛错
  capsNow = { voice: false, file: false }
  const blockedTool = await tool.execute({ song: '夜曲' })
  assert.equal(blockedTool.ok, false)
  assert.match(blockedTool.message, /不支持发送语音或音频文件/)
  const blockedRoute = await routes.get('/song/request')({})
  assert.equal(blockedRoute.ok, false)
  await assert.rejects(() => studio.deliverVoice('feishu:private:ou_owner', audioFile, '[翻唱] 夜曲'), /不支持/)
})
