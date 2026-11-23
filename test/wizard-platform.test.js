// 多平台设置向导：接入方式、配置、连接、认主和身份唯一性保护。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')

test('设置向导：QQ 旧版直连和网关托管分开，网关模式走迁移事务', () => {
  assert.ok(client.includes("id: 'qq-gateway'"), '缺少 QQ 网关托管选项')
  assert.ok(client.includes("label: 'QQ（旧）'"), '旧版直连没有标注（旧）')
  assert.ok(client.includes('finishGatewayQq'), '缺少网关托管完成流程')
  assert.ok(client.includes("post('/platforms/qq-migration/preflight'"), '缺少迁移预检')
  assert.ok(client.includes("post('/platforms/qq-migration/start'"), '缺少迁移启动')
  assert.ok(client.includes('完成并切换到网关托管'), '缺少网关托管完成按钮')
})

test('多平台向导：第 1 步可以选择 QQ / 飞书 / QQ 官方机器人 / 通用桥', () => {
  assert.ok(client.includes("id: 'qq'") && client.includes("id: 'feishu'"), '缺 QQ/飞书选项')
  assert.ok(client.includes("id: 'qqbot'") && client.includes("id: 'bridge'"), '缺 QQ 官方/通用桥选项')
  assert.ok(client.includes('WIZ_PLATFORM_MODES'), '缺接入方式列表')
  assert.ok(client.includes('WIZ_PLATFORM_STEPS'), '缺非 QQ 步骤')
})

test('多平台向导：非 QQ 平台会保存配置、启用并轮询连接', () => {
  assert.ok(client.includes("post('/platforms/add', { platform: mode, enabled: false })"), '缺停用创建')
  assert.ok(client.includes("post('/platforms/settings'"), '缺保存平台配置')
  assert.ok(client.includes("post('/platforms/toggle', { instance: inst.instance, enabled: true })"), '缺启用平台')
  assert.ok(client.includes("platformInst?.state === 'connected'"), '连接确认未检查 connected')
  assert.ok(host.includes('enabled: b.enabled !== false'), '后端不支持停用创建')
})

test('多平台向导：已有主人时先校验当前账号绑定，不直接进入面板', () => {
  assert.ok(client.includes("get('/platforms/people')"), '缺身份绑定查询')
  assert.ok(client.includes('ownerAccountOnMode'), '缺主人账号校验')
  assert.ok(client.includes('candidateBound'), '缺候选账号绑定校验')
  assert.ok(client.includes('canFinishExternal'), '缺外部平台完成闸门')
  assert.ok(client.includes('还没有绑定到主人'), '缺未绑定提示')
})

test('多平台向导：首次认主显式传 platform/account，完成后校验 owner', () => {
  assert.ok(client.includes("post('/platforms/claim', { platform: c.platform, account: c.account })"), '认主未显式传平台账号')
  assert.ok(client.includes('owner === person') || client.includes('canFinishExternal'), '缺主人结果校验')
  assert.ok(client.includes("post('/setup/done', { platformOnly: true })"), '缺平台完成调用')
})
