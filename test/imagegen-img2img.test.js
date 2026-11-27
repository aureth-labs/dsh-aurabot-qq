// 参考图沿用 qq_draw_image：请求形状、短期媒体来源、安全边界及原有发送 / 经历流程。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createImageGen, customRequest, resolveDrawImage } from '../src/features/imagegen.js'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import { createLocal } from '../src/local/local.js'
import { savePainting } from '../src/features/paintings.js'
import imagegenModule from '../src/modules/imagegen/index.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const OTHER = Buffer.from(PNG)
OTHER[40] = 1
const b64 = PNG.toString('base64')
const log = { info() {}, warn() {}, debug() {}, error() {} }
const OWNER = '10000001', BOT = '20000002'
const privateChat = { kind: 'private', chatId: `private:${OWNER}`, userId: OWNER }
const groupChat = { kind: 'group', chatId: 'group:123', groupId: '123' }
const unsupported = { message: '这个生图服务不支持参考图' }
const config = (extra = {}) => normalize({ imageGen: { enabled: true, baseUrl: 'https://image.example/v1', apiKey: 'key', model: 'image-test', stylePrompt: '水彩', ...extra } })
const result = () => new Response(JSON.stringify({ data: [{ b64_json: b64 }] }))
function sandbox(t) {
  const previous = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-img2img-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('OpenAI 参考图：只请求 edits，multipart 包含图片、完整提示词、模型和本次尺寸', async () => {
  const seen = [], cfg = config()
  const gen = createImageGen({ getConfig: () => cfg, log, fetchImpl: async (url, init) => { seen.push({ url, init }); return result() } })
  assert.deepEqual(await gen.generate('把猫改成蓝色', { image: PNG, shape: 'portrait' }), PNG)
  assert.equal(seen.length, 1)
  const { url, init } = seen[0]
  assert.equal(url, 'https://image.example/v1/images/edits')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, 'Bearer key')
  assert.equal(init.headers['content-type'], undefined, 'multipart boundary 由 fetch 设置')
  assert.ok(init.body instanceof FormData)
  assert.deepEqual([...init.body.keys()].sort(), ['image', 'model', 'prompt', 'size'])
  assert.equal(init.body.get('prompt'), '水彩，把猫改成蓝色')
  assert.equal(init.body.get('model'), 'image-test')
  assert.equal(init.body.get('size'), '1024x1536')
  const image = init.body.get('image')
  assert.equal(image.type, 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG)
  await gen.generate('猫')
  assert.equal(seen[1].url, 'https://image.example/v1/images/generations')
  assert.equal(JSON.parse(seen[1].init.body).image, undefined)
})

test('OpenAI 不支持 edits / 参考图时明确报错，只发一次请求；其他失败保留原因', async () => {
  for (const [status, message, expected] of [
    [404, 'Not found', unsupported], [405, 'Method not allowed', unsupported],
    [400, 'This model does not support image edits', unsupported],
    [422, 'Unknown parameter: image', unsupported],
    [400, 'unsupported size', /unsupported size/], [401, 'invalid API key', /invalid API key/],
  ]) {
    let calls = 0
    const gen = createImageGen({ getConfig: () => config(), log, fetchImpl: async (url) => {
      calls++
      assert.match(url, /\/images\/edits$/)
      return new Response(JSON.stringify({ error: { message } }), { status })
    } })
    await assert.rejects(gen.generate('猫', { image: PNG }), expected)
    assert.equal(calls, 1, '不退回 generations，也不丢掉 image 重试')
  }
})

