// Standard public API prices, USD per million tokens. Offline reference, not a reseller invoice.
import { beijingDayKey, isPeak } from './offpeak.js'
export const REFERENCE_DATE = '2026-11-21'
// Order: uncached input, output, cache read, explicit cache write (only if published).
// https://platform.minimax.io/docs/guides/pricing-paygo and https://docs.z.ai/guides/overview/pricing
const fixed = new Map([
  ['minimax-m3.1-flash', [0.15, 0.60, 0.015]],
  ['glm-5.3-flash', [0.15, 0.50, 0.03, 0]],
  ['glm-5.3-flashx', [0.37, 1.25, 0.075, 0]],
  ['glm-5.3', [1.40, 4.40, 0.26, 0]],
])
// Weekends are handled by isPeak; these are the published 2026 weekday closures.
const holidays = ['01-01','01-02','02-16','02-17','02-18','02-19','02-20','02-23','04-06','05-01','05-04','05-05','06-19','09-25','10-01','10-02','10-05','10-06','10-07'].map(d => '2026-' + d)
function rates(row, input) {
  // Strip routing namespaces, never match a substring, different model suffix or quantization.
  const id = String(row.model || '').split('/').at(-1).toLowerCase()
  if (fixed.has(id)) return fixed.get(id)
  if (id === 'minimax-m3') return input > 512000 ? [0.60, 2.40, 0.12] : [0.30, 1.20, 0.06]
  // https://ai.google.dev/gemini-api/docs/pricing (standard text, not batch or cache storage)
  if (id === 'gemini-3.8-flash') return row.at >= Date.UTC(2027, 0, 1) ? [1.50, 7.50, 0.15] : [0.75, 3.75, 0.075]
  // https://api-docs.deepseek.com/quick_start/pricing — provider's current Flash aliases.
  if (['deepseek-flash','deepseek-v4.1-flash','deepseek-v4.1-flash-1017','deepseek-v4-flash','deepseek-v4-flash-vision-exp','deepseek-v4-pro'].includes(id)) {
    const peak = isPeak(row.at, { holidays })
    if (peak && !beijingDayKey(row.at).startsWith('2026-')) return null // holiday calendar not verified
    if (id === 'deepseek-v4-pro') return peak ? [1.32, 3.96, 0.044] : [0.66, 1.98, 0.022]
    return peak ? [0.30, 1.20, 0.006] : [0.15, 0.60, 0.003]
  }
  return null
}
export function officialCost(row) {
  const [fresh, out, cached, written] = [row.in, row.out, row.cached, row.written].map(n => Number.isSafeInteger(n) && n >= 0 ? n : 0)
  const p = rates(row, fresh + cached + written)
  if (!p || (written && p[3] === undefined)) return null
  return (fresh*p[0] + out*p[1] + cached*p[2] + written*(p[3] || 0)) / 1e6
}
