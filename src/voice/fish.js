import { rateMeta } from './key-pool.mjs'
// Only send speech to the free endpoint selected here. Never redirect credentials.
export async function fishSpeech(text, key, request = fetch, referenceId = '', signal = AbortSignal.timeout(90000)) {
  if (!key?.trim()) throw new Error('请在「语音 → 扩展服务 → Fish Audio」填写 API Key')
  if (referenceId && !/^[a-f\d]{32}$/i.test(referenceId)) throw new Error('Fish 音色 ID 应为 32 位十六进制字符')
  const response = await request('https://api.fish.audio/v1/tts', {
    method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${key.trim()}`, 'content-type': 'application/json', model: 's2.1-pro-free' },
    body: JSON.stringify({ text, format: 'mp3', ...(referenceId && { reference_id: referenceId }) }),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw Object.assign(new Error(response.status === 401 || response.status === 403 ? `Fish 拒绝访问（HTTP ${response.status}），请检查 API Key 和音色权限` : `Fish Free 合成失败（HTTP ${response.status}）`), rateMeta(response))
  }
  const audio = Buffer.from(await response.arrayBuffer())
  if (audio.length < 4 || !(audio.subarray(0, 3).toString() === 'ID3' || (audio[0] === 255 && (audio[1] & 224) === 224))) throw new Error('Fish Free 未返回 MP3 音频')
  return audio
}

// A missing legacy credential must not suppress explicitly configured accounts.
export async function fishPrimary(voice, credentials) {
  if (voice.fishApiKey) return voice.fishApiKey
  try { return (await credentials()?.resolve?.('FISH_API_KEY'))?.value }
  catch (error) { if (!voice.keyPools?.['fish-free']?.accounts?.some(a => a.apiKey)) throw error; return '' }
}

// Fish separates subscription credits from its API wallet. Neither is a remaining free-TTS character count.
export async function fishBalances(voice, credentials, request = fetch) {
  const primary = await fishPrimary(voice, credentials)
  const accounts = [{ name: '主账号', apiKey: primary }, ...(voice.keyPools?.['fish-free']?.accounts || []).map((a, i) => ({ name: a.name || `附加账号 ${i + 1}`, apiKey: a.apiKey }))]
  const seen = new Set(), saved = accounts.filter(a => {
    const key = a.apiKey?.trim(); if (!key || seen.has(key)) return false
    seen.add(key); return true
  })
  const signal = AbortSignal.timeout(10000), rows = new Array(saved.length)
  async function read(path, key, parse) {
    if (signal.aborted) return { error: '查询超时' }
    try {
      const r = await request('https://api.fish.audio/wallet/self/' + path, { headers: { Authorization: `Bearer ${key.trim()}` }, signal, redirect: 'error' })
      if (!r.ok) { await r.body?.cancel(); return { error: r.status === 429 ? '查询限流，稍后重试' : `查询失败（HTTP ${r.status}）` } }
      return parse(await r.json()) || { error: '未返回余额' }
    } catch { return { error: signal.aborted ? '查询超时' : '未能读取余额' } }
  }
  let next = 0
  async function worker() {
    while (next < saved.length) {
      const i = next++, { name, apiKey } = saved[i]
      const wallet = await read('api-credit', apiKey, j => /^-?\d+(?:\.\d+)?$/.test(String(j?.credit)) && { usd: String(j.credit) })
      const pack = await read('package', apiKey, j => [j?.balance, j?.total].every(Number.isSafeInteger) && { remaining: j.balance, total: j.total, extra: Number.isSafeInteger(j.extra_balance) ? j.extra_balance : 0 })
      rows[i] = { name, wallet, pack }
    }
  }
  await Promise.all(Array.from({ length: Math.min(saved.length, 3) }, worker))
  return { ok: true, rows }
}
