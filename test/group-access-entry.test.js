import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { normalize } from '../src/core/config.js'
const source=readFileSync(new URL('../client/client.js',import.meta.url),'utf8')
const publicPanel=source.includes('function GroupPermissions(')
const entry=publicPanel?'GroupPermissions':'Access'
function fixture(){
 let loader,cursor=0,slots=[],draft=normalize({ownerQQ:'10000001',allow:{private:['10000001','20000002'],groups:['30000003']},group:{moduleOnlyGroups:['30000003']}})
 const visits=[]
 const React={Component:class{},createElement:(type,props,...children)=>({type,props:props||{},children}),useRef:v=>({current:v}),useState:init=>{const i=cursor++;if(!(i in slots))slots[i]=typeof init==='function'?init():init;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v]}}
 new Script(source.replace('exports.AurabotPage = AurabotPage',`exports.Entry = ${entry}; exports.GroupOverrides = GroupOverrides; exports.AurabotPage = AurabotPage`)).runInNewContext({window:{__ModuleLoader__:{load:v=>loader=v}}})
 const components=loader.factory(()=>React)
 return{visits,get draft(){return draft},render(name='Entry'){cursor=0;return components[name]({draft,setDraft:v=>draft=JSON.parse(JSON.stringify(v)),st:{config:draft,modules:[]},toast(){},reload(){},go:tab=>visits.push(tab),setSection(){}})}}
}
const nodes=root=>[root,...(root?.children||[]).flat(Infinity).filter(v=>v&&typeof v==='object').flatMap(nodes)]
const text=n=>typeof n==='string'?n:(n?.children||[]).flat(Infinity).map(text).join('')
const find=(root,fn)=>{const n=nodes(root).find(fn);assert.ok(n);return n}
test('群设置主入口直接跳转，旧名单默认折叠；浏览不会改设置',()=>{
 const p=fixture(),before=structuredClone(p.draft),tree=p.render()
 const card=find(tree,n=>n.props.title==='群消息设置')
 const fold=find(card,n=>n.type==='details')
 assert.notEqual(fold.props.open,true);assert.match(text(fold),/直接编辑群白名单/)
 const link=find(card,n=>text(n)==='打开群聊设置'&&n.props.onClick)
 assert.equal(link.props.kind,'primary');link.props.onClick()
 assert.deepEqual(p.visits,['group']);assert.deepEqual(p.draft,before)
 assert.ok(nodes(fold).some(n=>n.props.onChange||n.props.onClick),'保留原名单操作')
 if(!publicPanel){
  const privateCard=find(tree,n=>n.props.title==='私聊白名单')
  const field=find(privateCard,n=>Array.isArray(n.props.value)&&n.props.onChange)
  field.props.onChange(['10000001','60000006'])
  assert.deepEqual(p.draft.allow.private,['10000001','60000006']);assert.deepEqual(p.draft.allow.groups,before.allow.groups);assert.deepEqual(p.draft.group,before.group)
 }
})
test('仅模块不显示旁听；不响应时开关紧跟模式，不改别的设置',()=>{
 const p=fixture(),gid='30000003',title='群 '+gid+' 不响应时仍旁听'
 let tree=p.render('GroupOverrides')
 assert.ok(!nodes(tree).some(n=>n.props.title===title))
 find(tree,n=>n.props.ariaLabel==='群 '+gid+' 响应模式').props.onChange('off')
 tree=p.render('GroupOverrides')
 const row=find(tree,n=>n.props.label==='群响应模式')
 const [select,label]=row.children
 assert.equal(select.props.value,'off');assert.equal(label.type,'label')
 const before=structuredClone(p.draft)
 find(label,n=>n.props.title===title).props.onChange(true)
 assert.deepEqual(p.draft,{...before,memory:{...before.memory,passiveGroups:[gid]}})
})
