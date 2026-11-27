// 后台定时任务不该在网关没连上时空跑：B 站刷视频、空间日记/互动、主动搭话（P4 起由 purpose 承担）
// 都会调 OneBot，没连上时跑了只会白白触发请求和日志。这里锁住「调度入口带网关判断」这个行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const MODULES = ['bili', 'diary', 'qzone-social', 'purpose']

for (const id of MODULES) {
  test(`模块 ${id}：网关未连接时跳过定时任务`, () => {
    const src = readFileSync(new URL(`../src/modules/${id}/index.js`, import.meta.url), 'utf8')
    assert.match(src, /api\.core\.onebot\?\.state/, `${id}/index.js 的定时任务缺少 onebot 状态判断`)
    assert.match(src, /!== 'connected'/, `${id}/index.js 的定时任务没有判断「未连接」`)
  })
}

// purpose 的守卫必须网关感知（与 bili 同款）：多平台网关的实例状态优先，
// QQ onebot 只是回落位。背景：裸读 onebot.state 会把「宿主直连 QQ + platforms
// 里 qq 显式 disabled」的部署误判成 stopped，定时任务被静默跳过（2026-11-18 实测报障）。
test('purpose：守卫先看多平台网关实例状态，onebot 只是回落位', () => {
  const src = readFileSync(new URL('../src/modules/purpose/index.js', import.meta.url), 'utf8')
  assert.match(src, /api\.core\.gateway\?\.instances\?\.\(\)/, 'purpose 的守卫没有读多平台网关实例状态')
  // 守卫顺序：gateway instances 在前，onebot.state 在后（回落位）
  const gwAt = src.indexOf('api.core.gateway?.instances?.()')
  const obAt = src.indexOf('api.core.onebot?.state')
  assert.ok(gwAt >= 0 && obAt > gwAt, 'purpose 的守卫顺序不对：应先看 gateway instances 再看 onebot.state')
})
