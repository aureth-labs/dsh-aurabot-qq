// 聊天流水里的图片（#540）：图段自带 url 的 rkey 一小时就过期，落盘只留 appid + fileid，
// 顺带记下消息 id，之后要用图得凭 id 去 get_msg 现取。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-chatlog-images-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ enabled: true, dryRun: false, workspaceDir: dir, voice: { enabled: false }, stickers: { enabled: false } })
  const hub = createHub({
    dsh: {},
    stickers: { match: () => null, segmentFor: () => null, pickForReply: () => null, markUsed: () => {} },
    getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, () => {}])),
    onebot: { async call() { return { status: 'ok' } } },
  })
  t.after(() => {
    hub.dispose()
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, dir }
}

/** 把这次跑出来的流水行全读出来（persona 子目录不一定，直接递归找 jsonl）。 */
function rowsOf(dir, seen = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) rowsOf(p, seen)
    else if (e.name.endsWith('.jsonl')) seen.push(...readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  }
  return seen
}

const imageSeg = (url, file = 'a.jpg') => ({ type: 'image', data: { url, file } })
const URL_WITH_RKEY = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=EhQabc123&rkey=DEADBEEF'

test('图片消息落盘只留 appid/fileid，不留会过期的 rkey', (t) => {
  const { hub, dir } = setup(t)
  const ok = hub.logChat('group:99', '某人', '[图片]', '1001', { images: [imageSeg(URL_WITH_RKEY)], mid: '4242' })
  assert.equal(ok, true)
  const [row] = rowsOf(dir)
  assert.equal(row.mid, '4242')
  assert.deepEqual(row.images, [{ appid: '1407', fileid: 'EhQabc123', file: 'a.jpg' }])
  assert.ok(!JSON.stringify(row).includes('rkey'), '流水里不该留 rkey')
})

test('没有图片的消息不写空字段', (t) => {
  const { hub, dir } = setup(t)
  hub.logChat('group:99', '某人', '你好', '1001', { mid: '7' })
  const [row] = rowsOf(dir)
  assert.equal(row.images, undefined)
  assert.equal(row.mid, '7')
})

test('取不到 fileid 的图段丢掉，最多记 4 张', (t) => {
  const { hub, dir } = setup(t)
  const segs = [
    imageSeg('https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=NOfileid'),
    ...[1, 2, 3, 4, 5].map((i) => imageSeg(`https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=F${i}`)),
  ]
  hub.logChat('group:99', '某人', '[图片]', '1001', { images: segs })
  const [row] = rowsOf(dir)
  assert.equal(row.images.length, 4)
  assert.deepEqual(row.images.map((i) => i.fileid), ['F1', 'F2', 'F3', 'F4'])
})
