// 翻唱：截取位置、音色列表、网易云加密和 Cookie 解析、点歌的前置检查、/sing 命令。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { nudgeMoodAfterSong } from '../src/modules/song/index.js'

let studio
let netease
let commands
let normalize

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-song-'))
  studio = await import('../src/song/studio.js')
  netease = await import('../src/song/netease.js')
  commands = await import('../src/chat/commands.js')
  ;({ normalize } = await import('../src/core/config.js'))
})

/** 合成一段 16-bit 单声道 PCM：每段给振幅（可传函数），方波让 RMS 等于振幅。 */
function pcmOf(sections, sampleRate = 200) {
  const totalSec = sections.reduce((sum, s) => sum + s.sec, 0)
  const buf = Buffer.alloc(totalSec * sampleRate * 2)
  let index = 0
  for (const section of sections) {
    const n = Math.round(section.sec * sampleRate)
    for (let i = 0; i < n; i++) {
      const amp = typeof section.amp === 'function' ? section.amp(i / sampleRate) : section.amp
      const v = Math.round((i % 2 ? amp : -amp) * 32767)
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), (index + i) * 2)
    }
    index += n
  }
  return buf
}

test('截一段：歌比上限长就从副歌附近截，短歌整首', () => {
  assert.deepEqual(studio.clipWindow(264, 120), { start: 79, length: 120 })
  assert.deepEqual(studio.clipWindow(264, 120, 'head'), { start: 0, length: 120 })
  assert.deepEqual(studio.clipWindow(90, 120), { start: 0, length: 90 })
  // 不会截到歌尾外面
  assert.deepEqual(studio.clipWindow(130, 120), { start: 10, length: 120 })
})

test('截一段：分析到的副歌入口优先，越界夹到歌尾，head 不受影响', () => {
  assert.deepEqual(studio.clipWindow(264, 120, 'auto', 60), { start: 60, length: 120 })
  assert.deepEqual(studio.clipWindow(264, 120, 'auto', 999), { start: 144, length: 120 })
  assert.deepEqual(studio.clipWindow(264, 120, 'auto', null), { start: 79, length: 120 }, '分析失败回退 30%')
  assert.deepEqual(studio.clipWindow(264, 120, 'head', 60), { start: 0, length: 120 })
})

test('副歌定位：能量找响段，重复段优先于更响的一次性桥段', () => {
  // 40s 前奏 + 20s 主歌 + 30s 副歌 + 20s 主歌 + 30s 副歌 + 20s 尾奏
  const plain = pcmOf([
    { sec: 40, amp: 0.08 }, { sec: 20, amp: 0.12 }, { sec: 30, amp: 0.65 },
    { sec: 20, amp: 0.12 }, { sec: 30, amp: 0.65 }, { sec: 20, amp: 0.08 },
  ])
  const start = studio.estimateChorusStart(plain, { sampleRate: 200, maxSec: 60 })
  assert.equal(start, 60, '应落在第一段副歌入口（前奏 40s + 主歌 20s）')

  // 两段低一点的副歌重复出现，后面跟着一段更响但不重复的桥段：应选副歌，不能被桥段带偏
  const wave = (t) => 0.5 + 0.06 * Math.sin(t * 2 * Math.PI / 3)
  const repeated = pcmOf([
    { sec: 30, amp: 0.08 }, { sec: 20, amp: wave }, { sec: 30, amp: 0.08 },
    { sec: 20, amp: wave }, { sec: 20, amp: 0.7 }, { sec: 30, amp: 0.08 },
  ])
  const chorus = studio.estimateChorusStart(repeated, { sampleRate: 200, maxSec: 40 })
  assert.ok((chorus >= 28 && chorus <= 34) || (chorus >= 78 && chorus <= 84), `应落在某段副歌入口，实际 ${chorus}`)

  // 静音 / 太短 / 没有明显响段：返回 null，交给 clipWindow 回退
  assert.equal(studio.estimateChorusStart(Buffer.alloc(160 * 200 * 2), { sampleRate: 200, maxSec: 60 }), null)
  assert.equal(studio.estimateChorusStart(plain, { sampleRate: 200, maxSec: 200 }), null)
  assert.equal(studio.estimateChorusStart(Buffer.alloc(0), { sampleRate: 200, maxSec: 60 }), null)
})