test('custom JSON / 表单：{image} 是原始 base64，继续沿用提示词和尺寸占位符', async () => {
  for (const bodyType of ['json', 'form']) {
    let seen
    const cfg = config({ provider: 'custom', custom: { method: 'POST', url: 'https://image.example/edit', bodyType, params: [
      { key: 'reference', value: '{image}' }, { key: 'text', value: '{prompt}' }, { key: 'size', value: '{size}' },
    ] } })
    const gen = createImageGen({ getConfig: () => cfg, log, fetchImpl: async (_url, init) => {
      seen = init
      return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    } })
    assert.deepEqual(await gen.generate('猫', { image: PNG, shape: 'wide' }), PNG)
    const body = bodyType === 'json' ? JSON.parse(seen.body) : Object.fromEntries(new URLSearchParams(seen.body))
    assert.deepEqual(body, { reference: b64, text: '水彩，猫', size: '1536x864' })
    assert.equal(seen.headers['content-type'], bodyType === 'json' ? 'application/json' : 'application/x-www-form-urlencoded')
  }
})

test('custom GET：URL 和参数里的参考图都正确编码，包括 + / =', () => {
  const image = Buffer.from([0xfb, 0xff])
  const req = customRequest({ size: '1024x1024', custom: { method: 'GET', url: 'https://image.example/edit?img={image}', params: [{ key: 'reference', value: '{image}' }] } }, '猫', image)
  const url = new URL(req.url)
  assert.equal(url.searchParams.get('img'), image.toString('base64'))
  assert.equal(url.searchParams.get('reference'), image.toString('base64'))
  assert.equal(req.body, undefined)
})

test('custom 没有有效 {image} 占位时拒绝请求，服务拒绝参考图也不退回文生图', async () => {
  let calls = 0
  const cfg = config({ provider: 'custom', custom: { method: 'POST', url: 'https://image.example/edit', params: [{ key: '', value: '{image}' }] } })
  const gen = createImageGen({ getConfig: () => cfg, log, fetchImpl: async () => {
    calls++
    return new Response(JSON.stringify({ message: 'image input is not supported' }), { status: 400 })
  } })
  await assert.rejects(gen.generate('猫', { image: PNG }), unsupported)
  assert.equal(calls, 0)
  cfg.imageGen.custom.params = [{ key: 'image', value: '{image}' }]
  await assert.rejects(gen.generate('猫', { image: PNG }), unsupported)
  assert.equal(calls, 1)
})

test('Codex 现有 JSON 文生图保持原形；参考图明确拒绝，连认证也不调用', async () => {
  let access = 0, requests = 0
  const cfg = config({ provider: 'codex' })
  const gen = createImageGen({ getConfig: () => cfg, log,
    codexAuth: { status: () => ({ loggedIn: true }), ensureAccess: async () => { access++; return { access: 'token', accountId: 'account' } } },
    fetchImpl: async (url, init) => {
      requests++
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/images/generations')
      assert.equal(init.headers['content-type'], 'application/json')
      assert.equal(JSON.parse(init.body).prompt, '水彩，猫')
      assert.equal(JSON.parse(init.body).image, undefined)
      return result()
    },
  })
  await assert.rejects(gen.generate('猫', { image: PNG }), unsupported)
  assert.equal(access, 0)
  assert.equal(requests, 0)
  assert.deepEqual(await gen.generate('猫'), PNG)
  assert.equal(requests, 1)
})

test('本地 call(image) 收到纯 base64 image 和原有 prompt / size；无图时不增加字段', async () => {
  const seen = [], cfg = config()
  const local = { active: () => true, call: async (slot, args) => { seen.push({ slot, args }); return PNG } }
  const gen = createImageGen({ getConfig: () => cfg, log, local })
  assert.deepEqual(await gen.generate('猫', { image: PNG, shape: 'landscape' }), PNG)
  assert.deepEqual(seen[0], { slot: 'image', args: { prompt: '水彩，猫', size: '1536x1024', image: b64 } })
  await gen.generate('猫')
  assert.deepEqual(seen[1].args, { prompt: '水彩，猫', size: '1024x1024' })
})

