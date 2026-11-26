# 企业微信智能机器人平台端（wecom）接入说明

`src/adapters/wecom/` 实现依据。对应协议：**企业微信官方 WebSocket 长连接（`wss://openws.work.weixin.qq.com`，无需公网回调）+ 官方扫码服务（`work.weixin.qq.com/ai/qc/*`）**，零第三方 npm 依赖（WebSocket 客户端基于内置 `node:http` / `node:https` / `node:crypto` 的 [src/core/ws-client.js](../src/core/ws-client.js)，其余仅使用 Node >= 22 内置 `fetch`、`node:crypto`）。

> **握手说明**：企业微信网关（`openws.work.weixin.qq.com` / `Server: Wwebsvr`）对 HTTP Upgrade 请求头名大小写敏感，遇到 Node 内置 `undici` `WebSocket` 发出的全小写请求头会直接返回 `404 Not Found`。因此 `wecom` 默认使用内置 Title-Case RFC 6455 客户端 `createTitleCaseWebSocket`，在零第三方依赖下发送标准 `Host` / `Connection` / `Upgrade` / `Sec-WebSocket-Key` / `Sec-WebSocket-Version` 请求头并保留非 `101` 握手诊断信息。

> **严格隔离声明**：`wecom` 是面向企业微信智能机器人的官方通道，**与个人微信 `wechat-clawbot`（iLink）及未来基于 HTTP 回调的企业微信自建应用（`wecom-app`）完全隔离**——不共享配置键、账号身份、`ChatId` 或缓存状态。

> 契约权威：[src/gateway/contracts.d.ts](../src/gateway/contracts.d.ts)、[CONTRACTS.md](CONTRACTS.md)、[PLATFORM-INTEGRATION.md](PLATFORM-INTEGRATION.md)。

## 一、接入方式与配置字段

### 1. 快速路径（Phase 1B 扫码创建/绑定机器人）

在 Aurabot 面板 **「通讯平台 → 企业微信」** 或 **设置向导 → 企业微信智能机器人** 点击 **「企业微信扫码绑定机器人」**（`qr-link` 驱动位于 [src/adapters/wecom/auth.js](../src/adapters/wecom/auth.js)）：

1. 宿主请求 `https://work.weixin.qq.com/ai/qc/generate?source=deepseek-harness&plat=...`（`redirect: 'error'`）获取一次性 `scode` 与 `auth_url`（强制校验为 `https://work.weixin.qq.com`）；
2. 本地 `src/core/qr.js` 将 `auth_url` 渲染为 SVG Data URI，`scode` 仅保存在宿主敏感会话字段内，绝不返回面板；
3. 企业微信客户端扫码确认后，轮询 `/ai/qc/query_result` 拿回 `bot_info.botid` 与 `bot_info.secret`，写入 `platforms.wecom`（`botId` + `secret`），等待 WebSocket `aibot_subscribe` 鉴权连通及 `whoami()` 核对 `botId`；
4. 扫码仅创建/绑定机器人凭据，**绝不自动认主**。

> 也可直接在企业微信管理后台创建智能机器人并手动填写 **Bot ID** 与 **Secret**。

### 2. 配置字段说明（`config.platforms.wecom`）

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `botId` | `string` | `''` | 企业微信智能机器人 Bot ID |
| `secret` | `password` | `''` | 机器人 Secret（仅保存在宿主配置，面板仅回显 `secretSet`） |
| `wsUrl` | `string` | `wss://openws.work.weixin.qq.com` | 官方 WebSocket 长连接接入点（私有化部署可替换） |
| `proactive` | `'free' \| 'none'` | `'free'` | `free` 允许通过 `aibot_send_msg` 主动发送；设为 `none` 时仅允许被动回复 |
| `maxTextChars` | `number` | `6000` | 单段文本字符上限（单帧另受 18,000 UTF-8 字节硬限制） |
| `timeoutMs` | `number` | `15000` | 单次命令或媒体上传回执等待超时（毫秒） |

## 二、能力表（`CAPS_WECOM`）

| 能力键 | 声明值 | 说明 / 依据 |
|---|---|---|
| `image` | `true` | 通过 `aibot_upload_media_init/chunk/finish` 分片上传后 `aibot_send_msg` 发送 `image` |
| `sticker` | `false` | 无原生表情包，由网关自动降级为 `image` |
| `voice` | `'native'` | 支持 AMR-NB 原生语音条（`aibot_upload_media_init` `type='voice'` + `aibot_send_msg` `msgtype='voice'`）；超 `2MB`/`60s`、未配 FFmpeg 或转码失败自动降级为 `file` 发送；入站可提取 `voice.content` 语音识别文字 |
| `video` | `true` | 支持 `video` 媒体三步分片上传并发送 |
| `file` | `true` | 支持 `file` 媒体三步分片上传并发送 |
| `maxFileBytes` | `20MB` | 默认单文件上限（协议理论上限 100 片 × 512KB） |
| `quoteReply` | `false` | 入站通过 `body.quote` 缓存提取文本/Markdown/Stream/卡片/语音/图片/视频/文件/图文混排摘要，并为引用中的图片与混排图片注册加密媒体引用（`message.quote.read: true`，供 `quoteImages` / `referenceImage` 解密下载原图）；出站不声明原生引用气泡 |
| `mention` / `mentionAll` | `false` / `false` | 当前群聊由 `@机器人` 触发，暂不声明群内 `@` 能力 |
| `poke` / `typing` / `recall` / `card` | `false` | 本期主接入通路未声明模板卡片、撤回、typing、拍一拍 |
| `listenAllInGroup` | `false` | 企业微信智能机器人在群里平台侧仅向机器人推送显式 `@机器人` 的消息（未 `@` 的普通群消息和关键词不会回调下发）；入站会自动剥离句首 `@机器人` 前缀 |
| `proactive` | `'free'` | 支持 `aibot_send_msg` 向目标会话发送 `markdown` 与媒体消息 |
| `replyWindowMs` / `repliesPerMessage` | `0` / `0` | 首条被动文本复用入站 `req_id` 走 `aibot_respond_msg`（`stream.finish=true`），后续段落/主动消息走 `aibot_send_msg` |
| `history` / `memberList` / `forwardExpand` | `false` | 官方长连接未提供历史/成员列表拉取，诚实报 `false` |
| L2 `features` | `message.quote.read: true`、`media.fetch: true`、`sticker.collect: true`，其余 11 项 `false` | 入站加密媒体（含 `body.quote` 携带的 `image` / `mixed` 引用图）先经 HTTP 下载，再用 `aeskey` 按 AES-256-CBC（32B PKCS#7）解密还原 |

