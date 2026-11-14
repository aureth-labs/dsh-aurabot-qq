// I1 身份库：平台账号 ↔ 人（PersonId）的映射实现。
// 来源：Aurabot多平台实施拆分/包-I1-身份库.md；契约唯一权威 src/gateway/contracts.d.ts §2，
// 文字规则 docs/CONTRACTS.md §四（PersonId 不透明、身份只按平台记、默认不合并人）。
// G1 把它挂在 gateway.identity 上；只有这个文件知道 p- 编号长什么样，
// 其他代码不许对 PersonId 用正则、Number()、比长度、拼地址。
import { openIdentityStore } from './identity-store.js'

/** 账号已属于别人时 link 抛这个错；调用方（面板）决定怎么办，本模块绝不静默改挂。 */
export class IdentityConflict extends Error {
  constructor(message) {
    super(message)
    this.name = 'IdentityConflict'
    this.code = 'identity-conflict'
  }
}

// 新人生成用：p- + 16 位小写字母数字。
const PERSON_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const GENERATED_ID_LENGTH = 16
const generatedPattern = new RegExp(`^p-[0-9a-z]{${GENERATED_ID_LENGTH}}$`)
// 口令：6 位数字，10 分钟有效，用一次作废，连错 5 次作废；存 meta，重启不丢。
const CODE_LENGTH = 6
const CODE_TTL_MS = 10 * 60 * 1000
const CODE_MAX_FAILS = 5
const OWNER_KEY = 'owner'

function randomPersonId() {
  let id = 'p-'
  for (let i = 0; i < GENERATED_ID_LENGTH; i++) {
    id += PERSON_ALPHABET[Math.floor(Math.random() * PERSON_ALPHABET.length)]
  }
  return id
}

function randomCode() {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += Math.floor(Math.random() * 10)
  return code
}

const rowToAccount = (row) => row && {
  platform: row.platform,
  account: row.account,
  alt: row.alt ?? undefined,
  linkedAt: row.linked_at,
  linkedBy: row.linked_by,
}

/**
 * 构造 Identity（contracts §2）。全部方法同步（SQLite 同步接口）。
 * 可注入项：now（毫秒时间戳，供测试口令过期）、log（写 alt 找回等日志）。
 */
