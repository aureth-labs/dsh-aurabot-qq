import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { createFakeDsh } from './helpers/fake-dsh.js'

test('市场索引和下载量挂起时，面板请求仍可独立完成', { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-market-panel-'))
  const env = { AURABOT_DATA_DIR: dir, AURABOT_WORKSPACE: join(dir, 'workspace'), DSH_HOME: join(dir, 'dsh') }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    mkdirSync(value, { recursive: true })
    process.env[key] = value
  }
  const registryUrl = 'https://market.example.test/index.json'
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    setupDone: true, dryRun: true,
    ext: { market: { registryUrl } },
    snowluma: { autoStart: false, autoAttach: false, dir: join(dir, 'no-snowluma') },
    memory: { enabled: false, vector: { enabled: false } },
  }))
  const indexReply = Promise.withResolvers()
  const statsReply = Promise.withResolvers()
  let indexCalls = 0
  let statsCalls = 0
  const fake = createFakeDsh({ brain: async () => '' })
  let api
  t.after(async () => {
    indexReply.resolve(new Response(null, { status: 503 }))
    statsReply.resolve(new Response(null, { status: 503 }))
    try {
      fake.dispose()
      await api?.dispose?.()
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input)
    if (url === registryUrl) {
      indexCalls++
      return indexReply.promise
    }
    if (url.startsWith('https://api.github.com/repos/mock-org/mock-market/releases?')) {
      statsCalls++
      return statsReply.promise
    }
    throw new Error('隔离测试不访问远端')
  })
  const { apply } = await import('../src/host.js')
  api = apply(fake.ctx)
  await api.ready

  const get = async (path) => {
    const response = await fake.call(path)
    assert.equal(response.status, 200, path)
    const data = response.json()
    assert.equal(data.ok, true, data.message)
    return data
  }
  const market = () => get('/modules/community?view=panel')
  const waitForMarket = async (check) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const data = await market()
      if (check(data)) return data
      await pause(10)
    }
    assert.fail('市场状态未按预期更新')
  }

  const cold = await market()
  assert.equal(cold.index.loading, true)
  assert.deepEqual(cold.list, [])
  const [logs, config] = await Promise.all([get('/logs?limit=1'), get('/panel/config')])
  assert.ok(Array.isArray(logs.entries))
  assert.equal(config.config.ext.market.registryUrl, registryUrl)
  assert.equal((await market()).index.loading, true)
  assert.equal(indexCalls, 1, '多个读取共享同一次索引刷新')

  indexReply.resolve(Response.json({
    schema: 1,
    assetsBase: 'https://github.com/mock-org/mock-market/releases/download/',
    modules: [{ id: 'test-market', name: '样本模块', version: '1.0.0', api: 1, requires: [], platforms: ['*'] }],
  }))
  const ready = await waitForMarket(data => data.list.length === 1)
  assert.equal(ready.index.loading, false)
  assert.equal(ready.downloads.loading, true)
  assert.equal(ready.list[0].id, 'test-market')
  assert.ok(Array.isArray((await get('/logs?limit=1')).entries))
  assert.equal(statsCalls, 1)

  statsReply.resolve(Response.json([{ tag_name: 'test-market-v1.0.0', assets: [{ download_count: 17 }] }]))
  const complete = await waitForMarket(data => data.list[0]?.downloads === 17)
  assert.equal(complete.downloads.loading, false)
  assert.equal(indexCalls, 1)
  assert.equal(statsCalls, 1)
})
