// I1 身份库的测试。
// 来源：Aurabot多平台实施拆分/包-I1-身份库.md「过关条件」逐条覆盖。
// 被测：src/gateway/identity.js + src/gateway/identity-store.js；契约 src/gateway/contracts.d.ts §2。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createIdentity, IdentityConflict } from '../../src/gateway/identity.js'
import { IDENTITY_FILE, IDENTITY_SCHEMA } from '../../src/gateway/identity-store.js'

// 每个用例一个独立的临时数据目录，互不串扰，测完清理。
function makeIdentity(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-identity-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const identity = createIdentity({ dataDir: dir, ...overrides })
  return { identity, dir }
}

// 直接读库里的表，用于断言「表没被改」「落库形态正确」。
function readRows(dir) {
  const db = new DatabaseSync(join(dir, IDENTITY_FILE))
  try {
    return {
      identities: db.prepare('SELECT platform, account, person_id, alt, linked_at, linked_by FROM identities ORDER BY platform, account').all(),
      meta: db.prepare('SELECT key, json FROM meta ORDER BY key').all(),
    }
  } finally { db.close() }
}

test('resolve：查不到新建 p- 编号，同一账号两次是同一个人', (t) => {
  const { identity } = makeIdentity(t)
  const first = identity.resolve('feishu', 'ou_abc')
  assert.match(first, /^p-[0-9a-z]{16}$/)
  assert.equal(identity.resolve('feishu', 'ou_abc'), first)
  assert.equal(identity.resolve('feishu', 'ou_abc', { alt: 'union_x' }), first) // 已有行不再换人
})

test('resolve：两个平台的同名账号是两个人', (t) => {
  const { identity } = makeIdentity(t)
  const a = identity.resolve('qq', '10001')
  const b = identity.resolve('feishu', '10001')
  assert.notEqual(a, b)
})

test('resolve：数字账号在 feishu 平台不会被当成 qq 的人', (t) => {
  const { identity } = makeIdentity(t)
  identity.importLegacyQQ(['12345'])
  const feishu = identity.resolve('feishu', '12345')
  assert.match(feishu, /^p-[0-9a-z]{16}$/) // 生成的是新 p- 人
  assert.equal(identity.lookup('qq', '12345'), '12345') // qq 侧仍是导入编号
  assert.equal(identity.lookup('feishu', '12345'), feishu)
})

test('lookup：只查不建，查不到返回 null', (t) => {
  const { identity, dir } = makeIdentity(t)
  assert.equal(identity.lookup('qq', 'nobody'), null)
  assert.equal(readRows(dir).identities.length, 0) // lookup 没有建人
  const p = identity.resolve('qq', '10001')
  assert.equal(identity.lookup('qq', '10001'), p)
})

test('accountsOf / accountOn：按人枚举账号、出站查某平台账号', (t) => {
  const { identity } = makeIdentity(t)
  const p = identity.resolve('qq', '10001')
  identity.link('feishu', 'ou_x', p, 'owner')
  const accounts = identity.accountsOf(p)
  assert.deepEqual(accounts.map((a) => `${a.platform}:${a.account}`).sort(), ['feishu:ou_x', 'qq:10001'])
  for (const a of accounts) {
    assert.equal(typeof a.linkedAt, 'number')
    assert.ok(['import', 'owner', 'code', 'auto'].includes(a.linkedBy))
  }
  assert.equal(identity.accountOn(p, 'feishu'), 'ou_x')
  assert.equal(identity.accountOn(p, 'telegram'), null)
  assert.deepEqual(identity.accountsOf('p-0000000000000000'), [])
})

test('isValid：认 p- 编号和表里已登记的导入编号，其他一律不认', (t) => {
  const { identity } = makeIdentity(t)
  const p = identity.resolve('qq', '10001')
  assert.equal(identity.isValid(p), true)
  assert.equal(identity.isValid('p-ABC'), false) // 形状不对（大写、太短）
  assert.equal(identity.isValid('p-zzzzzzzzzzzzzzzz'), true) // p- 形状对即认，不必查表
  assert.equal(identity.isValid('12345'), false) // 没导入过，数字串不认
  assert.equal(identity.isValid(null), false)
  assert.equal(identity.isValid(12345), false)
  identity.importLegacyQQ(['12345'])
  assert.equal(identity.isValid('12345'), true) // 导入后在表里，认
})

test('claimOwner / owner / isOwner：首次设主人，已有主人抛错', (t) => {
  const { identity } = makeIdentity(t)
  assert.equal(identity.owner(), null)
  const p = identity.claimOwner('qq', '10001')
  assert.equal(identity.owner(), p)
  assert.equal(identity.isOwner(p), true)
  assert.equal(identity.isOwner(identity.resolve('qq', '20002')), false)
  assert.throws(() => identity.claimOwner('feishu', 'ou_x'), /已有主人/)
})

