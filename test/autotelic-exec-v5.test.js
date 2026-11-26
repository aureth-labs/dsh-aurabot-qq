// 自驱引擎 v5 · 行动单执行器测试（src/autotelic/exec.js）。
// 全部走 fake 注入（hooks.execStep / hooks.selfCheck / hooks.sleep / now / book / skills），
// 不打真模型、不碰真实数据目录（快照用临时目录，测完可清）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecV5, isForbidden, TRANSIENT_RE } from '../src/autotelic/exec.js'

/** 造一张最小行动单。 */
function ticket(over = {}) {
  return {
    id: 't1', intent: '把 README 读一遍', tag: 'curious', ownerSide: false,
    steps: [{ desc: '读文件', level: 'read-only' }],
    budget: { maxSteps: 3, timeoutMs: 0 },
    ...over,
  }
}

test('TRANSIENT_RE 命中冷却/超时类瞬态措辞（坑#7 模式）', () => {
  assert.ok(TRANSIENT_RE.test('后台会话冷却中，请稍后'))
  assert.ok(TRANSIENT_RE.test('等太久了'))
  assert.ok(TRANSIENT_RE.test('执行超时(timeout)'))
  assert.ok(!TRANSIENT_RE.test('文件不存在 ENOENT'))
})

test('硬禁区五类样本全部拒绝（代码层拦截，整单不执行）', async () => {
  const exec = createExecV5({ hooks: { execStep: async () => { throw new Error('不该被调用') } } })
  const samples = [
    { desc: '改宿主配置', target: 'host.json', level: 'write-data' },
    { desc: '编辑插件源码', target: 'src/core/hub.js', level: 'write-data' },
    { desc: '导出登录态', target: 'cookies/token 存档', level: 'write-data' },
    { desc: '删除聊天流水与记忆原始数据', target: 'memory/records', level: 'write-data' },
    { desc: '在终端里跑一段命令看看', level: 'read-only' },
  ]
  for (const step of samples) {
    const out = await exec.run(ticket({ id: `t-${step.desc}`, steps: [step] }))
    assert.equal(out.status, 'rejected', step.desc)
    assert.match(out.why, /硬禁区/)
  }
  // 五类之外的正常步不误伤
  assert.equal(isForbidden({ desc: '读 README 写进笔记', level: 'read-only' }).forbidden, false)
})

// 2026-11-18 审查回归：硬禁区黑名单只该拦「明确指向执行能力」的说法。
// 上一版 RE_SHELL 含 \bsh\b / \brm\s / \bdel\s，把「sh 开头的歌」「sh 音标」
// 「记录 rm -rf 的危险性」「del 掉过期草稿」这类正常描述整单 rejected。
test('硬禁区不误伤：长得像 shell/命令的正常描述必须放行', () => {
  const normal = [
    '把这首 sh 开头的歌找出来',
    '梳理 sh 音标的发音',
    '记录 rm -rf 的危险性',
    'del 掉过期的日记草稿',
    '学习 shell 排序（sort）的做法',
    '看看 delete 的用法',
    '研究 terminal 配色',
    '整理一下 git push 的记录',
  ]
  for (const desc of normal) {
    const v = isForbidden({ desc, level: 'read-only' })
    assert.equal(v.forbidden, false, `不该拦：${desc}（${v.why}）`)
  }
  // 反向：真正指向执行环境的说法仍必须拦
  const blocked = ['跑 powershell 脚本', '打开终端执行', '执行命令 ls', '调用 exec() 函数', '写个 bash 循环']
  for (const desc of blocked) {
    assert.equal(isForbidden({ desc }).forbidden, true, `该拦没拦：${desc}`)
  }
})