test('本地旧脚本未声明支持时，在执行前报错；已适配脚本可收到参考图', async (t) => {
  const dir = sandbox(t), cfg = config()
  cfg.local.image = true
  const local = createLocal({ getConfig: () => cfg, log })
  mkdirSync(join(dir, 'local'), { recursive: true })
  writeFileSync(local.pathOf('image'), 'export default async () => { throw new Error("不该执行旧脚本") }')
  const gen = createImageGen({ getConfig: () => cfg, log, local })
  await assert.rejects(gen.generate('猫', { image: PNG }), unsupported)
  // 新的目录避免依赖文件系统的 mtime 精度，不运行计时等待。
  process.env.AURABOT_DATA_DIR = join(dir, 'adapted')
  mkdirSync(join(dir, 'adapted', 'local'), { recursive: true })
  writeFileSync(local.pathOf('image'), 'export const supportsImage = true; export default async ({ image }) => ({ base64: image })')
  assert.deepEqual(await gen.generate('猫', { image: PNG }), PNG)
})

test('图库只接受文件名；任意路径、URL、base64 输入、伪图片一律拒绝', async (t) => {
  sandbox(t)
  const path = savePainting(PNG, '旧画'), file = basename(path)
  const context = { chat: privateChat, hub: { referenceImage: () => { throw new Error('不该查询聊天') } } }
  assert.deepEqual(await resolveDrawImage(file, context), PNG)
  for (const ref of [path, '../secret.png', '..\\secret.png', 'C:\\secret.png', 'C:/secret.png', '/tmp/secret.png', 'https://image.example/a.png', 'file:///tmp/secret.png', 'base64://' + b64, 'a.png\0', { file }]) {
    await assert.rejects(resolveDrawImage(ref, context), /只接受/)
  }
  writeFileSync(path, '不是图片')
  await assert.rejects(resolveDrawImage(file, context), /不是可用的图片/)
  assert.equal(await resolveDrawImage(undefined, context), null)
})

function mediaHub(t) {
  sandbox(t)
  const cfg = normalize({ botQQ: BOT, ownerQQ: OWNER, enabled: false, dryRun: true, titleFilter: { enabled: false }, stickers: { collect: false }, allow: { private: ['10000002'], groups: ['123'] } })
  const hub = createHub({ dsh: {}, getConfig: () => cfg, log, onebot: {}, stickers: {} })
  t.after(() => hub.dispose())
  return hub
}
const send = (hub, buf, user = OWNER, group = '') => hub.onMessage({
  message_type: group ? 'group' : 'private', self_id: BOT, user_id: user, sender: { nickname: '测试' },
  ...(group ? { group_id: group } : {}), message_id: 1,
  message: [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }],
})

test('last 复用 hub 最近图片：群 / 私聊隔离，取当前聊天最新一张，不限定主人', async (t) => {
  const hub = mediaHub(t)
  await send(hub, PNG)
  await send(hub, PNG, OWNER, '123')
  await send(hub, OTHER, '10000002', '123')
  assert.deepEqual(await resolveDrawImage('last', { hub, chat: privateChat }), PNG)
  assert.deepEqual(await resolveDrawImage('对方最近发的图', { hub, chat: groupChat }), OTHER)
  await assert.rejects(resolveDrawImage('last', { hub, chat: { chatId: 'group:999' } }), /没有收到图片/)
})

test('last 保留同一条消息中照片 / 表情的先后顺序，不把更早的照片当最后一张', async (t) => {
  const hub = mediaHub(t)
  await hub.onMessage({ message_type: 'private', self_id: BOT, user_id: OWNER, sender: { nickname: '测试' }, message_id: 2,
    message: [
      { type: 'image', data: { file: 'base64://' + b64 } },
      { type: 'image', data: { file: 'base64://' + OTHER.toString('base64'), sub_type: 1 } },
    ],
  })
  assert.deepEqual(await hub.referenceImage(privateChat), OTHER)
})

