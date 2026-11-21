// 更新执行器：镜像失败必须按顺序回退直连；第一条成功就停；本地 link 安装保护不能误伤。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linkInstallOf, runUpdateAttempts, updateAttempts } from '../src/core/update.js'

const plan = { command: 'dsh plugin --profile desktop add mirror-url', directCommand: 'dsh plugin --profile desktop add github:a/b#v1.2.0', mirror: 'https://gh-proxy.com/', mirrorLabel: 'gh-proxy.com' }
const attempts = () => updateAttempts({ repo: 'a/b', channel: 'main', ref: 'v1.2.0', profile: 'desktop', mirror: 'gh-proxy' })

test('镜像失败后按顺序回退直连：第一次失败才执行第二条，并标记 fallback', async () => {
  const calls = []
  const r = await runUpdateAttempts({
    attempts: attempts(),
    plan,
    runAttempt: async (attempt) => {
      calls.push(attempt.kind)
      return attempt.kind === 'mirror'
        ? { ok: false, message: '镜像超时', output: 'mirror failed' }
        : { ok: true, message: '更新命令跑完了，重启 DSH 生效', output: 'direct ok' }
    },
  })
  assert.deepEqual(calls, ['mirror', 'direct'], '必须先镜像、失败后直连，且只各执行一次')
  assert.equal(r.ok, true)
  assert.equal(r.usedMirror, false)
  assert.equal(r.fallback, true)
  assert.match(r.message, /镜像下载失败，已自动回退直连/)
  assert.match(r.message, /重启 DSH 生效/)
  assert.match(r.output, /direct ok/)
})

test('第一条镜像成功就不再执行直连', async () => {
  const calls = []
  const r = await runUpdateAttempts({
    attempts: attempts(),
    plan,
    runAttempt: async (attempt) => {
      calls.push(attempt.kind)
      return { ok: true, message: '更新命令跑完了，重启 DSH 生效' }
    },
  })
  assert.deepEqual(calls, ['mirror'], '镜像成功时不能多跑一次直连')
  assert.equal(r.ok, true)
  assert.equal(r.usedMirror, true)
  assert.equal(r.fallback, false)
  assert.match(r.message, /本次走镜像 gh-proxy\.com/)
})

test('两条都失败：返回失败并保留两段输出，方便排查镜像和直连', async () => {
  const calls = []
  const r = await runUpdateAttempts({
    attempts: attempts(),
    plan,
    runAttempt: async (attempt) => {
      calls.push(attempt.kind)
      return { ok: false, message: attempt.kind + ' 挂了', output: attempt.kind + ' output' }
    },
  })
  assert.deepEqual(calls, ['mirror', 'direct'])
  assert.equal(r.ok, false)
  assert.match(r.message, /镜像和直连都没成功/)
  assert.match(r.output, /\[镜像\] mirror output/)
  assert.match(r.output, /\[直连\] direct output/)
})

test('没有镜像时只有一条直连，不会凭空多执行一次', async () => {
  const calls = []
  const directOnly = updateAttempts({ repo: 'a/b', channel: 'main', ref: 'v1.2.0', profile: 'desktop' })
  assert.equal(directOnly.length, 1)
  const r = await runUpdateAttempts({ attempts: directOnly, plan: { command: 'direct' }, runAttempt: async (attempt) => { calls.push(attempt.kind); return { ok: true, message: 'ok' } } })
  assert.deepEqual(calls, ['direct'])
  assert.equal(r.ok, true)
  assert.equal(r.usedMirror, false)
})

test('本地 link: 安装保护：读 profile package.json，只认 link: 依赖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-update-link-'))
  try {
    const pkg = (dependencies) => { writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'profile', dependencies })) }
    pkg({ 'dsh-aurabot-qq': 'link:/home/ubuntu/work/dsh-aurabot-qq' })
    assert.equal(linkInstallOf({ profileDir: dir, packageName: 'dsh-aurabot-qq' }), 'link:/home/ubuntu/work/dsh-aurabot-qq')
    pkg({ 'dsh-aurabot-qq': 'github:aureth-labs/dsh-aurabot-qq#v1.2.0' })
    assert.equal(linkInstallOf({ profileDir: dir, packageName: 'dsh-aurabot-qq' }), '', '正常安装不能被 link 保护误判')
    pkg({})
    assert.equal(linkInstallOf({ profileDir: dir, packageName: 'dsh-aurabot-qq' }), '')
    assert.equal(linkInstallOf({ profileDir: '', packageName: 'dsh-aurabot-qq' }), '', '没有 profile 目录时按无保护处理')
    writeFileSync(join(dir, 'package.json'), '{bad json')
    assert.equal(linkInstallOf({ profileDir: dir, packageName: 'dsh-aurabot-qq' }), '', '坏 JSON 不能抛错中断更新')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
