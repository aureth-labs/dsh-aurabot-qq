// SnowLuma 单实例守卫：端口被占用且网关不健康时拒绝 spawn，避免双开写坏 messages.db。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createSnowLumaManager, shouldRefuseStart } from '../src/snowluma/manager.js'

const noLog = { info() {}, warn() {}, debug() {} }

function makeCfg(httpPort = 3000) {
  const dir = mkdtempSync(join(tmpdir(), 'snowluma-guard-'))
  writeFileSync(join(dir, 'index.mjs'), '// fake snowluma')
  mkdirSync(join(dir, 'config'), { recursive: true })
  writeFileSync(join(dir, 'config', 'onebot.json'), JSON.stringify({
    networks: { httpServers: [{ host: '127.0.0.1', port: httpPort, enable: true }] },
  }))
  return { botQQ: '20000002', snowluma: { dir, webuiPort: 15999, webuiPassword: 'x' } }
}

function fakeChild() {
  const child = new EventEmitter()
  child.pid = 1234
  child.stdout = { on() {} }
  child.stderr = { on() {} }
  return child
}

test('shouldRefuseStart：只有端口仍被占用且网关不健康才拒绝', () => {
  assert.equal(shouldRefuseStart({ portOpen: true, portFree: false, gatewayHealthy: false }), true)
  assert.equal(shouldRefuseStart({ portOpen: true, portFree: false, gatewayHealthy: true }), false, '网关健康 = 可复用')
  assert.equal(shouldRefuseStart({ portOpen: true, portFree: true, gatewayHealthy: false }), false, '端口已释放 = 可正常启动')
  assert.equal(shouldRefuseStart({ portOpen: false, portFree: false, gatewayHealthy: false }), false, '端口没被占用')
  assert.equal(shouldRefuseStart(), false)
})

test('start：端口被占用、等待后仍不释放且网关不健康 → 拒绝启动，不 spawn', async () => {
  const cfg = makeCfg()
  let spawned = 0
  const mgr = createSnowLumaManager({ getConfig: () => cfg, log: noLog })
  const r = await mgr.start({
    probe: {
      running: async () => false,
      gatewayHealthy: async () => false,
      portOpen: async () => true,
      waitPortFree: async () => false,
      spawn: () => { spawned++; return fakeChild() },
    },
  })
  assert.equal(r.ok, false)
  assert.match(r.message, /OneBot 端口 3000 被其他程序占用/)
  assert.match(r.message, /可能已有另一套 SnowLuma/)
  assert.match(r.message, /messages\.db/)
  assert.match(r.message, /关闭另一个 SnowLuma 或改端口/)
  assert.equal(spawned, 0, '不能继续 spawn 第二套 SnowLuma')
})

test('start：网关健康时直接复用，不 spawn', async () => {
  const cfg = makeCfg()
  let spawned = 0
  let portProbed = false
  const mgr = createSnowLumaManager({ getConfig: () => cfg, log: noLog })
  const r = await mgr.start({
    probe: {
      running: async () => false,
      gatewayHealthy: async () => true,
      portOpen: async () => { portProbed = true; return true },
      waitPortFree: async () => false,
      spawn: () => { spawned++; return fakeChild() },
    },
  })
  assert.equal(r.ok, true)
  assert.match(r.message, /直接复用/)
  assert.equal(spawned, 0)
  assert.equal(portProbed, false, '网关健康时不用再探端口')
})

test('start：端口空闲时正常启动', async () => {
  const cfg = makeCfg()
  let spawned = false
  const child = fakeChild()
  const mgr = createSnowLumaManager({ getConfig: () => cfg, log: noLog })
  const r = await mgr.start({
    probe: {
      // start() 开头的 running 查询要 false；spawn 后轮询看到 true 就返回
      running: async () => spawned,
      gatewayHealthy: async () => false,
      portOpen: async () => false,
      waitPortFree: async () => true,
      spawn: () => { spawned = true; return child },
    },
  })
  assert.equal(r.ok, true)
  assert.match(r.message, /已启动/)
  assert.equal(spawned, true)
})