test('read-only 自由执行：done，reviewRound 按契约入参回调，账本记 done', async () => {
  const bookCalls = []
  const book = {
    addTask: (o) => ({ ok: true, task: { id: 'bk1', ...o } }),
    close: (...a) => bookCalls.push(a),
  }
  let review = null
  const exec = createExecV5({
    book,
    hooks: { execStep: async () => ({ ok: true, observation: '读完了' }) },
  })
  const out = await exec.run(ticket(), { plan: { reviewRound: (r) => { review = r } } })
  assert.equal(out.status, 'done')
  assert.equal(bookCalls.at(-1)[1], 'done')
  assert.ok(review, 'reviewRound 应被回调')
  assert.equal(review.ticketId, 't1'); assert.equal(review.tag, 'curious')
  assert.equal(review.finalStatus, 'done'); assert.equal(review.ownerSide, false)
  assert.equal(typeof review.ts, 'number'); assert.ok(Array.isArray(review.steps))
  assert.ok('ownerResponse' in review && 'evidence' in review && 'lesson' in review && 'roundId' in review && 'intentTitle' in review)
})

test('skills.recordOutcome 只锚真实终态：done/failed 调，aborted/rejected 不调', async () => {
  const calls = []
  const skills = { recordOutcome: (...a) => calls.push(a) }
  let mode = 'ok'
  const exec = createExecV5({
    skills,
    hooks: { execStep: async () => (mode === 'ok' ? { ok: true } : { ok: false }) },
  })
  await exec.run(ticket({ id: 'a', skillId: 'sk-readme', steps: [{ desc: 'x', level: 'read-only' }] }))
  assert.deepEqual(calls.at(-1), ['sk-readme', 'done', ''])
  mode = 'bad'
  await exec.run(ticket({ id: 'b', skillId: 'sk-readme' }))
  assert.deepEqual(calls.at(-1), ['sk-readme', 'failed', ''])
  const n = calls.length
  mode = 'ok' // 复位：aborted 用例要求步骤本身成功，前面 failed 用例把 mode 置了 bad
  // rejected 分支：用**明确命中**硬禁区的描述（不能再用「跑 shell」——那条按 2026-11-18
  // 的误伤修正已放行：单独的 shell 词不足以判禁区，真正的物理边界在 noTools 通道）。
  await exec.run(ticket({ id: 'c', skillId: 'sk-readme', steps: [{ desc: '打开终端执行命令', level: 'read-only' }] }))
  await exec.run(ticket({ id: 'd', skillId: 'sk-readme', budget: { maxSteps: 1, timeoutMs: 0 }, steps: [
    { desc: '第一步', level: 'read-only' }, { desc: '第二步', level: 'read-only' }] }))
  assert.equal(calls.length, n, 'rejected/aborted 不调 recordOutcome')
})

test('write-data：执行前把目标文件快照进 history/<ISO时间戳>/（append 目录，弃 .bak）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autotelic-exec-'))
  const target = join(dir, 'notes.json')
  writeFileSync(target, '{"v":1}', 'utf8')
  const exec = createExecV5({
    dataDir: dir,
    hooks: { execStep: async () => ({ ok: true }) },
  })
  const out = await exec.run(ticket({ steps: [{ desc: '更新笔记', level: 'write-data', files: [target] }] }))
  assert.equal(out.status, 'done')
  const historyDir = join(dir, 'history')
  assert.ok(existsSync(historyDir), 'history/ 目录应存在')
  const stampDir = readdirSync(historyDir)[0]
  assert.match(stampDir, /^\d{4}-\d{2}-\d{2}T/, '目录名是 ISO 时间戳')
  assert.ok(existsSync(join(historyDir, stampDir, 'notes.json')), '目标文件应有快照')
  rmSync(dir, { recursive: true, force: true })
})

