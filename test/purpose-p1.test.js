// P1（speakup → purpose 迁移）配置翻转与播种的回归。
// 方案：docs/SPEAKUP-INTO-PURPOSE-PLAN.md §3（配置迁移）/ §7.1（P1 用例清单）。
// 覆盖五条验收：新装默认开、显式 false 不被洗回、老用户 speakUp.enabled=true 播种开、
// 播种只发生一次、nudge 写读一致（双层 fallback）。
// 播种用例走真实模块壳（src/modules/purpose/index.js）+ createModules 最小 harness；
// 落盘用 AURABOT_DATA_DIR 临时目录隔离，不引入新依赖。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { purposeConfig } from '../src/purpose/module.js'
import { quietWindowOf, inHourWindow } from '../src/core/time-window.js'
import purposeDef from '../src/modules/purpose/index.js'
import { createModules } from '../src/core/modules.js'

// ---------- 1. purposeConfig 开关语义（纯函数，Q1 拍板：默认开） ----------

test('P1 默认开：ext.purpose.enabled 缺省（undefined）= 开', () => {
  assert.equal(purposeConfig({}).enabled, true, '什么都没配也开（Q1：新装默认开启）')
  assert.equal(purposeConfig({ speakUp: { enabled: true } }).enabled, true, '只配了 speakUp 也开')
  assert.equal(purposeConfig({ ext: { purpose: { minMaterials: 3 } } }).enabled, true, 'ext.purpose 有别的键但没写 enabled = 开')
  // 全局总开关关着时仍不开（这是插件级 enabled，不是 purpose 自己的键，语义不变）
  assert.equal(purposeConfig({ enabled: false }).enabled, false)
})

test('显式 false 尊重，不被默认值洗回', () => {
  const cfg = normalize({ ext: { purpose: { enabled: false } } })
  assert.equal(cfg.ext.purpose.enabled, false, 'normalize 不得把显式 false 洗掉（Q1 实现要点）')
  assert.equal(purposeConfig(cfg).enabled, false, '显式关过 = 保持关')
  // 显式 false 但其它调参仍在：关是关，参数保留
  const cfg2 = normalize({ ext: { purpose: { enabled: false, minMaterials: 5 } } })
  assert.equal(purposeConfig(cfg2).enabled, false)
  assert.equal(purposeConfig(cfg2).minMaterials, 5)
})

// ---------- 2. 追问 nudge 双层 fallback（P1 翻键：读兼容，写入口在 /panel/purpose/config） ----------

test('nudge：ext.purpose.nudge ?? speakUp.nudge ?? true 双层读', () => {
  assert.equal(purposeConfig({}).nudge, true, '两边都没设 = 默认开')
  assert.equal(purposeConfig({ speakUp: { nudge: false } }).nudge, false, '老用户 speakUp.nudge=false 仍生效（迁移不洗）')
  assert.equal(purposeConfig({ speakUp: { nudge: true } }).nudge, true)
  assert.equal(purposeConfig({ speakUp: { nudge: true }, ext: { purpose: { nudge: false } } }).nudge, false, 'ext 覆写位优先（翻键后的写入口）')
  assert.equal(purposeConfig({ speakUp: { nudge: false }, ext: { purpose: { nudge: true } } }).nudge, true, '显式 ext 覆写可重新打开')
})

// ---------- 2.5 醒着窗口边界（用户报障回归：醒着 07~24 不得被当成全天） ----------

test('醒着窗口边界：awakeTo=24 是「到当天结束」不是全天', () => {
  // 用户报障场景：醒着 07~24，安静（睡着）必须是 00:00~07:00，而不是 00:00~00:00（全天/不启用）
  assert.deepEqual(quietWindowOf(7, 24), { quietStart: '00:00', quietEnd: '07:00' })
  // normalize 不钳掉 24：用户设的 7/24 原样落盘
  const cfg = normalize({ speakUp: { awakeFrom: 7, awakeTo: 24 } })
  assert.equal(cfg.speakUp.awakeFrom, 7)
  assert.equal(cfg.speakUp.awakeTo, 24)
  const config = purposeConfig(cfg)
  assert.equal(config.quietStart, '00:00')
  assert.equal(config.quietEnd, '07:00')
  // 行为口径：0~6 点睡着、7~23 点醒着
  const h = (hour) => inHourWindow(new Date(2026, 0, 1, hour).getTime(), 7, 24)
  assert.equal(h(0), false, '0 点睡着')
  assert.equal(h(6), false, '6 点睡着')
  assert.equal(h(7), true, '7 点醒着')
  assert.equal(h(23), true, '23 点醒着')
})

test('醒着窗口边界：0/24、24/24、0/0 才是全天（安静 00:00~00:00 = 不启用）', () => {
  assert.deepEqual(quietWindowOf(0, 24), { quietStart: '00:00', quietEnd: '00:00' })
  assert.deepEqual(quietWindowOf(24, 24), { quietStart: '00:00', quietEnd: '00:00' })
  assert.deepEqual(quietWindowOf(0, 0), { quietStart: '00:00', quietEnd: '00:00' })
  // 跨天窗口（9~3）：安静 = 03:00~09:00，别被 24 端点弄坏
  assert.deepEqual(quietWindowOf(9, 3), { quietStart: '03:00', quietEnd: '09:00' })
  // awakeTo=0（跨天另一端）：醒着 7~0 = 7 点到午夜，安静 00:00~07:00
  assert.deepEqual(quietWindowOf(7, 0), { quietStart: '00:00', quietEnd: '07:00' })
})

