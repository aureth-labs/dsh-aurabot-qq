import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateSongClip, selectedWindow, SongClipError, parseSingRequest, clipCacheParts, clipFade } from '../src/song/segment.js'
let module, normalize, commands, root
before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'song-segment-'))
  root = mkdtempSync(join(tmpdir(), 'song-root-'))
  module = await import('../src/modules/song/index.js')
  ;({ normalize } = await import('../src/core/config.js'))
  commands = await import('../src/chat/commands.js')
})
test('片段不改旧默认；时长单独填写从头，开始单独填写用上限', () => {
  assert.deepEqual(validateSongClip({}, 120), { ok: true, clip: null })
  assert.deepEqual(validateSongClip({durationSec:30},120).clip,{startSec:0,durationSec:30})
  assert.deepEqual(validateSongClip({startSec:60},120).clip,{startSec:60,durationSec:120})
  for(const o of [{startSec:-1},{startSec:86401},{startSec:1.5},{startSec:null},{startSec:'60'}, {durationSec:0},{durationSec:121},{durationSec:NaN},{durationSec:Infinity},{durationSec:'30'}]) assert.equal(validateSongClip(o,120).ok,false,JSON.stringify(o))
})
test('歌尾截短；越界或读不到时长不能退回整首', () => {
  assert.deepEqual(selectedWindow(74,{startSec:60,durationSec:30}),{start:60,length:14})
  for(const dur of [0,NaN,Infinity,60])assert.throws(()=>selectedWindow(dur,{startSec:60,durationSec:30}),SongClipError)
})
test('不同片段缓存分开；旧缓存不变；短片段淡入淡出不覆盖全段',()=>{
  const c={maxVoiceSec:120,clipStart:'auto'}
  assert.deepEqual(clipCacheParts(null,c),[120,'auto'])
  assert.notDeepEqual(clipCacheParts({startSec:0,durationSec:30},c),clipCacheParts({startSec:60,durationSec:30},c))
  assert.notDeepEqual(clipCacheParts({startSec:0,durationSec:30},c),clipCacheParts({startSec:0,durationSec:60},c))
  assert.equal(clipFade(1),'afade=t=in:d=0.25,afade=t=out:st=0.75:d=0.25')
  assert.equal(clipFade(120),'afade=t=in:d=1.5,afade=t=out:st=117:d=3')
})
test('/sing 兼容旧语法，支持参数顺序，拒绝重复或误放而不制作',async()=>{
  assert.deepEqual(parseSingRequest('红日 李克勤 +12'),{song:'红日 李克勤',pitch:12})
  for(const s of ['红日 李克勤 +12 开始=60 时长=30','红日 李克勤 时长=30 开始=60 +12'])assert.deepEqual(parseSingRequest(s),{song:'红日 李克勤',pitch:12,startSec:60,durationSec:30})
  const calls=[], deps={getConfig:()=>normalize({}),song:{request:o=>{calls.push(o);return {message:'排队'}}}}
  for(const arg of ['红日 开始=1 开始=2','红日 时长=abc','红日 开始=-1','开始=60 红日','红日 +12 +3 时长=30']){
    assert.ok(parseSingRequest(arg).error)
    await commands.runCommand({name:'sing',arg},{chatId:'group:1'},deps)
  }
  assert.equal(calls.length,0)
  await commands.runCommand(commands.parseCommand('/sing 红日 +12 开始=60 时长=30'),{chatId:'group:1'},deps)
  assert.deepEqual(calls[0],{song:'红日',pitch:12,startSec:60,durationSec:30,chatId:'group:1'})
})
test('工具和面板透传片段；群/私聊所有者权限不放宽',async()=>{
  const cfg=normalize({ownerQQ:'10001',song:{enabled:true,ownerOnly:true,root}}), routes={};let factory, owner=true
  const song=module.default.setup({config:()=>cfg,log:{info(){},warn(){},debug(){}},lazy:()=>({}),emit(){},tool:f=>factory=f,route:(p,f)=>routes[p]=f,core:{hub:{turnSendersAllOwner:()=>owner},http:{body:async x=>x}}})
  const calls=[];song.request=o=>{calls.push(o);return {ok:true,message:'queued'}}
  const tool=factory({chat:{kind:'group',chatId:'group:42'},sessionId:'s'})
  assert.equal(tool.parameters.properties.start_sec.type,'integer')
  await tool.execute({song:'红日',start_sec:60,duration_sec:30})
  assert.equal(calls[0].startSec,60);assert.equal(calls[0].durationSec,30);assert.equal(calls[0].chatId,'group:42')
  await routes['/song/request']({song:'红日',startSec:12,durationSec:7})
  assert.equal(calls[1].startSec,12);assert.equal(calls[1].durationSec,7);assert.equal(calls[1].chatId,'private:10001')
  owner=false
  assert.equal((await tool.execute({song:'红日'})).ok,false)
  assert.equal((await factory({chat:{kind:'private',chatId:'private:10002',userId:'10002'},sessionId:'s'}).execute({song:'红日'})).ok,false)
  assert.equal(calls.length,2)
})
test('错误参数在探测和排队前拒绝',async()=>{
  const {createSongStudio}=await import('../src/song/studio.js')
  const s=createSongStudio({getConfig:()=>normalize({song:{enabled:true,root}}),log:{warn(){},info(){}}})
  assert.match(s.request({song:'红日',durationSec:121}).message,/最多唱/)
  assert.equal(s.status().current,null);assert.deepEqual(s.status().queue,[])
})
test('失败口语不得带 Windows / WSL 路径或堆栈',()=>{
  for(const line of ['文件 C:\\Users\\Admin\\voice.pth 不存在','读不到 /home/user/voice.pth','读不到/home/user/voice.pth','读不到 \\\\host\\share\\voice.pth','Error: bad','Traceback (most recent call last)'])assert.equal(module.cleanFailLine(line),'',line)
  assert.equal(module.cleanFailLine('这次没唱成，稍后再试吧。'),'这次没唱成，稍后再试吧。')
})
