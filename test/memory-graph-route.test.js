import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { normalize } from '../src/core/config.js'
import { LAYOUT_VERSION } from '../src/features/memory-graph.js'
import memoryModule from '../src/modules/memory/index.js'
import { writeMemoryState } from './helpers/memory-state.js'

const owner = '10000001'
const previousGroup = 'person:previous'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-graph-route-'))
  const previousDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const disposers = []
  const workers = []
  let memory
  const dispose = () => { for (const callback of disposers.splice(0).reverse()) callback() }
  t.after(async () => {
    dispose()
    await Promise.all(workers.map(({ finished }) => finished))
    memory?.close()
    if (previousDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previousDir
    rmSync(dir, { recursive: true, force: true })
  })

  const at = Date.now()
  const fact = (id, text) => ({
    id, text, about: owner, chatId: `private:${owner}`, source: 'tool', at, saidAt: at, importance: 0.7, tier: 2,
  })
  writeMemoryState(dir, { items: [fact('star-a', '主人收藏瓷杯'), fact('star-b', '主人喝普洱茶')] })
  const file = join(dir, 'graph-state.json')
  const previous = JSON.stringify({
    version: LAYOUT_VERSION,
    at: 1,
    layout: {
      version: LAYOUT_VERSION,
      radius: 470,
      groups: [{ id: previousGroup, label: '旧星团', x: 200, y: 100, z: 400 }],
      positions: { 'star-a': { x: 203, y: 105, z: 402 }, 'star-b': { x: 195, y: 98, z: 399 } },
      clusters: { 'star-a': previousGroup, 'star-b': previousGroup },
    },
  })
  writeFileSync(file, previous, 'utf8')

  const started = Promise.withResolvers()
  const addListenerOnce = Worker.prototype.once
  t.mock.method(Worker.prototype, 'once', function (event, listener) {
    const result = addListenerOnce.call(this, event, listener)
    if (event === 'message') {
      const worker = this
      const finished = new Promise(resolve => addListenerOnce.call(worker, 'exit', resolve))
      workers.push({ worker, finished })
      started.resolve({ worker, finished })
    }
    return result
  })
  const handlers = new Map()
  const config = normalize({ ownerQQ: owner, memory: { enabled: true, dailyConsolidate: false, vector: { enabled: false } } })
  memory = memoryModule.setup({
    config: () => config,
    dsh: {},
    dataDir: (...parts) => join(dir, ...parts),
    log: { info() {}, warn() {}, debug() {} },
    core: {
      hub: { chatLogDays: () => [], chatLogOf: () => [] },
      http: { body: async req => req.body },
    },
    context() {}, on() {}, every() {}, tool() {},
    route: (path, fn) => handlers.set(path, fn),
    onDispose: callback => disposers.push(callback),
  })
  return {
    memory, dir, file, previous, dispose, workers,
    request: (day = 0) => handlers.get('/memory/graph')({ body: { day } }),
    async waitForWorker(request) {
      const running = await Promise.race([started.promise, request.then(() => null)])
      assert.ok(running, '布局须启动真实 Worker')
      return running
    },
  }
}

test('记忆星图合并同代次请求，沿用旧布局并写回完整 graph-state.json', { timeout: 5000 }, async t => {
  const graph = setup(t)
  const first = graph.request()
  const duplicate = graph.request()
  const conflicting = await graph.request(1)
  assert.equal(conflicting.ok, false)
  assert.match(conflicting.message, /正在计算/)
  const { worker } = await graph.waitForWorker(first)
  assert.ok(worker instanceof Worker)
  const [result, reused] = await Promise.all([first, duplicate])
  assert.equal(result.ok, true, result.message)
  assert.strictEqual(reused, result, '同代次请求共用同一份布局结果')
  assert.equal(graph.workers.length, 1)
  assert.equal(result.stars.length, 2)
  assert.ok(result.edges.some(edge => [edge.a, edge.b].sort().join(',') === 'star-a,star-b'))
  assert.deepEqual(result.clusters, { 'star-a': previousGroup, 'star-b': previousGroup })
  const persisted = JSON.parse(readFileSync(graph.file, 'utf8'))
  assert.equal(persisted.version, LAYOUT_VERSION)
  assert.ok(persisted.at > 1)
  for (const { id, x, y, z } of result.stars) {
    assert.ok([x, y, z].every(Number.isFinite))
    assert.deepEqual(persisted.layout.positions[id], { x, y, z })
  }
  assert.ok(!readdirSync(graph.dir).some(name => name.startsWith('graph-state.json.tmp-')))
})

test('真实 Worker 运行期间修改记忆，旧布局不会写盘或返回已删除条目', { timeout: 5000 }, async t => {
  const graph = setup(t)
  const first = graph.request()
  await graph.waitForWorker(first)
  assert.equal(graph.memory.remove('star-a').ok, true)
  const stale = await first
  assert.equal(stale.ok, false)
  assert.match(stale.message, /记忆已变化/)
  assert.equal(readFileSync(graph.file, 'utf8'), graph.previous)
  const fresh = await graph.request()
  assert.equal(fresh.ok, true, fresh.message)
  assert.deepEqual(fresh.stars.map(({ id }) => id), ['star-b'])
  assert.equal(graph.workers.length, 2)
})

test('卸载记忆模块会终止当前的真实 Worker 并保留已有布局', { timeout: 5000 }, async t => {
  const graph = setup(t)
  const request = graph.request()
  const { worker, finished } = await graph.waitForWorker(request)
  const terminate = t.mock.method(worker, 'terminate')
  graph.dispose()
  assert.equal(terminate.mock.callCount(), 1)
  await finished
  assert.equal(worker.threadId, -1)
  assert.equal((await request).ok, false)
  assert.equal(readFileSync(graph.file, 'utf8'), graph.previous)
})

test('星图布局超时结束线程，忽略晚到结果，同一请求可以重试', { timeout: 5000 }, async t => {
  const graph = setup(t)
  const timers = new Map()
  const cleared = new Set()
  const startTimer = globalThis.setTimeout
  const stopTimer = globalThis.clearTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = startTimer(callback, delay, ...args)
    if (delay === 15_000) timers.set(timer, callback)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', timer => {
    if (timers.has(timer)) cleared.add(timer)
    return stopTimer(timer)
  })

  const first = graph.request()
  const duplicate = graph.request()
  const { worker, finished } = await graph.waitForWorker(first)
  const terminate = t.mock.method(worker, 'terminate')
  assert.equal(timers.size, 1)
  const [[timer, fire]] = timers
  fire()
  worker.emit('message', { edges: [], out: {} })
  const [timeout, reused] = await Promise.all([first, duplicate])
  assert.deepEqual(timeout, { ok: false, message: '星图布局超时，请稍后重试' })
  assert.strictEqual(reused, timeout)
  assert.ok(cleared.has(timer))
  await finished
  assert.equal(worker.threadId, -1)
  assert.equal(terminate.mock.callCount(), 1)
  assert.equal(readFileSync(graph.file, 'utf8'), graph.previous)

  const fresh = await graph.request()
  assert.equal(fresh.ok, true, fresh.message)
  assert.deepEqual(fresh.stars.map(({ id }) => id).sort(), ['star-a', 'star-b'])
  assert.equal(graph.workers.length, 2)
  assert.equal(timers.size, 2)
  assert.equal(cleared.size, 2, '成功之后也应清理超时计时器')
})
