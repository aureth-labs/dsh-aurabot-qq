import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001', BOT = '20000002', GROUP = '30000003', GUEST = '40000004'
const text = s => ({ type: 'text', data: { text: s } })
const at = { type: 'at', data: { qq: BOT } }
const event = (message, { group = GROUP, user = OWNER, id = 101 } = {}) => ({
  message_type: group ? 'group' : 'private', self_id: BOT, user_id: user,
  ...(group ? { group_id: group } : {}), message_id: id,
  sender: { user_id: user, nickname: '测试' }, message,
})
const log = { info() {}, warn() {}, debug() {}, error() {} }

function setup(t, { patch = {} } = {}) {
  const previous = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'rejected-buffer-'))
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({
    enabled: true, dryRun: true, setupDone: true, ownerQQ: OWNER, botQQ: BOT,
    workspaceDir: join(dir, 'workspace'), allow: { groups: [GROUP] },
    merge: { enabled: false }, voice: { enabled: false },
    stickers: { enabled: false, collect: false, autoChance: 0 }, titleFilter: { enabled: false }, ...patch,
  })
  const calls = [], prompts = []
  const fake = createFakeDsh({ brain: async () => '[沉默]' })
  const hub = createHub({
    dsh: fake.ctx, getConfig: () => cfg, log, stickers: {},
    hooks: {
      prompt: content => { prompts.push(structuredClone(content)); return content },
      groupDecide: (_decision, { msg }) => ({ reply: msg.mentioned, mode: 'must' }),
    },
    onebot: {
      connected: true,
      async call(action, params) {
        calls.push({ action, params })
        if (action === 'get_group_info') return { group_name: '检查群' }
        return {}
      },
    },
  })
  fake.ctx.effect(() => fake.ctx.on('session/event', hub.onSessionEvent))
  t.after(() => {
    hub.dispose(); fake.dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, calls, prompts, cfg, fake }
}

async function ready(s, count = 1) {
  const end = Date.now() + 3000
  while (s.prompts.length < count && Date.now() < end) await new Promise(r => setTimeout(r, 5))
  assert.ok(s.prompts.length >= count, '模型应收到消息')
  return s.prompts.at(-1)
}
const body = p => p.filter(x => x.type === 'text').map(x => x.text).join('\n')

test('rejected batch never returns as older context; later arrivals and other chats survive', async t => {
  const s=setup(t,{patch:{allow:{groups:[GROUP,'50000005']}}})
  await s.hub.onMessage(event([text('BAD_BACKGROUND')],{user:GUEST,id:0}))
  await s.hub.onMessage(event([at,text('FAILED_REQUEST')],{id:0}))
  await ready(s)
  while(s.fake.turns.length<1)await new Promise(r=>setTimeout(r,5))
  const failed=s.fake.turns[0]
  assert.ok(failed.source.contextEntryIds.length>=2)
  await s.hub.onMessage(event([text('LATER_SAME_SENDER')],{user:GUEST,id:0}))
  await s.hub.onMessage(event([text('OTHER_GROUP_CONTEXT')],{group:'50000005',user:GUEST,id:0}))
  s.hub.discardRejectedInputs(failed.sessionId,[{data:{source:failed.source}}])
  s.hub.discardRejectedInputs(failed.sessionId,[{data:{source:failed.source}}])
  await s.hub.onMessage(event([at,text('NEW_QUESTION')],{id:102}))
  const p=body(await ready(s,2))
  assert.doesNotMatch(p,/BAD_BACKGROUND|FAILED_REQUEST/)
  assert.match(p,/LATER_SAME_SENDER/)
  assert.match(p,/NEW_QUESTION/)
  await s.hub.onMessage(event([at,text('OTHER_WAKE')],{group:'50000005',id:103}))
  assert.match(body(await ready(s,3)),/OTHER_GROUP_CONTEXT/)
})
