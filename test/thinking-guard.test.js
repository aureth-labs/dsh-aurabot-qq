// 正文污染闸：真实泄露样本 + 正常话不能误伤。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardOutgoing, stripThinkingPrefix, isDegenerate } from '../src/chat/guard.js'

// 这两条是从万事屋群（group:941644689，2026-11-11）chatlog 里原样抄来的真实泄露。
const LEAK_1 = 'NSFW image + 筹集 joke. Not addressed to me. Silence.[沉默]'
const LEAK_2 = "Godot's story about 美服 印度人互喷 + 老白男娇喘 is funny. I could react with a laugh line. One line.美服这局也太热闹了 打着打着变现场喜剧 [sticker]"

test('真实泄露样本 1：整条都是内心判断，不发', () => {
  const r = guardOutgoing(LEAK_1)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'thinking-only')
})

test('真实泄露样本 2：切掉思考前缀，正好留下她想说的那句', () => {
  const r = guardOutgoing(LEAK_2)
  assert.equal(r.ok, true)
  assert.equal(r.text, '美服这局也太热闹了 打着打着变现场喜剧 [sticker]')
})

test('思考塌缩：做。重复 200 次被判退化', () => {
  const r = guardOutgoing('做。'.repeat(200))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'degenerate')
})

test('正常重复不误伤：好耶好耶好耶 / 哈哈哈哈哈哈', () => {
  assert.equal(isDegenerate('好耶好耶好耶'), false)
  assert.equal(isDegenerate('哈哈哈哈哈哈'), false)
  assert.equal(guardOutgoing('好耶好耶好耶').ok, true)
})

test('正常说话原样放行', () => {
  const ok = [
    '这画里的人又不是我，别拿张图就往我头上按',
    '没玩过也正常，那角色得靠酒精熬，你都拿去酿酒了',
    '刚吃完白米饭，幸福',
    'emmm 我想想',
    '好',
  ]
  for (const text of ok) {
    const r = guardOutgoing(text)
    assert.equal(r.ok, true, `不该拦：${text}`)
    assert.equal(r.text, text)
  }
})

test('空白 / 纯标点 / 只有沉默标记：不发', () => {
  for (const text of ['', '   ', '。。。', '！？', '[沉默]', '[沉默] [沉默]']) {
    const r = guardOutgoing(text)
    assert.equal(r.ok, false, `应该拦：${JSON.stringify(text)}`)
  }
})

test('草稿标记：整条不发', () => {
  const r = guardOutgoing('Reply: 今天有点累，先睡')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'draft')
})

test('纯英文思考（切完没中文）：不发', () => {
  const r = stripThinkingPrefix('Let me think. The user wants me to react. Silence.')
  assert.equal(r, '')
})

test('中文元话语开头：当思考处理', () => {
  const r = stripThinkingPrefix('这条不是对我说的，先不接。')
  assert.equal(r, '')
})

test('英文整句但后面紧跟中文正文：保留正文', () => {
  const r = stripThinkingPrefix('One line.今天好累啊')
  assert.equal(r, '今天好累啊')
})

test('超长文本直接拦（防止整段思考倾倒）', () => {
  const r = guardOutgoing('啊'.repeat(3000))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'too-long')
})

// ---- 干活时贴代码 / 命令行：不能误伤 ----

const fence = '```'

test('干活时贴的代码块：整段放行', () => {
  const code = '给你改好了：\n' + fence + 'js\nfunction foo() {\n  return 1\n}\n' + fence
  const r = guardOutgoing(code)
  assert.equal(r.ok, true)
  assert.ok(r.text.includes('function foo'))
})

test('代码里的英文注释不能被当成思考前缀切掉', () => {
  const code = '看这里：\n' + fence + 'js\n// I should handle this.\nconst a = 1\n' + fence
  const r = guardOutgoing(code)
  assert.equal(r.ok, true)
  assert.ok(r.text.includes('I should handle this'), '注释要保留')
  assert.ok(r.text.includes('const a = 1'))
})

test('超过 2000 字的代码块：放行（上限 20k）', () => {
  const code = fence + '\n' + 'x'.repeat(3000) + '\n' + fence
  const r = guardOutgoing(code)
  assert.equal(r.ok, true)
})

test('超过 2000 字的普通文字：仍然拦', () => {
  const r = guardOutgoing('啊'.repeat(3000))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'too-long')
})

test('base64 / 哈希长串：不按复读拦', () => {
  const r = guardOutgoing('这是结果：' + 'A'.repeat(80))
  assert.equal(r.ok, true)
})

test('代码块外的思考前缀照样切，围栏内一个字不动', () => {
  const text = 'I could react. ' + fence + '\nconst a = 1\n' + fence
  const r = guardOutgoing(text)
  assert.equal(r.ok, true)
  assert.ok(r.text.startsWith(fence), '围栏内容保留')
  assert.ok(!r.text.includes('I could'), '思考前缀被切掉')
})

test('命令行多行：放行', () => {
  const r = guardOutgoing('先跑这两个：\necho %USERPROFILE%\ncd D:\\work\\qq\nnode --test')
  assert.equal(r.ok, true)
})