test('touch-owner 默认静默排队：queued → confirm 放行；autoConfirmOwner 豁免直接跑', async () => {
  let clock = 1_700_000_000_000 // 真实纪元起点：频控窗口是 24h，1970 年附近的假钟会被误频控
  let ran = 0
  const mk = (auto) => createExecV5({
    settings: () => ({ autoConfirmOwner: auto, confirmWindowMinutes: 10 }),
    now: () => clock,
    hooks: { execStep: async () => { ran++; return { ok: true } } },
  })
  const t = () => ticket({ id: 'ow1', ownerSide: true, steps: [{ desc: '给主人发条消息', level: 'touch-owner' }] })
  const exec1 = mk(false)
  const q = await exec1.run(t())
  assert.equal(q.status, 'queued'); assert.equal(ran, 0)
  assert.equal(exec1.pendingList().length, 1)
  const done = await exec1.confirm('ow1')
  assert.equal(done.status, 'done'); assert.equal(ran, 1)

  const exec2 = mk(true)
  const out = await exec2.run(t())
  assert.equal(out.status, 'done', 'autoConfirmOwner 豁免直接执行'); assert.equal(ran, 2)
})

test('确认窗口超时：confirm 与 pendingList 都把超时单自动取消为 aborted', async () => {
  let clock = 1_000_000
  const bookCalls = []
  const exec = createExecV5({
    settings: () => ({ confirmWindowMinutes: 5 }),
    now: () => clock,
    book: { addTask: (o) => ({ ok: true, task: { id: 'b', ...o } }), close: (...a) => bookCalls.push(a) },
    hooks: { execStep: async () => ({ ok: true }) },
  })
  await exec.run(ticket({ id: 'late', ownerSide: true, steps: [{ desc: '发言', level: 'touch-owner' }] }))
  clock += 6 * 60_000 // 过窗
  const r = await exec.confirm('late')
  assert.equal(r.status, 'aborted'); assert.match(r.why, /超时|取消/)
  assert.equal(bookCalls.at(-1)[1], 'abandoned', 'aborted 映射账本 abandoned')

  await exec.run(ticket({ id: 'late2', ownerSide: true, steps: [{ desc: '发言', level: 'touch-owner' }] }))
  clock += 6 * 60_000
  assert.equal(exec.pendingList().length, 0, 'pendingList 顺带清扫过期单')
})

test('单步失败重试 1 次：第二次成功 → done；两次都失败 → failed', async () => {
  let n = 0
  const execA = createExecV5({ hooks: { execStep: async () => (++n === 1 ? { ok: false, observation: '挂了' } : { ok: true, observation: '好了' }) } })
  const out = await execA.run(ticket({ id: 'r1' }))
  assert.equal(out.status, 'done'); assert.equal(n, 2)

  let m = 0
  const execB = createExecV5({ hooks: { execStep: async () => { m++; return { ok: false, observation: '一直挂' } } } })
  const outB = await execB.run(ticket({ id: 'r2' }))
  assert.equal(outB.status, 'failed'); assert.equal(m, 2, '重试 1 次，共 2 次尝试')
})

test('瞬态错误走退避不计失败：冷却两次后成功仍 done（坑#7）', async () => {
  const sleeps = []
  let n = 0
  const exec = createExecV5({
    hooks: {
      sleep: async (ms) => sleeps.push(ms),
      execStep: async () => {
        n++
        if (n <= 2) throw new Error('后台会话冷却中，等太久')
        return { ok: true, observation: '缓过来了' }
      },
    },
  })
  const out = await exec.run(ticket({ id: 'tr' }))
  assert.equal(out.status, 'done', '瞬态不算失败，重试后成功')
  assert.equal(n, 3); assert.ok(sleeps.length >= 2, '瞬态之间有退避等待')
})

test('超时按瞬态处理：预算 timeoutMs 内没跑完 → 退避重试，不直接 failed', async () => {
  let n = 0
  const exec = createExecV5({
    hooks: {
      sleep: async () => {},
      execStep: async () => { n++; await new Promise((r) => setTimeout(r, n === 1 ? 50 : 1)); return { ok: true } },
    },
  })
  const out = await exec.run(ticket({ id: 'to', budget: { maxSteps: 3, timeoutMs: 10 } }))
  assert.equal(out.status, 'done', '第一次超时算瞬态退避，第二次短任务成功')
  assert.equal(n, 2)
})

