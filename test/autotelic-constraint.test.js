// 自驱引擎 v5 · constraint.js 测试（成员 B 决策环交付之二）。
// 覆盖：逐行解析（坏行静默跳过）、check 前置否决纯函数、变更感知（「主人改了规矩」观察事件）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConstraintRules, check, ruleKeywords, createConstraintWatcher } from '../src/autotelic/constraint.js'

// —— 解析：逐行一条，解析失败静默跳过 ——

test('解析：逐行一条，空行/#注释 跳过', () => {
  const r = parseConstraintRules('# 这是注释\n\n不许半夜说话\n[钱包]不许乱花钱\n  前后空格也算一条  ')
  assert.equal(r.rules.length, 3)
  assert.equal(r.rules[0].text, '不许半夜说话')
  assert.equal(r.rules[1].tag, '钱包')
  assert.equal(r.rules[2].text, '前后空格也算一条')
})

test('解析：剥掉标签/空白后为空、超长的行静默跳过并计数，不抛错', () => {
  const r = parseConstraintRules('[标签]\n不许说话\n' + 'x'.repeat(600))
  assert.equal(r.rules.length, 1)
  assert.equal(r.rules[0].text, '不许说话')
  assert.equal(r.skipped, 2, `两条坏行都要静默跳过并计数，实得 skipped=${r.skipped}`)
})

test('解析：undefined/null/空文本 → 0 条规则 0 跳过', () => {
  for (const v of [undefined, null, '']) {
    const r = parseConstraintRules(v)
    assert.equal(r.rules.length, 0)
    assert.equal(r.skipped, 0)
  }
})

// —— 前置否决纯函数 ——

test('check：触犯约束的意图直接否决（不许半夜说话）', () => {
  const { rules } = parseConstraintRules('不许半夜说话')
  const hit = check(rules, { title: '半夜给主人发条消息问候晚安', tag: '问候' })
  assert.equal(hit.vetoed, true)
  assert.equal(hit.hits[0].index, 1)
})

test('check：不触犯的意图放行（vetoed=false）', () => {
  const { rules } = parseConstraintRules('不许半夜说话')
  const ok = check(rules, { title: '把那个 README 读一遍', tag: '学习' })
  assert.equal(ok.vetoed, false)
  assert.deepEqual(ok.hits, [])
})

test('check：多条款、steps 里的文本也纳入核对范围', () => {
  const { rules } = parseConstraintRules('不许动主人的配置文件\n禁止乱花钱')
  const hit = check(rules, { title: '整理技能库', steps: [{ desc: '顺手删掉主人 cordis.patch.yml 里的旧配置' }] })
  assert.equal(hit.vetoed, true)
  assert.ok(hit.hits.some((h) => /配置文件/.test(h.text)))
})

test('check：是纯函数——不改 rules 也不改 intent，可复算', () => {
  const { rules } = parseConstraintRules('不许半夜说话')
  const before = JSON.stringify(rules)
  const intent = Object.freeze({ title: '半夜说话', steps: [{ desc: 'x' }] })
  const a = check(rules, intent)
  const b = check(rules, intent)
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(rules), before)
})

test('ruleKeywords：剥禁令词提取内容词；纯禁令词回退整条', () => {
  assert.deepEqual(ruleKeywords('不许半夜说话'), ['半夜说话'])
  assert.ok(ruleKeywords('勿扰').includes('勿扰'), '切不出内容词时回退整条规则文本')
})

// —— 变更感知：「主人改了规矩」 ——

test('变更感知：约束文件变化产出观察事件 + 审计回调，第二次 detect 不再报变更', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autotelic-constraint-'))
  try {
    const file = join(dir, 'constraint-rules.txt')
    writeFileSync(file, '不许半夜说话', 'utf8')
    const audits = []
    const w = createConstraintWatcher({ file, now: () => 1_700_000_000_000, onAudit: (p) => audits.push(p) })
    // 第一轮：与内存初值一致 → 无变更
    assert.equal((await w.detectChange()).changed, false)
    // 主人改了规矩
    writeFileSync(file, '不许半夜说话\n不许乱花钱', 'utf8')
    const r = await w.detectChange()
    assert.equal(r.changed, true)
    assert.equal(r.event.observation.text, '主人改了规矩')
    assert.deepEqual(r.event.added, ['不许乱花钱'])
    assert.deepEqual(r.event.removed, [])
    assert.equal(audits.length, 1, '变更要回调审计（decisions.jsonl 侧由集成层接）')
    // 没再变 → 无变更
    assert.equal((await w.detectChange()).changed, false)
    // load 出来的规则与观察层拿到的一致
    const loaded = await w.load()
    assert.equal(loaded.rules.length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('变更感知：重启后（新 watcher + 指纹文件）仍能认出变更；文件不存在 = 空约束', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autotelic-constraint2-'))
  try {
    const file = join(dir, 'constraint-rules.txt')
    writeFileSync(file, '第一条', 'utf8')
    const w1 = createConstraintWatcher({ file })
    await w1.detectChange() // 记住基线 + 落指纹
    // 模拟重启：新建 watcher（内存态为空，回退指纹文件）
    writeFileSync(file, '第一条\n第二条', 'utf8')
    const w2 = createConstraintWatcher({ file })
    const r = await w2.detectChange()
    assert.equal(r.changed, true, '重启后靠指纹文件仍要认出「主人改了规矩」')
    const empty = createConstraintWatcher({ file: join(dir, '不存在.txt') })
    assert.equal((await empty.load()).rules.length, 0)
    assert.equal((await empty.detectChange()).changed, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
