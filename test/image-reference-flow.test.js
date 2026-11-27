import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import imagegen from '../src/modules/imagegen/index.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const other = Buffer.from(png); other[40] = 1
const OWNER = '10000001', BOT = '20000002', GROUP = '30000003'
const log = { info() {}, warn() {}, debug() {}, error() {} }

test('真实收图→合批→提示：混合照片/表情与下载失败不会错配编号', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-image-ref-flow-')), previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ enabled: true, dryRun: true, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    workspaceDir: join(dir, 'workspace'), allow: { groups: [GROUP] }, voice: { enabled: false },
    merge: { enabled: true, groupWaitSec: 0.01, groupMaxSec: 0.02 }, imageGen: { enabled: true },
    titleFilter: { enabled: false }, stickers: { collect: false },
  })
  let prompt, captured
  const fake = createFakeDsh({ brain: async () => '[沉默]' })
  const admit = fake.ctx.attachments.admitPromptContent
  fake.ctx.attachments.admitPromptContent = content => { captured = content; return admit(content) }
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log, stickers: {},
    onebot: { connected: true, call: async action => {
      if (action === 'get_group_info') return { group_name: '测试群' }
      if (action === 'get_image') throw new Error('故意让第一张图下载失败')
      return {}
    } },
    hooks: { groupDecide: () => ({ reply: true, mode: 'must' }), prompt: (content, info) => prompt(content, info) },
  })
  imagegen.setup({ config: () => cfg, log, dsh: fake.ctx, lazy: () => ({}), route() {}, tool() {},
    on: (event, fn) => { if (event === 'prompt') prompt = fn }, core: { hub, local: { active: () => true } },
  })
  fake.ctx.effect(() => fake.ctx.on('session/event', hub.onSessionEvent))
  t.after(() => { hub.dispose(); fake.dispose(); if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous; rmSync(dir, { recursive: true, force: true }) })
  await hub.onMessage({ message_type: 'group', self_id: BOT, user_id: OWNER, group_id: GROUP, message_id: -701,
    sender: { nickname: '测试' }, message: [
      { type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: '请改照片，不要改表情' } },
      { type: 'image', data: { file: 'not-downloadable' } },
      { type: 'image', data: { file: 'base64://' + png.toString('base64') } },
      { type: 'image', data: { file: 'base64://' + other.toString('base64'), sub_type: 1 } },
    ],
  })
  const deadline = Date.now() + 4000
  while (!captured && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(captured, '消息应交给模型')
  const images = captured.filter(c => c.type === 'image')
  assert.equal(images.length, 2)
  for (const block of images) {
    const index = captured.indexOf(block)
    const number = block.name.endsWith('-3') ? 3 : 2
    assert.equal(block.name, `qqref--701-${number}`)
    assert.equal(captured[index - 1].text, `【聊天图片 msg:-701:${number}，发送者 QQ ${OWNER}】`)
    assert.deepEqual(await hub.referenceImage({ chatId: `group:${GROUP}` }, `msg:-701:${number}`), Buffer.from(block.data, 'base64'))
  }
  assert.ok(!captured.some(c => c.type === 'text' && c.text.includes('【聊天图片 msg:-701:1，')), '失败的图不借用成功图的位置')
})
