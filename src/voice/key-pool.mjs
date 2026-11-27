// One scheduler per running voice backend. Key material never appears in errors or logs.
export const cloudProviders = ['fish-free', 'breeze', 'minimax', 'volcano', 'http']
export function normalizePools(raw) {
  const out = {}
  for (const id of cloudProviders) {
    const pool = raw?.[id]
    if (!pool || typeof pool !== 'object') continue
    const seen = new Set(), accounts = []
    for (const row of Array.isArray(pool.accounts) ? pool.accounts : []) {
      if (!row || typeof row.id !== 'string' || !/^[\w-]{1,80}$/.test(row.id) || seen.has(row.id)) continue
      seen.add(row.id)
      accounts.push({ id: row.id, name: String(row.name || '').trim().slice(0, 80), ...(id === 'http' && { origin: String(row.origin || '') }), apiKey: String(row.apiKey || '').trim() })
    }
    out[id] = { strategy: pool.strategy === 'ordered' ? 'ordered' : 'balanced', accounts }
  }
  return out
}
export function maskPools(pools) {
  for (const p of Object.values(pools || {})) for (const a of p.accounts || []) { a.apiKeySet = Boolean(a.apiKey); a.apiKey = '' }
}
// A blank password means unchanged for this (provider, row ID), never the row at the same index.
export function restorePoolKeys(next, previous, incoming) {
  for (const id of cloudProviders) {
    const rows = incoming?.[id]?.accounts
    if (!Array.isArray(rows)) continue
    const old = new Map((previous?.[id]?.accounts || []).map(a => [a.id, a.apiKey]))
    const previousRows = previous?.[id]?.accounts || []
    next[id] = { ...next[id], accounts: rows.map(a => ({ ...a,
      ...(id === 'http' && !a?.apiKey && { origin: previousRows.find(x => x.id === a?.id)?.origin || a?.origin || '' }),
      apiKey: a?.apiKey === null ? '' : a?.apiKey || old.get(a?.id) || '' })) }
  }
}
export function retryDelay(header, now) {
  const h = String(header ?? '').trim()
  if (/^\d+(?:\.\d+)?$/.test(h)) { const ms = Number(h) * 1000; if (Number.isFinite(ms)) return ms }
  const date = /[a-z]/i.test(h) ? Date.parse(h) : NaN
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}
export function rateMeta(response, status = response.status) {
  const scope = response.headers.get('x-ratelimit-scope') || response.headers.get('ratelimit-scope') || ''
  return { status, retryAfter: response.headers.get('retry-after'), shared: /^(?:global|shared|service|org(?:anization)?|ip)$/i.test(scope) || response.headers.get('x-ratelimit-global') === 'true' }
}
export function createKeyRouter(now = Date.now) {
  const states = new Map()
  let serial = 0
  return async function run(id, primary, pool, request, trackSingle = false) {
    // Without additional accounts preserve the original provider's own errors and retry behavior.
    const extra = pool?.accounts?.map(a => a.apiKey?.trim()).filter(Boolean) || []
    if (!extra.length && (!primary || (!trackSingle && !states.has(id)))) return request(primary)
    const keys = [...new Set([primary?.trim(), ...extra].filter(Boolean))]
    let state = states.get(id)
    if (!state) { state = { keys: new Map(), until: 0 }; states.set(id, state) }
    for (const key of state.keys.keys()) if (!keys.includes(key) && !state.keys.get(key).busy && state.keys.get(key).until <= now()) state.keys.delete(key)
    const entries = keys.map(key => {
      let slot = state.keys.get(key)
      if (!slot) { slot = { busy: 0, turn: 0, until: 0 }; state.keys.set(key, slot) }
      return { key, slot }
    })
    const tried = new Set(), start = now()
    let last
    while (now() >= state.until) {
      const candidates = entries.filter(({slot}) => !tried.has(slot) && slot.until <= now())
      if (pool?.strategy !== 'ordered') candidates.sort((a,b) => a.slot.busy - b.slot.busy || a.slot.turn - b.slot.turn)
      if (!candidates.length || tried.size >= 4 || (tried.size && now() - start >= 5000)) break
      const { key, slot } = candidates[0]
      tried.add(slot); slot.busy++; slot.turn = ++serial
      try { return await request(key) }
      catch (e) {
        const at = now(), ms = retryDelay(e?.retryAfter, at), code = e?.status
        if ((e?.shared && code === 429) || code >= 500) {
          state.until = Math.max(state.until, at + (ms ?? (code === 429 ? 30000 : 5000)))
          throw e
        }
        if (![401,402,429].includes(code)) throw e // ambiguous completion, invalid text, permissions or service fault
        slot.until = Math.max(slot.until, at + (ms ?? (code === 429 ? 30000 : code === 401 ? 300000 : 900000)))
        last = code
      } finally { slot.busy-- }
    }
    // Per-key state owns this cooldown. Do not turn one exhausted account into a provider-wide chain cooldown.
    throw new Error(state.until > now() ? '语音服务暂时限流，请稍后再试' : '当前没有可用的语音账号' + (last ? `（HTTP ${last}）` : '，请稍后再试'))
  }
}
