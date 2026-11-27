// 心情项（情绪向量）与「向量下沉到心情模块」的回归。
//
// 背景（2026-11-17 合并）：合并前有两套心情——
//   · 心情模块：单标量 0~100（影响表情/语音/延迟/插话，进提示词）；
//   · 目的引擎：十维情绪向量（只给面板看，衰减常数写死 6 小时，目的引擎关掉就没了）。
// 两个半衰期、两块面板、谁也不影响谁。合并后：
//   · 向量归心情模块（mood.json 的 emotions/emotionsAt），与标量共用 mood.halfLifeHours；
//   · 目的引擎只上报（reportMood → mood.feel + mood.nudge），不再自己存一份；
//   · 心情项可配置（mood.emotions）：增删改名、正负倾向与强弱都可调。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMood } from '../src/features/mood.js'
import { normalize } from '../src/core/config.js'
import {
  DEFAULT_EMOTIONS, MAX_EMOTIONS, defaultEmotions, deriveEmotionVector,
  emotionLabels, normalizeEmotionVector, normalizeEmotions, profileOf, resolveEmotion, topEmotion,
} from '../src/features/mood-emotions.js'

const HOUR = 3600_000

function setup(t, patch = {}, now = new Date(2026, 10, 17, 12, 0).getTime()) {
  const previous = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-mood-emotions-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
  })
  t.mock.timers.enable({ apis: ['Date'], now })
  // 用 normalize 而不是手搓对象：心情项的归一化链路（config.js 里那段）也要一起覆盖到
  const cfg = normalize({ mood: { enabled: true, halfLifeHours: 6, ...patch } })
  return { mood: createMood({ getConfig: () => cfg }), cfg, dir, file: join(dir, 'mood.json') }
}

// ---------- 纯函数层：心情项归一化 ----------

test('心情项：默认十项，键与旧引擎的 EMOTION_LABELS 完全一致（老存档直接对得上）', () => {
  const list = normalizeEmotions(undefined)
  assert.deepEqual(list.map((e) => e.key), DEFAULT_EMOTIONS.map((e) => e.key))
  assert.equal(list.length, 10)
  // 老存档里的键必须都还在，否则迁移时向量会被整片丢掉
  for (const key of ['curious', 'excited', 'lonely', 'envious', 'worried', 'proud', 'affectionate', 'bored', 'amused', 'content']) {
    assert.ok(list.some((e) => e.key === key), `出厂项缺少 ${key}`)
  }
})

test('心情项：坏项丢弃、重复键只留第一个、一条不剩回落到出厂十项', () => {
  const list = normalizeEmotions([
    { key: 'happy', label: '开心', valence: 0.9, arousal: 0.8 },
    { key: 'happy', label: '重复的' }, // 键重复 → 丢
    { key: 'Bad Key', label: '非法键' }, // 键格式不对 → 丢
    null,
    'not-an-object',
    { label: '没有键' },
    { key: 'sad', label: '难过', valence: -9, arousal: 99 }, // 数值夹回范围
  ])
  assert.deepEqual(list.map((e) => e.key), ['happy', 'sad'])
  assert.equal(list[1].valence, -1, 'valence 夹到 -1')
  assert.equal(list[1].arousal, 1, 'arousal 夹到 1')
  assert.equal(normalizeEmotions([]).length, 10, '空数组回落到出厂十项')
  assert.equal(normalizeEmotions([{ key: 'bad key' }]).length, 10, '全是坏项也回落')
})

test('心情项：上限 24 项，标签截断到 8 个字，图标最多两个码位', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ key: 'e' + i, label: '名字' + i }))
  assert.equal(normalizeEmotions(many).length, MAX_EMOTIONS)
  const [one] = normalizeEmotions([{ key: 'x1', label: '一二三四五六七八九十', icon: '🤔🤔🤔' }])
  assert.equal(one.label, '一二三四五六七八')
  assert.equal(Array.from(one.icon).length, 2)
})

test('心情项：向量只认配置里现存的键；删掉的项自然从向量里瘦下来', () => {
  const custom = [{ key: 'happy', label: '开心' }, { key: 'sad', label: '难过' }]
  const vector = normalizeEmotionVector({ happy: 0.8, sad: 2, lonely: 0.5, garbage: 1 }, custom)
  assert.deepEqual(Object.keys(vector).sort(), ['happy', 'sad'], 'lonely 不在配置里 → 丢弃')
  assert.equal(vector.sad, 1, '超范围夹到 1')
  assert.equal(vector.happy, 0.8)
})

