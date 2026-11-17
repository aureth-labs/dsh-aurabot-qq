// 自驱引擎 v5 · 三层技能体系测试（R7/R8，docs/design/autotelic-v5/00-v5-final.md §2.4/§3.4）。
// 覆盖：三层目录契约、晋升链各阈值、快照回滚、score 只认终态（含模型自评篡改无效）、
// stale 归档、方法解析三档、探索模式返回 null、稳定前缀段（prefix.js §9.3）。

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSkillStore } from '../src/autotelic/skills.js'
import { buildPrefix, hashPrefix, createPrefixCache } from '../src/autotelic/prefix.js'

let root
let t0 // 固定时间源：快照目录名可预测

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'autotelic-skills-v5-'))
  t0 = 1731800000000
})
afterEach(() => { try { rmSync(root, { recursive: true, force: true }) } catch {} })

const mkStore = (opts = {}) => createSkillStore(join(root, 'skills'), {
  now: () => { t0 += 1000; return t0 },
  personaFile: opts.personaFile ?? null,
  distill: opts.distill ?? null,
  log: () => {},
})

// ---------- 三层目录契约 ----------

test('目录契约：memory/skills/instinct/archive/history + index.json 一次建齐；一技能一 md + frontmatter', () => {
  const s = mkStore()
  const r = s.ingestReflection({ roundId: 'r1', tag: '裁切', lesson: '竖屏先裁后转', evidence: ['obs-1'] })
  assert.equal(r.ok, true)
  const base = join(root, 'skills')
  for (const d of ['memory', 'skills', 'instinct', 'archive', 'history']) assert.ok(existsSync(join(base, d)), `${d}/ 存在`)
  assert.ok(existsSync(join(base, 'index.json')), 'index.json 存在')
  const raw = readFileSync(join(base, 'memory', 'r1.md'), 'utf8')
  assert.match(raw, /^---\n/, 'frontmatter 在')
  for (const k of ['id', 'title', 'layer', 'score', 'uses', 'createdAt']) assert.match(raw, new RegExp(`^${k}:`, 'm'), `frontmatter 有 ${k}`)
  for (const sec of ['## 内容', '## 来历', '## 熟练度', '## 亲缘']) assert.ok(raw.includes(sec), `正文有 ${sec}`)
  assert.match(raw, /obs-1/, '来历记了出处观察')
})

// ---------- ingestReflection：宽松归一化（成员 B 复盘契约字段） ----------

test('ingestReflection：契约字段（roundId/tag/lesson/intentTitle/evidence）正确落 memory/；同 roundId 合并不覆盖', () => {
  const s = mkStore()
  const a = s.ingestReflection({ roundId: 'round-9', ticketId: 't-1', intentTitle: '给视频换竖屏', tag: '裁切', finalStatus: 'failed', ownerSide: false, ownerResponse: 'none', evidence: ['obs-a', 'obs-b'], lesson: '先看分辨率再裁' })
  assert.equal(a.ok, true)
  const doc = s.get('round-9')
  assert.equal(doc.layer, 'memory')
  assert.ok(doc.body.includes('先看分辨率再裁'))
  assert.ok(doc.body.includes('obs-a、obs-b'), 'evidence 进来历')
  const b = s.ingestReflection({ roundId: 'round-9', lesson: '换个分辨率再试一次', tag: '裁切' })
  assert.equal(b.ok, true)
  const again = s.get('round-9')
  assert.ok(again.body.includes('先看分辨率再裁') && again.body.includes('换个分辨率再试一次'), '同 id 追加不覆盖')
})

test('ingestReflection：完全未知的字段形状也落得下来（JSON 兜底），模型塞 score 进来不落分', () => {
  const s = mkStore()
  const r = s.ingestReflection({ weirdShape: true, foo: 'bar', score: 0.99 })
  assert.equal(r.ok, true, '宁存勿丢')
  const doc = s.get(r.id)
  assert.ok(doc.meta.score !== 0.99, '模型给的 score 不是落库分')
  assert.equal(doc.meta.score, 0.5, '记忆层初始分是中性 0.5')
  assert.ok(doc.body.includes('bar'), '正文兜底存了原始内容')
})