test('副歌定位：maxSec=120 时 15 秒副歌也能检出（minRun 上限 12 秒）', () => {
  // 40s 前奏 + 20s 主歌 + 15s 副歌 + 20s 主歌 + 15s 副歌 + 90s 尾奏
  const pcm = pcmOf([
    { sec: 40, amp: 0.08 }, { sec: 20, amp: 0.12 }, { sec: 15, amp: 0.65 },
    { sec: 20, amp: 0.12 }, { sec: 15, amp: 0.65 }, { sec: 90, amp: 0.08 },
  ])
  assert.equal(studio.estimateChorusStart(pcm, { sampleRate: 200, maxSec: 120 }), 60)
})

test('副歌定位：121~124 秒的歌也要进入分析，不再被 maxSec+4 挡掉', () => {
  // 122s：1s 前奏 + 15s 副歌（从 1s 开始）+ 106s 尾奏；clip 最多 120s，起点夹到 2s 内
  const pcm = pcmOf([{ sec: 1, amp: 0.08 }, { sec: 15, amp: 0.65 }, { sec: 106, amp: 0.08 }])
  const start = studio.estimateChorusStart(pcm, { sampleRate: 200, maxSec: 120 })
  assert.ok(Number.isInteger(start), `122 秒歌应能分析，实际 ${start}`)
  assert.ok(start <= 2, `起点必须给 120 秒留够空间，实际 ${start}`)
})

test('cutFirst：注入假 readPcm，成功用副歌入口、失败回退 30%', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'song-cut-'))
  const song = join(dir, 'song.mp3')
  // 264s：40 前奏 + 20 主歌 + 30 副歌（60s 起）+ 20 主歌 + 30 副歌 + 124 尾奏
  const pcm = pcmOf([
    { sec: 40, amp: 0.08 }, { sec: 20, amp: 0.12 }, { sec: 30, amp: 0.65 },
    { sec: 20, amp: 0.12 }, { sec: 30, amp: 0.65 }, { sec: 124, amp: 0.08 },
  ], 8000)
  const calls = []
  const run = async (cmd, args) => { calls.push({ cmd, args }) }
  const base = {
    song, dir, clip: null, maxSec: 120, clipStart: 'auto',
    probeDuration: async () => 264, run, ffmpegPath: 'ffmpeg',
    log: { info() {}, debug() {} },
  }
  const ok = await studio.cutFirstWith({ ...base, readPcm: async () => pcm })
  assert.equal(ok.cut, true)
  assert.equal(ok.length, 120)
  let args = calls.at(-1).args
  assert.equal(args[args.indexOf('-ss') + 1], '60', '应使用分析出的副歌入口 60s')

  calls.length = 0
  const fallback = await studio.cutFirstWith({ ...base, readPcm: async () => { throw new Error('分析失败') } })
  assert.equal(fallback.cut, true)
  assert.equal(fallback.length, 120)
  args = calls.at(-1).args
  assert.equal(args[args.indexOf('-ss') + 1], '79', '分析失败回退 264s 的 30%')

  calls.length = 0
  await studio.cutFirstWith({ ...base, clipStart: 'head', readPcm: async () => { throw new Error('不该被调用') } })
  args = calls.at(-1).args
  assert.equal(args[args.indexOf('-ss') + 1], '0', 'head 不分析')
})

test('readPcm 会消费 stderr（改动后的源码契约）', () => {
  const src = readFileSync(new URL('../src/song/studio.js', import.meta.url), 'utf8')
  const start = src.indexOf('async function readPcm')
  const end = src.indexOf('async function meanVolume', start)
  assert.ok(start >= 0 && end > start)
  assert.match(src.slice(start, end), /c\.stderr\.on\('data'/)
})

test('挑歌：钢琴版、伴奏这类排到最后，点歌时本来就要钢琴版就不排', () => {
  const list = [{ id: 1, name: '稻香 (钢琴版)' }, { id: 2, name: '稻香', alias: '伴奏' }, { id: 3, name: '稻香(治愈版)' }, { id: 4, name: '稻香' }]
  assert.deepEqual(studio.rankCandidates(list, '稻香').map((x) => x.id), [3, 4, 1, 2])
  assert.deepEqual(studio.rankCandidates(list, '稻香 钢琴版').map((x) => x.id), [1, 2, 3, 4])
  assert.ok(studio.VOCAL_MIN_DB < -40)
})

test('清唱：不带伴奏输入，翻唱照常混音', () => {
  const dry = studio.mixArgs({ vocals: 'v.wav', vol: 1, iv: 0.8, out: 'o.mp3' })
  assert.equal(dry.filter((a) => a === '-i').length, 1)
  assert.ok(!dry.join(' ').includes('amix'))
  const full = studio.mixArgs({ vocals: 'v.wav', inst: 'i.wav', vol: 1, iv: 0.8, out: 'o.mp3' })
  assert.equal(full.filter((a) => a === '-i').length, 2)
  assert.ok(full.join(' ').includes('amix'))
})

test('音色列表：models 目录里的 .pth，配同名 .index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voices-'))
  for (const n of ['voiceB.pth', 'voiceA.pth', 'added_IVF_voiceA.index', 'readme.txt']) writeFileSync(join(dir, n), 'x')
  const v = studio.listVoices(dir)
  assert.deepEqual(v.map((x) => x.id), ['voiceA', 'voiceB'])
  assert.ok(v[0].index.endsWith('added_IVF_voiceA.index'))
  assert.equal(v[1].index, '')
  assert.deepEqual(studio.listVoices(join(dir, 'nope')), [])
})

