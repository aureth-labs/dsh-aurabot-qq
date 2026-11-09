// 故事板抽帧：不用 ffmpeg，也不用下载视频流 —— B 站自己给每个视频生成了「故事板」拼图，
// 按时间点从拼图里裁一块下来就能看画面。比 ffmpeg 从 CDN 拉流定位轻得多，
// 而且是**没装 ffmpeg 时的兜底**（原来的 vision.js 依赖本机 ffmpeg）。
//
// 接口：api.bilibili.com/x/player/videoshot（要 WBI 签名）
//   index:    [{timestamp}, ...] 每块的时刻（秒 / 毫秒两种单位都见过，只能靠和时长比较来判断）
//   pvdata:   index 为空时的兜底（指向一个大端 uint16 秒数数组）
//   image:    拼图地址数组，一张拼图里排了若干块
//   img_x_size / img_y_size: 单块的宽高（默认 480x270）
//
// ⚠️ index 会偶发返回空（实测约 25%）：先用 pvdata 兜底，两个都空才重试。
// ⚠️ 多 P 视频的故事板通常只覆盖第 1P，别拿 P2 的时长去算目标时刻。

const TILE_W = 480
const TILE_H = 270
const FRAME_MAX = 6

/** 把 index 归一成 [[秒, 块序号], ...]。时间单位靠和时长比较判断，别用绝对值。 */
export function snapshotEntries(data, duration = 0) {
  const raws = []
  const list = Array.isArray(data?.index) ? data.index : []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    const ts = item && typeof item === 'object' ? item.timestamp : item
    const n = Number(ts)
    if (Number.isFinite(n)) raws.push([n, i])
  }
  if (!raws.length) return []
  const biggest = Math.max(...raws.map(([v]) => v))
  const looksMs = duration > 0 && biggest > duration * 1.5
  const scale = looksMs ? 1000 : 1
  return raws.map(([v, i]) => [v / scale, i])
}

/** 目标时刻：传了 at 就用它（夹在覆盖范围内），否则按覆盖长度均分。 */
export function frameTargets(coveredSec, { count = 3, at = null } = {}) {
  const covered = Math.max(0, Number(coveredSec) || 0)
  if (!covered) return []
  if (Array.isArray(at) && at.length) {
    return at.slice(0, FRAME_MAX).map((t) => Math.min(Math.max(0, Number(t) || 0), Math.max(0, covered - 0.1)))
  }
  const n = Math.max(1, Math.min(FRAME_MAX, Math.round(Number(count) || 3)))
  const out = []
  for (let i = 0; i < n; i++) out.push((covered * (i + 1)) / (n + 1))
  return out
}

/** 从拼图里算出一张能装几块（列 × 行）。 */
export function tilesPerSheet(sheetWidth, sheetHeight, tw = TILE_W, th = TILE_H) {
  const cols = Math.max(1, Math.floor(sheetWidth / tw))
  const rows = Math.max(1, Math.floor(sheetHeight / th))
  return cols * rows
}

/** 第 tileIndex 块在拼图里的位置（列, 行, 宽, 高）。 */
export function tileRect(tileIndex, { cols, tw = TILE_W, th = TILE_H }) {
  const c = Math.max(1, Number(cols) || 1)
  const col = tileIndex % c
  const row = Math.floor(tileIndex / c)
  return { x: col * tw, y: row * th, w: tw, h: th }
}

/** 从故事板数据里挑出「最接近目标时刻」的那几块：[[块序号, 实际时刻], ...] */
export function pickTiles(entries, targets) {
  const out = []
  for (const t of targets) {
    let best = null
    let bestD = Infinity
    for (const [ts, idx] of entries) {
      const d = Math.abs(ts - t)
      if (d < bestD) { bestD = d; best = [idx, ts] }
    }
    if (best) out.push(best)
  }
  return out
}

/**
 * 解析一个视频的故事板。
 * @param {(url:string)=>Promise<any>} reqJson 已带签名的 GET
 * @param {{bvid?:string, aid?:string, cid:number}} v
 * @returns {Promise<{ok:boolean, reason?:string, sheets?:string[], tw?:number, th?:number, entries?:Array, covered?:number, pages?:number}>}
 */
export async function fetchStoryboard(reqJson, { bvid, aid, cid, duration = 0, coveredSec = 0 }) {
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt++) {
    let data = null
    try {
      const q = new URLSearchParams({ ...(bvid ? { bvid } : { aid: String(aid) }), cid: String(cid), json_index: '1' })
      data = await reqJson('https://api.bilibili.com/x/player/videoshot?' + q.toString())
    } catch (error) {
      lastError = error
    }
    const covered = Number(coveredSec) || Number(duration) || 0
    let entries = snapshotEntries(data, covered)
    if (!entries.length && data?.pvdata) {
      entries = await entriesFromPvdata(reqJson, data, covered).catch(() => [])
    }
    const sheets = Array.isArray(data?.image) ? data.image.filter(Boolean) : []
    if (entries.length && sheets.length) {
      const storyMax = Math.max(...entries.map(([ts]) => ts), 0)
      return {
        ok: true,
        sheets,
        tw: Number(data.img_x_size) || TILE_W,
        th: Number(data.img_y_size) || TILE_H,
        entries,
        covered: storyMax > 0 ? Math.min(covered || storyMax, storyMax) : covered,
      }
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1000))
  }
  return { ok: false, reason: lastError ? lastError.message : '取不到画面快照（试了 2 次）' }
}

/** index 为空时的兜底：pvdata 指向一个大端 uint16 秒数数组。 */
async function entriesFromPvdata(reqJson, data, covered) {
  const raw = await reqJson(String(data.pvdata), { raw: true })
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || [])
  const out = []
  for (let i = 0; i + 1 < buf.length; i += 2) out.push([buf.readUInt16BE(i), out.length])
  const biggest = out.length ? Math.max(...out.map(([v]) => v)) : 0
  const scale = covered > 0 && biggest > covered * 1.5 ? 1000 : 1
  return out.map(([v, i]) => [v / scale, i])
}
