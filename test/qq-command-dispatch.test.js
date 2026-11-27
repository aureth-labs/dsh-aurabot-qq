import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createFakeDsh} from './helpers/fake-dsh.js'
import {isSlashCommand, parseCommand} from '../src/chat/commands.js'
import {parseReply} from '../src/chat/reply.js'

test('malformed reply prefixes become real quote metadata, ordinary prose and code remain literal', () => {
  const r = parseReply('/reply:5>这波资讯我眼熟 ||| /reply:1>接着聊')
  assert.equal(r.items[0].replyTo, '5')
  assert.equal(r.items[0].value, '这波资讯我眼熟')
  assert.equal(r.items[1].value, '接着聊')
  assert.equal(r.items[1].replyTo, undefined, 'still quote at most once')
  assert.equal(parseReply('前一句\n/reply:2>后一句').items.at(-1).replyTo, '2')
  for (const text of ['示例 `/reply:1>`', '例如 /reply:1> 是写坏的标记', '```text\n/reply:1>例子\n```']) {
    const parsed = parseReply(text)
    assert.ok(parsed.items.every(i => !i.replyTo))
    assert.ok(parsed.items.map(i => i.value).join('\n').includes('/reply:1>'))
  }
})

test('command shape excludes paths, code, arithmetic and ordinary questions', () => {
  for (const text of ['/clear', '/unknown abc', '／帮助', '/help']) assert.equal(isSlashCommand(text), true)
  for (const text of ['/usr/bin/node', 'https://example.com', '`/clear`', '怎么用 /help？', '/2', '// comment']) assert.equal(isSlashCommand(text), false)
  assert.equal(parseCommand('/clear'), null, 'do not silently introduce a destructive alias')
  assert.equal(parseCommand('/重开').name, 'reset')
})

test('unknown and unauthorized commands never reach the model or reset a session; owner and module commands retain their contracts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qq-command-dispatch-'))
  process.env.AURABOT_DATA_DIR = root
  process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  writeFileSync(join(root, 'config.json'), JSON.stringify({enabled:true,dryRun:true,setupDone:true,ownerQQ:'10000001',botQQ:'20000002',allow:{private:['10000002'],groups:['30000003']},voice:{enabled:false},merge:{enabled:false},snowluma:{autoStart:false,autoAttach:false,dir:join(root,'no-snow')}}))
  writeFileSync(join(root,'sessions.json'), JSON.stringify({chats:{'group:30000003':{sessionId:'existing-session'}}}))
  mkdirSync(join(root,'modules','command-probe'),{recursive:true})
  writeFileSync(join(root,'modules','command-probe','index.mjs'), `export default {id:'command-probe',api:1,setup(api){api.command({name:'probe',run:()=>{globalThis.__commandProbe=(globalThis.__commandProbe||0)+1;return 'probe done'}});api.on('message',msg=>{if(msg.text==='/hook'){globalThis.__hookProbe=true;return true}})}}`)
  const fake=createFakeDsh({brain:async()=>{throw Error('Commands must not reach the model')}})
  const app=(await import('../src/host.js')).apply(fake.ctx)
  t.after(()=>{fake.dispose();delete globalThis.__commandProbe;delete globalThis.__hookProbe;rmSync(root,{recursive:true,force:true})})
  await app.ready
  let seq=1
  const command=async(text,user='10000002',group=true,atFirst=true)=>{
    const mention={type:'at',data:{qq:'20000002'}},plain={type:'text',data:{text}}
    const event={post_type:'message',message_type:group?'group':'private',self_id:20000002,user_id:Number(user),...(group?{group_id:30000003}:{}),message_id:seq++,sender:{user_id:Number(user),nickname:'测试'},message:group?(atFirst?[mention,plain]:[plain,mention]):[plain]}
    const {sent}=await app.hub.capture(()=>app.hub.onMessage(event),{simulate:true})
    return sent.flatMap(s=>s.message).filter(s=>s.type==='text').map(s=>s.data.text).join('\n')
  }
  const session=()=>JSON.parse(readFileSync(join(root,'sessions.json'),'utf8')).chats['group:30000003']?.sessionId
  assert.match(await command('/clear'),/没有识别.*没有执行/)
  assert.equal(session(),'existing-session')
  assert.match(await command('/help','10000002',true,false),/没有执行.*权限/)
  assert.match(await command('/reset'),/没有执行.*权限/)
  assert.equal(session(),'existing-session')
  assert.match(await command('/help','10000001'),/\/reset/)
  assert.match(await command('/clear','10000001'),/没有识别/)
  assert.match(await command('/help','10000002',false),/没有执行.*权限/)
  assert.match(await command('/probe'),/没有执行.*权限/)
  assert.equal(globalThis.__commandProbe,undefined)
  assert.match(await command('/probe','10000001'),/probe done/)
  assert.equal(globalThis.__commandProbe,1)
  assert.equal(await command('/hook'),'')
  assert.equal(globalThis.__hookProbe,true,'custom message hooks retain their slash syntax')
  await command('/silent','10000001')
  assert.equal(await command('/help'),'','muted group commands do not wake the bot for guests')
  await command('/active','10000001')
  await command('/off','10000001')
  assert.equal(await command('/help'),'','disabled bot does not reply to guest commands')
  await command('/on','10000001')
  assert.match(await command('/reset','10000001'),/重新开始/)
  assert.equal(session(),undefined)
  assert.equal(fake.turns.length,0)
})