test('网易云：weapi 加密格式、Cookie 只取 MUSIC_U', () => {
  const f = netease.weapi({ s: '小幸运' })
  assert.match(f.params, /^[A-Za-z0-9+/=]+$/)
  assert.match(f.encSecKey, /^[0-9a-f]{256}$/)
  assert.notEqual(netease.weapi({ s: 'x' }).encSecKey, netease.weapi({ s: 'x' }).encSecKey, '每次随机密钥')
  assert.equal(netease.musicU('os=pc; MUSIC_U=abc123; __csrf=x'), 'abc123')
  assert.equal(netease.musicU('abc123'), 'abc123')
  assert.equal(netease.musicU('foo=bar'), '')
  assert.equal(netease.musicU(''), '')
})

test('点歌前置检查：没打开、没装好、没说歌名', () => {
  let cfg = normalize({ song: { enabled: false, root: mkdtempSync(join(tmpdir(), 'rvc-')) } })
  const s = studio.createSongStudio({ getConfig: () => cfg, log: { info() {}, warn() {}, debug() {} }, sendVoiceFile: async () => {} })
  assert.match(s.request({ song: '小幸运', chatId: 'private:1' }).message, /还没打开/)
  cfg = normalize({ song: { ...cfg.song, enabled: true } })
  const r = s.request({ song: '小幸运', chatId: 'private:1' })
  assert.equal(r.ok, false)
  assert.match(r.message, /还没装好/)
  const st = s.status()
  assert.equal(st.ready, false)
  assert.equal(st.parts.python, false)
  assert.match(st.message, /导入/)
})

// env/Scripts/python.exe 在 Linux 上只是一行「转给真解释器」的脚本；venv 被删了文件还在，
// 只判存在就会报「装好了」，一点就 127。这里造一个 shim 转发给不存在的路径。
function makeShim(root, body) {
  const dir = join(root, 'env', 'Scripts')
  mkdirSync(dir, { recursive: true })
  const shim = join(dir, 'python.exe')
  writeFileSync(shim, body)
  chmodSync(shim, 0o755)
  return shim
}

test('翻唱环境：shim 在、转发到的解释器没了，不能算装好', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rvc-'))
  const shim = makeShim(root, '#!/bin/bash\nexec /nonexistent/sep-venv/bin/python "$@"\n')
  const cfg = normalize({ song: { enabled: true, root } })
  const s = studio.createSongStudio({ getConfig: () => cfg, log: { info() {}, warn() {}, debug() {} }, sendVoiceFile: async () => {} })
  const st = s.status()
  assert.equal(st.parts.python, false, `${dirname(shim)} 里的 shim 转发到的解释器不存在，不能报就绪`)
  assert.equal(st.ready, false)
})

test('翻唱环境：解释器真能跑才算 python 就绪，包缺了分离器仍不算', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rvc-'))
  makeShim(root, '#!/bin/bash\necho 1\n')
  const cfg = normalize({ song: { enabled: true, root } })
  const s = studio.createSongStudio({ getConfig: () => cfg, log: { info() {}, warn() {}, debug() {} }, sendVoiceFile: async () => {} })
  const st = s.status()
  assert.equal(st.parts.python, true)
  assert.equal(st.parts.separator, false, '没放 audio-separator.exe，分离器不能报就绪')
  assert.equal(st.ready, false)
})