test('link / unlink：正常挂载；冲突抛 IdentityConflict 且表未被改', (t) => {
  const { identity } = makeIdentity(t)
  const a = identity.resolve('qq', '10001')
  const b = identity.resolve('qq', '20002')
  identity.link('feishu', 'ou_x', a, 'owner')
  assert.equal(identity.accountOn(a, 'feishu'), 'ou_x')

  // 冲突：ou_x 已属于 a，往 b 名下挂必须抛错。
  assert.throws(() => identity.link('feishu', 'ou_x', b, 'code'), (error) => {
    assert.ok(error instanceof IdentityConflict)
    assert.equal(error.code, 'identity-conflict')
    assert.ok(error.message.includes(a)) // message 带现有归属
    return true
  })
  // 表未被改：ou_x 仍属于 a，b 名下仍只有 qq。
  assert.equal(identity.accountOn(a, 'feishu'), 'ou_x')
  assert.deepEqual(identity.accountsOf(b).map((x) => x.platform), ['qq'])

  identity.unlink('feishu', 'ou_x')
  assert.equal(identity.accountOn(a, 'feishu'), null)
})

test('issueCode / redeemCode：成功兑换挂到签发人名下，用一次作废', (t) => {
  const { identity } = makeIdentity(t)
  const p = identity.resolve('qq', '10001')
  const code = identity.issueCode(p)
  assert.match(code, /^\d{6}$/)

  const got = identity.redeemCode('telegram', 'tg_1', code)
  assert.equal(got, p)
  assert.equal(identity.accountOn(p, 'telegram'), 'tg_1')
  assert.equal(identity.accountsOf(p).find((a) => a.platform === 'telegram').linkedBy, 'code')
  // 用一次作废
  assert.equal(identity.redeemCode('telegram', 'tg_2', code), null)
})

test('口令：过期作废', (t) => {
  let now = 1_000_000_000_000
  const { identity } = makeIdentity(t, { now: () => now })
  const p = identity.resolve('qq', '10001')
  const code = identity.issueCode(p)
  now += 10 * 60 * 1000 + 1 // 刚好过了 10 分钟
  assert.equal(identity.redeemCode('telegram', 'tg_1', code), null)
  assert.equal(identity.accountOn(p, 'telegram'), null)
})

test('口令：连续输错 5 次作废', (t) => {
  const { identity } = makeIdentity(t)
  const p = identity.resolve('qq', '10001')
  const code = identity.issueCode(p)
  for (let i = 0; i < 5; i++) assert.equal(identity.redeemCode('telegram', 'tg_1', '000000'), null)
  assert.equal(identity.redeemCode('telegram', 'tg_1', code), null) // 正确口令也已被连错作废
  assert.equal(identity.accountOn(p, 'telegram'), null)
})

test('口令：账号已属于别人时兑换失败，表未被改', (t) => {
  const { identity } = makeIdentity(t)
  const p = identity.resolve('qq', '10001')
  const q = identity.resolve('telegram', 'tg_taken')
  const code = identity.issueCode(p)
  assert.equal(identity.redeemCode('telegram', 'tg_taken', code), null)
  assert.equal(identity.lookup('telegram', 'tg_taken'), q) // 归属没变
  // 口令没被这次失败销掉：换一个新账号仍能兑换
  assert.equal(identity.redeemCode('telegram', 'tg_new', code), p)
})

test('口令：存 meta 重启不丢；同一人旧口令被新签发作废', (t) => {
  const { identity, dir } = makeIdentity(t)
  const p = identity.resolve('qq', '10001')
  const code = identity.issueCode(p)
  // 第二个实例指向同一目录，模拟进程重启
  const again = createIdentity({ dataDir: dir })
  assert.equal(again.redeemCode('telegram', 'tg_1', code), p)
  // 新签发后旧口令作废
  const code2 = again.issueCode(p)
  assert.notEqual(code2, code)
  assert.equal(again.redeemCode('telegram', 'tg_2', code), null)
  assert.equal(again.redeemCode('telegram', 'tg_3', code2), p)
})

test('importLegacyQQ：编号=QQ号字符串，幂等，linked_by=import', (t) => {
  const { identity } = makeIdentity(t)
  assert.deepEqual(identity.importLegacyQQ(['10001', '20002']), { added: 2, existing: 0 })
  assert.equal(identity.lookup('qq', '10001'), '10001') // 导入编号就是 QQ 号字符串
  assert.equal(identity.isValid('10001'), true)
  assert.equal(identity.accountsOf('10001')[0].linkedBy, 'import')
  // 幂等：再来一遍全是 existing
  assert.deepEqual(identity.importLegacyQQ(['10001', '20002', '30003']), { added: 1, existing: 2 })
  // p- 生成编号带前缀，不会和导入号相撞
  const p = identity.resolve('qq', '40004')
  assert.match(p, /^p-/)
  assert.notEqual(p, '40004')
})

