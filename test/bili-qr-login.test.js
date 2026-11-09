// 扫码登录写回配置：完整设备指纹要一起保留，老配置不能被改坏。
import test from 'node:test'
import assert from 'node:assert/strict'

const { splitBiliCookie, normalize } = await import('../src/core/config.js')

test('扫码登录拿到的五个字段按顺序拼进 cookie，设备指纹一并回写', () => {
  const r = splitBiliCookie({
    sessdata: 'sess', biliJct: 'jct', buvid3: 'b3', buvid4: 'b4', dedeUserId: '3747576094394883',
  })
  assert.equal(r.cookie, 'SESSDATA=sess; bili_jct=jct; buvid3=b3; buvid4=b4; DedeUserID=3747576094394883')
  assert.deepEqual(r, {
    sessdata: 'sess', biliJct: 'jct', buvid3: 'b3', buvid4: 'b4', dedeUserId: '3747576094394883',
    cookie: 'SESSDATA=sess; bili_jct=jct; buvid3=b3; buvid4=b4; DedeUserID=3747576094394883',
  })
})

test('老配置只有 sessdata + biliJct：仍然只拼两项，不报错也不产生空段', () => {
  const r = splitBiliCookie({ sessdata: 'x', biliJct: 'y' })
  assert.equal(r.cookie, 'SESSDATA=x; bili_jct=y')
  assert.equal(r.buvid3, '')
  assert.equal(r.buvid4, '')
  assert.equal(r.dedeUserId, '')
  assert.ok(!r.cookie.includes(';;'))
})

test('buvid3 字段为空时，从整串 cookie 里补出来', () => {
  const r = splitBiliCookie({ cookie: 'SESSDATA=s; bili_jct=j; buvid3=b3; buvid4=b4; DedeUserID=99' })
  assert.equal(r.buvid3, 'b3')
  assert.equal(r.buvid4, 'b4')
  assert.equal(r.dedeUserId, '99')
  assert.equal(r.cookie, 'SESSDATA=s; bili_jct=j; buvid3=b3; buvid4=b4; DedeUserID=99')
})

test('老配置过 normalize 不炸：cookie 仍是两项，新增字段是空串', () => {
  const cfg = normalize({ bili: { sessdata: 'x', biliJct: 'y' } })
  assert.equal(cfg.bili.cookie, 'SESSDATA=x; bili_jct=y')
  assert.equal(cfg.bili.buvid3, '')
  assert.equal(cfg.bili.buvid4, '')
  assert.equal(cfg.bili.dedeUserId, '')
})
