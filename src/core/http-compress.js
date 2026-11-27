// 面板 JSON 响应压缩：只有 application/json、> 2 KB、客户端接受 gzip 时才压。
// 返回 { payload, encoding }，编码为空表示原样发送。
import { gzipSync } from 'node:zlib'

export function encodeResponse(body, type = 'application/json; charset=utf-8', acceptEncoding = '') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  const isJson = String(type || '').startsWith('application/json')
  if (!isJson || !/gzip/i.test(String(acceptEncoding || ''))) return { payload, encoding: '' }
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  if (buf.length <= 2048) return { payload, encoding: '' }
  return { payload: gzipSync(buf), encoding: 'gzip' }
}
