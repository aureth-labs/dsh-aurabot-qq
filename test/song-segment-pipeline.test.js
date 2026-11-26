// 流程测试用假分离器/ffmpeg，不下载模型、不联网、不发 QQ。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

test('片段无人声不封禁整首；越界不发语音；失败后下一首照常运行并按片段缓存', {skip:process.platform==='win32'}, async()=>{
  const data=mkdtempSync(join(tmpdir(),'song-flow-'));process.env.AURABOT_DATA_DIR=data
  const {createSongStudio}=await import('../src/song/studio.js')
  const {normalize}=await import('../src/core/config.js')
  const root=join(data,'engine'),calls=join(root,'calls.jsonl'),mode=join(root,'volume')
  function put(file,text,executable=false){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);if(executable)chmodSync(file,0o755)}
  const script=body=>`#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2);\n${body}`
  put(join(root,'env/Scripts/python.exe'),script("console.log('1')"),true)
  put(join(root,'separator-models/test.onnx'),'model')
  put(join(root,'env/Scripts/audio-separator.exe'),script(`fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n'); const dir=a[a.indexOf('--output_dir')+1];fs.writeFileSync(p.join(dir,'part_(Vocals).wav'),'v');fs.writeFileSync(p.join(dir,'part_(Instrumental).wav'),'i');`),true)
  put(join(root,'bin/ffmpeg.exe'),script(`if(a.includes('volumedetect')){console.error('mean_volume: '+fs.readFileSync(${JSON.stringify(mode)},'utf8'));}else if(a.length===3){console.error('Duration: 00:01:40.00');}else{fs.writeFileSync(a.at(-1),'audio');}`),true)
  put(mode,'-100');const input=join(data,'song.wav');put(input,'input')
  const cfg=normalize({song:{enabled:true,root,separatorModel:'test.onnx',keepWork:false}}),sent=[],notices=[],spoken=[];let conversions=0,failConversion=false,delivery,sung=0
  const s=createSongStudio({getConfig:()=>cfg,log:{info(){},warn(){}},local:{active:()=>true,call:async(_n,o)=>{conversions++;if(failConversion)throw Error('ENOENT /home/private/secret.py at internalFn()');put(o.output,'converted');return o.output}},say:async o=>spoken.push(o),onSung:()=>sung++,sendVoiceFile:async(_c,f)=>{if(delivery===undefined)sent.push(f);return delivery},sendText:async(_c,t)=>notices.push(t)})
  async function request(o){assert.equal(s.request({song:'测试',file:input,chatId:'private:'+Date.now(),...o}).ok,true);for(let i=0;i<500;i++){if(!s.status().current)return;await new Promise(r=>setTimeout(r,10))}throw Error('queue timeout')}
  await request({startSec:20,durationSec:8});assert.equal(sent.length,0);assert.match(notices.at(-1),/这段没有检测到人声/)
  assert.equal(existsSync(join(data,'songs/no-vocals.json')),false);assert.equal(readFileSync(calls,'utf8').trim().split('\n').length,1,'no retry of a different track')
  await request({startSec:100,durationSec:8});assert.match(notices.at(-1),/歌尾/);assert.equal(sent.length,0)
  put(mode,'-15');await request({startSec:20,durationSec:8});assert.equal(sent.length,1);assert.equal(conversions,1)
  await request({startSec:20,durationSec:8});assert.equal(sent.length,2);assert.equal(conversions,1)
  await request({startSec:30,durationSec:8});assert.equal(sent.length,3);assert.equal(conversions,2);assert.notEqual(sent[1],sent[2])
  failConversion=true;await request({startSec:40,durationSec:8});assert.equal(sent.length,3)
  assert.equal(spoken.length,1);assert.doesNotMatch(spoken[0].why + spoken[0].error,/private|secret\.py|ENOENT|internalFn/)
  assert.match(s.status().history[0].message,/secret\.py/,'本机诊断仍可查看真实原因')
  failConversion=false;await request({startSec:50,durationSec:8});assert.equal(sent.length,4,'失败不会堵住后续任务')
  assert.equal(s.status().current,null);assert.deepEqual(s.status().queue,[])
  assert.deepEqual(readdirSync(join(data,'songs')),['cache'],'成功和失败的工作目录均清理，成品缓存保留')
  cfg.song.keepWork=true;failConversion=true;await request({startSec:60,durationSec:8})
  assert.equal(readdirSync(join(data,'songs')).filter(n=>n!=='cache').length,1,'主动保留工作文件时不删除')
  cfg.song.keepWork=false;failConversion=false;const beforeSung=sung
  delivery=null;await request({startSec:70,durationSec:8});assert.equal(s.status().history[0].ok,false);assert.match(notices.at(-1),/发送未确认/);assert.equal(sung,beforeSung)
  delivery={queued:true};await request({startSec:80,durationSec:8});assert.equal(s.status().history[0].queued,true);assert.match(s.status().history[0].message,/补发队列；请在目标聊天确认送达/);assert.equal(sung,beforeSung)
  assert.equal(readdirSync(join(data,'songs')).filter(n=>n!=='cache').length,1,'发送未确认和等待补发均清理工作文件，仅保留之前明确留存的一份')
  delivery=undefined;await request({startSec:90,durationSec:8});assert.equal(sung,beforeSung+1,'兼容原有不返回值的发送回调')
})
