// 内置模块清单（按启动顺序）。每个模块的说明见各自文件开头；写法和接口见 API.md。

import stickers from './stickers/index.js'
import voice from './voice/index.js'
import mood from './mood/index.js'
import memory from './memory/index.js'
import qqTools from './qq-tools/index.js'
import qqApi from './qq-api/index.js'
import imagegen from './imagegen/index.js'
import diary from './diary/index.js'
import qzoneSocial from './qzone-social/index.js'
// P4（speakup → purpose 迁移，docs/SPEAKUP-INTO-PURPOSE-PLAN.md §4）：主动搭话模块已退场，
// 能力并入 purpose（P1 默认开+播种保证老用户无感切换；P2b 小闹钟、P3 策略源均已收拢）。
import purpose from './purpose/index.js'
import autotelic from './autotelic/index.js'
import bili from './bili/index.js'
import song from './song/index.js'
import profile from './profile/index.js'
import contacts from './contacts/index.js'
import video from './video/index.js'
import imageRecovery from './image-recovery/index.js'
import inputRejectionNotice from './input-rejection-notice/index.js'

export const BUILTINS = [stickers, voice, mood, memory, qqTools, qqApi, imagegen, diary, qzoneSocial, purpose, autotelic, bili, song, profile, contacts, video, imageRecovery, inputRejectionNotice]
