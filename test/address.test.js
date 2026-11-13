// P0 · 地址函数表驱动穷举测试
// 对应 docs/CONTRACTS.md §三 与 contracts.d.ts §1。
// 覆盖：旧写法、新写法、带 #实例、system:*、空串、乱码、数字型输入、非法字符、边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatId, parseChatId, sameChat, formatChatId } from '../src/gateway/address.js';

// ── normalizeChatId：[输入, 期望]；期望 null = 认不出 ──
const normCases = [
  // 旧写法（永久别名 → qq）
  ['private:10001', 'qq:private:10001'],
  ['group:123456', 'qq:group:123456'],
  ['private:10001 ', 'qq:private:10001 '],           // 尾随空格不改写：规范化不做 trim，编号原样
  // 新写法
  ['qq:private:10001', 'qq:private:10001'],
  ['feishu:group:oc_xxx', 'feishu:group:oc_xxx'],
  ['qq#2:private:10001', 'qq#2:private:10001'],
  ['qq#team-1:group:123', 'qq#team-1:group:123'],
  ['telegram:private:88148318', 'telegram:private:88148318'],
  // system:*
  ['system:cron', 'system:cron'],
  ['system:面板', 'system:面板'],
  ['system:', null],                                  // 空名字不放行
  // 认不出 → null
  ['', null],
  [null, null],
  [undefined, null],
  [12345, null],                                      // 数字型输入：不收非字符串
  ['10001', null],                                    // 裸编号没有前缀
  ['private:', null],                                 // 空编号
  ['qq:private:', null],                              // 新写法空编号
  ['group:123', 'qq:group:123'],
  [':private:1', null],                               // 冒号开头
  ['QQ:private:1', null],                             // 大写平台名不合法
  ['qq:voice:1', null],                               // kind 只认 private/group
  ['qq#:private:1', null],                            // # 后空别名
  ['qq#2:private', null],                             // 缺编号段
  ['qq:private:1:extra', 'qq:private:1:extra'],       // 编号本身可含冒号（平台 id 原样）
  ['qq private:1', null],
];

// ── parseChatId：[输入, 期望对象或 null] ──
const parseCases = [
  ['qq:private:10001', { instance: 'qq', platform: 'qq', kind: 'private', id: '10001' }],
  ['qq#2:private:10001', { instance: 'qq#2', platform: 'qq', kind: 'private', id: '10001' }],
  ['feishu:group:oc_x', { instance: 'feishu', platform: 'feishu', kind: 'group', id: 'oc_x' }],
  ['private:10001', { instance: 'qq', platform: 'qq', kind: 'private', id: '10001' }], // 别名换算后拆开
  ['system:cron', null],
  ['garbage', null],
  ['qq:private:', null],
];

test('normalizeChatId 表驱动', () => {
  for (const [input, want] of normCases) {
    assert.equal(normalizeChatId(input), want, `normalizeChatId(${JSON.stringify(input)})`);
  }
});

test('parseChatId 表驱动', () => {
  for (const [input, want] of parseCases) {
    assert.deepEqual(parseChatId(input), want, `parseChatId(${JSON.stringify(input)})`);
  }
});

test('sameChat：别名、实例、规范化一致则相等；认不出一律不等', () => {
  assert.equal(sameChat('private:10001', 'qq:private:10001'), true);   // 旧别名 == 新写法
  assert.equal(sameChat('qq:private:10001', 'qq:group:10001'), false); // kind 不同
  assert.equal(sameChat('qq:private:10001', 'qq#2:private:10001'), false); // 实例不同不是同一聊天
  assert.equal(sameChat('feishu:private:10001', 'qq:private:10001'), false); // 平台不同
  assert.equal(sameChat('system:cron', 'system:cron'), true);          // system 原样比
  assert.equal(sameChat('garbage', 'garbage'), false);                 // 认不出 → 不相等
  assert.equal(sameChat('', 'qq:private:1'), false);
});

test('formatChatId：合法拼回，非法返回 null；与 parse 互逆', () => {
  assert.equal(formatChatId({ instance: 'qq', kind: 'private', id: '10001' }), 'qq:private:10001');
  assert.equal(formatChatId({ instance: 'qq#2', kind: 'group', id: '123' }), 'qq#2:group:123');
  assert.equal(formatChatId(null), null);
  assert.equal(formatChatId({ instance: 'QQ', kind: 'private', id: '1' }), null); // 大写实例
  assert.equal(formatChatId({ instance: 'qq', kind: 'voice', id: '1' }), null);
  assert.equal(formatChatId({ instance: 'qq', kind: 'private', id: '' }), null);
  // 互逆：format → parse 回原对象
  const a = { instance: 'qq#2', platform: 'qq', kind: 'private', id: '9' };
  assert.deepEqual(parseChatId(formatChatId(a)), a);
});

test('编号里带百分号编码原样保留', () => {
  const s = 'feishu:private:ou_%E5%BC%A0%E4%B8%89';
  assert.equal(normalizeChatId(s), s);
  assert.equal(parseChatId(s).id, 'ou_%E5%BC%A0%E4%B8%89');
});