// ---------- score 只认终态 ----------

test('score 只认真实复用终态：done +0.1 / failed −0.2 / aborted 不计；便捷签名 recordOutcome(id, status, resp)', () => {
  const s = mkStore()
  for (let i = 0; i < 3; i++) s.ingestReflection({ roundId: `k1-${i}`, tag: '竖屏', lesson: `第${i}条` })
  const sid = s.list('skills')[0]?.meta.id
  assert.ok(sid, '同主题 3 条已晋升为技能')
  const r1 = s.recordOutcome(sid, 'done')
  assert.equal(r1.ok, true)
  assert.equal(s.get(sid).meta.score, 0.6, '0.5 + 0.1')
  s.recordOutcome(sid, 'failed')
  assert.equal(s.get(sid).meta.score, 0.4, '−0.2')
  s.recordOutcome(sid, 'aborted')
  assert.equal(s.get(sid).meta.score, 0.4, 'aborted 不计')
  assert.equal(s.get(sid).meta.uses, 2, 'aborted 也不加 uses')
  s.recordOutcome(sid, 'done', 'ignored')
  assert.equal(s.get(sid).meta.score, 0.2, 'ignored 视同 failed：0.4 − 0.2（便捷签名下档位直接生效）')
})

test('touch-owner：ignored/perfunctory 视同 failed；replied 照常 done 加分', () => {
  const s = mkStore({ distill: () => [{ title: '竖屏终法', content: '先裁后转', tags: ['竖屏'] }] })
  for (let i = 0; i < 3; i++) s.ingestReflection({ roundId: `to-${i}`, tag: '竖屏', lesson: `第${i}` })
  const id = s.list('skills')[0]?.meta.id
  assert.ok(id, '预置技能层条目')
  const start = s.get(id).meta.score
  s.recordOutcome({ skillId: id, status: 'done', touchOwner: true, ownerResponse: 'ignored' })
  assert.equal(s.get(id).meta.score, +(start - 0.2).toFixed(4), 'ignored 视同 failed')
  s.recordOutcome({ skillId: id, status: 'done', ownerResponse: 'perfunctory' })
  assert.equal(s.get(id).meta.score, +(start - 0.4).toFixed(4), 'perfunctory 同档')
  s.recordOutcome({ skillId: id, status: 'done', touchOwner: true, ownerResponse: 'replied' })
  assert.equal(s.get(id).meta.score, +(start - 0.4 + 0.1).toFixed(4), 'replied 照常 done 加分')
})

test('模型自评篡改无效：任何入口传 score 都改变不了分值', () => {
  const s = mkStore({ distill: () => [{ title: 't', content: 'c', tags: ['k'] }] })
  for (let i = 0; i < 3; i++) s.ingestReflection({ roundId: `m-${i}`, tag: 'k', lesson: 'l' })
  const id = s.list('skills')[0]?.meta.id
  const evil = s.recordOutcome({ skillId: id, status: 'done', score: 1.0, selfAssess: '我做得很好' })
  assert.equal(evil.ok, true)
  assert.equal(s.get(id).meta.score, 0.6, '混进来的 score=1.0 被丢弃，只 +0.1')
  s.recordOutcome({ skillId: id, status: 'done', score: 5, selfScore: 5 })
  assert.equal(s.get(id).meta.score, 0.7, '第二次混分依然无效')
})

// ---------- 晋升链阈值 ----------