test('Linux 一键安装从 uv 到 ffmpeg 走原生路径，保留残留的手工安装文件', { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-song-linux-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const oldPython = makeShim(root, '#!/bin/sh\nexit 127\n')
  const p = studio.pathsOf(root, { platform: 'linux', allowLegacy: false })
  assert.equal(studio.pathsOf(root, { platform: 'linux' }).python, oldPython)
  assert.equal(p.python, join(root, 'env', 'bin', 'python'))
  assert.equal(p.separatorExe, join(root, 'env', 'bin', 'audio-separator'))
  assert.equal(studio.checkRoot('/srv/aurabot/rvc', 'linux').ok, true)
  assert.equal(studio.checkRoot('C:\\Aurabot\\rvc', 'linux').ok, false)

  const separatorModel = Object.keys(studio.SEPARATOR_FILES)[0]
  const config = normalize({ song: { root, pypiMirror: 'off', separatorModel } })
  const zip = join(root, 'downloads', 'applio.zip')
  const uv = join(root, 'bin', 'uv')
  const ffmpegSource = join(root, 'ffmpeg-source')
  const localFiles = [zip, uv, ffmpegSource, join(p.separatorModels, 'download_checks.json'),
    ...studio.SEPARATOR_FILES[separatorModel].map(([name]) => join(p.separatorModels, name))]
  for (const file of localFiles) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, file === zip ? 'PK' : 'fixture')
  }
  const commands = []
  let finish
  const finished = new Promise((resolve) => { finish = resolve })
  const s = studio.createSongStudio({
    platform: 'linux',
    getConfig: () => config,
    log: {
      info: (message) => { if (message === '翻唱环境装好了') finish() },
      warn: (message, error) => finish(error || message),
    },
    runInstallCommand: async (command, args) => {
      commands.push([command, args])
      if (args[0] === 'venv') {
        mkdirSync(dirname(p.python), { recursive: true })
        writeFileSync(p.python, 'fixture')
      } else if (args[1] === 'zipfile') {
        const unpacked = join(args.at(-1), 'Applio-unpacked')
        for (const relative of ['core.py', 'requirements-engine.txt', 'rvc/models/predictors/rmvpe.pt',
          'rvc/models/embedders/contentvec/config.json', 'rvc/models/embedders/contentvec/pytorch_model.bin']) {
          const file = join(unpacked, relative)
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, 'fixture')
        }
      } else if (args[0] === '-c') return ffmpegSource
      return ''
    },
  })
  s.install()
  assert.equal(await finished, undefined)
  assert.equal(s.status().install.ok, true)
  assert.deepEqual(commands.map(([command, args]) => [command, args[0]]), [[uv, 'venv'], [p.python, '-m'], [uv, 'pip'], [p.python, '-c']])
  assert.ok(commands[2][1].includes('audio-separator[cpu]'))
  assert.ok(existsSync(oldPython))
  assert.equal(readFileSync(p.ffmpeg, 'utf8'), 'fixture')
})

test('/sing：歌名和变调', async () => {
  const calls = []
  const deps = { getConfig: () => normalize({}), setConfig() {}, song: { request: (o) => { calls.push(o); return { ok: true, message: '开始准备' } } } }
  const msg = { kind: 'private', chatId: 'private:1', userId: '1' }
  assert.equal(await commands.runCommand(commands.parseCommand('/sing 小幸运 田馥甄 +12'), msg, deps), '开始准备')
  assert.deepEqual(calls[0], { song: '小幸运 田馥甄', pitch: 12, chatId: 'private:1' })
  await commands.runCommand(commands.parseCommand('/唱 晴天'), msg, deps)
  assert.deepEqual(calls[1], { song: '晴天', pitch: undefined, chatId: 'private:1' })
  assert.match(await commands.runCommand(commands.parseCommand('/sing'), msg, deps), /唱哪首/)
})