## 三、已知限制

1. **同一 Bot ID 仅允许一条活跃长连接**：若有第二客户端用相同 `botId/secret` 连接，企微服务端会向旧连接推送 `disconnected_event` 并关闭旧链路；本适配器收到该事件后会立即停用心跳与自动重连、发出 `{ type: 'offline', reason: 'disconnected_event' }`，防止双端互踢死循环。
2. **群聊只接收 @机器人 的推送**：`listenAllInGroup=false`，未 @ 只发关键词时适配器收不到消息。
3. **引用能力限于回调自带 `body.quote`**：若 `body.quote` 携带完整内容，适配器会生成 `[引用：...]` 摘要，并将图片/图文混排中的加密图片（`url` + `aeskey`）缓存于私有 `quoteCache` + `mediaCache` 供 Hub 通过 `fetch('message')` → `fetch('media')` 下载并传入 `quoteImages` / `referenceImage`（即使缺少 `quote.msgid` 也会生成合成索引键）。若真实回调缺 `url` 或仅给 `quote.msgid`，则回退 Hub `recentInbound` 或显示不可读/摘要；由于平台未提供历史消息回查接口，跨会话任意历史 ID 回查与出站引用回复（`quoteReply=false`）仍不支持。
4. **文件加解密采用 32 字节块 PKCS#7**：与 Node 默认 16 字节 padding 不兼容，本适配器已按 `@wecom/aibot-node-sdk` 规范使用 `setAutoPadding(false)` + 1..32 字节填充核验（见 `decryptWecomFile`）。
5. **验证边界**：本地 mock WebSocket / fetch、分片上传与加解密往返测试已覆盖协议主路径；**2026-11-25 已完成真实企业微信智能机器人的扫码创建连接、文字、图片和语音条测试**。文件/视频、群内 @、主动消息和长断网重连仍需补测。

## 四、错误码与 `SendError.certainty` 分类

| 场景 / 错误码 | `certainty` | 处理原则 |
|---|---|---|
| 未连接 / `proactive=none` 主动发送 / `nothing-to-send` | `'not-sent'` | 确定未发出 |
| `errcode === 48002`（`permission-denied`）、`errcode === 45009`（`rate-limited`）、其余非 0 `errcode` | `'not-sent'` | 企微服务端明确拒绝 |
| `local-path-blocked` / `ssrf-blocked` / `too-large` / `empty-media` | `'not-sent'` | 发送前本地路径白名单、公网 URL 或体积校验拒绝 |
| `timeout`（等待 ACK 超时）、`connection-closed` / `heartbeat-timeout` / `server-disconnected` / `adapter-stopped` | `'unknown'` | 请求或连接在等待回执期间中断，严禁自动重试 |

## 五、生命周期、心跳、重连与停止

1. **建连与订阅**：连上 WebSocket 后立即发送 `{ cmd: 'aibot_subscribe', headers: { req_id }, body: { bot_id, secret } }`，收到 `errcode === 0` 回执后才报告 `connected`。
2. **心跳**：连接成功后每 30 秒发送 `{ cmd: 'ping', headers: { req_id } }`；连续 2 次未收到回执判定断线，清理连接并以指数退避（默认 `1s` 至 `30s`）重连。
3. **顶号处理**：收到 `aibot_event_callback` (`eventtype === 'disconnected_event'`) 时，停止重连并标记 `disconnected`。
4. **停止**：`stop()` 会停止心跳与重连定时器，以 `unknown` 终止未决 ACK，关闭 WebSocket 并清空缓存，确保之后不再触发 `ctx.emit`。

## 六、安全注意事项

- **`aeskey` 与凭据隔离**：入站媒体 `aeskey` 仅存入适配器内部有限缓存，**严禁写入 `MediaRef`、`AdapterInbound.raw`（强制递归剥离）或模型上下文/日志**；`scode` 与 `secret` 仅存宿主，面板不可见。
- **SSRF 与路径隔离**：入站媒体下载地址通过公网 URL 检查；出站本地文件仅接受 `file://` 解码后位于 `allowedLocalDirs` 内的常规文件。
- **通道彻底分离**：不从 `src/adapters/wechat-clawbot/` 复用或读取任何状态/token/命名空间，仅共用无状态的 `src/adapters/wechat-common/` 纯工具函数。

## 七、测试与验证

```bash
node --test test/core/ws-client.test.js test/voice/audio-format.test.js test/adapters/wecom.test.js test/gateway/phase1b-auth-drivers.test.js test/tool-naming.test.js
npm run test:types
npm run test:qr-decode
npm test
```

> 2026-11-25 已完成企业微信真实扫码创建连接、文字、图片和语音条测试，文件/视频、群内 @、主动消息和长断网重连仍待补测。