test('last 沿用 30 分钟有效期，取不到图就报错', async (t) => {
  const hub = mediaHub(t)
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  await send(hub, PNG)
  now += 30 * 60_000
  await assert.rejects(resolveDrawImage('last', { hub, chat: privateChat }), /最近半小时没有收到图片/)
})

test('quote 复用 hub 引用解析缓存，按聊天隔离，支持私聊并保留短期有效期', async (t) => {
  sandbox(t)
  let now = 1_800_000_000_000, gets = 0
  t.mock.method(Date, 'now', () => now)
  const cfg = normalize({ enabled: true, botQQ: BOT, ownerQQ: OWNER, dryRun: true,
    merge: { enabled: true, waitSec: 3600, maxSec: 3600 },
    titleFilter: { enabled: false }, stickers: { collect: false }, allow: { groups: ['123', '456'] },
  })
  const hub = createHub({ dsh: {}, getConfig: () => cfg, log, stickers: {},
    hooks: { groupDecide: () => ({ reply: false }) },
    onebot: { call: async (action) => {
      assert.equal(action, 'get_msg')
      gets++
      return { sender: { user_id: OWNER }, message: [{ type: 'image', data: { file: 'base64://' + (gets === 2 ? OTHER : PNG).toString('base64') } }] }
    } },
  })
  t.after(() => hub.dispose())
  const quote = (group = '', id = '42') => hub.onMessage({
    message_type: group ? 'group' : 'private', self_id: BOT, user_id: OWNER, sender: { nickname: '测试' },
    ...(group ? { group_id: group } : {}), message_id: '99',
    message: [{ type: 'reply', data: { id } }, { type: 'text', data: { text: '参考引用的图' } }],
  })
  await quote('123')
  await quote('456') // 相同 message_id 在另一个聊天必须重新按该聊天解析。
  assert.equal(gets, 2)
  assert.deepEqual(await hub.referenceImage(groupChat, 'quote'), PNG)
  assert.deepEqual(await hub.referenceImage({ chatId: 'group:456' }, 'quote'), OTHER)
  await assert.rejects(hub.referenceImage(privateChat, 'quote'), /没有可用的引用图片/)
  await quote()
  assert.deepEqual(await hub.referenceImage(privateChat, 'quote'), PNG)
  assert.equal(gets, 3)
  assert.deepEqual(hub.recentMedia(privateChat.chatId), [], '引用图仍放原有引用缓存，不另存一份最近媒体')
  now += 30 * 60_000
  await assert.rejects(hub.referenceImage(privateChat, 'quote'), /没有可用的引用图片/)
})

function drawTool(cfg, overrides = {}) {
  let build
  const generated = [], sent = [], events = [], references = [], prompts = []
  const hub = {
    turnSendersAllOwner: () => true,
    sendText: async () => ({ message_id: 1 }),
    referenceImage: async (chat, source) => { references.push({ chat, source }); return PNG },
    sendSegments: async (...args) => { sent.push(args); return { message_id: 1 } },
    canSeeImages: async () => false,
    ...overrides,
  }
  imagegenModule.setup({ config: () => cfg, log, dsh: {}, lazy: () => ({ addEvent: (event) => events.push(event) }),
    route() {}, on: (event, fn) => { if (event === 'prompt') prompts.push(fn) }, tool: (fn) => { build = fn },
    core: { hub, local: { active: () => true, call: async (slot, args) => { generated.push({ slot, args }); return OTHER } } },
  })
  return { tool: build({ chat: privateChat, sessionId: 'img-test' }), generated, sent, events, references, prompt: (content, chat) => prompts.reduce((out, fn) => fn(out, { chat, sessionId: 'img-test' }), content) }
}

