import test from 'node:test'
import assert from 'node:assert/strict'
import module, { isInputRejection, rejectedInputPlan, withdrawRejectedInput } from '../src/modules/image-recovery/index.js'
const user=(seq,kind='aurabot')=>({seq,type:'user/message',data:{id:'u'+seq,role:'user',source:{kind},content:[{type:'text',text:'INPUT_'+seq}]}})
const start=(seq,turn=1)=>({seq,type:'turn/start',data:{turn}})
const failure=(seq,turn=1)=>({seq,type:'turn/end',data:{turn,reason:{kind:'error',error:{code:'INVALID_REQUEST',message:'(HTTP 400, SensitiveContentDetected)'}}}})
const base=()=>[user(0),{seq:1,type:'assistant/message',data:{turn:0,message:{role:'assistant',content:[{type:'text',text:'OLD_OK'}]}}},start(2),user(3),user(4,'time-context'),failure(5)]
function fixture(events=base(),{owned=true,observeWait}={}) {
 const listeners=new Map(),disposers=[],batches=[],discarded=[],logs=[]
 const nodes=events.filter(e=>['user/message','assistant/message','system/message','tool/result'].includes(e.type)).map(e=>e.seq)
 let flushed=0,released=0,publishing=false
 const session={id:'session-test',surface:{nodes},get seq(){return Math.max(-1,...events.map(e=>e.seq))+1},append(batch){
  assert.equal(publishing,false)
  assert.ok(Array.isArray(batch));batches.push(batch)
  for(const [type,data,opts] of batch){
   const {startSeq,endSeq}=opts.surfaceOp,a=nodes.indexOf(startSeq),b=nodes.indexOf(endSeq)
   assert.ok(a>=0&&b>=a);assert.deepEqual(opts.sourceEventSeqs,nodes.slice(a,b+1))
   const seq=this.seq;events.push({seq,type,data,...opts});nodes.splice(a,b-a+1,seq)
  }
 }}
 const api={core:{hub:{chatOfSession:()=>owned?'group:123':'',sessions:()=>({}),discardRejectedInputs:(_id,rows)=>discarded.push(...rows)}},
  log:{info:x=>logs.push(x),warn:x=>logs.push(x)},onDispose:fn=>disposers.push(fn),
  dsh:{sessions:{get:()=>session,flush:async()=>{flushed++}},
   get:()=>({observeSession:async()=>{if(observeWait)await observeWait;return {events:[...events],[Symbol.dispose]:()=>released++}}}),
   on:(name,fn)=>{const list=listeners.get(name)||[];list.push(fn);listeners.set(name,list);return()=>listeners.set(name,list.filter(x=>x!==fn))}}}
 const service=module.setup(api)
 const dispatch=async(name,info,tail=async()=>undefined)=>{
  const handlers=listeners.get(name)||[];let i=0
  const next=()=>handlers[i++]?.(info,next)??tail()
  return next()
 }
 return {api,session,events,batches,discarded,logs,service,dispatch,nodes,counts:()=>({flushed,released}),
  emit:e=>{publishing=true;listeners.get('session/event')?.forEach(fn=>fn(session,e));publishing=false},
  stop:()=>disposers.forEach(fn=>fn()),unown:()=>owned=false}
}
const settle=()=>new Promise(setImmediate)
test('precise error qualification never treats normal transport failure as input rejection',()=>{
 assert.equal(isInputRejection(failure(5)),true)
 for(const m of ['timeout','HTTP 429','text sensitive','image unsafe','SensitiveContentDetectedLater']) {const f=failure(5);f.data.reason.error.message=m;assert.equal(isInputRejection(f),false)}
})
test('withdraw failed user and context input only; preserve success, system and later input',async()=>{
 const events=[...base().slice(0,4),{seq:4,type:'system/message',data:{}},user(5,'time-context'),failure(6),user(7)]
 const f=fixture(events),snapshot=structuredClone(events)
 assert.equal(await withdrawRejectedInput(f.api,f.session,f.events,failure(6)),2)
 assert.deepEqual(f.discarded.map(e=>e.seq),[3,5]);assert.ok(f.nodes.includes(0)&&f.nodes.includes(1)&&f.nodes.includes(4)&&f.nodes.includes(7))
 assert.deepEqual(f.events.slice(0,snapshot.length),snapshot)
 assert.equal(await withdrawRejectedInput(f.api,f.session,f.events,failure(6)),0);f.stop()
})
test('live request-error awaits withdrawal before letting the failed turn finish; no retry',async()=>{
 const f=fixture(base().slice(0,-1));const reason=failure(5).data.reason.error
 assert.equal(await f.dispatch('agent/request-error',{agent:{session:f.session},turn:1,failure:reason}),undefined)
 assert.equal(f.batches.length,1);assert.deepEqual(f.discarded.map(e=>e.seq),[3,4]);assert.equal(f.counts().flushed,1)
 f.events.push(failure(f.session.seq));f.emit(f.events.at(-1));await settle();assert.equal(f.batches.length,1);f.stop()
})
test('cold resume withdraws trailing repeated rejections and preserves the new turn',async()=>{
 const f=fixture([...base(),start(6,2),user(7),failure(8,2),start(9,3),user(10)])
 await f.dispatch('agent/pre-step',{agent:{session:f.session}},async()=>({kind:'enter'}))
 assert.deepEqual(f.discarded.map(e=>e.seq),[3,4,7]);assert.ok(f.nodes.includes(10));assert.ok(f.nodes.includes(0));assert.equal(f.batches.length,2)
 const count=f.counts().released;await f.dispatch('agent/pre-step',{agent:{session:f.session}});assert.equal(f.counts().released,count);f.stop()
})
test('no automatic rollback after assistant output, tool execution or partial streaming',()=>{
 for(const e of [
  {seq:5,type:'assistant/message',data:{turn:1}},
  {seq:5,type:'tool/result',data:{turn:1}},
  {seq:5,type:'assistant/attempt',data:{stream:[{type:'chunk',chunk:{type:'text-delta',text:'partial'}}]}},
 ]){const f=fixture([...base().slice(0,-1),e,failure(6)]);assert.equal(rejectedInputPlan(f.session,f.events,failure(6)),null);f.stop()}
})
test('zero-token failed attempt is recoverable; later successful turn prevents cold rewinding',async()=>{
 const f=fixture([...base().slice(0,-1),{seq:5,type:'assistant/attempt',data:{stream:[{chunk:{type:'usage',usage:{totalTokens:0}}},{chunk:{type:'finish'}}]}},failure(6)])
 assert.ok(rejectedInputPlan(f.session,f.events,failure(6)));f.stop()
 const g=fixture([...base(),start(6,2),user(7),{seq:8,type:'turn/end',data:{turn:2,reason:{kind:'completed'}}}]);await g.service.recoverInput(g.session);assert.equal(g.batches.length,0);g.stop()
})
test('disposal and reset while waiting never mutate the old session; new arrivals survive',async()=>{
 for(const mode of ['dispose','reset','new']){
  const gate=Promise.withResolvers(),f=fixture(base(),{observeWait:gate.promise});const pending=f.service.recoverInput(f.session)
  await settle();if(mode==='dispose')f.stop();if(mode==='reset')f.unown();if(mode==='new'){f.events.push(user(6));f.nodes.push(6)}
  gate.resolve();await pending;assert.equal(f.batches.length,mode==='new'?1:0);if(mode==='new')assert.ok(f.nodes.includes(6));f.stop()
 }
})
test('unknown source and another plugin session are untouched',async()=>{
 const f=fixture([start(0),user(1,'other-plugin'),failure(2)]);assert.equal(rejectedInputPlan(f.session,f.events,failure(2)),null);f.stop()
 const g=fixture(base(),{owned:false});await g.service.recoverInput(g.session);assert.equal(g.batches.length,0);g.stop()
})
