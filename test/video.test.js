import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { memoryLine } from '../src/features/memory.js'
import video, { videoFile, videoReady, minimaxBody, customRequestParts, clampResolution, fillJson, fillUrl } from '../src/modules/video/index.js'
import { SLOTS } from '../src/local/local.js'

function setup({ owner = true, result = 'D:/out/a.mp4', active = true, sendFails = false, confirm = false, enhance = false, provider = 'local', minimaxKey = '', customReady = false, asked = [], selfView = false } = {}) {
  const sent = []
  const calls = []
  let tool = null
  let onMessage = null
  let finish
  const done = new Promise((r) => { finish = r })
  let sendersOwner = owner
  const hub = {
    turnSendersAllOwner: () => sendersOwner,
    sendSegments: async (chatId, segs) => { if (sendFails) throw new Error('网关不收'); sent.push({ chatId, segs }); finish() },
    sendFile: async (chatId, file) => { sent.push({ chatId, file }); finish() },
    sendText: async (chatId, text) => { sent.push({ chatId, text }); if (/没做成/.test(String(text))) finish() },
  }
  const local = { active: () => active, call: async (slot, args) => { calls.push({ slot, args }); if (result instanceof Error) throw result; return result } }
  const rules = []
  const config = {
    video: {
      provider,
      confirm,
      enhance,
      selfView,
      minimax: { apiKey: minimaxKey, baseUrl: 'https://api.minimax.cn', model: 'MiniMax-H3', resolution: '768P', duration: 5, ratio: '16:9', pollMs: 5000 },
      custom: { createUrl: customReady ? 'https://x/create' : '', queryUrl: customReady ? 'https://x/query/{taskId}' : '', createMethod: 'POST', headers: '', body: '{"prompt":"{prompt}"}', taskIdPath: 'task_id', statusPath: 'status', successValue: 'succeeded', failValue: 'failed', urlPath: 'content.url', pollMs: 5000 },
    },
    local: { video: active, videoTimeoutMin: 20 },
    bili: {},
  }
  const api = {
    core: { hub, local },
    config: () => config,
    dsh: {},
    log: { warn() {}, info() {}, debug() {} },
    ask: async (o) => { asked.push(o); return '【扩写】镜头缓缓推进，暖光，胶片质感，大肥鱼在池塘里打滚，水面反光' },
    isOwner: (id) => owner && String(id) === '7',
    rule: (f) => rules.push(f),
    tool: (f) => { tool = f },
    on: (ev, fn) => { if (ev === 'message') onMessage = fn },
    onDispose() {},
    context() {},
  }
  video.setup(api)
  const chat = { chatId: 'private:1', userId: '7', kind: 'private' }
  return {
    get: (c = chat) => tool({ chat: c, sessionId: 's' }),
    say: (text, c = chat, userId = c.userId) => onMessage({ ...c, userId, sessionId: 's', text }),
    rules, sent, calls, done, config, chat,
    setSenders: (v) => { sendersOwner = v },
  }
}

test('video 槽位默认等 20 分钟', () => {
  assert.equal(SLOTS.video.file, 'video.mjs')
  assert.equal(SLOTS.video.timeoutMs, 20 * 60_000)
})

test('脚本返回路径或 { file }', () => {
  assert.equal(videoFile('a.mp4'), 'a.mp4')
  assert.equal(videoFile({ file: 'b.mp4' }), 'b.mp4')
  assert.equal(videoFile(null), '')
})

test('三个接口各自的就绪判断', () => {
  const local = { active: () => false }
  const mk = (patch) => ({ video: { minimax: { apiKey: '' }, custom: { createUrl: '', queryUrl: '' }, ...patch } })
  assert.equal(videoReady(mk({ provider: 'local' }), { active: () => true }), true)
  assert.equal(videoReady(mk({ provider: 'local' }), local), false)
  assert.equal(videoReady(mk({ provider: 'minimax' }), local), false)
  assert.equal(videoReady(mk({ provider: 'minimax', minimax: { apiKey: 'k' } }), local), true)
  assert.equal(videoReady(mk({ provider: 'custom' }), local), false)
  assert.equal(videoReady(mk({ provider: 'custom', custom: { createUrl: 'a', queryUrl: 'b' } }), local), true)
})