// 测试用的小 zip 打包器：deflate 压缩；name 可以传 Buffer（模拟 Windows 上 GBK 编码的中文文件名）
async function makeZip(entries) {
  const { deflateRawSync, crc32 } = await import('node:zlib')
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8')
    const flags = Buffer.isBuffer(e.name) ? 0 : 0x800
    const data = deflateRawSync(e.data)
    const crc = crc32(e.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42)
    locals.push(lh, name, data)
    centrals.push(ch, name)
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
const fakePth = (n = 2) => Buffer.concat([Buffer.from('PK'), Buffer.alloc(n * 1024 * 1024, 7)])

test('导入音色：zip 里的 .pth 和 .index 自动识别，单个音色时 index 自动配对，中文文件名不乱码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-'))
  const gbkName = Buffer.from([0xd0, 0xa1, 0xd3, 0xe3, 0x2e, 0x70, 0x74, 0x68]) // 「小鱼.pth」的 GBK 编码
  const zip = await makeZip([
    { name: gbkName, data: fakePth() },
    { name: 'logs/added_IVF256_Flat_nprobe_1_v2.index', data: Buffer.from('idx') },
    { name: '__MACOSX/._x.pth', data: Buffer.from('junk') },
    { name: 'readme.txt', data: Buffer.from('hi') },
  ])
  const r = studio.importModels(dir, 'models.zip', zip)
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(r.added, ['小鱼'])
  const v = studio.listVoices(dir)
  assert.equal(v.length, 1)
  assert.equal(v[0].id, '小鱼')
  assert.ok(v[0].index.endsWith('小鱼.index'), '唯一的 index 自动配上')
})

test('导入音色：单个 .pth 直接导入；不是模型、不支持的格式会拒绝；可以删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-'))
  assert.equal(studio.importModels(dir, 'voiceX.pth', fakePth()).ok, true)
  assert.match(studio.importModels(dir, 'fake.pth', Buffer.from('hello')).message, /不是 RVC 模型/)
  assert.match(studio.importModels(dir, 'song.mp3', Buffer.from('x')).message, /只支持/)
  assert.throws(() => studio.importModels(dir, 'broken.zip', Buffer.from('not a zip')), /不是 zip/)
  assert.deepEqual(studio.listVoices(dir).map((x) => x.id), ['voiceX'])
  assert.equal(studio.deleteVoice(dir, 'voiceX').ok, true)
  assert.deepEqual(studio.listVoices(dir), [])
  // 文件名里带路径也只取文件名，不会写到 models 目录外面
  assert.equal(studio.importModels(dir, '..\\..\\evil.pth', fakePth()).ok, true)
  assert.deepEqual(studio.listVoices(dir).map((x) => x.id), ['evil'])
})

test('安装：报错翻译成人话、安装位置检查、列出各个盘', async (t) => {
  assert.match(studio.explainInstallError('spawn uv ENOENT'), /找不到需要的程序（uv）/)
  assert.match(studio.explainInstallError('error sending request for url ... connection reset'), /国内镜像/)
  assert.match(studio.explainInstallError('30 秒没进度'), /超时/)
  assert.match(studio.explainInstallError('No space left on device'), /磁盘空间/)
  // #3：证书校验失败要说清是证书问题，并指向手动放置，不能笼统说网络断了
  const cert = studio.explainInstallError('URLError [SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate')
  assert.match(cert, /证书校验没通过/)
  assert.match(cert, /手动放置预训练文件/)
  assert.equal(studio.checkRoot('rvc').ok, false)
  assert.equal(studio.checkRoot('').ok, true)
  await t.test('Windows 安装位置检查和盘符列表', { skip: process.platform !== 'win32' && '安装位置检查和盘符列表依赖 Windows 盘符' }, () => {
    assert.match(studio.checkRoot('C:\\我的 文件\\rvc').warn, /中文或空格/)
    assert.ok(studio.checkRoot('C:\\Aurabot\\rvc').freeGB > 0)
    const drives = studio.listDrives()
    assert.ok(drives.some((d) => d.drive === 'C:' && d.root === 'C:\\Aurabot\\rvc' && d.totalGB > 0))
  })
  assert.equal(studio.INSTALL_STEPS.length, 6)
})

test('翻唱缓存只留最新的几个', async () => {
  const { utimesSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'cache-'))
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(dir, i + '.mp3'), 'x')
    utimesSync(join(dir, i + '.mp3'), new Date(1000 * i), new Date(1000 * i))
  }
  assert.equal(studio.pruneCache(dir, 2), 3)
  const { readdirSync } = await import('node:fs')
  assert.deepEqual(readdirSync(dir).sort(), ['3.mp3', '4.mp3'])
})