test('记忆→技能：同主题 ≥3 条晋升；不足 3 条且无真实复用成功不晋升', () => {
  const s = mkStore()
  s.ingestReflection({ roundId: 'p1', tag: '滤镜', lesson: 'a' })
  s.ingestReflection({ roundId: 'p2', tag: '滤镜', lesson: 'b' })
  assert.equal(s.get('p1').layer, 'memory', '2 条不晋升')
  s.ingestReflection({ roundId: 'p3', tag: '滤镜', lesson: 'c' })
  assert.equal(s.get('p1').layer, 'skills', '第 3 条到位即晋升')
  const doc = s.list('skills')[0]
  assert.match(readFileSync(doc.file, 'utf8'), /sourceSkill: p1/, 'frontmatter 记 sourceSkill 溯源')
  // 另一主题只 1 条 + failed 终态：不晋升
  s.ingestReflection({ roundId: 'q1', tag: '调色', lesson: 'z' })
  const r = s.recordOutcome({ skillId: 'q1', status: 'failed' })
  assert.equal(s.get('q1').layer, 'memory', 'failed 不算真实复用成功，不晋升')
  assert.equal(r.ok, true)
  // done（真实复用成功）：单条也晋升
  s.recordOutcome({ skillId: 'q1', status: 'done' })
  assert.equal(s.get('q1').layer, 'skills', '真实复用成功单条即晋升')
})

test('记忆→技能：提炼调用走注入点 distill（一次 LLM 调用的口子）；不给 distill 走模板兜底不炸', () => {
  let calls = 0
  const s = mkStore({ distill: (entries) => { calls++; assert.ok(entries.length >= 3); return [{ title: '提炼后的方法', content: '合并三条记忆的办法', tags: ['滤镜'] }] } })
  for (let i = 0; i < 3; i++) s.ingestReflection({ roundId: `d-${i}`, tag: '滤镜', lesson: `第${i}条` })
  assert.equal(calls, 1, '一次提炼调用')
  const doc = s.list('skills').find((d) => d.meta.title === '提炼后的方法')
  assert.ok(doc, '提炼产物落了技能层')
  const s2 = mkStore() // 无 distill
  for (let i = 0; i < 3; i++) s2.ingestReflection({ roundId: `e-${i}`, tag: '兜底', lesson: `第${i}条` })
  assert.ok(s2.list('skills').length >= 1, '模板兜底照样晋升')
})

test('技能→本能：uses≥5 且 score≥0.8 自动晋升 instinct/ + 写人格卡附加段（写前快照，写坏只影响附加段）', () => {
  const personaFile = join(root, 'personas', 'dafeiyu.md')
  mkdirSync(join(root, 'personas'), { recursive: true })
  writeFileSync(personaFile, '---\nname: 大肥鱼\n---\n\n我是大肥鱼。\n', 'utf8')
  const s = mkStore({ personaFile, distill: () => [{ title: '竖屏终法', content: '先裁后转', tags: ['竖屏'] }] })
  for (let i = 0; i < 3; i++) s.ingestReflection({ roundId: `i-${i}`, tag: '竖屏', lesson: `第${i}` })
  const id = s.list('skills')[0]?.meta.id
  // score 0.5 → 5 次 done = 1.0，uses=5：第 5 次 done 时触发本能晋升
  for (let i = 0; i < 4; i++) s.recordOutcome(id, 'done')
  assert.equal(s.get(id).layer, 'skills', '4 次还差一步')
  const r = s.recordOutcome(id, 'done')
  assert.equal(s.get(id).layer, 'instinct', '第 5 次晋升本能层')
  const raw = readFileSync(s.get(id).file, 'utf8')
  assert.match(raw, /promotedAt: \d+/, 'frontmatter 记 promotedAt')
  const persona = readFileSync(personaFile, 'utf8')
  assert.match(persona, /<!-- instinct:.+ start -->/, '人格卡有附加段开始标记')
  assert.match(persona, /<!-- instinct:end -->/, '人格卡有附加段结束标记')
  assert.ok(persona.includes('先裁后转'), '附加段带技能内容')
  assert.match(persona, /我是大肥鱼/, '主卡正文未受影响')
  assert.equal(r.promoted.some((p) => p.startsWith('skills→instinct')), true)
  // 写前必快照：history/ 里有人格卡的副本
  const stamps = s.listSnapshots()
  assert.ok(stamps.length >= 1, `有快照（${stamps.length} 个）`)
  assert.ok(stamps.some((st) => existsSync(join(root, 'skills', 'history', st, 'dafeiyu.md'))), '人格卡写前快照进了 history/')
  // 重复晋升不重复追加：修订本能条目再晋升同 id 不堆叠
  s.revise(id, { content: '先裁后转（修订版）' })
  const persona2 = readFileSync(personaFile, 'utf8')
  assert.equal(persona2.match(/<!-- instinct:.+ start -->/g).length, 1, '附加段幂等（同 id 替换不堆叠）')
  assert.ok(persona2.includes('修订版'))
})

