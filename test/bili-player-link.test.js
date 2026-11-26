// #334：私聊分享用 QQ 里点得开的网页播放器链接；记忆/流水仍存正式视频地址。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { link, playerLink } from '../src/bili/duty.js'

test('播放器链接带 bvid 与 autoplay，分 P 可指定', () => {
  assert.equal(playerLink('BV1GJ411x7h7'), 'https://www.bilibili.com/blackboard/webplayer/mbplayer.html?bvid=BV1GJ411x7h7&p=1&autoplay=true')
  assert.match(playerLink('BV1GJ411x7h7', 3), /[?&]p=3&autoplay=true$/)
})

test('正式视频地址保持不变，仍用 video/ 形式', () => {
  assert.equal(link('BV1GJ411x7h7'), 'https://www.bilibili.com/video/BV1GJ411x7h7')
})