test('预算耗尽即 aborted 不续命：3 步但 maxSteps=2，第 3 步不执行', async () => {
  let ran = 0
  const bookCalls = []
  const exec = createExecV5({
    book: { addTask: (o) => ({ ok: true, task: { id: 'b', ...o } }), close: (...a) => bookCalls.push(a) },
    hooks: { execStep: async () => { ran++; return { ok: true } } },
  })
  const out = await exec.run(ticket({
    id: 'bud',
    steps: [{ desc: '一', level: 'read-only' }, { desc: '二', level: 'read-only' }, { desc: '三', level: 'read-only' }],
    budget: { maxSteps: 2, timeoutMs: 0 },
  }))
  assert.equal(out.status, 'aborted'); assert.match(out.why, /预算耗尽/)
  assert.equal(ran, 2, '第 3 步不许续命')
  assert.equal(bookCalls.at(-1)[1], 'abandoned')
})

test('主动发言专项：同 tag 24h 频控——第二单发言步被跳过', async () => {
  let clock = 1_700_000_000_000 // 同上：真实纪元，避免假钟撞进 24h 窗口
  let spoke = 0
  const exec = createExecV5({
    settings: () => ({ autoConfirmOwner: true }),
    now: () => clock,
    hooks: { execStep: async () => { spoke++; return { ok: true } } },
  })
  const t = () => ticket({ ownerSide: true, steps: [{ desc: '主动分享', level: 'touch-owner' }] })
  await exec.run(ticket({ id: 's1', ownerSide: true, steps: [{ desc: '主动分享', level: 'touch-owner' }] }))
  assert.equal(spoke, 1)
  const out2 = await exec.run(ticket({ id: 's2', ownerSide: true, steps: [{ desc: '又想分享', level: 'touch-owner' }] }))
  assert.equal(spoke, 1, '24h 内同 tag 第二次不发言')
  assert.ok(out2.results[0].skipped === 'rate-limited')
  clock += 25 * 3600_000
  await exec.run(ticket({ id: 's3', ownerSide: true, steps: [{ desc: '隔天再分享', level: 'touch-owner' }] }))
  assert.equal(spoke, 2, '过了 24h 可以再发')
})

test('发言前自查：「删掉主人会损失什么」答不出 → 降级只写日记（不发）', async () => {
  const spoke = []
  const mk = (loss) => createExecV5({
    settings: () => ({ autoConfirmOwner: true }),
    hooks: {
      selfCheck: async () => ({ loss }),
      execStep: async (step) => { spoke.push(step.desc); return { ok: true } },
    },
  })
  const mkTicket = (id) => ticket({ id, ownerSide: true, steps: [{ desc: '说句废话', level: 'touch-owner', text: '你好呀' }] })
  const bad = mk('')
  const out = await bad.run(mkTicket('d1'))
  assert.equal(spoke.length, 0, '答不出损失就不发')
  assert.equal(out.results[0].skipped, 'downgraded-diary')

  const good = mk('提醒了主人 README 有个错字，删掉就不知道了')
  const out2 = await good.run(mkTicket('d2'))
  assert.equal(spoke.length, 1, '答得出损失才放行')
  assert.equal(out2.status, 'done')
})

test('形状不合法的行动单直接 rejected：缺 id / 没有步骤', async () => {
  const exec = createExecV5({ hooks: { execStep: async () => ({ ok: true }) } })
  assert.equal((await exec.run({ steps: [{ desc: 'x', level: 'read-only' }] })).status, 'rejected')
  assert.equal((await exec.run({ id: 'no-steps', steps: [] })).status, 'rejected')
})

