// 运行时快照复读：整块、加粗拆行、引用符号、只剩尾巴，都要整段拦下；正常聊天不能误伤。
// 背景：DSH 每轮把 runtime context 快照追加进会话（Current runtime context / Current working
// directory / Current DSH file policy / Approval prompts are enabled / Current DeepSeek Harness …），
// 模型偶尔把它当成想说的话整段续写出来。块头的正则只认「Current runtime context. This snapshot
// supersedes」这一种写法，块里换行、加粗、加引用符、或者只剩「Approval prompts are enabled」这类
// 尾巴时，清洗会漏，整段发到 QQ。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { memoryPromptRanges } = await import('../src/security/leak-guard.js')

/** 按 memoryPromptRanges 给出的区间删掉注入内容，剩下的就是会发出去的话。 */
function strip (text) {
  const ranges = memoryPromptRanges(text).slice().sort((a, b) => a.start - b.start || b.end - a.end)
  let out = ''
  let last = 0
  for (const range of ranges) {
    if (range.end <= last) continue
    if (range.start > last) out += text.slice(last, range.start)
    last = Math.max(last, range.end)
  }
  return (out + text.slice(last)).replace(/\n{3,}/g, '\n\n').trim()
}

const SNAPSHOT = [
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
  '',
  'Current working directory: "C:\\Users\\me\\qq-chats".',
  '',
  'Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace.',
  '',
  'Approval prompts are enabled in this session: operations that require approval may ask through the configured answerers.',
  '',
  'Current DeepSeek Harness implementation checkout: "C:\\app\\dsh\\".',
  '',
  'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:51598".',
].join('\n')

test('整段快照连同 Approval 行和后面的 Current 行一起删，前后的正常回复留着', () => {
  const text = '在的呀，刚忙完\n\n' + SNAPSHOT + '\n\n你上次说的那个补丁我看过了'
  assert.equal(strip(text), '在的呀，刚忙完\n\n你上次说的那个补丁我看过了')
})

test('块头被加粗、和 This snapshot 拆成两行时也能整块删掉', () => {
  const text = [
    '收到！',
    '',
    '**Current runtime context.**',
    'This snapshot supersedes earlier runtime-context snapshots.',
    '',
    '**Current working directory:** C:\\Users\\me\\qq-chats',
    '',
    '**Approval prompts are enabled in this session:** ok',
    '',
    '她说得对，先这样',
  ].join('\n')
  assert.equal(strip(text), '收到！\n\n她说得对，先这样')
})

test('快照被写成 Markdown 引用（> 前缀）时整块删', () => {
  const text = '> Current runtime context.\n> This snapshot supersedes earlier runtime-context snapshots.\n> Current working directory: C:\\Users\\me\n\n好'
  assert.equal(strip(text), '好')
})

test('块头没被抄出来、只剩尾巴时按行拦', () => {
  for (const tail of [
    'Approval prompts are enabled in this session: operations that require approval may ask.',
    'Approval policy: ask',
    'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:51598".',
    'This snapshot supersedes earlier runtime-context snapshots.',
  ]) {
    assert.equal(strip(tail), '', '应整行删掉：' + tail)
    assert.equal(strip('先说这个\n\n' + tail + '\n\n再说这个'), '先说这个\n\n再说这个', '只删尾巴那一行：' + tail)
  }
})

test('正常聊天里提到这些词不误伤', () => {
  for (const text of [
    '我这边收到的说明里有 Current working directory 和 Approval prompts 这些行，是 DSH 每轮塞进来的',
    'Approval prompts 是啥意思呀',
    '她说这个 Current working directory 就是我当时在的文件夹',
    'Current 这个事情我一会儿再想',
  ]) {
    assert.equal(strip(text), text, '不该删：' + text)
  }
})
