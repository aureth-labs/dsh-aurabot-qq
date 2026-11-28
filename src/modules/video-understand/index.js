// 内置模块：视频理解（基础能力，供其他模块复用）。
// 三条主力路线：B站字幕提取 → ASR 语音识别 → 抽帧+视觉模型描述，统一 understand/supports/estimate/status
// 接口，内置路由降级与磁盘缓存。原生视频 API（第三方）已实现但默认关闭。
//
// 双通道设计（可配置）：
//   通道A = DSH/项目现成接口：视觉走 askModel（复用 src/bili/vision.js describeFrames），
//           ASR 走 DSH speechToText（复用 src/chat/hub.js localTranscribe 的调用范式）；
//   通道B = 第三方 OpenAI 兼容接口（baseUrl/apiKey/model，如智谱 GLM-4V-Plus），模块内 HTTP 直调。
// 引擎本体在 engine.js（纯逻辑），双通道在 channels.js，磁盘缓存在 cache.js。
//
// 其他模块用法：
//   const vu = api.use('video-understand')
//   const r = await vu.understand('BV1xx411c7mD')            // 或本地路径 / URL / { messageId }
//   vu.supports(input) / await vu.estimate(input) / vu.status()

import { createEngine } from './engine.js'
import { createCache } from './cache.js'

