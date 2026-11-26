# 钉钉机器人平台端（dingtalk）接入说明

`src/adapters/dingtalk/` 实现依据。对应协议：**DingTalk Stream 长连接 + OpenAPI 机器人收发 + `/app/registration/*` 扫码建机器人**，零第三方 npm 依赖（仅使用 Node >= 22 内置 `fetch`、`WebSocket`、`FormData`、`Blob`）。

> 契约权威：[src/gateway/contracts.d.ts](../src/gateway/contracts.d.ts)、[CONTRACTS.md](CONTRACTS.md)、[PLATFORM-INTEGRATION.md](PLATFORM-INTEGRATION.md)。

## 一、接入方式与配置字段

### 1. 快速路径（Phase 1B 扫码创建机器人）

在 Aurabot 面板 **「通讯平台 → 钉钉」** 或 **设置向导** 点击 **「钉钉扫码创建机器人」**（`device-code` 驱动位于 [src/adapters/dingtalk/auth.js](../src/adapters/dingtalk/auth.js)）：

1. 宿主向 `https://oapi.dingtalk.com/app/registration/init`（固定来源 `DING_DWS_CLAW`）与 `/app/registration/begin` 请求 `device_code` 与 `verification_uri_complete`（及可选 `user_code`）；
2. 本地 `src/core/qr.js` 将授权链接生成为 SVG Data URI，不在日志或前端暴露 `deviceCode`；
3. 手机钉钉扫码确认后，轮询 `/app/registration/poll` 获取 `client_id` 与 `client_secret`，写入 `platforms.dingtalk`（`clientId` + Secret `clientSecret`），触发网关连接并执行 `whoami()`（核对 `clientId`）；
4. 扫码仅完成机器人凭据配置，**绝不自动认主**，主人身份仍需在绑定流程中确认。

> 若所在租户或网络无法使用扫码创建，可直接在下方手动填写企业自建应用的 **Client ID（AppKey）** 与 **Client Secret（AppSecret）**。

### 2. 配置字段说明（`config.platforms.dingtalk`）

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `clientId` | `string` | `''` | 应用 Client ID / AppKey |
| `clientSecret` | `password` | `''` | 应用 Client Secret（仅保存在宿主配置，面板仅回显 `clientSecretSet`） |
| `apiBaseUrl` | `string` | `https://api.dingtalk.com` | 钉钉新版 OpenAPI 基地址 |
| `oapiBaseUrl` | `string` | `https://oapi.dingtalk.com` | 钉钉 OAPI 地址（媒体上传与扫码注册） |
| `proactive` | `'free' \| 'none'` | `'free'` | `free` 允许主动消息；设为 `none` 时仅允许带 `inResponseTo` 的被动回复 |
| `maxTextChars` | `number` | `4000` | 单条文本发送字符上限，超出按换行切分并保持拼接逐字一致 |
| `timeoutMs` | `number` | `15000` | 单次 HTTP 请求预算超时（毫秒） |

## 二、能力表（`CAPS_DINGTALK`）

| 能力键 | 声明值 | 说明 / 依据 |
|---|---|---|
| `image` | `true` | 先上传 `/media/upload?type=image` 获取 `media_id`，再发 `sampleImageMsg` |
| `sticker` | `false` | 无原生通用表情包，由网关自动降级为 `image` |
| `voice` | `'native'` | 支持 AMR-NB（`8kHz` 单声道）或 Ogg Opus 原生语音条（`/media/upload?type=voice` + `sampleAudio` 带真实毫秒 `duration`）；超 `2MB`、未配 FFmpeg 或转码失败自动降级为 `sampleFile`；入站支持识别 `recognition` 文本 |
| `video` | `false` | 本期未实现视频出站，设为 `false` |
| `file` | `true` | 先上传 `/media/upload?type=file`，再发 `sampleFile` |
| `maxFileBytes` | `20MB` | 媒体上传单文件上限（超过前置拒绝为 `not-sent`） |
| `quoteReply` | `false` | 入站通过回调 `repliedMsg` 缓存提取文本/富文本/图片等结构化引用媒体（`message.quote.read: true`，可下载原图进入 `quoteImages` / `referenceImage`）；仅含 `msgId` 时退回不可读占位并保留 `replyTo`，出站暂无原生引用气泡 |
| `mention` / `mentionAll` | `true` / `true` | 通过 `sessionWebhook` 的 `at.atUserIds` / `at.isAtAll` 发送 |
| `poke` / `typing` / `recall` / `card` | `false` | 本期未声明交互卡片、戳一戳、typing、撤回 |
| `listenAllInGroup` | `false` | 钉钉机器人群内默认仅接收 `@机器人` 消息 |
| `proactive` | `'free'` | 支持 `oToMessages/batchSend` 与 `groupMessages/send` 主动发送 |
| `replyWindowMs` / `repliesPerMessage` | `0` / `0` | OpenAPI 主动通道无被动窗口次数限制；`sessionWebhook` 过期时自动回落 OpenAPI |
| `history` / `memberList` / `forwardExpand` | `false` | 未实现，全部诚实报 `false` |
| L2 `features` | `message.quote.read: true`、`media.fetch: true`、`sticker.collect: true`，其余 11 项 `false` | 入站图片/文件（含回调 `repliedMsg` 中的 `picture`/`richText` 原图）通过 `/v1.0/robot/messageFiles/download` 换取临时 HTTPS 地址下载 |