// ---------- 快照与回滚 ----------

test('每次晋升/修订前快照进 history/<ISO>；rollback 铺回原位；弃 .bak（目录里没有 .bak 文件）', () => {
  const s = mkStore({ distill: () => [{ title: 'T', content: 'C', tags: ['x'] }] })
  for (let i = 0; i < 3; i++) s.ingestReflection({ roundId: `s-${i}`, tag: 'x', lesson: `第${i}` })
  const id = s.list('skills')[0]?.meta.id
  s.recordOutcome(id, 'done')
  const before = readFileSync(s.get(id).file, 'utf8')
  s.revise(id, { content: '新内容' })
  const after = readFileSync(s.get(id).file, 'utf8')
  assert.notEqual(before, after, '修订生效')
  const stamps = s.listSnapshots()
  assert.ok(stamps.length >= 2, '晋升 + 修订各有一次快照')
  assert.match(stamps[0], /^\d{4}-\d{2}-\d{2}T/, '快照目录是 ISO 时间戳')
  const walkAll = (dir, acc = []) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); e.isDirectory() ? walkAll(p, acc) : acc.push(p) } ; return acc }
  const all = walkAll(join(root, 'skills'))
  assert.equal(all.some((p) => p.endsWith('.bak')), false, '弃 .bak')
  // 回滚最近一次快照 → 条目回到修订前内容
  const rb = s.rollback(stamps[0])
  assert.equal(rb.ok, true)
  assert.ok(rb.restored >= 1)
  const idFile = join(root, 'skills', 'skills', `${id}.md`)
  if (existsSync(idFile)) assert.notEqual(readFileSync(idFile, 'utf8'), after, '回滚把修订前版本铺了回来')
})

// ---------- stale 与归档 ----------

test('score<0.3 且 uses≥3 标 stale；suggestStale 给复盘建议；archive 归档不删除保历史', () => {
  const s = mkStore({ distill: () => [{ title: '怪招', content: 'c', tags: ['y'] }] })
  for (let i = 0; i < 3; i++) s.ingestReflection({ roundId: `st-${i}`, tag: 'y', lesson: `第${i}` })
  const id = s.list('skills')[0]?.meta.id
  assert.ok(id)
  for (let i = 0; i < 3; i++) s.recordOutcome(id, 'failed') // 0.5→0.3→0.1→−0.1，uses=3
  const doc = s.get(id)
  assert.equal(doc.meta.stale, true, '自动标 stale')
  assert.deepEqual(s.suggestStale().map((x) => x.id), [id])
  const r = s.archive(id)
  assert.equal(r.ok, true)
  assert.equal(s.get(id).layer, 'archive', '进了 archive/')
  assert.ok(existsSync(s.get(id).file), '归档不删除')
  assert.match(readFileSync(s.get(id).file, 'utf8'), /archivedAt: \d+/)
  assert.equal(s.suggestStale().length, 0, '归档后不再出现在建议清单')
})

// ---------- 方法解析三档 ----------