test('心情项：删掉的写死键映射到最接近的一项，而不是留空', () => {
  // 用户只剩「平静」和「兴奋」两项时，engine 写死的 lonely（-0.6/0.3）应落到平静（0.2/0.3）
  const custom = [{ key: 'content', label: '平静', valence: 0.2, arousal: 0.3 }, { key: 'excited', label: '兴奋', valence: 0.8, arousal: 0.9 }]
  assert.equal(resolveEmotion(custom, 'lonely'), 'content')
  assert.equal(resolveEmotion(custom, 'excited'), 'excited', '还存在的键原样返回')
  assert.equal(resolveEmotion(custom, ''), '')
  // 自定义键本身也要能解析
  assert.equal(resolveEmotion([{ key: 'sleepy', label: '困', valence: -0.2, arousal: 0.1 }], 'sleepy'), 'sleepy')
})

test('心情项：标签与画像跟着配置走；未知键回中性偏弱', () => {
  const custom = [{ key: 'cozy', label: '惬意', valence: 0.5, arousal: 0.2 }]
  assert.deepEqual(emotionLabels(custom), { cozy: '惬意' })
  assert.deepEqual(profileOf(custom, 'cozy'), { valence: 0.5, arousal: 0.2 })
  assert.deepEqual(profileOf(custom, 'unknown'), { valence: 0, arousal: 0.4 })
})

test('心情项：向量衰减按半衰期，抬升可给权重，最长只认 72 小时', () => {
  const base = { curious: 1, excited: 0.5 }
  const six = deriveEmotionVector({ vector: base, at: 1000, boost: null, halfLifeHours: 6, now: 1000 + 6 * HOUR })
  assert.equal(Math.round(six.vector.curious * 100), 50, '一个半衰期掉一半')
  assert.equal(Math.round(six.vector.excited * 100), 25)
  // 抬升：+0.45 封顶到 1
  const boosted = deriveEmotionVector({ vector: { curious: 0.9 }, at: 1000, boost: 'curious', halfLifeHours: 6, now: 1000 })
  assert.equal(boosted.vector.curious, 1)
  // 权重 0 不抬
  const zero = deriveEmotionVector({ vector: {}, at: 1000, boost: { curious: 0 }, now: 1000 })
  assert.equal(zero.vector.curious || 0, 0)
  // 72 小时上限：三天前的兴奋几乎归零，而不是按公式留 0.0001 那样的残渣
  const long = deriveEmotionVector({ vector: { curious: 1 }, at: 1000, halfLifeHours: 6, now: 1000 + 240 * HOUR })
  assert.ok(long.vector.curious < 0.0004, `衰减到几乎为零，实际 ${long.vector.curious}`)
  // at=0（没结算过）不衰减，否则刚启动就把存档洗光
  const fresh = deriveEmotionVector({ vector: { curious: 0.7 }, at: 0, halfLifeHours: 6, now: 1000 })
  assert.equal(fresh.vector.curious, 0.7)
})

test('心情项：topEmotion 只报够格的项，全淡了就说「没有」', () => {
  const custom = [{ key: 'a', label: '甲' }, { key: 'b', label: '乙', icon: '😄' }]
  assert.equal(topEmotion({ a: 0.1, b: 0.6 }, custom).key, 'b')
  assert.equal(topEmotion({ a: 0.1, b: 0.6 }, custom).icon, '😄')
  assert.equal(topEmotion({ a: 0.01 }, custom), null, '都低于门槛 → null，不硬报一个 0.01 的项')
})

// ---------- 心情模块：向量记账 ----------

test('心情模块：feel 抬升向量并落盘；state 带出情绪条与最强项', (t) => {
  const { mood, file } = setup(t)
  assert.equal(mood.state().emotionsItems.length, 10, '出厂十项都下发')
  mood.feel('lonely', { weight: 0.6 })
  const state = mood.state()
  assert.ok(state.emotions.lonely >= 0.6, `寂寞被抬起来了（实际 ${state.emotions.lonely}）`)
  assert.equal(state.emotionTop.key, 'lonely')
  assert.match(state.emotionTop.label, /寂寞/)
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(onDisk.emotions.lonely >= 0.6, '向量落在 mood.json 里（不是目的引擎的状态文件）')
  assert.ok(onDisk.emotionsAt > 0, '结算时间也落盘，衰减才有起点')
})

test('心情模块：向量与标量共用 mood.halfLifeHours（不再是引擎里写死的 6 小时）', (t) => {
  const { mood } = setup(t, { halfLifeHours: 1 })
  mood.feel('excited', { weight: 0.8 })
  t.mock.timers.setTime(Date.now() + HOUR)
  const after = mood.state().emotions.excited
  assert.ok(Math.abs(after - 0.4) < 0.02, `1 小时半衰期后应剩约 0.4，实际 ${after}`)
})

test('心情模块：模块关着 / 调试模式时 feel 静默，不落盘', (t) => {
  const off = setup(t, { enabled: false })
  assert.equal(off.mood.feel('lonely'), null)
  const debug = normalize({ mood: { enabled: true }, debug: true })
  const previous = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-mood-emotions-debug-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => { process.env.AURABOT_DATA_DIR = previous })
  const m = createMood({ getConfig: () => debug })
  assert.equal(m.feel('lonely'), null)
  assert.equal(m.state().emotions.lonely || 0, 0)
})

