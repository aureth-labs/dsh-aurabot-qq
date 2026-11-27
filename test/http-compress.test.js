// 面板 JSON 压缩：只压 application/json、>2KB、客户端接受 gzip。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { encodeResponse } from '../src/core/http-compress.js'

const big = { ok: true, items: Array.from({ length: 200 }, (_, i) => ({ id: i, text: '记忆内容' + i })) }

test('大 JSON + gzip：压缩后能解回原文', () => {
  const r = encodeResponse(big, 'application/json; charset=utf-8', 'gzip, deflate, br')
  assert.equal(r.encoding, 'gzip')
  assert.ok(Buffer.isBuffer(r.payload))
  assert.deepEqual(JSON.parse(gunzipSync(r.payload).toString('utf8')), big)
})

test('小 JSON：不压', () => {
  const r = encodeResponse({ ok: true, message: 'hi' }, 'application/json; charset=utf-8', 'gzip')
  assert.equal(r.encoding, '')
  assert.equal(r.payload, '{"ok":true,"message":"hi"}')
})

test('客户端不接受 gzip / 非 JSON：不压', () => {
  assert.equal(encodeResponse(big, 'application/json', 'identity').encoding, '')
  assert.equal(encodeResponse(Buffer.alloc(4096), 'application/zip', 'gzip').encoding, '')
  assert.equal(encodeResponse(Buffer.alloc(4096), 'text/javascript; charset=utf-8', 'gzip').encoding, '')
})