test('醒着窗口边界：7/23 当天窗口与跨午夜环绕（非 24 端点的 from>to 不受 24 修复影响）', () => {
  // 7~23 是普通当天窗口：安静 = 23:00~07:00（不含 24 端点参与）
  assert.deepEqual(quietWindowOf(7, 23), { quietStart: '23:00', quietEnd: '07:00' })
  // 9~3 跨午夜环绕保持原语义：醒着 9 点到次日 3 点，安静 3 点–9 点
  const config = purposeConfig({ speakUp: { awakeFrom: 9, awakeTo: 3 } })
  assert.equal(config.quietStart, '03:00')
  assert.equal(config.quietEnd, '09:00')
  // 行为口径：环绕窗口 3~8 点睡着、9~23 点与 0~2 点醒着
  const h = (hour) => inHourWindow(new Date(2026, 0, 1, hour).getTime(), 9, 3)
  assert.equal(h(3), false, '3 点睡着')
  assert.equal(h(8), false, '8 点睡着')
  assert.equal(h(9), true, '9 点醒着')
  assert.equal(h(23), true, '23 点醒着')
  assert.equal(h(0), true, '0 点（次日凌晨）仍醒着')
  assert.equal(h(2), true, '2 点仍醒着')
})

// ---------- 3. 播种（§3.1：只发生一次，只写 ext.purpose，显式关过不覆盖） ----------

/** createModules 最小 harness：只装 purpose 一个内置模块，getConfig/setConfig 用内存配置。
 *  initialCfg 带顶层 enabled:true：normalize 的安全默认是总开关关（enabled:false），
 *  而播种用例关注的是 ext.purpose 层，先把插件级总开关打开。 */
function makeMods(initialCfg) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-p1-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  let cfg = normalize({ enabled: true, ...initialCfg })
  const writes = [] // 每次 setConfig 的深拷贝快照：播种「只发生一次」靠它断言
  const noop = { info() {}, warn() {}, error() {}, debug() {}, child() { return noop } }
  const fakeCtx = { effect: () => () => {}, on: () => () => {} }
  const mods = createModules({
    ctx: fakeCtx,
    core: { hub: {} }, // setup 只把 hub 存进闭包，不立即调用
    getConfig: () => cfg,
    setConfig: (next) => { cfg = normalize(next); writes.push(JSON.parse(JSON.stringify(cfg))) },
    logger: { child: () => noop },
    version: 'test',
    builtins: [purposeDef],
  })
  return {
    mods,
    cfg: () => cfg,
    writes,
    cleanup: () => { mods.dispose(); rmSync(dataDir, { recursive: true, force: true }); delete process.env.AURABOT_DATA_DIR; delete process.env.AURABOT_WORKSPACE },
  }
}

test('播种：speakUp.enabled=true 且 ext 未设 → 播种开 + 写标记', async () => {
  const h = makeMods({ speakUp: { enabled: true } })
  try {
    await h.mods.boot()
    const ext = h.cfg().ext?.purpose || {}
    assert.equal(ext.enabled, true, '播种把 ext.purpose.enabled 落成 true')
    assert.equal(ext.seededFromSpeakup, true, '播种标记已写（重启不再重复）')
    assert.equal(h.writes.length, 1, '播种只发生一次写盘')
    assert.equal(purposeConfig(h.cfg()).enabled, true)
  } finally { h.cleanup() }
})

test('播种只发生一次：重启（stop → sync 再启动）不再写盘', async () => {
  const h = makeMods({ speakUp: { enabled: true } })
  try {
    await h.mods.boot()
    const markerAfterFirst = h.cfg().ext.purpose.seededFromSpeakup
    assert.equal(h.writes.length, 1)
    // 模拟重启：停掉再让 sync 按配置重新拉起内置模块
    h.mods.stop('purpose')
    await h.mods.sync()
    assert.equal(h.cfg().ext.purpose.seededFromSpeakup, markerAfterFirst, '标记不变')
    assert.equal(h.cfg().ext.purpose.enabled, true, '开关保持开')
    assert.equal(h.writes.length, 1, '第二次启动没有再写盘（标记兜住）')
  } finally { h.cleanup() }
})

test('显式关过（ext.purpose.enabled=false）不被播种覆盖', async () => {
  const h = makeMods({ speakUp: { enabled: true }, ext: { purpose: { enabled: false } } })
  try {
    await h.mods.boot()
    const ext = h.cfg().ext?.purpose || {}
    assert.equal(ext.enabled, false, '保持关')
    assert.equal(ext.seededFromSpeakup, undefined, '不写播种标记（用户显式选择过，不再打扰）')
    assert.equal(h.writes.length, 0, '没有任何写盘')
    assert.equal(purposeConfig(h.cfg()).enabled, false)
  } finally { h.cleanup() }
})

test('speakUp.enabled=false 的用户（新装语义）：不播种标记，引擎按默认开语义运行', async () => {
  const h = makeMods({ speakUp: { enabled: false } })
  try {
    await h.mods.boot()
    const ext = h.cfg().ext?.purpose || {}
    assert.equal(ext.seededFromSpeakup, undefined, '没有 speakUp 在用就不打迁移标记')
    // Q1：默认开是键语义（缺省=开），不依赖 speakUp 状态
    assert.equal(purposeConfig(h.cfg()).enabled, true)
  } finally { h.cleanup() }
})

after(() => { try { delete process.env.AURABOT_DATA_DIR } catch {} try { delete process.env.AURABOT_WORKSPACE } catch {} })
