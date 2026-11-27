import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createFakeDsh} from './helpers/fake-dsh.js'
import {normalize} from '../src/core/config.js'
process.env.AURABOT_DATA_DIR=mkdtempSync(join(tmpdir(),'cmd-privacy-'))
const {createHub}=await import('../src/chat/hub.js')
const {runCommand,parseCommand}=await import('../src/chat/commands.js')
const {createSongStudio,songFailureReason}=await import('../src/song/studio.js')
const errors=['ENOENT C:\\Users\\Private\\config.json','failed at /home/private/run.js:20:3','Traceback \\wsl.localhost\\Ubuntu\\root\\secret','const password = "hidden"; internal detail']
const owner='10000001',cfg=normalize({enabled:true,dryRun:false,ownerQQ:owner,botQQ:'20000002',merge:{enabled:false},voice:{enabled:false}})
test('斜杠命令异常只回安全提示，详细错误留日志，下一条命令仍可执行',async t=>{
 const fake=createFakeDsh({brain:async()=>''}),sent=[],logs=[];let failing=true
 const hub=createHub({dsh:fake.ctx,getConfig:()=>cfg,log:{info(){},debug(){},warn:(...a)=>logs.push(a.join(' '))},onebot:{connected:true,call:async(action,p)=>{if(action==='send_private_msg')sent.push(p.message);return {message_id:sent.length}}},onCommand:async msg=>{if(failing)throw Error(msg.text.slice(6));return '状态正常'}})
 t.after(()=>{hub.dispose();fake.dispose()})
 let id=1
 const event=text=>({post_type:'message',message_type:'private',self_id:20000002,user_id:Number(owner),message_id:id++,sender:{user_id:Number(owner),nickname:'测试'},message:[{type:'text',data:{text}}]})
 for(const e of errors)await hub.onMessage(event('/sing '+e))
 assert.equal(sent.length,errors.length)
 for(const message of sent){const text=message.filter(s=>s.type==='text').map(s=>s.data.text).join('');assert.match(text,/命令没执行成功/);assert.doesNotMatch(text,/Private|private|wsl|Traceback|password|ENOENT|run\.js/)}
 assert.ok(logs.some(s=>s.includes('config.json')))
 failing=false;await hub.onMessage(event('/status'));assert.ok(JSON.stringify(sent.at(-1)).includes('状态正常'));assert.equal(fake.turns.length,0)
})
test('日记和记忆返回失败对象也不能把内部原因拼进聊天',async()=>{
 for(const message of errors){
  const deps={getConfig:()=>cfg,qzone:{writeDiary:async()=>({ok:false,message})},memory:{add:()=>({ok:false,message})},log:{warn(){}}}
  for(const text of ['/diary','/remember 测试']){
   const r=await runCommand(parseCommand(text),{kind:'private',chatId:'private:'+owner},deps)
   assert.match(r,/未确认/);assert.doesNotMatch(r,/Private|private|wsl|Traceback|password|ENOENT|run\.js/)
  }
 }
 const r=await runCommand(parseCommand('/diary'),{kind:'private'}, {getConfig:()=>cfg,qzone:{writeDiary:async()=>({ok:false,message:'上一篇还在写'})}})
 assert.match(r,/上一篇还在写/)
})
test('翻唱排队异常不透传，模型收到的失败概括不含路径代码',()=>{
 for(const message of errors){
  const s=createSongStudio({getConfig:()=>{throw Error(message)},log:{warn(){}}})
  const result=s.request({song:'红日'});assert.equal(result.ok,false);assert.match(result.message,/点歌未完成/)
  assert.doesNotMatch(result.message+songFailureReason(Error(message)),/Private|private|wsl|Traceback|password|ENOENT|run\.js/)
 }
 assert.match(songFailureReason(Error('版权限制 /home/private/a')),/歌曲版本暂时下载不了/)
 assert.match(songFailureReason(Error('No module named private_lib')),/环境不完整/)
})
