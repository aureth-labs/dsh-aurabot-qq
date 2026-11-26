// 翻唱自动定变调（#10）：估原唱人声的中位基频，判断男声还是女声，再按她的声线定 0 / +12 / -12。
// 只用整八度：伴奏不跟着变调，平移非八度会和伴奏跑调。

const MIN_HZ = 60
const MAX_HZ = 700
const MALE_FEMALE_SPLIT = 165 // 中位基频低于这个算男声（成年男声唱歌多在 100～160 Hz，女声 200 Hz 以上）

/**
 * 用 YIN（累积均值归一化差分）估一段单声道人声的中位基频。
 * @param {Float32Array} samples - [-1, 1] 的单声道采样
 * @param {number} rate - 采样率
 * @returns {number|null} 中位基频（Hz）；有声帧太少返回 null
 */
export function medianF0(samples, rate) {
  const win = Math.round(rate * 0.064)
  const hop = Math.round(rate * 0.02)
  const minLag = Math.floor(rate / MAX_HZ)
  const maxLag = Math.min(win - 1, Math.ceil(rate / MIN_HZ))
  const d = new Float32Array(maxLag + 1)
  const found = []
  for (let start = 0; start + win + maxLag < samples.length; start += hop) {
    // 太安静的帧（换气、间奏）跳过
    let energy = 0
    for (let i = 0; i < win; i++) energy += samples[start + i] * samples[start + i]
    if (energy / win < 1e-4) continue
    for (let lag = 1; lag <= maxLag; lag++) {
      let s = 0
      for (let i = 0; i < win; i++) { const v = samples[start + i] - samples[start + i + lag]; s += v * v }
      d[lag] = s
    }
    // 累积均值归一化：第一个低于阈值的谷，顺着往下走到最低点
    let sum = 0
    const cmnd = new Float32Array(maxLag + 1)
    for (let lag = 1; lag <= maxLag; lag++) {
      sum += d[lag]
      cmnd[lag] = sum > 0 ? (d[lag] * lag) / sum : 1
    }
    let best = -1
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (cmnd[lag] < 0.15) {
        while (lag + 1 <= maxLag && cmnd[lag + 1] < cmnd[lag]) lag++
        best = lag
        break
      }
    }
    if (best > 0) found.push(rate / best)
  }
  if (found.length < 20) return null
  found.sort((a, b) => a - b)
  return found[Math.floor(found.length / 2)]
}

/** 原唱是男声还是女声；判断不了返回 ''。 */
export function voiceKind(f0) {
  if (!Number.isFinite(f0) || f0 <= 0) return ''
  return f0 < MALE_FEMALE_SPLIT ? 'male' : 'female'
}

/**
 * 按原唱和她的声线定变调（半音）：女声唱男声歌 +12，男声唱女声歌 -12，同类 0；判断不了返回 null。
 * @param {number|null} f0 - 原唱中位基频
 * @param {'female'|'male'} self - 她当前音色的声线
 */
export function autoShift(f0, self = 'female') {
  const kind = voiceKind(f0)
  if (!kind) return null
  if (kind === self) return 0
  return self === 'female' ? 12 : -12
}

/** 把 16 位小端 PCM 转成 [-1, 1] 的浮点采样。 */
export function pcm16ToFloat(buf) {
  const n = Math.floor(buf.length / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}
