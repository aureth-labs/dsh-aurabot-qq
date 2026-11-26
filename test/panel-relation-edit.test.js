// #101：人物关系的方向允许手动改正，客户端必须有编辑入口和保存路由。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const mod = readFileSync(new URL('../src/modules/memory/index.js', import.meta.url), 'utf8')

test('人物关系卡片有「改」入口，保存走 /memory/relations/save', () => {
  assert.match(client, /relationEdit/)
  assert.match(client, /修改这条关系/)
  assert.match(client, /post\('\/memory\/relations\/save'/)
})

test('后端注册关系保存路由并校验主语/关系/宾语', () => {
  assert.match(mod, /api\.route\('\/memory\/relations\/save'/)
  assert.match(mod, /关系要写全主语、关系、宾语/)
})