test('hub 通道返回字符串（回复文本）算做成，不误判失败（2026-11-18 真机坑）', async () => {
  // 真机证据：账本 failed 行的 why 里躺着模型成功输出的 {"done": true,...} 原文——
  // hub.runSystemTurn 成功 resolve 的是文本字符串，旧代码按 r?.ok===true 判成失败。
  let calls = 0
  const exec = createExecV5({
    hub: { runSystemTurn: async () => { calls++; return '{"done": true, "observation": "已把方法记进技能库"}' } },
    hooks: {}, // 不注入 execStep，走默认 hub 通道
  })
  const out = await exec.run(ticket({ id: 'hub-str', steps: [{ desc: '记一条笔记', level: 'write-data' }] }))
  assert.equal(out.status, 'done', '字符串返回应算做成')
  assert.equal(calls, 1, '做成后不应重试')
  assert.match(out.results[0].observation, /记进技能库/)
})

test('hub 通道抛错仍按失败走（含瞬态退避语义不变）', async () => {
  let n = 0
  const exec = createExecV5({
    hub: { runSystemTurn: async () => { n++; throw new Error('这个后台会话的上一轮还没结束') } },
    hooks: {},
  })
  const out = await exec.run(ticket({ id: 'hub-err', steps: [{ desc: 'x', level: 'read-only' }] }))
  assert.equal(out.status, 'failed')
  assert.match(out.why, /还没结束/)
  assert.ok(n >= 1, '至少调用过一次')
})

test('hub 通道返回无 ok 字段的对象按做成算（不冤死）', async () => {
  const exec = createExecV5({
    hub: { runSystemTurn: async () => ({ observation: '看过了，没问题' }) },
    hooks: {},
  })
  const out = await exec.run(ticket({ id: 'hub-obj' }))
  assert.equal(out.status, 'done')
})

test('预算传给 hub 自管超时，exec 侧 race 只兜底不抢跑（2026-11-18 真机坑）', async () => {
  // 旧 bug：exec 侧 race（预算 120s）先于 hub 默认 180s 到点就重试，
  // 旧轮次没被取消还占着 system:autotelic-act:workbench → 重试全撞「上一轮还没结束」。
  const seen = []
  const exec = createExecV5({
    hub: { runSystemTurn: async (name, title, prompt, opts) => { seen.push(opts); return '好' } },
    hooks: {},
  })
  await exec.run(ticket({ id: 'budget', budget: { maxSteps: 1, timeoutMs: 120_000 } }))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].timeoutMs, 120_000, '预算应传给 hub（hubMs = min(budget,150s)）')
  await exec.run(ticket({ id: 'nobudget', budget: { maxSteps: 1, timeoutMs: 0 } }))
  assert.equal(seen[1].timeoutMs, 150_000, '无预算时 hub 默认 150s（低于 hub 内置 180s 上限）')
})

test('频控跨重启持久（lead 裁决 2026-11-17）：注入 feedback 后，换新执行器实例节流仍在', async () => {
  const { mkdtempSync: mtd, rmSync: rm, writeFileSync: dummy } = await import('node:fs')
  const { createFeedback } = await import('../src/autotelic/feedback.js')
  const dir = mtd(join(tmpdir(), 'autotelic-exec-fb-'))
  const file = join(dir, 'feedback.json')
  dummy(file, '', 'utf8') // 落一个真实文件路径，走持久面
  let clock = 1_700_000_000_000
  const mkExec = (fb) => createExecV5({
    settings: () => ({ autoConfirmOwner: true }), feedback: fb, now: () => clock,
    hooks: { execStep: async () => ({ ok: true }) },
  })
  await mkExec(createFeedback({ file, now: () => clock })).run(ticket({ ownerSide: true, steps: [{ desc: '主动分享', level: 'touch-owner' }] }))
  // 「重启」：新 feedback 实例重读同一文件 + 新执行器实例
  const fb2 = createFeedback({ file, now: () => clock })
  assert.ok(fb2.lastSpokeOf('curious') > 0, '发言时刻写在 feedback.json')
  const out = await mkExec(fb2).run(ticket({ id: 'again', ownerSide: true, steps: [{ desc: '又想分享', level: 'touch-owner' }] }))
  assert.equal(out.results[0].skipped, 'rate-limited', '重启后 24h 频控不重置')
  rm(dir, { recursive: true, force: true })
})
