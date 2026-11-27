import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { createImageGen } from '../src/features/imagegen.js'
import { gifFrameCount } from '../src/features/image-format.js'
import { normalize, mergeFromPanel } from '../src/core/config.js'
import { imageToolBlock, findFfmpeg } from '../src/core/img.js'
import imagegen from '../src/modules/imagegen/index.js'
const GIF = Buffer.from('R0lGODlhEAAQAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAEAAQAAAIHQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFgQEBACH5BAEUAAEALAAAAAAQABAAgQAA/wAAAAAAAAAAAAgdAAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWBAQEAOw==', 'base64')
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), Buffer.alloc(64)])
const log = { info(){},warn(){},debug(){} }
const config = (extra={}) => normalize({imageGen:{enabled:true,provider:'openai',allowGif:true,model:'example',baseUrl:'https://image.example/v1',...extra}})
const response = (buf=GIF) => new Response(JSON.stringify({data:[{b64_json:buf.toString('base64')}]}))
function generator(extra={},fetchImpl=async()=>response(),deps={}) { return createImageGen({getConfig:()=>config(extra),log,fetchImpl,...deps}) }

test('GIF 默认关闭，面板可以独立开关，其他设置不变',()=>{
 const old=normalize({});assert.equal(old.imageGen.allowGif,false)
 const changed=mergeFromPanel(old,{imageGen:{allowGif:true}})
 assert.equal(changed.imageGen.allowGif,true);changed.imageGen.allowGif=false;assert.deepEqual(changed,old)
})
test('只有明确选 GIF 才增加 GIF 参数；普通画图保持原尺寸和格式',async()=>{
 const calls=[];const gen=generator({},async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return response()})
 await gen.generate('挥手循环',{format:'gif',shape:'portrait'})
 assert.deepEqual(Object.fromEntries(Object.entries(calls[0].body).filter(([k])=>['output_format','frame_count','frame_duration_ms','size'].includes(k))),{size:'384x576',output_format:'gif',frame_count:8,frame_duration_ms:200})
 await gen.generate('挥手姿势');await gen.generate('猫',{format:'static'})
 for(const call of calls.slice(1)){assert.equal(call.body.output_format,undefined);assert.equal(call.body.frame_count,undefined);assert.equal(call.body.frame_duration_ms,undefined);assert.equal(call.body.size,config().imageGen.size)}
})
test('参考图生成 GIF 保留原图、动作提示和 GIF 参数',async()=>{
 const gen=generator({},async(url,init)=>{assert.match(url,/images\/edits$/);assert.equal(init.body.get('output_format'),'gif');assert.equal(init.body.get('frame_count'),'8');assert.equal(init.body.get('frame_duration_ms'),'200');assert.equal(init.body.get('prompt'),'眨眼');assert.deepEqual(Buffer.from(await init.body.get('image').arrayBuffer()),PNG);return response()})
 assert.deepEqual(await gen.generate('眨眼',{format:'gif',image:PNG}),GIF)
})
test('未开启、其他接法、非法格式都在请求前拒绝',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return response()}
 for(const extra of [{allowGif:false},{provider:'custom'},{provider:'codex'}]) await assert.rejects(generator(extra,fetchImpl).generate('猫',{format:'gif'}))
 await assert.rejects(generator({},fetchImpl,{local:{active:()=>true}}).generate('猫',{format:'gif'}))
 await assert.rejects(generator({},fetchImpl).generate('猫',{format:'video'}),/只支持/)
 assert.equal(calls,0)
})
test('静态图片、单帧 GIF、截断文件不能假装生成成功',async()=>{
 const first=GIF.indexOf(Buffer.from([0x21,0xf9]),50);const single=Buffer.concat([GIF.subarray(0,first),Buffer.from([0x3b])])
 assert.equal(gifFrameCount(single),1);assert.equal(gifFrameCount(GIF),2)
 for(const bad of [PNG,single,GIF.subarray(0,-1),Buffer.from('GIF89a'),Buffer.alloc(0)]) await assert.rejects(generator({},async()=>response(bad)).generate('猫',{format:'gif'}),/有效的多帧 GIF|没有返回图片/)
 // 扩展块中伪造的帧标记不计数。
 const boundary=13+3*(1<<((GIF[10]&7)+1))
 const injected=Buffer.concat([GIF.subarray(0,boundary),Buffer.from([0x21,0xfe,4,0x21,0xf9,4,0,0]),GIF.subarray(boundary)])
 assert.equal(gifFrameCount(injected),2,'扩展内容不能被当成额外帧')
})
test('GIF 请求失败不会切换备用服务；不添加静态接口兼容参数',async()=>{
 let n=0
 await assert.rejects(generator({fallbackEnabled:true,fallbacks:[{provider:'openai',baseUrl:'https://backup.example',model:'backup'}]},async()=>{n++;return new Response('{}',{status:500})}).generate('猫',{format:'gif'}));assert.equal(n,1)
 n=0;await generator({},async(url,init)=>{n++;const b=JSON.parse(init.body);assert.equal(b.output_format,'gif');assert.equal(b.frame_count,8);assert.equal(b.response_format,undefined);assert.equal(b.image_size,undefined);return response()}).generate('猫',{format:'gif'});assert.equal(n,1)
})
function sandbox(t){const old=process.env.AURABOT_DATA_DIR;const dir=mkdtempSync(join(tmpdir(),'aurabot-gif-'));process.env.AURABOT_DATA_DIR=dir;t.after(()=>{if(old==null)delete process.env.AURABOT_DATA_DIR;else process.env.AURABOT_DATA_DIR=old;rmSync(dir,{recursive:true,force:true})});return dir}
function tool(t,{owner=true,extra={},fetchImpl=async()=>response()}={}){
 sandbox(t);t.mock.method(globalThis,'fetch',fetchImpl);let build;const sent=[];const cfg=config({seeOwn:false,...extra})
 const hub={turnSendersAllOwner:()=>owner,sendText:async()=>({message_id:1}),sendSegments:async(...args)=>{sent.push(args);return {message_id:1}},canSeeImages:async()=>false,lastTextOf:()=>''}
 imagegen.setup({config:()=>cfg,log,dsh:{},lazy:()=>({}),route(){},tool:fn=>build=fn,core:{hub,local:{active:()=>false}}})
 return {run:args=>build({chat:{kind:'private',chatId:'private:10001',userId:'10001'},sessionId:'gif-test'}).execute(args),sent}
}
test('工具保留 GIF 原始字节发送和存盘，告知模型预览仅第一帧',async(t)=>{
 const s=tool(t);const out=await s.run({prompt:'鲸鱼挥手',format:'gif',notice:'画个挥手动图。'})
 assert.equal(out.ok,true,out.message);assert.equal(out.frames,2);assert.equal(out.format,'gif');assert.equal(extname(out.path),'.gif');assert.deepEqual(readFileSync(out.path),GIF);assert.equal(s.sent[0][1][0].data.file,'base64://'+GIF.toString('base64'));assert.match(out.message,/第一帧/);assert.equal(out.image,undefined)
})
test('非主人不能利用 GIF 绕过权限',async(t)=>{let calls=0;const s=tool(t,{owner:false,fetchImpl:async()=>{calls++;return response()}});const out=await s.run({prompt:'猫',format:'gif'});assert.equal(out.ok,false);assert.equal(calls,0);assert.equal(s.sent.length,0)})
test('服务内部报错不进入聊天，也不发送错误图片',async(t)=>{const s=tool(t,{fetchImpl:async()=>{throw new Error('secret-token C:\\Users\\Admin /root/private at stack.js:42')}});const out=await s.run({prompt:'猫',format:'gif',notice:'画动图。'});assert.equal(out.ok,false);assert.doesNotMatch(out.message,/secret-token|Users|root|stack.js/);assert.equal(s.sent.length,0)})
test('即使很小的 GIF，模型也只能得到静态 JPEG 预览或无预览',async()=>{
 let admitted
 const dsh={attachments:{admitPromptContent:async(blocks)=>{admitted=blocks[0];return [{...blocks[0],attachment:{id:'preview'}}]}}}
 const result=await imageToolBlock(dsh,GIF)
 if(!result){assert.equal(admitted,undefined);return}
 assert.equal(admitted.mediaType,'image/jpeg');const b=Buffer.from(admitted.data,'base64');assert.equal(b.readUInt16BE(0),0xffd8);assert.equal(gifFrameCount(b),0);assert.equal(result.data,undefined)
 if(findFfmpeg())assert.equal(b.toString('hex').match(/ffd8ff/g).length,1,'只输出一帧 JPEG')
})

test('外部生图接管时拒绝 GIF；未接管时不把 GIF 请求送入不支持格式的旧接口',async()=>{
 let calls=0;const upstream=async()=>{calls++;return PNG};upstream.ready=()=>true
 await assert.rejects(generator({},async()=>response(),{upstream}).generate('猫',{format:'gif'}),/当前生图接法/)
 upstream.ready=()=>false
 assert.deepEqual(await generator({},async()=>response(),{upstream}).generate('猫',{format:'gif'}),GIF)
 assert.equal(calls,0)
})