## 三、已知限制

1. **群全量监听与免 `@` 关键词唤醒不可用**：钉钉企业内部机器人回调在群聊中默认仅向机器人下发 `@机器人` 的消息，平台不投递群内未 `@` 的普通消息；因此仅发关键词不 `@` 不会触发唤醒（`listenAllInGroup: false`）。
2. **文件/图片出站需上传或已持有外部媒体 ID**：不接受无字节来源的内网 HTTP URL，也不读取允许目录（`allowedLocalDirs`）外的本地路径。
3. **引用正文仅限回调自带字段与短期缓存**：入站从回调 `repliedMsg` 提取文本 / 富文本 / 图片 / 文件 / 语音 / 视频摘要并保留 `replyTo`，且对回调携带的 `picture` / `richText` 图片 `downloadCode` 注册为 `quoteCache` + `mediaCache` 供 Hub（`fetch('message')` → `fetch('media')`）拉取原图进入 `quoteImages` / `referenceImage`；若回调未带下载字段（例如仅含 `msgId` 或 `[interactive card message]` 占位），则退回 `[引用：引用内容不可读]` 并尝试 Hub `recentInbound` 命中。钉钉仍未提供通用按历史 `msgId` 回查任意旧消息正文的接口，出站也不支持原生引用气泡（`quoteReply=false`）。
4. **验证边界**：本地 fake fetch + fake WebSocket + `runAdapterContract` 已覆盖状态机、媒体、引用摘要和语音链路；**2026-11-25 已完成真实钉钉企业账号的扫码创建连接、文字、图片和语音条测试**。文件/视频、群内 @、主动消息和长断网重连仍需补测。

## 四、错误码与 `SendError.certainty` 分类

| 场景 / 错误码 | `certainty` | 处理原则 |
|---|---|---|
| 未连接 / `proactive=none` 主动发送 / `nothing-to-send` / `reply-revoked`（首条前） | `'not-sent'` | 确定未发出，可按策略入队或报错 |
| `local-path-blocked` / `ssrf-blocked` / `too-large` / `empty-media` | `'not-sent'` | 发送前安全/体积校验拦截 |
| HTTP `401`/`403`（`permission-denied`）、`429`（`rate-limited`）、其余 `4xx`、非零 `errcode`/`code`、`ECONNREFUSED`/`ENOTFOUND` | `'not-sent'` | 平台明确拒绝或未建连 |
| 发送超时（`timeout` / HTTP `408`）、HTTP `5xx`、响应 JSON 解析失败、网络中断 | `'unknown'` | 结果不确定，严禁自动重试以免重复发送 |

## 五、生命周期、重连与停止

1. **建连**：`POST https://api.dingtalk.com/v1.0/gateway/connections/open`（必须携带 `Accept: application/json` 避免服务端返回 XML）获取一次性 `endpoint` 与 `ticket`，再建立 WebSocket 长连接。
2. **心跳与应答**：收到 `SYSTEM` `ping` 时原样回传 `code: 200`；收到 `EVENT` 或 `CALLBACK` 时立即通过 WebSocket 回传 `{ code: 200, headers: { contentType: 'application/json', messageId }, data }` 避免钉钉 60s 重投。
3. **断线重连**：运行期间遇到 `SYSTEM disconnect` 或异常断线会使用指数退避（默认 `1s` 至 `30s`）自动重连。
4. **停止**：`stop()` 会递增连接代数、清理重连定时器、关闭 WebSocket 并清空短期回复/媒体缓存，保证停止后不再调用 `ctx.emit`。

## 六、安全注意事项

- **注册与回调域名白名单**：扫码注册接口与二维码 URL 强制校验为默认端口 `https:` 且域名归属 `dingtalk.com` / `*.dingtalk.com`，`sessionWebhook` 同理验证后方可投递并剥离 `#hash`。
- **凭据脱敏**：`deviceCode` 列为 `sensitiveDriverSessionKeys`；`clientSecret` 仅存入宿主 secret 存储；`AuthSessionView`、`AdapterInbound.raw`（剥离 `sessionWebhook`）与日志/错误消息均不输出密钥明文。
- **不自动认主**：扫码成功只写入 `platforms.dingtalk` 与连接验证，不改变 `ownerPersonId` 或共享私聊状态。

## 七、测试与验证

```bash
node --test test/core/ws-client.test.js test/voice/audio-format.test.js test/adapters/dingtalk.test.js test/gateway/phase1b-auth-drivers.test.js test/tool-naming.test.js
npm run test:types
npm run test:qr-decode
npm test
```

> 2026-11-25 已完成钉钉真实扫码创建连接、文字、图片和语音条测试，文件/视频、群内 @、主动消息和长断网重连仍待补测。