test('resolveMethod：kind 精确 > match 关键词 > 探索模式返回 null', () => {
  const s = mkStore({
    distill: (entries) => [{ title: entries[0]?.title || '方法', content: '正文里有像素二字', tags: [entries[0]?.kind || 'x'] }],
  })
  s.ingestReflection({ roundId: 'rm-1', tag: '像素画', intentTitle: '像素画法', lesson: '放大不糊要用邻近采样', evidence: ['o1'] })
  s.ingestReflection({ roundId: 'rm-2', tag: '像素画', lesson: '先描格子' })
  s.ingestReflection({ roundId: 'rm-3', tag: '像素画', lesson: '颜色表提前定' })
  const px = s.list('skills').find((d) => d.meta.kind === '像素画')
  assert.ok(px, '像素画技能在库')
  // 1) kind 精确
  const a = s.resolveMethod('像素画', {})
  assert.equal(a.mode, 'kind')
  assert.equal(a.doc.meta.kind, '像素画')
  // 2) match 关键词（want.kind 对不上，但关键词命中 tags/正文）
  const b = s.resolveMethod('画图', { kind: '画画', keywords: ['像素'], text: '做一张图' })
  assert.equal(b.mode, 'match', '关键词命中像素画')
  // 3) 探索模式：库里毫无关联 → null，调用方走探索模板
  const c = s.resolveMethod('爬楼梯', { kind: '爬楼梯', text: '完全无关的事情' })
  assert.equal(c, null, '探索模式返回 null')
})

// ---------- 稳定前缀段（prefix.js，§9.3） ----------

test('buildPrefix：人格摘要 + 本能附加段 + constraintRules 三段固定顺序拼装；确定性输出', () => {
  const p = { personaSummary: '你是大肥鱼。', instincts: [{ id: 'px', title: '像素法', content: '先裁后转' }], constraints: '不许半夜说话' }
  const a = buildPrefix(p)
  const b = buildPrefix({ ...p })
  assert.equal(a, b, '同一输入永远同一输出（缓存前提）')
  const order = ['你是大肥鱼', '【本能·像素法】', '先裁后转', '【强制约束规则】', '不许半夜说话'].map((s) => a.indexOf(s))
  assert.ok(order.every((i) => i >= 0), '三段都在')
  assert.ok(order[0] < order[2] && order[2] < order[4], '固定顺序：人格 → 本能 → 约束')
  assert.match(a, /违反任何一条的行动与候选直接打回/, '约束段带把关前置否决措辞（§3.7 注入位置一的措辞口径）')
})

test('buildPrefix：空段跳过；本能条目缺 content 跳过；constraints 为空不出约束段', () => {
  const a = buildPrefix({ personaSummary: '', instincts: [{ id: 'x', title: 't', content: '' }], constraints: '' })
  assert.equal(a, '', '全空 = 空前缀')
  const b = buildPrefix({ personaSummary: '人格', instincts: [{ id: 'x', title: 't', content: 'c' }, { id: 'y', title: '', content: '' }], constraints: '' })
  assert.equal(b, '人格\n\n【本能·t】（本段由本能层自动晋升写入）\nc', '空条目跳过、段间双换行')
})

test('getVersion/hashPrefix：内容变则 hash 变，内容不变则 hash 稳定；createPrefixCache 命中不重拼', () => {
  const h1 = hashPrefix('abc')
  const h2 = hashPrefix('abc')
  const h3 = hashPrefix('abd')
  assert.equal(h1, h2)
  assert.notEqual(h1, h3)
  assert.equal(h1.length, 16)

  const cache = createPrefixCache()
  const p = { personaSummary: 'P', instincts: [{ id: 'i', title: 't', content: 'c' }], constraints: 'R' }
  const first = cache.build(p)
  assert.equal(cache.changed(p), false, '同输入不再视为变更')
  const second = cache.build(p)
  assert.equal(first, second, '缓存命中原样返回')
  const v1 = cache.version(p)
  const p2 = { ...p, constraints: 'R2' }
  assert.equal(cache.changed(p2), true, '约束修改 = 前缀变更（§9.3 两个变化事件之一）')
  assert.notEqual(cache.version(p2), v1, 'hash 跟着变')
})