export function createIdentity({ dataDir, now = () => Date.now(), log = console } = {}) {
  const store = openIdentityStore({ dataDir, log })
  // 构造时就开一次库：库损坏、版本过新这类问题在启动当场报错，而不是等第一次调用才炸。
  store.transact(() => {})

  const metaGet = (db, key) => {
    const row = db.prepare('SELECT json FROM meta WHERE key = ?').get(key)
    return row ? JSON.parse(row.json) : null
  }
  const metaSet = (db, key, value) => {
    db.prepare('INSERT INTO meta (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(key, JSON.stringify(value))
  }
  const metaDelete = (db, key) => db.prepare('DELETE FROM meta WHERE key = ?').run(key)

  const rowOf = (db, platform, account) =>
    db.prepare('SELECT * FROM identities WHERE platform = ? AND account = ?').get(platform, account)

  const ownerOf = (db) => metaGet(db, OWNER_KEY)

  // 生成一个没被占用的新人编号；撞了重来（概率极低，但要兜住）。
  const freshPersonId = (db) => {
    for (;;) {
      const id = randomPersonId()
      if (!db.prepare('SELECT 1 FROM identities WHERE person_id = ? LIMIT 1').get(id)) return id
    }
  }

  const insertAccount = (db, { platform, account, personId, alt = null, linkedBy }) => {
    db.prepare(
      'INSERT INTO identities (platform, account, person_id, alt, linked_at, linked_by) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(platform, account, personId, alt, now(), linkedBy)
  }

  const isValid = (value) => {
    // 只认两种：本模块生成的 p-…，和表里已登记的导入编号（旧 QQ 号迁来的数字串）。
    if (typeof value !== 'string' || !value) return false
    if (generatedPattern.test(value)) return true
    // 导入编号没有固定形状可判，只能查表；查表即存在性验证。
    return !!store.transact((db) =>
      db.prepare('SELECT 1 FROM identities WHERE person_id = ? LIMIT 1').get(value),
    )
  }

  const resolve = (platform, account, hint) => store.transact((db) => {
    const existing = rowOf(db, platform, account)
    if (existing) {
      // 带了 alt 且这一行还没有 alt 时补上（如飞书首次拿到 union_id）。
      if (hint?.alt && !existing.alt) {
        db.prepare('UPDATE identities SET alt = ? WHERE platform = ? AND account = ?').run(hint.alt, platform, account)
      }
      return existing.person_id
    }
    // alt 找回：(platform, account) 没查到，但同平台有一行的 alt 等于 hint.alt
    // → 账号变了、人没变（飞书换应用后 open_id 变、union_id 不变），把新账号挂回那个人。
    if (hint?.alt) {
      const recovered = db.prepare('SELECT * FROM identities WHERE platform = ? AND alt = ? LIMIT 1').get(platform, hint.alt)
      if (recovered) {
        insertAccount(db, { platform, account, personId: recovered.person_id, alt: hint.alt, linkedBy: 'auto' })
        log?.info?.(`身份：${platform} 账号 ${account} 通过 alt 找回，重新挂到 ${recovered.person_id} 名下`)
        return recovered.person_id
      }
    }
    const personId = freshPersonId(db)
    insertAccount(db, { platform, account, personId, alt: hint?.alt ?? null, linkedBy: 'auto' })
    return personId
  })

  const lookup = (platform, account) => store.transact((db) => rowOf(db, platform, account)?.person_id ?? null)

  const accountsOf = (person) => store.transact((db) =>
    db.prepare('SELECT * FROM identities WHERE person_id = ? ORDER BY linked_at, rowid').all(person).map(rowToAccount),
  )

  const accountOn = (person, platform) => store.transact((db) =>
    db.prepare('SELECT account FROM identities WHERE person_id = ? AND platform = ? ORDER BY linked_at, rowid LIMIT 1')
      .get(person, platform)?.account ?? null,
  )

  const claimOwner = (platform, account) => store.transact((db) => {
    if (ownerOf(db)) throw new Error('已有主人，改主人走 link（面板操作）')
    const existing = rowOf(db, platform, account)
    const personId = existing?.person_id ?? freshPersonId(db)
    if (!existing) insertAccount(db, { platform, account, personId, linkedBy: 'owner' })
    metaSet(db, OWNER_KEY, personId)
    return personId
  })

  const link = (platform, account, person, by) => store.transact((db) => {
    const existing = rowOf(db, platform, account)
    if (existing && existing.person_id === person) return // 已经是这个人的，无事可做
    if (existing) {
      // 冲突：带上现有归属抛 IdentityConflict，表不被改。
      throw new IdentityConflict(
        `账号 ${platform}:${account} 已属于 ${existing.person_id}（无法改挂到 ${person}）`,
      )
    }
    insertAccount(db, { platform, account, personId: person, linkedBy: by })
  })

  const unlink = (platform, account) => store.transact((db) => {
    db.prepare('DELETE FROM identities WHERE platform = ? AND account = ?').run(platform, account)
  })

  const issueCode = (person) => store.transact((db) => {
    // 一个人同时只留一个有效口令：签发新的就作废旧口令。
    for (const row of db.prepare("SELECT key, json FROM meta WHERE key LIKE 'code:%'").all()) {
      const code = JSON.parse(row.json)
      if (code.person === person) metaDelete(db, row.key)
    }
    // 生成不与现有待兑换口令重复的 6 位数字。
    let code
    do { code = randomCode() } while (metaGet(db, `code:${code}`))
    metaSet(db, `code:${code}`, { person, expiresAt: now() + CODE_TTL_MS, fails: 0 })
    return code
  })

  const redeemCode = (platform, account, code) => store.transact((db) => {
    const key = `code:${code}`
    const entry = typeof code === 'string' ? metaGet(db, key) : null
    if (!entry) {
      // 输错：给所有仍待兑换的口令记一次失败，连错 5 次作废。
      voidFailing(db)
      return null
    }
    const cleanup = () => metaDelete(db, key)
    if (now() > entry.expiresAt) { cleanup(); return null } // 过期作废
    if (entry.fails >= CODE_MAX_FAILS) { cleanup(); return null } // 已因连错作废
    const existing = rowOf(db, platform, account)
    // 该账号已属于别人：兑换失败，不改表、不销口令（留给用户改用别的账号）。
    if (existing && existing.person_id !== entry.person) return null
    if (!existing) insertAccount(db, { platform, account, personId: entry.person, linkedBy: 'code' })
    cleanup() // 用一次作废
    return entry.person
  })

  /**
   * F2 绑定专用：新平台账号在第一次发消息时通常已经被 resolve() 自动建了临时人。
   * 普通 redeemCode 遇到这种账号会拒绝；绑定时允许把「只有这一个 auto 账号」的临时人
   * 并入签发口令的人，其他已有绑定/历史的人仍然拒绝。
   */
  const redeemCodeBinding = (platform, account, code) => store.transact((db) => {
    const key = `code:${code}`
    const entry = typeof code === 'string' ? metaGet(db, key) : null
    if (!entry) { voidFailing(db); return null }
    const cleanup = () => metaDelete(db, key)
    if (now() > entry.expiresAt) { cleanup(); return null }
    if (entry.fails >= CODE_MAX_FAILS) { cleanup(); return null }
    const existing = rowOf(db, platform, account)
    if (!existing) {
      insertAccount(db, { platform, account, personId: entry.person, linkedBy: 'code' })
      cleanup()
      return entry.person
    }
    if (existing.person_id === entry.person) { cleanup(); return entry.person }
    const rows = db.prepare('SELECT * FROM identities WHERE person_id = ?').all(existing.person_id)
    // 只接管一个平台的单个临时账号；已经有过主动 link/code/import 的人不合并。
    if (rows.length !== 1 || rows[0].linked_by !== 'auto') return null
    const clash = db.prepare('SELECT 1 FROM identities WHERE person_id = ? AND platform = ? LIMIT 1').get(entry.person, platform)
    if (clash) return null
    db.prepare('UPDATE identities SET person_id = ? WHERE person_id = ?').run(entry.person, existing.person_id)
    cleanup()
    return entry.person
  })
  // 兑换失败时给所有待兑换口令记失败；达到次数上限的当场作废。
  function voidFailing(db) {
    for (const row of db.prepare("SELECT key, json FROM meta WHERE key LIKE 'code:%'").all()) {
      const entry = JSON.parse(row.json)
      entry.fails += 1
      if (entry.fails >= CODE_MAX_FAILS) metaDelete(db, row.key)
      else metaSet(db, row.key, entry)
    }
  }

  const importLegacyQQ = (numbers) => store.transact((db) => {
    let added = 0
    let existing = 0
    for (const number of numbers) {
      const account = String(number)
      if (!account) continue
      // 幂等：已登记（不管当时挂的是谁）就跳过。导入编号就是 QQ 号字符串本身。
      if (rowOf(db, 'qq', account)) { existing++; continue }
      insertAccount(db, { platform: 'qq', account, personId: account, linkedBy: 'import' })
      added++
    }
    return { added, existing }
  })

  const repoint = (from, into) => store.transact((db) => {
    const moved = []
    const conflicts = []
    if (from === into) return { moved, conflicts }
    const rows = db.prepare('SELECT * FROM identities WHERE person_id = ? ORDER BY linked_at, rowid').all(from)
    for (const row of rows) {
      // into 在同一平台已有账号的不动，放进 conflicts。
      const target = db.prepare('SELECT 1 FROM identities WHERE person_id = ? AND platform = ? LIMIT 1').get(into, row.platform)
      if (target) { conflicts.push(rowToAccount(row)); continue }
      db.prepare('UPDATE identities SET person_id = ? WHERE platform = ? AND account = ?').run(into, row.platform, row.account)
      moved.push(rowToAccount({ ...row, person_id: into }))
    }
    return { moved, conflicts }
  })

  return {
    resolve, lookup, accountsOf, accountOn, isValid,
    owner: () => store.transact(ownerOf),
    isOwner: (person) => store.transact(ownerOf) === person,
    claimOwner, link, unlink, issueCode, redeemCode, redeemCodeBinding,
    importLegacyQQ, repoint,
  }
}
