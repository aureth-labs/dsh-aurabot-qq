// P0 · 分层测试（docs/CONTRACTS.md §二）
// 检查中枢层（src/chat、src/features、src/purpose、src/persona）不出现任何平台名/平台协议词；
// 平台端目录不 import 中枢；网关目录不 import 平台端。
// 尚未清理的文件列在下面白名单里。规矩：白名单只许缩短，不许加长（约定 §二）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');

// ── 白名单：G3 / I3 / U1 合并前暂时违禁的文件。只许缩短。 ──
const WHITELIST_HUB_WORDS = new Set([
  'src/chat/commands.js',
  'src/chat/faces.js',
  'src/chat/forward.js',
  'src/chat/group-roles.js',
  'src/chat/hub.js',
  'src/chat/inbound.js',
  'src/chat/mentions.js', // 仅注释提到 SnowLuma，无代码耦合；G3 清注释后移出
  'src/chat/notices.js',
  'src/chat/outbound-policy.js',
  'src/chat/title-filter.js',
  'src/features/memory.js',
  'src/features/memory-rules.js',
  'src/features/qq-file.js',
  'src/features/qq-profile.js',
  'src/features/qzone.js',
  'src/features/qzone-social.js',
  'src/features/stickers.js',
  'src/persona/personas.js',
  'src/purpose/engine.js',
  'src/purpose/module.js',
]);
// 平台端禁 import 中枢：现在还没平台端搬进来（G2 未动工），先全量检查
// 网关禁 import 平台端：同理全量检查

const HUB_DIRS = ['src/chat', 'src/features', 'src/purpose', 'src/persona'];
const HUB_FORBIDDEN = [/feishu/i, /onebot/i, /snowluma/i, /send_private_msg/i, /send_group_msg/i, /['"]qq['"]/];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('中枢层不出现平台名与平台协议词（白名单只许缩短）', () => {
  const offenders = [];
  for (const dir of HUB_DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file).replace(/\\/g, '/');
      if (WHITELIST_HUB_WORDS.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const re of HUB_FORBIDDEN) {
        if (re.test(text)) { offenders.push(`${rel} ↔ ${re}`); break; }
      }
    }
  }
  assert.deepEqual(offenders, [], `中枢层出现平台词（去清这些文件或确认该进白名单）:\n${offenders.join('\n')}`);
});

test('src/adapters 不 import 中枢（src/chat、src/features）', () => {
  const dir = join(root, 'src/adapters');
  if (!statSync(dir, { throwIfNoEntry: false })) return; // 目录还没建时不查
  const offenders = [];
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8');
    if (/from\s+['"](\.\.\/)+(?:chat|features)\//.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('src/gateway 不 import src/adapters（平台端是注册进来的，不是引用进来的）', () => {
  const offenders = [];
  for (const file of walk(join(root, 'src/gateway'))) {
    const text = readFileSync(file, 'utf8');
    if (/from\s+['"][^'"]*adapters\//.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
