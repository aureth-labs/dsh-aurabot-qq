# 视频理解（video-understand）

可复用的「视频理解基础模块」。其他模块通过模块机制调用：

```js
const vu = api.use('video-understand')
const result = await vu.understand('BV1xx411c7mD') // 也支持本地路径 / 公网 URL / QQ语音条
```

三条主力路线，自动路由、逐层降级：

1. **字幕提取**（仅 B站视频，零模型开销）
2. **ASR 语音识别**（无字幕时；ffmpeg 抽音轨 → 16kHz 单声道 WAV → 识别）
3. **抽帧 + 视觉模型**（显式要求 / 关键词命中 / 完全没拿到文字时兜底）

另实现**原生视频 API**路线（第三方多模态模型直接看完整视频），**默认关闭**——按整段视频计费，成本高。

## 接口签名

| 接口 | 签名 | 说明 |
| --- | --- | --- |
| `understand` | `understand(input, options?) → Promise<result>` | 完整理解一个视频。全部路线失败时抛错（`e.code='NO_RESULT'`，带 `e.tried`） |
| `supports` | `supports(input) → { input, routes: [{ route, ok, reason }] }` | 同步、零网络开销，返回该输入可走的路线与原因 |
| `estimate` | `estimate(input, options?) → Promise<{ route, estimatedTokens, time, note }>` | 预计路线 / token 区间 / 耗时档位（只给档位，不伪精确）。注意：对 B 站输入会联网拉 view 元数据，对直链 URL 会 probeMedia 探测（其余情况零网络）；内网地址会被 SSRF 校验拒绝 |
| `status` | `status() → { enabled, ffmpeg, cache, channels, lastError }` | 运行状态：ffmpeg、缓存命中数、双通道就绪情况、最近错误 |
| `clearCache` | `clearCache() → { ok }` | 清空结果缓存与帧文件 |

**input** 支持四种形态：

| 形态 | 例子 | 说明 |
| --- | --- | --- |
| B站 | `'BV1xx411c7mD'` / `'https://www.bilibili.com/video/BV...'` / b23.tv 短链 | 走字幕 → ASR → 抽帧 |
| 本地文件 | `'D:/videos/demo.mp4'` 或 `{ path: '...' }` | 走 ASR → 抽帧 |
| 公网 URL | `'https://example.com/demo.mp4'` 或 `{ url: '...' }` | 走 ASR → 抽帧（带 SSRF 防护，拒绝内网地址） |
| QQ语音条 | `{ messageId: 123456 }` | 走 QQ 服务端转写（fetch_ptt_text），仅限语音消息 |

**options**（均可选）：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `needsVisual` | boolean | 强制走抽帧+视觉路线 |
| `saveFrames` | boolean | 把抽出的帧存到 `modules-data/video-understand/frames/<缓存key>/` 并在结果里返回路径 |
| `native` | boolean | 本次调用允许原生视频 API（还需配置里 `nativeEnabled` 开启，双重保险防止意外计费） |
| `language` | string | ASR 语言提示（如 `'zh'`） |
| `prompt` | string | 原生视频 API 的提示词 |
| `signal` | AbortSignal | 取消信号 |

**result** 结构：

```js
{
  input:   { kind: 'bilibili'|'local'|'url'|'qq-voice', raw },
  meta:    { durationSec, sizeBytes, mime, platform, title, sourceUrl },  // 取不到的字段为 null
  transcript: { text, source: 'subtitle'|'asr'|'native'|null, language, segments },
  visual:  { description, frames: [{ tSec, path }] },   // frames 仅 saveFrames=true 时有内容
  events:  [],   // 结构预留，当前恒为空数组（时间线事件填充属后续版本）
  route:   { chosen: 'subtitle+frames', tried: [{ route, ok, note?, ms? }], fallbackReason },
  cost:    { estimatedTokens, actualTokens, note },
  cachedAt: '2026-01-01T00:00:00.000Z',                 // 缓存命中时才有
}
```

## 双通道说明

「视觉理解」和「语音识别」各自可独立选择通道：

- **通道A（默认）**：DSH / 项目现成接口，零配置可用
  - 视觉：当前对话模型直接看图（复用 `src/bili/vision.js` 的抽帧与描述链路；模型不支持看图时自动降级）
  - ASR：DSH「语音输入」插件（SenseVoice，本地转写，零 API 费用；模型未就绪时会自动触发下载并明确报错）
  - 视觉可选覆盖模型：`visualDshModel` 填 `'provider/model'`（如 `zhipu/glm-4.6v`），留空跟随插件默认模型
- **通道B**：第三方 OpenAI 兼容接口，HTTP 直调
  - 视觉：`{baseUrl}/chat/completions`，图片走 base64 `image_url`（智谱 GLM-4V-Plus 等兼容此格式）
  - ASR：`{baseUrl}/audio/transcriptions`（OpenAI Whisper 兼容格式，multipart 上传 WAV）
  - 需配置 `baseUrl` + `apiKey` + 可选 `model`；**apiKey 只存本机，面板不回显**