test('人声分离模型：手动导入要核对校验值；下载地址先给国内能下的', async () => {
  const { createHash } = await import('node:crypto')
  const { existsSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-sep-'))
  assert.equal(studio.importSeparator(dir, 'x.ckpt', Buffer.from('不是模型')).ok, false)
  const buf = Buffer.from('假的模型内容')
  studio.SEPARATOR_FILES['fake.ckpt'] = [['fake.ckpt', [], createHash('sha256').update(buf).digest('hex')]]
  const r = studio.importSeparator(dir, '随便叫啥.ckpt', buf)
  assert.equal(r.ok, true, r.message)
  assert.ok(existsSync(join(dir, 'fake.ckpt')), '按模型要的文件名存')
  delete studio.SEPARATOR_FILES['fake.ckpt']
  const links = studio.separatorLinks('model_bs_roformer_ep_317_sdr_12.9755.ckpt')
  assert.match(links[0], /^https:\/\/hf-mirror\.com\//)
  assert.ok(studio.UV_SOURCES[0].url.includes('mirrors.aliyun.com') && studio.UV_SOURCES[0].sha256)
})

test('下载源：自动模式下官方源慢就用国内镜像；老配置自动迁移', async () => {
  const fast = async () => ({ status: 200 })
  const down = async (url) => { if (url.includes('pytorch')) throw new Error('timeout'); return { status: 200 } }
  assert.equal(await studio.shouldUseCnMirror('auto', fast), false)
  assert.equal(await studio.shouldUseCnMirror('auto', down), true)
  assert.equal(await studio.shouldUseCnMirror('cn', fast), true)
  assert.equal(await studio.shouldUseCnMirror('off', down), false)
  assert.equal(normalize({}).song.pypiMirror, 'auto')
  assert.equal(normalize({ song: { pypiMirror: '' } }).song.pypiMirror, 'auto')
  assert.equal(normalize({ song: { pypiMirror: 'tuna' } }).song.pypiMirror, 'cn')
})

test('检查更新：Release Atom 连不上就走 GitHub API', async () => {
  const u = await import('../src/core/update.js')
  const seen = []
  const check = u.createUpdateChecker({ pkg: { version: '0.2.0', repository: 'https://github.com/a/b' }, fetchImpl: async (url) => { seen.push(url); if (url.includes('releases.atom')) throw new Error('reset'); return { ok: true, json: async () => [{ tag_name: 'v0.3.0', draft: false }] } } })
  const r = await check({ force: true })
  assert.equal(r.newer, true)
  assert.ok(seen[1].includes('api.github.com'))
})

test('翻唱失败那句话：让她自己说，提示词带上歌名和真实原因、明说别念内部信息', async () => {
  const { failPrompt } = await import('../src/modules/song/index.js')
  const p = failPrompt('雨爱', '翻唱环境不完整，在面板里点「重新检查」')
  assert.ok(p.includes('《雨爱》'))
  assert.ok(p.includes('翻唱环境不完整'))
  assert.ok(p.includes('不要念出来'))
  assert.ok(p.includes('[沉默]'))
})

test('翻唱失败那句话：清洗只留一句口语，[沉默] 和念了内部信息的都当没说话', async () => {
  const { cleanFailLine } = await import('../src/modules/song/index.js')
  assert.equal(cleanFailLine('  「这次嗓子有点哑，等我润润再来～」\n后面还有废话'), '这次嗓子有点哑，等我润润再来～')
  assert.equal(cleanFailLine('大肥鱼：刚没唱成，回头再试试？'), '刚没唱成，回头再试试？')
  assert.equal(cleanFailLine('**好，我记下了。**'), '好，我记下了。')
  assert.equal(cleanFailLine('[沉默]'), '')
  assert.equal(cleanFailLine('（沉默）'), '')
  assert.equal(cleanFailLine('   '), '')
  // 念了报错 / 路径 / 额度就不发这句，交给兜底
  assert.equal(cleanFailLine('下载失败：Error: ENOENT /root/x.mp3，额度不够'), '')
  // 太长截到第一个句末
  assert.equal(cleanFailLine('今天嗓子不太行呀，这个调太高了，我唱不上去，等我想想办法再录一次好不好。要是还不行，我回头自己练两天，练好了再给你唱一遍试试'), '今天嗓子不太行呀，这个调太高了，我唱不上去，等我想想办法再录一次好不好。')
})

test('翻唱完成的心情原因带上当前聊天，避免原因在所有聊天里消失', () => {
  const calls = []
  nudgeMoodAfterSong({ nudge: (...args) => calls.push(args) }, '小幸运', 'group:12345')
  assert.deepEqual(calls, [[8, '唱完了「小幸运」', 'group:12345']])
  assert.doesNotThrow(() => nudgeMoodAfterSong(null, '小幸运', 'private:1'))
})
