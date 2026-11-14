// 测试用轻量 Identity（实现 contracts.d.ts §2 Identity 形状），供各单元测试注入 identity 与 routeOwner。

export function makeTestIdentity(ownerAccount = '10000001', platform = 'qq', { personId = '', legacyIds = [] } = {}) {
  const links = new Map()
  const persons = new Map()
  let seq = 0
  let ownerPerson = null
  const key = (plat, acc) => `${String(plat || '').trim()}\u0000${String(acc ?? '').trim()}`

  const importLegacyQQ = (numbers = []) => {
    let added = 0
    let existing = 0
    for (const raw of numbers || []) {
      const acc = String(raw ?? '').trim()
      if (!/^\d+$/.test(acc)) continue
      const k = key('qq', acc)
      if (links.has(k)) { existing++; continue }
      links.set(k, acc)
      if (!persons.has(acc)) persons.set(acc, [])
      const list = persons.get(acc)
      if (!list.some((x) => x.platform === 'qq' && x.account === acc)) {
        list.push({ platform: 'qq', account: acc, linkedAt: Date.now(), linkedBy: 'legacy' })
      }
      added++
    }
    return { added, existing }
  }

  const resolve = (plat, acc, hint) => {
    const p = String(plat || '').trim()
    const a = String(acc ?? '').trim()
    if (!p || !a) throw new Error('platform / account 不能为空')
    const k = key(p, a)
    if (!links.has(k)) {
      const id = 'p-' + String(++seq).padStart(16, '0')
      links.set(k, id)
      persons.set(id, [])
    }
    const id = links.get(k)
    const list = persons.get(id)
    if (!list.some((x) => x.platform === p && x.account === a)) {
      list.push({ platform: p, account: a, ...(hint?.alt ? { alt: hint.alt } : {}), linkedAt: Date.now(), linkedBy: 'auto' })
    }
    return id
  }

  const claimWithId = (plat, acc, explicitId = '') => {
    const p = String(plat || '').trim()
    const a = String(acc ?? '').trim()
    const k = key(p, a)
    if (!links.has(k) && explicitId) {
      links.set(k, explicitId)
      if (!persons.has(explicitId)) persons.set(explicitId, [])
      persons.get(explicitId).push({ platform: p, account: a, linkedAt: Date.now(), linkedBy: 'owner' })
      ownerPerson = explicitId
      return explicitId
    }
    const id = resolve(p, a)
    ownerPerson = id
    return id
  }

  const identity = {
    resolve,
    lookup: (plat, acc) => links.get(key(plat, acc)) ?? null,
    accountsOf: (person) => (persons.get(person) || []).map((x) => ({ ...x })),
    accountOn: (person, plat) => (persons.get(person) || []).find((x) => x.platform === plat)?.account ?? null,
    isValid: (val) => typeof val === 'string' && (/^p-[0-9a-z-]+$/i.test(val) || persons.has(val)),
    importLegacyQQ,
    owner: () => ownerPerson,
    isOwner: (person) => Boolean(person && ownerPerson && person === ownerPerson),
    claimOwner: (plat, acc) => claimWithId(plat, acc),
    setOwner: (acc, plat = platform, explicitId = '') => {
      if (!acc) { ownerPerson = null; return null }
      return claimWithId(plat, acc, explicitId)
    },
    clearOwner: () => { ownerPerson = null },
    routeOwner: (preferPlat = platform) => {
      if (!ownerPerson) return ''
      const list = persons.get(ownerPerson) || []
      const hit = (preferPlat ? list.find((x) => x.platform === preferPlat) : null) || list[0]
      if (!hit) return ''
      return hit.platform === 'qq' ? `private:${hit.account}` : `${hit.platform}:private:${hit.account}`
    },
  }

  if (Array.isArray(legacyIds) && legacyIds.length) importLegacyQQ(legacyIds)
  if (ownerAccount) claimWithId(platform, ownerAccount, personId)
  return identity
}