test('qq_draw_image 的 image 可选；quote 来源传递；沿用发送、存盘、经历和 seeOwn', async (t) => {
  const dir = sandbox(t), cfg = config({ seeOwn: false })
  const s = drawTool(cfg)
  assert.ok(!s.tool.parameters.required.includes('image'))
  const out = await s.tool.execute({ prompt: '换个颜色', image: 'quote' })
  assert.equal(out.ok, true, out.message)
  assert.deepEqual(s.references, [{ chat: privateChat, source: 'quote' }])
  assert.equal(s.generated[0].args.image, b64)
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0][0], privateChat.chatId)
  assert.equal(s.sent[0][1][0].data.file, 'base64://' + OTHER.toString('base64'))
  assert.deepEqual(readFileSync(out.path), OTHER)
  assert.equal(readdirSync(join(dir, 'imagegen')).length, 1)
  assert.match(s.events[0].text, /^参考了一张图画了/)
  assert.equal(s.events[0].about, OWNER)
  assert.deepEqual(s.events[0].tags, ['画画'])
  assert.equal(out.image, undefined)
  assert.doesNotMatch(out.message, /已保存到本机/)
  const plain = await s.tool.execute({ prompt: '新画' })
  assert.equal(plain.ok, true)
  assert.match(s.events[1].text, /^按提示词画了一张图/)
  assert.equal(s.generated[1].args.image, undefined)
})

test('ownerOnly 和 img2img 在读图前检查；拒绝时不生成、不发送、不记经历', async (t) => {
  sandbox(t)
  for (const [cfg, overrides, message] of [
    [config(), { turnSendersAllOwner: () => false }, /只给主人/],
    [config({ img2img: false }), {}, /参考图功能已关闭/],
  ]) {
    const s = drawTool(cfg, overrides)
    const out = await s.tool.execute({ prompt: '猫', image: 'last' })
    assert.equal(out.ok, false)
    assert.match(out.message, message)
    assert.equal(s.references.length + s.generated.length + s.sent.length + s.events.length, 0)
  }
  let calls = 0
  const gen = createImageGen({ getConfig: () => config({ img2img: false }), log, local: { active: () => true, call: async () => { calls++; return PNG } } })
  await assert.rejects(gen.generate('猫', { image: PNG }), /参考图功能已关闭/)
  assert.equal(calls, 0)
  assert.equal(normalize({}).imageGen.img2img, true)
})

test('工具拒绝任意路径，不调用生成服务，也不发送或记成功经历', async (t) => {
  sandbox(t)
  const s = drawTool(config())
  const out = await s.tool.execute({ prompt: '猫', image: 'C:\\private\\secret.png' })
  assert.equal(out.ok, false)
  assert.match(out.message, /不接受路径或网址/)
  assert.equal(s.references.length + s.generated.length + s.sent.length + s.events.length, 0)
})

test('发送失败沿用原流程：不保存画作、不记成功经历', async (t) => {
  const dir = sandbox(t), s = drawTool(config(), { sendSegments: async () => false })
  const out = await s.tool.execute({ prompt: '猫', image: 'last' })
  assert.equal(out.ok, false)
  assert.match(out.message, /没有发到 QQ/)
  assert.equal(s.events.length, 0)
  assert.ok(!readdirSync(dir).includes('imagegen'))
})

test('绘图说明区分本轮权限与参考图来源，工具定义不随请求者改变', t => {
  sandbox(t)
  const owner = drawTool(config()).tool
  const guest = drawTool(config(), { turnSendersAllOwner: () => false }).tool
  assert.equal(owner.description, guest.description)
  assert.deepEqual(owner.parameters, guest.parameters)
  assert.match(owner.description, /群聊和私聊都支持绘图/)
  assert.match(owner.description, /不要沿用旧轮次的拒绝结论/)
  assert.match(owner.parameters.properties.image.description, /引用机器人的文字回复不等于引用原图/)
  assert.match(owner.parameters.properties.image.description, /只有确定最近一张就是目标图时才用 last/)
})