export default {
  id: 'video-understand',
  name: '视频理解',
  version: '1.0.0',
  description: '可复用的视频理解基础模块：字幕 → ASR → 抽帧+VLM 三条路线自动路由降级，双通道（DSH / 第三方 OpenAI 兼容）可配，带缓存与成本控制。其他模块用 api.use("video-understand") 调 understand/supports/estimate/status。',
  files: ['modules/video-understand/engine.js', 'modules/video-understand/channels.js', 'modules/video-understand/cache.js'],
  defaults: {
    enabled: true, // 基础模块默认开：只在被调用时工作，不主动做任何事
    maxDurationSec: 7200, // 输入时长上限（秒），超过直接拒绝，不产生任何费用
    maxSizeMB: 1024, // 本地文件大小上限（MB）
    preferSubtitle: true, // 优先走 B站字幕（零模型开销）
    preferAsr: true, // 无字幕时走 ASR
    autoVisual: true, // 一个字都没拿到时，自动抽帧兜底
    visualKeywords: '', // 标题/作者命中这些关键词时自动抽帧，逗号分隔，如：开箱,评测,纯画面
    visualChannel: 'dsh', // 视觉理解通道：dsh | third
    visualDshModel: '', // 通道A 可选覆盖，格式 'provider/model'，留空跟随插件默认模型
    visualBaseUrl: '', // 通道B：OpenAI 兼容 baseUrl（如 https://open.bigmodel.cn/api/paas/v4）
    visualApiKey: '', // 通道B：密钥（只存本机，面板不回显）
    visualModel: '', // 通道B：模型名，留空用 glm-4v-plus-0111
    visualPrompt: '', // 自定义画面描述提示词，留空用内置
    visualMaxTokens: 1000,
    asrChannel: 'dsh', // ASR 通道：dsh | third
    asrBaseUrl: '', // 通道B：OpenAI 兼容 baseUrl（到 /v1 这级，模块自动补 /audio/transcriptions）
    asrApiKey: '', // 通道B：密钥
    asrModel: '', // 通道B：模型名，留空用 whisper-1
    asrLanguage: '', // 可选语言提示（如 zh），留空自动
    frameCount: 6, // 抽帧数（1~12，与 src/bili/vision.js 同参数）
    frameWidth: 512, // 帧宽
    nativeEnabled: false, // 原生视频 API：默认关（第三方按整段视频计费，贵）
    nativeBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    nativeApiKey: '', // 原生 API：密钥
    nativeModel: 'glm-4v-plus-0111',
    cacheEnabled: true, // 结果缓存：命中免重复付费
    cacheTtlHours: 168, // 缓存有效期（小时），7 天
    cacheMaxEntries: 200, // 缓存条数上限，超出淘汰最旧
  },
  settings: [
    { key: 'enabled', label: '启用视频理解', type: 'switch', hint: '基础模块：只在被其他模块或 HTTP 调用时工作' },
    { key: 'maxDurationSec', label: '时长上限（秒）', type: 'number', min: 0, max: 86400, hint: '超过直接拒绝，不产生任何费用；0 = 不限' },
    { key: 'maxSizeMB', label: '本地文件上限（MB）', type: 'number', min: 0, max: 102400 },
    { key: 'preferSubtitle', label: '优先字幕', type: 'switch', hint: 'B站视频先拉字幕，零模型开销' },
    { key: 'preferAsr', label: '无字幕时转写语音', type: 'switch' },
    { key: 'autoVisual', label: '无文字时抽帧兜底', type: 'switch', hint: '字幕和 ASR 都没拿到文字时，自动抽帧让视觉模型看' },
    { key: 'visualKeywords', label: '自动抽帧关键词', type: 'textarea', placeholder: '开箱,评测', hint: '标题/作者命中时自动抽帧（即使有字幕），逗号分隔' },
    { key: 'visualChannel', label: '视觉理解通道', type: 'select', options: [{ value: 'dsh', label: '通道A：DSH 当前模型' }, { value: 'third', label: '通道B：第三方接口' }] },
    { key: 'visualDshModel', label: '通道A 模型覆盖', type: 'text', placeholder: 'provider/model', hint: '如 zhipu/glm-4.6v；留空跟随插件默认模型' },
    { key: 'visualBaseUrl', label: '通道B baseUrl', type: 'text', placeholder: 'https://open.bigmodel.cn/api/paas/v4' },
    { key: 'visualApiKey', label: '通道B apiKey', type: 'password', placeholder: '没有就留空' },
    { key: 'visualModel', label: '通道B 模型', type: 'text', placeholder: '留空 = glm-4v-plus-0111' },
    { key: 'visualPrompt', label: '画面描述提示词', type: 'textarea', placeholder: '留空用内置提示词' },
    { key: 'visualMaxTokens', label: '描述最大 token', type: 'number', min: 100, max: 8000 },
    { key: 'asrChannel', label: '语音识别通道', type: 'select', options: [{ value: 'dsh', label: '通道A：DSH 语音输入' }, { value: 'third', label: '通道B：第三方接口' }] },
    { key: 'asrBaseUrl', label: 'ASR 通道B baseUrl', type: 'text', placeholder: 'https://api.example.com/v1', hint: 'OpenAI 兼容，模块自动补 /audio/transcriptions' },
    { key: 'asrApiKey', label: 'ASR 通道B apiKey', type: 'password', placeholder: '没有就留空' },
    { key: 'asrModel', label: 'ASR 通道B 模型', type: 'text', placeholder: '留空 = whisper-1' },
    { key: 'asrLanguage', label: '识别语言提示', type: 'text', placeholder: '如 zh，留空自动' },
    { key: 'frameCount', label: '抽帧数', type: 'number', min: 1, max: 12 },
    { key: 'frameWidth', label: '帧宽（像素）', type: 'number', min: 128, max: 1920 },
    { key: 'nativeEnabled', label: '启用原生视频 API', type: 'switch', hint: '默认关：第三方按整段视频计费，开启后还需每次调用显式传 options.native=true' },
    { key: 'nativeBaseUrl', label: '原生 API baseUrl', type: 'text' },
    { key: 'nativeApiKey', label: '原生 API apiKey', type: 'password', placeholder: '没有就留空' },
    { key: 'nativeModel', label: '原生 API 模型', type: 'text' },
    { key: 'cacheEnabled', label: '结果缓存', type: 'switch', hint: '同一视频同样参数直接返回上次结果，不重复付费' },
    { key: 'cacheTtlHours', label: '缓存有效期（小时）', type: 'number', min: 1, max: 8760 },
    { key: 'cacheMaxEntries', label: '缓存条数上限', type: 'number', min: 10, max: 10000, hint: '超出淘汰最旧' },
  ],
  setup(api) {
    const cache = createCache({ dir: api.dataDir('cache'), log: (m) => api.log.warn(m) })
    const engine = createEngine({ api, dsh: api.dsh, log: (m) => api.log.info(m), cache })
    // 注意：缓存是磁盘持久化的，插件停止时不清空，跨重启命中

    // 面板/其他模块可查状态、清缓存（内置模块路由前缀为空 → /aurabot/api/video-understand/...）
    api.route('/video-understand/status', () => ({ ok: true, status: engine.status() }))
    api.route('/video-understand/clear-cache', () => engine.clearCache())

    return engine // understand / supports / estimate / status / clearCache
  },
}
