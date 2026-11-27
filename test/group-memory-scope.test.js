import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize, mergeFromPanel } from '../src/core/config.js'
import { createMemoryStore, extractionMask } from '../src/features/memory.js'

const id = '30000001', group = 'group:' + id, owner = '10000001'
const row = (i, extra = {}) => ({ chatId: group, who: '同学', uid: '10000002', text: '消息' + i, t: 1_000_000 + i, ...extra })
const bits = (rows, modes) => Array.from(extractionMask(rows, { ownerQQ: owner, memory: { groupExtraction: modes } }))
test('相关对话：只凭互动证据，加同群最近五行、两分钟上下文，不按昵称和文本猜测', () => {
  const rows = [row(0), ...Array.from({length:6}, (_,i)=>row(180000+i)), row(180006, {chatId:'group:9'}), row(180007,{interaction:['10000002']}), row(180008,{who:'bot', text:'@机器人'}), row(400000,{uid:owner}), row(700000,{direct:true}), row(1000000,{who:'bot',uid:''}), row(1300000,{forgottenAt:1,direct:true}), row(1400000,{chatId:'private:1'}), row(1500000,{chatId:'qzone'})]
  assert.deepEqual(bits(rows),[0,0,1,1,1,1,1,0,1,0,1,1,1,0,1,1]); assert.equal(bits(rows,{[id]:'all'})[0],1)
})
test('自动模式：第 81 行降级，降到 40 行恢复；两阈值之间保持原模式，别的群不抢额度',()=>{
  const rows=Array.from({length:81},(_,i)=>row(i*1000)); rows.push(row(81000,{chatId:'group:9'}),row(82000,{direct:true}),row(3600000+15000),row(3600000+50000));
  // 直接互动的前文会纳入，即使在降级期间。
  const modes={[id]:'auto','9':'all'}; assert.equal(bits(rows.slice(0,81),modes)[80],0)
  assert.deepEqual(bits(rows,modes).slice(79),[1,1,1,1,0,1]); assert.deepEqual(bits([row(0)],modes),[1]); assert.ok(bits(rows,{[id]:'all','9':'all'}).every(Boolean))
})
test('面板可保存、清除单群模式；局部更新保留现有群选择',()=>{
  const init=normalize({memory:{groupExtraction:{[id]:'all','2':'auto','x':'all','3':'wrong'}}});assert.deepEqual(init.memory.groupExtraction,{[id]:'all','2':'auto'});
  assert.deepEqual(mergeFromPanel(init,{memory:{extractMinLines:22}}).memory.groupExtraction,init.memory.groupExtraction);assert.deepEqual(mergeFromPanel(init,{memory:{groupExtraction:{'2':'auto'}}}).memory.groupExtraction,{'2':'auto'})
})
test('存储与调度：范围外不占提炼预算，不进梗概；重启后按原始行号续跑',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'group-scope-'));const day='2020-01-01', rows=[row(0,{text:'隐去闲聊甲'}),row(500000,{text:'应该提炼的发言',direct:true}),row(800000,{text:'隐去闲聊乙'})], calls=[];
  const cfg=normalize({ownerQQ:owner,model:{provider:'p',model:'m'},memory:{keepChatlogDays:-1, gistEnabled:true, extractDailyBatches:24}});let present=true;
  const hub={chatLogDays:()=>present?[day]:[],chatLogOf:()=>rows,deleteChatLog:()=>{present=false}};
  const make=()=>createMemoryStore({directory,getConfig:()=>cfg,hub,log:{info(){},warn(){},debug(){}},dsh:{get:()=>null,llm:{async *stream({system,messages}){calls.push([system,messages[0].content[0].text]);yield {type:'text-delta',text:system.includes('整理长期记忆')?'[]':system.includes('整理自己的记忆')?'{"text":"群友聊过自己的周末安排"}':'{"insights":[],"style":[]}'};yield {type:'finish',reason:{kind:'completed'}}}}}})
  let mem=make();t.after(()=>{mem.close();rmSync(directory,{recursive:true,force:true})});const initial=await mem.backlog();assert.equal(initial.pending,1);assert.equal(initial.outOfScope,2);
  assert.equal((await mem.consolidate()).ok,true);assert.equal((await mem.backlog()).pending,0);assert.equal((await mem.backlog()).used,1);mem.close();mem=make();await mem.consolidate();assert.equal(calls.filter(([s])=>s.includes('整理长期记忆')).length,1);
  cfg.memory.keepChatlogDays=0;await mem.consolidate();assert.ok(calls.some(([s,v])=>s.includes('整理自己的记忆')&&v.includes('应该提炼的发言')));assert.equal(present,false);assert.ok(calls.every(([,v])=>!v.includes('隐去闲聊')))
})
