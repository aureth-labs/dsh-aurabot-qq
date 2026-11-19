// #518：模型复读 DSH 图片句柄时，出站清洗要删掉 Image/请求预览/Normalized copy 行，
// 不能把真实附件路径和 sha256 发到 QQ。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanOutboundText } from '../src/chat/reply.js'

test('图片句柄：Image 名 + sha256 + 预览 + 规范化路径整段删除', () => {
  const leak = '哪来的大肥鱼，我是蓝白鲸鱼\n\nImage "qq--5*****354-1" (sha256:27f12155428077bd041826d5883c0069098b5c*******908ddcecf7b45b0); request preview 180x180px. Normalized copy (read-only; may be resized or re-encoded): "/home/user/.dsh/attachments/1.png" (180x180px, image/png). Source dimensions, format, and byte size may differ.'
  assert.equal(cleanOutboundText(leak), '哪来的大肥鱼，我是蓝白鲸鱼')
})

test('图片句柄：没有 Normalized 尾巴的裸预览行也删', () => {
  const leak = '嗯\nImage "qq--5*****354-1" (sha256:abc123); request preview 512x512px. It may be resized or re-encoded; source dimensions, format, and byte size may differ.'
  assert.equal(cleanOutboundText(leak), '嗯')
})

test('普通正文里提到 Image 两个字不误伤', () => {
  const text = 'Image 这个词我今天已经听三遍了'
  assert.equal(cleanOutboundText(text), text)
})

test('图片句柄：正文中间、前导空格也删（不要求行首）', () => {
  const leak = '前面这句是正常话  Image "qq--abc-1" (sha256:deadbeef); request preview 90x90px. Normalized copy (read-only; may be resized or re-encoded): "/home/alice/.dsh/attachments/secret.png" (90x90px, image/png). 后面这句也正常'
  const out = cleanOutboundText(leak)
  assert.doesNotMatch(out, /secret\.png|sha256|Normalized copy/)
  assert.match(out, /前面这句是正常话/)
})

test('图片句柄：主人私聊里前面有正常话也要删（不受 prompt 复读豁免影响）', () => {
  const leak = '好呀，我在呢  Image "qq--abc-1" (sha256:deadbeef); request preview 90x90px. Normalized copy (read-only; may be resized or re-encoded): "/home/alice/.dsh/attachments/secret.png" (90x90px, image/png).'
  const out = cleanOutboundText(leak, { ownerPrivate: true })
  assert.doesNotMatch(out, /secret\.png|Normalized copy/)
  assert.match(out, /好呀，我在呢/)
})

test('图片句柄：后面接 ||| 气泡分隔时只删句柄，不吞正常回答', () => {
  const leak = 'Image "qq--abc-1" (sha256:deadbeef); request preview 90x90px.|||正常回复'
  const out = cleanOutboundText(leak)
  assert.doesNotMatch(out, /sha256|request preview/)
  assert.match(out, /\|\|\|正常回复/)
})

test('图片句柄：dsh-llm 无名字格式 Image sha256:... 也删', () => {
  const leak = '前文\nImage sha256:27f12155428077bd041826d5883c0069098b5cdeadbeef; request preview 180x180px. Normalized copy (read-only; may be resized or re-encoded): "/home/alice/.dsh/attachments/secret.png" (180x180px, image/png). Source dimensions, format, and byte size may differ.'
  const out = cleanOutboundText(leak)
  assert.doesNotMatch(out, /secret\.png|request preview|sha256/)
  assert.match(out, /前文/)
})

test('图片句柄：超出限制的 [image omitted to fit request image limits; ...] 整段删', () => {
  const leak = '好\n[image omitted to fit request image limits; "qq--abc-1" (sha256:deadbeef). Normalized copy (read-only; may be resized or re-encoded): "/home/alice/.dsh/attachments/secret.png" (90x90px, image/png).]'
  const out = cleanOutboundText(leak)
  assert.doesNotMatch(out, /secret\.png|image omitted/)
  assert.match(out, /好/)
})

test('图片句柄：Normalized copy 被换行分开也一起删', () => {
  const leak = '你好\nImage sha256:deadbeef; request preview 180x180px.\nNormalized copy (read-only; may be resized or re-encoded): "/home/alice/.dsh/attachments/secret.png" (180x180px, image/png).'
  const out = cleanOutboundText(leak)
  assert.doesNotMatch(out, /secret\.png|Normalized copy/)
  assert.match(out, /你好/)
})

test('图片句柄：换行 Normalized copy 后接 ||| 正常回复不被吞', () => {
  const leak = '你好\nImage sha256:deadbeef; request preview 180x180px.\nNormalized copy (read-only; may be resized or re-encoded): "/home/alice/.dsh/attachments/secret.png" (180x180px, image/png).|||正常回复'
  const out = cleanOutboundText(leak)
  assert.doesNotMatch(out, /secret\.png|Normalized copy/)
  assert.match(out, /\|\|\|正常回复/)
})
