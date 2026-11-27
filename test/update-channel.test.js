import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, createUpdateChecker, updateCommand, updatePlan, wantsUnstable } from '../src/core/update.js'

const pkg = (version) => ({ version, repository: 'https://github.com/a/b' })
const feed = (versions) => '<feed>' + versions.map((v) => `<entry><updated>2026-11-01T00:00:00Z</updated><link rel="alternate" href="https://github.com/a/b/releases/tag/v${v}"/><title>${v}</title></entry>`).join('') + '</feed>'
const fetchOf = (versions) => {
  const asked = []
  const fetchImpl = async (url) => {
    asked.push(url)
    return { ok: true, text: async () => feed(versions) }
  }
  return { fetchImpl, asked }
}

test('版本比较：beta < rc < 正式版', () => {
  assert.ok(compareVersions('1.2.0-rc.1', '1.2.0-beta.9') > 0)
  assert.ok(compareVersions('1.2.0-beta.2', '1.2.0-beta.1') > 0)
  assert.ok(compareVersions('1.2.0-rc.2', '1.2.0-rc.1') > 0)
  assert.ok(compareVersions('1.2.0', '1.2.0-rc.9') > 0)
  assert.equal(compareVersions('1.2.0-beta.1', '1.2.0-beta.1'), 0)
})

test('没选过：用测试版算订阅，用正式版不算；选过听主人的', () => {
  assert.equal(wantsUnstable(null, '1.2.0-beta.1'), true)
  assert.equal(wantsUnstable(null, '1.2.0'), false)
  assert.equal(wantsUnstable(false, '1.2.0-beta.1'), false)
  assert.equal(wantsUnstable(true, '1.2.0'), true)
})

test('没订阅只看正式 Release，收不到 beta', async () => {
  const { fetchImpl, asked } = fetchOf(['1.1.24', '1.2.0-beta.2'])
  const r = await createUpdateChecker({ pkg: pkg('1.1.24'), fetchImpl, unstable: () => false })({ force: true })
  assert.equal(r.newer, false)
  assert.equal(r.latest, '1.1.24')
  assert.equal(asked.length, 1)
  assert.match(asked[0], /releases\.atom/)
})

test('订阅后收到 beta，命令按 Release Tag 安装', async () => {
  const { fetchImpl } = fetchOf(['1.1.24', '1.2.0-beta.2'])
  const r = await createUpdateChecker({ pkg: pkg('1.1.24'), fetchImpl, unstable: () => true })({ force: true })
  assert.equal(r.newer, true)
  assert.equal(r.latest, '1.2.0-beta.2')
  assert.equal(r.channel, 'beta')
  assert.equal(r.tag, 'v1.2.0-beta.2')
  assert.match(r.command, /#v1\.2\.0-beta\.2$/)
})

test('订阅后正式版发布时走正式版：转正不会卡在 beta', async () => {
  const { fetchImpl } = fetchOf(['1.2.0', '1.2.0-rc.3'])
  const r = await createUpdateChecker({ pkg: pkg('1.2.0-rc.3'), fetchImpl, unstable: () => true })({ force: true })
  assert.equal(r.latest, '1.2.0')
  assert.equal(r.channel, 'main')
  assert.match(r.command, /#v1\.2\.0$/)
  assert.doesNotMatch(r.command, /#beta/)
})

test('没有对应 Release/Tag 时不会把分支版本当成更新', async () => {
  const { fetchImpl } = fetchOf(['1.2.0'])
  const r = await createUpdateChecker({ pkg: pkg('1.3.0-beta.1'), fetchImpl, unstable: () => true })({ force: true })
  assert.equal(r.newer, false)
  assert.equal(r.latest, '1.2.0')
})

test('Atom 读不到时回退 GitHub Releases API', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (url.endsWith('.atom')) throw new Error('断网')
    return { ok: true, json: async () => [{ tag_name: 'v0.3.0', draft: false }] }
  }
  const r = await createUpdateChecker({ pkg: pkg('0.2.0'), fetchImpl })({ force: true })
  assert.equal(r.latest, '0.3.0')
  assert.equal(r.newer, true)
  assert.match(seen[1], /api\.github\.com/)
})

test('updateCommand 按分支或 Release Tag 给命令', () => {
  assert.match(updateCommand('a/b', 'beta'), /github:a\/b#beta/)
  assert.doesNotMatch(updateCommand('a/b', 'main'), /#/)
  assert.match(updateCommand('a/b', 'main', { ref: 'v1.2.0' }), /github:a\/b#v1\.2\.0/)
  assert.match(updatePlan({ repo: 'a/b', channel: 'main', latest: '1.2.0', tag: 'v1.2.0' }).tagUrl, /releases\/tag\/v1\.2\.0$/)
})
