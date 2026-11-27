import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const start = source.indexOf('    const fmtTokens = ')
const end = source.indexOf('    /**', start)
const format = runInNewContext('(() => {' + source.slice(start, end) + '; return fmtTokens })()')
test('Token 简写：零、小数位、K/M/B 以及舍入跨单位', () => {
  for (const [n, expected] of [
    [0,'0'], [999,'999'], [1000,'1K'], [1234,'1.23K'], [1200,'1.2K'],
    [999999,'1M'], [1000000,'1M'], [474782167,'474.78M'],
    [999999999,'1B'], [1000000000,'1B'], [1234567890,'1.23B'],
  ]) assert.equal(format(n), expected, String(n))
})

test('显示币种用交叉汇率换算；保留原价、未知单位、微量费用和零', () => {
  const cost = source.slice(source.indexOf('    const fmtCost = '),source.indexOf('    /** chatId'))
  const currency = source.slice(source.indexOf('    const usageCurrencies = '),source.indexOf('    function UsageSummary'))
  const money=runInNewContext('(() => {'+cost+currency+'; return usageMoney })()')
  const fx={rates:{EUR:1,USD:2,CNY:14,JPY:160}}
  assert.equal(money(3,'USD','CNY',fx),'21.00 元');assert.equal(money(14,'元','USD',fx),'2.00 美元')
  assert.equal(money(80,'日元','USD',fx),'1.00 美元');assert.equal(money(1,'USD','USD',fx),'1.00 美元')
  assert.equal(money(0,'USD','CNY',fx),'0 元');assert.equal(money(0.000001,'USD','CNY',fx),'< 0.0001 元')
  assert.equal(money(3,'积分','USD',fx),'3.00 积分（原单位）');assert.equal(money(3,'USD','CNY',null),'3.00 美元')
})