test('引用文字缺图时不静默改用 last 或无参考生成；新请求可使用明确底图', async t => {
  sandbox(t)
  const sources = []
  const s = drawTool(config(), { referenceImage: async (_chat, source) => {
    sources.push(source)
    if (source === 'quote') throw new Error('当前聊天没有可用的引用图片，请引用带图的消息再试')
    return PNG
  } })
  const missing = await s.tool.execute({ prompt: '修改这张图', image: 'quote' })
  assert.equal(missing.ok, false)
  assert.match(missing.message, /没有可用的引用图片/)
  assert.deepEqual(sources, ['quote'])
  assert.equal(s.generated.length + s.sent.length + s.events.length, 0)
  const retry = await s.tool.execute({ prompt: '修改刚刚单独发送的目标图', image: 'last' })
  assert.equal(retry.ok, true, retry.message)
  assert.deepEqual(sources, ['quote', 'last'])
  assert.equal(s.generated.length, 1)
  assert.equal(s.generated[0].args.image, b64)
})


test('参考图提示追加在本条消息后，不改原消息、不改历史或工具前缀', t => {
  sandbox(t)
  const cfg = config()
  const owner = drawTool(cfg), guest = drawTool(cfg, { turnSendersAllOwner: () => false })
  const original = [{ type: 'text', text: '请改这张图' }, { type: 'image', attachment: 'test-image' }]
  const out = owner.prompt(original, groupChat), text = out.at(-1).text
  assert.match(text, /新画以请求者指定的人物或作品为准.*优先用目标图旁的 msg 编号/)
  assert.match(text, /不能省略参考图生成一张新图来代替/)
  assert.deepEqual(out.slice(0, -1), original)
  assert.equal(original.length, 2)
  assert.equal(text, guest.prompt(original, groupChat).at(-1).text)
  assert.equal(text, owner.prompt(original, privateChat).at(-1).text)
  assert.doesNotMatch(text, new RegExp(OWNER))
  assert.deepEqual(owner.prompt(original, { kind: 'system' }), original)
})

const sendReference = (hub, mid, buffers, user = OWNER, group = '123') => hub.onMessage({
  message_type: group ? 'group' : 'private', self_id: BOT, user_id: user, sender: { nickname: '测试' },
  ...(group ? { group_id: group } : {}), message_id: mid,
  message: buffers.map((buf, i) => ({ type: 'image', data: { file: 'base64://' + buf.toString('base64'), sub_type: i ? 1 : 0 } })),
})

test('msg 绑定具体消息图片；群友插图后仍取原图，last 保持旧语义', async t => {
  const hub = mediaHub(t)
  await sendReference(hub, '-101', [PNG])
  await sendReference(hub, '102', [OTHER], '10000002')
  assert.deepEqual(await resolveDrawImage('msg:-101:1', { hub, chat: groupChat }), PNG)
  assert.deepEqual(await resolveDrawImage('last', { hub, chat: groupChat }), OTHER)
  assert.deepEqual(await resolveDrawImage('msg:102:1', { hub, chat: groupChat }), OTHER)
  await assert.rejects(resolveDrawImage('msg:-101:1', { hub, chat: privateChat }), /不在当前聊天/)
  await assert.rejects(resolveDrawImage('msg:-101:2', { hub, chat: groupChat }), /指定图片/)
  await assert.rejects(resolveDrawImage('msg:999999:1', { hub, chat: groupChat }), /指定图片/)
})

test('msg 按原消息顺序区分照片与表情，失效后不回退到其他图片', async t => {
  const hub = mediaHub(t)
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  await sendReference(hub, '201', [PNG, OTHER])
  assert.deepEqual(await resolveDrawImage('msg:201:1', { hub, chat: groupChat }), PNG)
  assert.deepEqual(await resolveDrawImage('msg:201:2', { hub, chat: groupChat }), OTHER)
  now += 29 * 60_000
  await sendReference(hub, '202', [OTHER])
  now += 60_000
  await assert.rejects(resolveDrawImage('msg:201:1', { hub, chat: groupChat }), /已过期/)
  assert.deepEqual(await resolveDrawImage('last', { hub, chat: groupChat }), OTHER)
  await sendReference(hub, '203', [PNG])
  for (let i = 0; i < 6; i++) await sendReference(hub, String(300 + i), [OTHER])
  await assert.rejects(resolveDrawImage('msg:203:1', { hub, chat: groupChat }), /缓存淘汰/)
})