test('MiniMax 请求体：文生视频必须给具体比例，首帧用例自适应', () => {
  const cfg = { video: { minimax: { model: 'MiniMax-H3', resolution: '2K', duration: 5, ratio: 'adaptive' } } }
  const t2v = minimaxBody({ prompt: '猫', seconds: 6, image: '', cfg })
  assert.equal(t2v.ratio, '16:9')
  assert.equal(t2v.duration, 6)
  assert.equal(t2v.resolution, '2K')
  assert.deepEqual(t2v.content, [{ type: 'text', text: '猫' }])

  const i2v = minimaxBody({ prompt: '猫', seconds: 6, image: 'data:image/jpeg;base64,xx', cfg })
  assert.equal(i2v.ratio, 'adaptive')
  assert.deepEqual(i2v.content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xx' }, role: 'first_frame' })
})

test('MiniMax：2K 只给 H3，时长夹到 4~15（Max 5 起）', () => {
  assert.equal(clampResolution('MiniMax-H3', '2K'), '2K')
  assert.equal(clampResolution('MiniMax-H3-Lite', '2K'), '768P')
  const lite = minimaxBody({ prompt: 'x', seconds: 30, image: '', cfg: { video: { minimax: { model: 'MiniMax-H3-Lite', duration: 5 } } } })
  assert.equal(lite.duration, 15)
  const max = minimaxBody({ prompt: 'x', seconds: 1, image: '', cfg: { video: { minimax: { model: 'MiniMax-H3-Max', duration: 5 } } } })
  assert.equal(max.duration, 5)
})

test('自定义接口：JSON 体转义、地址编码、任务 ID 进轮询地址', () => {
  assert.equal(fillJson('{"p":"{prompt}"}', { prompt: 'a"b\nc' }), '{"p":"a\\"b\\nc"}')
  assert.equal(fillUrl('https://x/{q}', { q: 'a b&c' }), 'https://x/a%20b%26c')

  const cfg = { video: { custom: { createUrl: 'https://x/create?q={prompt}', queryUrl: 'https://x/t/{taskId}', createMethod: 'POST', headers: 'Authorization: Bearer t', body: '{"prompt":"{prompt}","n":{seconds}}', taskIdPath: 'id', statusPath: 'status', urlPath: 'out.url' } } }
  const parts = customRequestParts({ prompt: 'a"b', seconds: 5, image: '', cfg })
  assert.equal(parts.method, 'POST')
  assert.equal(parts.createUrl, 'https://x/create?q=a%22b')
  assert.equal(parts.queryUrl, 'https://x/t/')
  assert.deepEqual(parts.headers, { Authorization: 'Bearer t' })
  assert.equal(parts.body, '{"prompt":"a\\"b","n":5}')
  const withTask = customRequestParts({ prompt: 'x', seconds: 5, image: '', cfg, taskId: 'T1' })
  assert.equal(withTask.queryUrl, 'https://x/t/T1')
})

test('关掉确认时：工具马上返回，做好后自动按视频发回聊天', async () => {
  const s = setup({ confirm: false })
  const r = await s.get().execute({ prompt: '一条鱼', seconds: '3' })
  assert.equal(r.ok, true)
  await s.done
  assert.equal(s.calls[0].slot, 'video')
  const seg = s.sent.find((x) => x.segs)
  assert.equal(seg.segs[0].type, 'video')
  assert.match(seg.segs[0].data.file, /^file:/)
})

test('开着确认时：先发描述等确认，确认后才生成', async () => {
  const s = setup({ confirm: true })
  const r = await s.get().execute({ prompt: '一条鱼', seconds: '5' })
  assert.equal(r.ok, true)
  assert.match(r.message, /等确认/)
  assert.equal(s.calls.length, 0)
  assert.ok(s.sent.some((x) => x.text && x.text.includes('要按这段生成视频吗')))

  assert.equal(await s.say('这个多少钱'), false)
  assert.equal(await s.say('确认'), true)
  await s.done
  assert.equal(s.calls.length, 1)
  assert.ok(s.sent.some((x) => x.segs))
})

test('等确认期间不接受新的生成请求', async () => {
  const s = setup({ confirm: true })
  await s.get().execute({ prompt: '一条鱼' })
  assert.equal((await s.get().execute({ prompt: '另一条' })).ok, false)
  await s.say('取消') // 清掉待确认和它的定时器，别让测试进程挂着
})

test('取消不生成', async () => {
  const s = setup({ confirm: true })
  await s.get().execute({ prompt: '一条鱼' })
  assert.equal(await s.say('取消'), true)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(s.calls.length, 0)
  assert.ok(s.sent.some((x) => x.text && x.text.includes('那不生成')))
})

test('别人不能替发起人确认', async () => {
  const s = setup({ confirm: true, owner: true })
  await s.get().execute({ prompt: '一条鱼' })
  s.setSenders(false) // 这条消息不是主人那一轮、也不是发起人
  assert.equal(await s.say('确认', s.chat, '999'), false)
  assert.equal(s.calls.length, 0)
  await s.say('取消')
})

test('提示词扩写：开着时把扩写结果交给生成接口', async () => {
  const asked = []
  const s = setup({ confirm: false, enhance: true, asked })
  await s.get().execute({ prompt: '一条鱼在池塘里', seconds: '5' })
  await s.done
  assert.equal(asked.length, 1)
  assert.match(s.calls[0].args.prompt, /^【扩写】/)
})

test('发视频失败时改发文件', async () => {
  const s = setup({ sendFails: true, confirm: false })
  await s.get().execute({ prompt: '一条鱼' })
  await s.done
  assert.equal(s.sent.find((x) => x.file).file, 'D:/out/a.mp4')
})

test('失败时告诉对方', async () => {
  const s = setup({ result: new Error('显存不够'), confirm: false })
  await s.get().execute({ prompt: '一条鱼' })
  await s.done
  assert.ok(s.sent.some((x) => x.text && /没做成.*显存不够/.test(x.text)))
})

test('只有主人能生成，后台会话和没配好时没有工具，规则跟着开关走', async () => {
  const s = setup({ owner: false })
  assert.equal((await s.get().execute({ prompt: 'x' })).ok, false)
  assert.equal(s.calls.length, 0)
  assert.deepEqual(s.get({ chatId: 'system:x', kind: 'system' }), [])
  const off = setup({ active: false })
  assert.deepEqual(off.get(), [])
  assert.deepEqual(off.rules[0](), [])
  assert.match(setup().rules[0]()[0], /很慢/)
})

test('一次只跑一段', async () => {
  const s = setup({ confirm: false })
  await s.get().execute({ prompt: 'a' })
  assert.equal((await s.get().execute({ prompt: 'b' })).ok, false)
  await s.done
})

test('面板注册齐全：标签、模块归属、分组、渲染、脏值、别名', () => {
  const c = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(c, /\{ id: 'video', label: '视频'/) // 后面跟着 flagFn 也算
  assert.match(c, /video: \['video'\],/)
  assert.match(c, /'imagegen', 'video', 'song', 'pet'\]/)
  assert.match(c, /imagegen: ImageGen, video: Video,/)
  assert.match(c, /video: \['video', 'local'\],/)
  assert.match(c, /video: '视频 生视频 拍视频'/)
  // 补丁只应生效一次：标签与组件都不能重复
  assert.equal((c.match(/id: 'video', label: '视频'/g) || []).length, 1)
  assert.match(c, /flagFn: \(cfg\) =>/) // 视频标签按当前接口配没配好亮灯
  assert.match(c, /t\.flagFn \? t\.flagFn\(cfg\)/) // 渲染处认 flagFn
  assert.equal((c.match(/function Video\(/g) || []).length, 1)
})

test('记忆行带 QQ 号，重名分得清；已经带了就不重复', () => {
  assert.match(memoryLine({ at: Date.now(), text: '喜欢吃辣', aboutName: '小明', about: '123' }), /\[小明\(123\)\] 喜欢吃辣/)
  assert.match(memoryLine({ at: Date.now(), text: 'x', aboutName: '小明(123)', about: '123' }), /\[小明\(123\)\] x/)
  assert.match(memoryLine({ at: Date.now(), text: 'x', aboutName: '小明', about: '' }), /\[小明\] x/)
})