test('心情模块：心情项改了立刻生效——删掉的项不再下发，新项也能被 feel', (t) => {
  const { mood, cfg } = setup(t)
  const before = mood.state().emotionsItems.map((e) => e.key)
  assert.ok(before.includes('bored'))
  // 模拟面板保存：只留两项，其中一项是自定义键
  cfg.mood.emotions = [
    { key: 'happy', label: '开心', icon: '😄', valence: 0.8, arousal: 0.7 },
    { key: 'sleepy', label: '困', icon: '😴', valence: -0.1, arousal: 0.1 },
  ]
  const after = mood.state().emotionsItems.map((e) => e.key)
  assert.deepEqual(after, ['happy', 'sleepy'], '删掉的项不再下发')
  mood.feel('sleepy', { weight: 0.5 })
  assert.equal(mood.state().emotionTop.key, 'sleepy')
  // 删掉的键喂进来也不会凭空造出一项
  mood.feel('bored', { weight: 0.9 })
  assert.equal(mood.state().emotions.bored, undefined)
})

test('心情模块：importEmotions 只并「更强的」项，不覆盖她现在更高的情绪', (t) => {
  const { mood } = setup(t)
  mood.feel('excited', { weight: 0.9 })
  mood.importEmotions({ excited: 0.2, lonely: 0.7 })
  const s = mood.state()
  assert.ok(s.emotions.excited >= 0.9, '已有的更高值不被旧向量压低')
  assert.ok(s.emotions.lonely >= 0.7, '旧向量里更高的项被搬进来')
})

// ---------- 目的引擎：只上报，不再自己存向量 ----------

test('目的引擎：清单里不再有心情向量，旧向量在第一次 load 时迁进心情模块并打标记', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-purpose-mood-migrate-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => { process.env.AURABOT_DATA_DIR = previous })
  mkdirSync(join(dir, 'purpose'), { recursive: true })
  // 老存档：情绪向量还在目的引擎的状态文件里
  writeFileSync(join(dir, 'purpose', 'purpose-state.json'), JSON.stringify({
    day: '2026-11-17',
    lastEmotion: 'lonely',
    moods: { lonely: 0.8, excited: 0.3 },
    moodsAt: Date.now() - 1000,
  }))
  const { createPurpose, purposeConfig } = await import('../src/purpose/module.js')
  const { normalize } = await import('../src/core/config.js')
  const cfg = normalize({ mood: { enabled: true }, ext: { purpose: { enabled: true } }, speakUp: { enabled: false } })
  const felt = []
  const p = createPurpose({
    getConfig: () => cfg,
    hub: { chatLogDays: () => [], chatLogOf: () => [] },
    log: { info() {}, warn() {}, debug() {} },
    mood: () => ({
      nudge() {},
      feel(emotion, opts) { felt.push({ emotion, opts }) },
      importEmotions(raw, opts) { felt.push({ imported: raw, opts }) },
    }),
    memory: () => ({ list: () => [] }),
    identity: null,
  })
  p.state() // 触发 loadState → 迁移
  const imported = felt.find((x) => x.imported)
  assert.ok(imported, '旧向量被交给心情模块')
  assert.equal(imported.imported.lonely, 0.8)
  // 迁移后的目的状态：向量清空、标记落盘（否则每次启动都会重新搬一遍）
  const saved = JSON.parse(readFileSync(join(dir, 'purpose', 'purpose-state.json'), 'utf8'))
  assert.deepEqual(saved.moods, {}, '迁移后目的引擎不再持有向量')
  assert.equal(saved.moodsAt, 0)
  assert.ok(saved.moodsMigratedAt > 0, '迁移标记要落盘')
  // 再 load 一次不应再搬（标记生效）
  felt.length = 0
  p.state()
  assert.equal(felt.filter((x) => x.imported).length, 0, '标记生效后不再重复迁移')
  // 配置层面也不再暴露向量相关的派生状态
  assert.equal(typeof purposeConfig(cfg).dailyMax, 'number', 'purposeConfig 照常可用')
})

test('心情历史路由的数据源仍在 state 里（面板改从 /mood/history 拉，不再依赖 /state）', (t) => {
  const { mood } = setup(t)
  mood.nudge(10, '被夸了', 'private:10001')
  const s = mood.state()
  assert.equal(Array.isArray(s.history), true)
  assert.equal(s.history[0].reason, '被夸了')
  // /state 侧会剥掉 history（e2e 锁着），所以面板必须走 /mood/history —— 见 client 的 Mood 组件
  assert.ok(s.history.length >= 1)
})