test('msg 随原缓存恢复；旧格式缓存仍支持 last，不凭空补编号', async t => {
  const hub = mediaHub(t)
  await sendReference(hub, '401', [PNG, OTHER])
  hub.dispose()
  const cfg = normalize({ botQQ: BOT, ownerQQ: OWNER, enabled: false, allow: { groups: ['123'] } })
  const restored = createHub({ dsh: {}, getConfig: () => cfg, log, onebot: {}, stickers: {} })
  t.after(() => restored.dispose())
  assert.deepEqual(await resolveDrawImage('msg:401:1', { hub: restored, chat: groupChat }), PNG)
  assert.deepEqual(await resolveDrawImage('msg:401:2', { hub: restored, chat: groupChat }), OTHER)
  restored.dispose()
  const file = join(process.env.AURABOT_DATA_DIR, 'recent-media.json')
  const legacy = JSON.parse(readFileSync(file, 'utf8'))
  for (const item of legacy[groupChat.chatId]) { delete item.messageId; delete item.imageIndex }
  writeFileSync(file, JSON.stringify(legacy))
  const old = createHub({ dsh: {}, getConfig: () => cfg, log, onebot: {}, stickers: {} })
  t.after(() => old.dispose())
  assert.deepEqual(await resolveDrawImage('last', { hub: old, chat: groupChat }), OTHER)
  await assert.rejects(resolveDrawImage('msg:401:1', { hub: old, chat: groupChat }), /指定图片/)
})

test('精确图片编号沿用权限、发送和存图流程，不获权不读图', async t => {
  sandbox(t)
  const allowed = drawTool(config())
  const result = await allowed.tool.execute({ prompt: '改这张图', image: 'msg:-501:2' })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(allowed.references, [{ chat: privateChat, source: 'msg:-501:2' }])
  const denied = drawTool(config(), { turnSendersAllOwner: () => false })
  assert.equal((await denied.tool.execute({ prompt: '改图', image: 'msg:-501:2' })).ok, false)
  assert.equal(denied.references.length + denied.generated.length, 0)
})

test('标签紧贴对应图片，发送者/编号只进入新消息，未知来源不误标', t => {
  sandbox(t)
  const recent = [
    { messageId: '-601', imageIndex: 1, userId: OWNER },
    { messageId: '602', imageIndex: 1, userId: '10000002' },
  ]
  const s = drawTool(config(), { recentMedia: () => recent })
  const original = [
    { type: 'text', text: '主人要求二次元化，群友随后发了无关图' },
    { type: 'image', name: 'qqref-602-1', data: 'other' },
    { type: 'image', name: 'qqref--601-1', data: 'target' },
    { type: 'image', name: 'qq-602-1', data: 'forwarded-without-binding' },
  ]
  const out = s.prompt(original, groupChat)
  assert.equal(out[0], original[0])
  assert.equal(out[1].text, '【聊天图片 msg:602:1，发送者 QQ 10000002】')
  assert.equal(out[2], original[1])
  assert.equal(out[3].text, `【聊天图片 msg:-601:1，发送者 QQ ${OWNER}】`)
  assert.equal(out[4], original[2])
  assert.equal(out[5], original[3], '未绑定的合并转发图不借用同名附件编号')
  assert.equal(original.length, 4)
  const description = s.tool.description, parameters = JSON.stringify(s.tool.parameters)
  recent.push({ messageId: '603', imageIndex: 1, userId: '10000003' })
  s.prompt([{ type: 'image', name: 'qqref-603-1' }], groupChat)
  assert.equal(s.tool.description, description)
  assert.equal(JSON.stringify(s.tool.parameters), parameters)
})
