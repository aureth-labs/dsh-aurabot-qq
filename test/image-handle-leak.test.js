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
