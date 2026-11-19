// Step 0A 契约锁定测试：防止后续开发破坏 contracts.d.ts 与 docs/CONTRACTS.md 中的 L2 Feature / Fetch / Gateway 约定。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')
const contracts = readFileSync(join(ROOT, 'src/gateway/contracts.d.ts'), 'utf8')
const docs = readFileSync(join(ROOT, 'docs/CONTRACTS.md'), 'utf8')

const EXPECTED_FEATURES = [
  'message.quote.send',
  'message.quote.read',
  'message.history.read',
  'message.forward.expand',
  'message.recall',
  'message.reaction',
  'media.fetch',
  'chat.member.list',
  'chat.member.read',
  'chat.typing',
  'sticker.send.native',
  'sticker.collect',
  'sticker.sync.native',
  'card.send',
]

function blockBetween(source, startMarker, endMarker) {
  const s = source.indexOf(startMarker)
  assert.ok(s >= 0, `缺少标记：${startMarker}`)
  const e = endMarker ? source.indexOf(endMarker, s) : source.length
  assert.ok(e > s, `缺少结束标记：${endMarker}`)
  return source.slice(s, e)
}

test('Step 0A：Feature 联合类型恰好包含约定好的 14 项能力', () => {
  const block = blockBetween(contracts, 'export type Feature =', 'export interface Caps')
  const items = [...block.matchAll(/\|\s*'([^']+)'/g)].map((m) => m[1])
  assert.equal(items.length, 14, `Feature 应恰好 14 项，实际：${items.length}`)
  assert.deepEqual(items, EXPECTED_FEATURES)
})

test('Step 0A：Caps 声明可选 L2 features 表，且 FetchRequest 含 message 与可选 count', () => {
  const capsBlock = blockBetween(contracts, 'export interface Caps {', '// ────')
  assert.match(capsBlock, /features\?:\s*Partial<Record<Feature,\s*boolean>>/)

  const fetchReqBlock = blockBetween(contracts, 'export type FetchRequest =', 'export interface FetchedMessage')
  assert.match(fetchReqBlock, /\{\s*kind:\s*'message';\s*messageId:\s*string;\s*chat\?:\s*\{\s*kind:\s*ChatKind;\s*id:\s*string\s*\}\s*\}/)
  assert.match(fetchReqBlock, /kind:\s*'history'[^\n]*count\?:\s*number[^\n]*before\?:\s*string/)
})

test('Step 0A：FetchedMessage / FetchedHistoryPage / FetchedForwardResult 形状及 raw @internal 边界锁定', () => {
  const msgBlock = blockBetween(contracts, 'export interface FetchedMessage {', 'export interface FetchedHistoryPage')
  assert.match(msgBlock, /sender\?:\s*\{/)
  assert.match(msgBlock, /isBot\?:\s*boolean/)
  assert.match(msgBlock, /idType\?:\s*'open_id'\s*\|\s*'union_id'\s*\|\s*'user_id'/)
  assert.match(msgBlock, /@internal[^\n]*\n\s*raw\?:\s*unknown/)

  const histBlock = blockBetween(contracts, 'export interface FetchedHistoryPage {', 'export interface FetchedForwardResult')
  assert.match(histBlock, /messages:\s*FetchedMessage\[\]/)
  assert.match(histBlock, /hasMore\?:\s*boolean/)
  assert.match(histBlock, /before\?:\s*string/)

  const fwdBlock = blockBetween(contracts, 'export interface FetchedForwardResult {', 'export interface PlatformAdapter')
  assert.match(fwdBlock, /messages:\s*FetchedMessage\[\]/)
  assert.doesNotMatch(fwdBlock, /Part\[\]\[\]/)
})

test('Step 0A：PlatformAdapter.fetch 与 Gateway.fetch 声明归一化返回重载，Gateway 必选 onCapsChanged 与 features', () => {
  const adapterBlock = blockBetween(contracts, 'export interface PlatformAdapter {', '// ────')
  assert.match(adapterBlock, /fetch\?\(request:\s*FetchRequest\s*&\s*\{\s*kind:\s*'message'\s*\}\):\s*Promise<FetchedMessage>/)
  assert.match(adapterBlock, /fetch\?\(request:\s*FetchRequest\s*&\s*\{\s*kind:\s*'forward'\s*\}\):\s*Promise<FetchedForwardResult>/)
  assert.match(adapterBlock, /fetch\?\(request:\s*FetchRequest\s*&\s*\{\s*kind:\s*'history'\s*\}\):\s*Promise<FetchedHistoryPage>/)

  const gwBlock = blockBetween(contracts, 'export interface Gateway {', '// ────')
  assert.match(gwBlock, /onCapsChanged\(fn:[\s\S]*?Record<Feature,\s*boolean>[\s\S]*?\):\s*\(\)\s*=>\s*void/)
  assert.doesNotMatch(gwBlock, /onCapsChanged\?\(/)
  assert.match(gwBlock, /features\(chatIdOrInstance:\s*string\):\s*Record<Feature,\s*boolean>/)
  assert.doesNotMatch(gwBlock, /features\?\(/)
  assert.match(gwBlock, /fetch\(chatIdOrInstance:\s*string,\s*request:\s*FetchRequest\s*&\s*\{\s*kind:\s*'message'\s*\}\):\s*Promise<FetchedMessage>/)
  assert.match(gwBlock, /fetch\(chatIdOrInstance:\s*string,\s*request:\s*FetchRequest\s*&\s*\{\s*kind:\s*'forward'\s*\}\):\s*Promise<FetchedForwardResult>/)
  assert.match(gwBlock, /fetch\(chatIdOrInstance:\s*string,\s*request:\s*FetchRequest\s*&\s*\{\s*kind:\s*'history'\s*\}\):\s*Promise<FetchedHistoryPage>/)
})

test('Step 0A：docs/CONTRACTS.md 与 contracts.d.ts 的 Feature 数量、清单及表述同步', () => {
  assert.match(docs, /L2 细粒度功能表（`Feature`，共 14 项）/)
  assert.match(docs, /`forward`\s*统一返回\s*`FetchedForwardResult`（其中\s*`messages`\s*为\s*`FetchedMessage\[\]`/)
  assert.match(docs, /`onState`\s*只负责连接生命周期状态/)
  assert.match(docs, /Gateway 必选/)
  for (const feature of EXPECTED_FEATURES) {
    assert.ok(docs.includes(`\`${feature}\``), `CONTRACTS.md 应完整列出全部 14 项 Feature：${feature}`)
  }

  const tsCheck = readFileSync(join(ROOT, 'test/contract/contracts-l2.typecheck.ts'), 'utf8')
  assert.match(tsCheck, /@ts-expect-error/)
  assert.match(tsCheck, /PlatformAdapter/)
  assert.match(tsCheck, /gw\.onCapsChanged/)
})