每个路线会先走选定通道，失败时自动尝试另一个通道，并把每次尝试记进 `route.tried`（含失败原因与耗时）。

### 错误分类（第三方调用）

所有第三方调用带超时与错误分类，错误对象带 `e.kind` / `e.retryable`：

| kind | retryable | 说明 |
| --- | --- | --- |
| `content-filter` | **否** | 内容审查类（content_filter/敏感/审核等），同内容重试必然再触发且重复计费，绝不重试 |
| `auth` / `notfound` / `bad-request` | 否 | 401/403/404/其他 4xx |
| `rate-limit` / `server` / `timeout` / `network` | 是 | 429/5xx/超时/网络错误，有限次退避重试 |

## 配置项

全部在面板「模块 → 视频理解」或 `config.ext['video-understand']`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 模块开关（只在被调用时工作） |
| `maxDurationSec` | `7200` | 输入时长上限（秒），超限直接拒绝不产生费用；0 不限 |
| `maxSizeMB` | `1024` | 本地文件大小上限（MB） |
| `preferSubtitle` | `true` | 优先 B站字幕 |
| `preferAsr` | `true` | 无字幕时走 ASR |
| `autoVisual` | `true` | 完全没拿到文字时自动抽帧兜底 |
| `visualKeywords` | `''` | 标题/作者命中关键词时自动抽帧，逗号分隔 |
| `visualChannel` | `'dsh'` | 视觉通道：`dsh` / `third` |
| `visualDshModel` | `''` | 通道A模型覆盖，`'provider/model'`，留空跟随默认 |
| `visualBaseUrl` | `''` | 通道B baseUrl（如 `https://open.bigmodel.cn/api/paas/v4`） |
| `visualApiKey` | `''` | 通道B 密钥（本机保存，不回显） |
| `visualModel` | `''` | 通道B 模型，留空 = `glm-4v-plus-0111` |
| `visualPrompt` | `''` | 自定义画面描述提示词 |
| `visualMaxTokens` | `1000` | 描述最大 token |
| `asrChannel` | `'dsh'` | ASR 通道：`dsh` / `third` |
| `asrBaseUrl` | `''` | 通道B baseUrl（到 `/v1` 这级即可） |
| `asrApiKey` | `''` | 通道B 密钥 |
| `asrModel` | `''` | 通道B 模型，留空 = `whisper-1` |
| `asrLanguage` | `''` | 识别语言提示，留空自动 |
| `frameCount` | `6` | 抽帧数（1~12） |
| `frameWidth` | `512` | 帧宽（像素） |
| `nativeEnabled` | `false` | 原生视频 API 总开关（默认关） |
| `nativeBaseUrl` | `https://open.bigmodel.cn/api/paas/v4` | 原生 API 地址 |
| `nativeApiKey` | `''` | 原生 API 密钥 |
| `nativeModel` | `glm-4v-plus-0111` | 原生 API 模型 |
| `cacheEnabled` | `true` | 结果缓存（命中免重复付费） |
| `cacheTtlHours` | `168` | 缓存有效期（小时） |
| `cacheMaxEntries` | `200` | 缓存条数上限，超出淘汰最旧 |

## 缓存

- 位置：`plugins-data/aurabot/modules-data/video-understand/cache/`（结果 JSON）与 `frames/`（帧文件，仅 `saveFrames` 时产生）
- key = 输入指纹（BV号+分P / URL 去跟踪参数 / 本地文件 mtime+size / messageId）+ 有影响的 options 子集
- 命中直接返回（带 `cachedAt` 字段），**不重复调用任何模型**；字幕命中时也不再调 ASR/视觉
- 面板/模块可调 `clearCache()` 清空

## 依赖

- **ffmpeg**（ASR 与抽帧必需）：读 `config.bili.ffmpegPath`，没有则在 PATH 与常见安装位查找——与「B站助手」共用同一配置，配一次即可
- DSH「语音输入」插件（通道A ASR）；对话模型支持看图（通道A 视觉）

## HTTP 接口

内置模块路由前缀为空：

- `GET /aurabot/api/video-understand/status` — 运行状态
- `POST /aurabot/api/video-understand/clear-cache` — 清缓存

## 已知边界（遗留）

- B站 FLV 分段（durl）老视频不支持抽帧/ASR（DASH 正常）；YouTube 等站外平台需自行先用 yt-dlp 落地成本地文件再传入
- 原生视频 API：B站视频没有可直接外链的完整视频流（DASH 音画分轨），该路线只支持公网 URL 输入或 ≤60MB 的本地文件（base64 上传）
- 本地转写（通道A ASR）时长与视频音轨长度正相关，超长视频建议调小 `maxDurationSec`
