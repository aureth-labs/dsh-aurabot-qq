// G1 测试基建：内存假 Identity + 网关测试壳。
// identity 接缝：G1 只要求「实现 Identity 形状的对象」，这里给一个内存假实现；
// I1 合并后测试换真实现即可，网关代码不动。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../../src/gateway/index.js'
import { makeFakeAdapter } from '../helpers/fake-adapter.js'

/** 内存假 Identity：按平台+账号记人，PersonId 是 p-xxxxxxxxxxxxxxxx 形状的不透明串。 */
export function makeIdentity() {
  const links = new Map() // `${platform}\u0000${account}` → person
  const persons = new Map() // person → Account[]
  let seq = 0
  const key = (platform, account) => `${platform}\u0000${account}`
  return {
    resolve(platform, account, hint) {
      const k = key(platform, account)
      if (!links.has(k)) {
        const person = 'p-' + String(++seq).padStart(16, '0')
        links.set(k, person)
        persons.set(person, [])
      }
      const person = links.get(k)
      const list = persons.get(person)
      if (!list.some((x) => x.platform === platform && x.account === account)) {
        list.push({ platform, account, alt: hint?.alt, linkedAt: Date.now(), linkedBy: 'auto' })
      }
      return person
    },
    lookup(platform, account) {
      return links.get(key(platform, account)) ?? null
    },
    accountsOf(person) {
      return (persons.get(person) || []).map((x) => ({ ...x }))
    },
    accountOn(person, platform) {
      return (persons.get(person) || []).find((x) => x.platform === platform)?.account ?? null
    },
    isValid(value) {
      return typeof value === 'string' && persons.has(value)
    },
    owner() {
      return null
    },
    isOwner() {
      return false
    },
    claimOwner() {
      throw new Error('测试假实现不支持 claimOwner')
    },
    link(platform, account, person) {
      const k = key(platform, account)
      if (links.has(k) && links.get(k) !== person) throw new Error('IdentityConflict')
      links.set(k, person)
      if (!persons.has(person)) persons.set(person, [])
      const list = persons.get(person)
      if (!list.some((x) => x.platform === platform && x.account === account)) {
        list.push({ platform, account, linkedAt: Date.now(), linkedBy: 'owner' })
      }
    },
    unlink(platform, account) {
      links.delete(key(platform, account))
    },
    issueCode() {
      return 'test-code'
    },
    redeemCode() {
      return null
    },
    importLegacyQQ() {
      return { added: 0, existing: 0 }
    },
    repoint() {
      return { moved: [], conflicts: [] }
    },
  }
}

/** 临时数据目录：每次隔离 */
export function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'aurabot-gw-'))
}

/**
 * 建一个测试网关。
 * @param {object} opts
 * @param {Record<string, object>=} opts.platforms 写进 config.platforms
 * @param {Array=} opts.adapters 预注册的假平台端工厂列表（返回 adapter 对象的函数）
 * @param {object=} opts.identity 默认 makeIdentity()
 * @param {() => number=} opts.now 注入时钟（测过期用）
 * @param {number=} opts.replyHoldMs 被动回复合并挂起时长（默认 40，测试要快）
 * @returns {{ gateway, identity, http, log: { lines: string[] } }}
 */
export function makeGateway({ platforms = {}, adapters = [], identity, now, replyHoldMs = 40 } = {}) {
  const root = makeTempRoot()
  const http = {
    routes: new Map(),
    route(path, handler) {
      this.routes.set(path, handler)
      return () => this.routes.delete(path)
    },
  }
  const lines = []
  const log = {
    debug() {},
    info() {},
    warn(...a) {
      lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
    },
    error() {},
  }
  const gateway = createGateway({
    config: { platforms },
    dataDir: (...parts) => join(root, 'data', ...parts),
    http,
    identity: identity || makeIdentity(),
    log,
    now,
    replyHoldMs,
  })
  for (const factory of adapters) gateway.register(factory)
  return { gateway, identity: gateway.identity, http, log: { lines } }
}

/**
 * 假平台端工厂：每次调用产出一个全新 adapter（同平台多实例各得一份）。
 * factory.get(i) 取第 i 个被创建的实例（register 探测 id 会先创建第 0 个）。
 */
export function fakeFactory(overrides = {}) {
  const created = []
  const factory = () => {
    const adapter = makeFakeAdapter(overrides)
    created.push(adapter)
    return adapter
  }
  factory.created = created
  factory.get = (i = 0) => created[i]
  return factory
}

const setTimeoutReal = setTimeout
export { setTimeoutReal }
