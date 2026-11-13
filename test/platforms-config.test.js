// P0 · platforms 配置换算测试：旧字段（gateway + snowluma.*）→ platforms.qq；用户手写的 platforms 原样保留
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/core/config.js';

test('旧字段换算出 platforms.qq（snowluma 后端）', () => {
  const c = normalize({ enabled: true, gateway: 'snowluma', snowluma: { httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001', httpToken: 't1', wsToken: 't2', dir: 'C:\\Aurabot\\snowluma' } });
  assert.equal(c.platforms.qq.enabled, true);
  assert.equal(c.platforms.qq.backend, 'snowluma');
  assert.equal(c.platforms.qq.httpUrl, 'http://127.0.0.1:3000');
  assert.equal(c.platforms.qq.wsToken, 't2');
  assert.equal(c.platforms.qq.dir, 'C:\\Aurabot\\snowluma');
  // 旧字段照常可读，行为不变
  assert.equal(c.gateway, 'snowluma');
  assert.ok(c.snowluma.httpUrl);
});

test('onebot 后端换算：backend=onebot', () => {
  const c = normalize({ enabled: true, gateway: 'onebot', snowluma: { httpUrl: 'http://x', wsUrl: 'ws://x' } });
  assert.equal(c.platforms.qq.backend, 'onebot');
});

test('用户手写的 platforms 原样保留，不被旧字段覆盖', () => {
  const c = normalize({ enabled: true, gateway: 'snowluma', snowluma: { httpUrl: 'http://old' }, platforms: { qq: { enabled: true, backend: 'onebot' }, feishu: { enabled: false, appId: 'a' } } });
  assert.equal(c.platforms.qq.backend, 'onebot');
  assert.ok(!('httpUrl' in c.platforms.qq));
  assert.equal(c.platforms.feishu.appId, 'a');
});

test('空配置：默认给出未启用的 qq 实例，不炸', () => {
  const c = normalize({});
  assert.equal(c.platforms.qq.enabled, false);
  assert.equal(c.platforms.qq.backend, 'snowluma');
});
