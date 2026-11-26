import { dataDir, readJson, writeJson } from './store.js'

// Units of each currency per euro. The bundled ECB fixing also works on first use offline.
const feed = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
const bundled = { date: '2026-11-20', rates: { CNY: 7.3388, USD: 1.0990, EUR: 1, HKD: 8.6150, JPY: 174.35, GBP: 0.83735, SGD: 1.4160, CAD: 1.5723, AUD: 1.6487, CHF: 0.9223 } }
const codes = Object.keys(bundled.rates)
function valid(q, now) {
  const date = q?.date
  const ms = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(date) : NaN
  return Number.isFinite(ms) && ms <= now && new Date(ms).toISOString().startsWith(date) && q.rates?.EUR === 1 && codes.every(c => Number.isFinite(q.rates[c]) && q.rates[c] > 0)
}
function parse(xml) {
  const date = xml.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>/)?.[1]
  const rates = { EUR: 1 }
  for (const [, code, rate] of xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]\s*\/>/g)) {
    if (code !== 'EUR' && codes.includes(code)) rates[code] = Number(rate)
  }
  return { date, rates }
}

export function createUsageFx({ request = globalThis.fetch, now = Date.now, file = dataDir('usage-fx.json') } = {}) {
  let quote, pending, nextTry = 0
  return async function getFx(refresh = false) {
    if (!quote) {
      const saved = readJson(file, null)
      quote = valid(saved, now()) && saved.date >= bundled.date ? saved : bundled
    }
    if (!refresh) return quote
    if (pending) return pending
    if (now() < nextTry || quote.date === new Date(now()).toISOString().slice(0, 10)) return quote
    nextTry = now() + 15 * 60_000
    pending = (async () => {
      const response = await request(feed, { redirect: 'error', signal: AbortSignal.timeout(2500) })
      if (!response.ok) return quote
      const candidate = parse(await response.text())
      if (!valid(candidate, now()) || candidate.date < quote.date) return quote
      nextTry = now() + 6 * 3600_000
      if (candidate.date !== quote.date || codes.some(k => candidate.rates[k] !== quote.rates[k])) {
        quote = candidate
        writeJson(file, quote)
      }
      return quote
    })().catch(() => quote).finally(() => { pending = null })
    return pending
  }
}