test('resolve 补 alt：行里 alt 为空时补上，已有 alt 不覆盖', (t) => {
  const { identity, dir } = makeIdentity(t)
  const p = identity.resolve('feishu', 'ou_b')
  identity.resolve('feishu', 'ou_b', { alt: 'union_2' })
  const row = readRows(dir).identities.find((r) => r.account === 'ou_b')
  assert.equal(row.alt, 'union_2')
  assert.equal(row.person_id, p)
  // 已有 alt 不覆盖
  identity.resolve('feishu', 'ou_b', { alt: 'union_3' })
  assert.equal(readRows(dir).identities.find((r) => r.account === 'ou_b').alt, 'union_2')
})

test('alt 找回：账号变、alt 不变 → 同一个人，日志可读', (t) => {
  const logs = []
  const log = { info: (...a) => logs.push(a.join(' ')), warn() {}, error() {}, debug() {} }
  const { identity } = makeIdentity(t, { log })
  const p = identity.resolve('feishu', 'ou_old', { alt: 'union_1' })
  const again = identity.resolve('feishu', 'ou_new', { alt: 'union_1' })
  assert.equal(again, p)
  assert.ok(logs.some((line) => line.includes('alt') && line.includes('ou_new')))
  // 两个账号都在同一个人名下
  assert.deepEqual(identity.accountsOf(p).map((a) => a.account).sort(), ['ou_new', 'ou_old'])
})

test('repoint：from 名下全部改挂到 into；into 同平台已有的进 conflicts 不动', (t) => {
  const { identity } = makeIdentity(t)
  const from = identity.resolve('qq', '10001')
  identity.link('feishu', 'ou_a', from, 'owner')
  identity.link('telegram', 'tg_x', from, 'code')
  const into = identity.resolve('qq', '20002')
  identity.link('feishu', 'ou_b', into, 'owner') // into 在 feishu 已有账号 → ou_a 冲突

  const { moved, conflicts } = identity.repoint(from, into)
  // into 在 qq（20002）和 feishu（ou_b）都已有账号 → 10001 和 ou_a 都按冲突不动；只有 telegram 能搬。
  assert.deepEqual(conflicts.map((a) => a.account).sort(), ['10001', 'ou_a'])
  assert.deepEqual(moved.map((a) => a.account), ['tg_x'])
  // 落库核对：telegram:tg_x 归 into；其余各平台归属不变
  assert.equal(identity.lookup('telegram', 'tg_x'), into)
  assert.equal(identity.lookup('qq', '10001'), from)
  assert.equal(identity.lookup('feishu', 'ou_a'), from)
  assert.equal(identity.lookup('feishu', 'ou_b'), into)
})

test('库损坏：报清楚的错，不新建空库盖掉原文件', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-identity-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, IDENTITY_FILE)
  const garbage = '这不是一个 SQLite 文件，只是一段垃圾数据。'.repeat(20)
  writeFileSync(file, garbage, 'utf8')
  assert.throws(() => createIdentity({ dataDir: dir }), /身份库损坏/)
  assert.equal(readFileSync(file, 'utf8'), garbage) // 原文件原样保留
})

test('库版本过新：报错不打开、不盖文件', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-identity-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, IDENTITY_FILE)
  // 手工建一个 user_version 比代码新的库，并放一行数据证明它没被盖掉
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES (\'keep\');')
  db.exec(`PRAGMA user_version = ${IDENTITY_SCHEMA + 5}`)
  db.close()

  assert.throws(() => createIdentity({ dataDir: dir }), /版本.*比代码新/)
  const check = new DatabaseSync(file)
  try { assert.equal(check.prepare('SELECT v FROM marker').get().v, 'keep') } finally { check.close() }
})

test('进程中途退出重启：数据在（第二个实例指向同一目录读回）', (t) => {
  const { identity, dir } = makeIdentity(t)
  const p = identity.resolve('qq', '10001')
  identity.link('feishu', 'ou_x', p, 'owner')
  identity.claimOwner('qq', '10001')
  const code = identity.issueCode(p)
  identity.importLegacyQQ(['30003'])
  // 不调用任何 close（本模块句柄本就不跨操作持有），直接开第二个实例当「重启后的进程」。
  const again = createIdentity({ dataDir: dir })
  assert.equal(again.lookup('qq', '10001'), p)
  assert.equal(again.lookup('feishu', 'ou_x'), p)
  assert.equal(again.owner(), p)
  assert.equal(again.lookup('qq', '30003'), '30003')
  assert.equal(again.redeemCode('telegram', 'tg_1', code), p) // 口令也活着
  assert.equal(existsSync(join(dir, IDENTITY_FILE)), true)
})
