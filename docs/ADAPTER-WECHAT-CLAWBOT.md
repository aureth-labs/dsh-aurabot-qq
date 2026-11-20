# 个人微信 ClawBot 平台端（`wechat-clawbot`）接入说明

> 实现位置：[src/adapters/wechat-clawbot/index.js](../src/adapters/wechat-clawbot/index.js)
> 公共工具层：[src/adapters/wechat-common/index.js](../src/adapters/wechat-common/index.js)、[src/adapters/wechat-common/qr-svg.js](../src/adapters/wechat-common/qr-svg.js)
> 契约权威：[src/gateway/contracts.d.ts](../src/gateway/contracts.d.ts)、[CONTRACTS.md](CONTRACTS.md) 第六～八节。

---

## 一、定位与命名说明

1. **平台性质**：通过腾讯官方开放的个人微信 ClawBot / iLink Bot HTTP 长轮询协议（`https://ilinkai.weixin.qq.com`）直接接入，不需要额外安装或启动 OpenClaw 网关，也不用配置第三方逆向个人号 hook。
2. **与企业微信严格隔离**：本端只负责个人微信 ClawBot；后续企业微信（`wecom`）将作为独立 adapter 实现，两者不共享 `platform` ID、`chatId` 命名空间、账号身份表、能力表（`caps`）或 API 客户端。
3. **为什么平台 ID 是 `wechat-clawbot`**：仓库冻结契约 `contracts.d.ts` 与 `src/gateway/address.js` 规定平台名正则是 `/^[a-z][a-z0-9-]*$/`（不允许下划线 `_`），因此采用连字符 `wechat-clawbot`。规范聊天地址形态为 `wechat-clawbot:private:<ilink_user_id>`（实验开启群聊时为 `wechat-clawbot:group:<group_id>`）。

---

## 二、协议与扫码流程

### 2.1 面板一键扫码登录

插件在面板「通讯平台」与「首次使用向导」提供本地扫码登录流程，不依赖外置浏览器或第三方二维码服务：

1. 前端调用 `POST /aurabot/api/platforms/wechat-clawbot/qr/start` → 宿主机向 iLink `GET /ilink/bot/get_bot_qrcode?bot_type=3` 申请二维码；
2. 宿主机使用内置零依赖编码器（[qr-svg.js](../src/adapters/wechat-common/qr-svg.js)）在本地把 `qrcode_img_content` 渲染成 SVG Data URI 展示给用户；
3. 前端每 2 秒轮询 `POST /aurabot/api/platforms/wechat-clawbot/qr/status` → 宿主机调用 `GET /ilink/bot/get_qrcode_status?qrcode=...`；
4. 手机微信确认授权（`confirmed`）后，宿主机将 `botToken`、`botId` 与区域 `baseUrl` 写入 `platforms.wechat-clawbot`、注册到日志脱敏表并自动触发 `gateway.sync()` 启动长轮询；`botToken` 不通过任何面板接口回传原文（仅回传 `botTokenSet: true`）。

### 2.2 核心接口与加密约定

| 阶段 | 方法与路径 | 说明 |
|---|---|---|
| 取码 / 轮询扫码 | `GET /ilink/bot/get_bot_qrcode?bot_type=3`<br>`GET /ilink/bot/get_qrcode_status?qrcode=...` | 携带 `iLink-App-ClientVersion: 1`、`X-WECHAT-UIN` |
| 长轮询收消息 | `POST /ilink/bot/getupdates` | 持久化同步游标 `get_updates_buf`，返回 `msgs` 与每条会话 `context_token`；遇 `-14` 立即停轮询并提示重新扫码 |
| 发消息 | `POST /ilink/bot/sendmessage` | 携带 `message_type: 2`、`message_state: 2` 与对应会话的 `context_token` |
| CDN 媒体上传 | `POST /ilink/bot/getuploadurl` → CDN upload | 随机 16 字节密钥 **AES-128-ECB + PKCS#7** 本地加密后上传至 `novac2c.cdn.weixin.qq.com/c2c`，捕获 `x-encrypted-param` |
| CDN 媒体下载 | `GET {cdnBaseUrl}/download?encrypted_query_param=...` | 兼容 32 位 hex 原始串、`base64(16字节)`、以及 `base64(32位hex)` 三种 `aes_key` 编码 |
| 输入状态 | `POST /ilink/bot/getconfig` + `POST /ilink/bot/sendtyping` | 缓存 `typing_ticket`（9 分钟）触发「对方正在输入…」 |

---

## 三、诚实能力边界（能做什么、不能做什么）

在完成 W0 真机账号全部实测前，默认采用严格保守声明（[CAPS_WECHAT_CLAWBOT](../src/adapters/wechat-clawbot/index.js)）：

### 3.1 能做

- ✅ **1:1 私聊文本收发**：支持超长文本自动按段落/换行分条（默认单条上限 2000 字符）。
- ✅ **入站语音识别文本优先，出站优先原生语音条**：入站有 `voice_item.text` 时直接当文本；出站默认尝试把音频转成 **16kHz SILK** 发微信语音气泡（`encode_type:0` / `bits_per_sample:16` / `sample_rate:16000` / `playtime` 秒）。缺少 `silk-wasm` / `mpg123-decoder` 或转码失败时，按真实音频文件发送，不谎报语音条。
- ✅ **图片 / 视频 / 通用文件收发与解密拉取**：入站自动缓存加密媒体描述符，调用 `fetch({ kind: 'media', media })` 即自动下载并 AES 解密（**注意**：媒体描述符 `mediaCache` 仅驻留内存，仅本次进程启动后收到的入站媒体可拉取；进程重启后旧入站媒体不再可拉取）。
- ✅ **入站引用摘要保留**：`ref_msg` 会在正文前附带可读引用摘要 `[引用: ...]`（无需猜测支持主动发送引用格式）。
- ✅ **受限主动消息**：在已保存有效 `context_token` 且未触发个人号频率限制（默认同对象 ≥ 3 秒/次、≤ 20 次/小时）时可主动发送；超过上限直接按 `not-sent / proactive-limit` 如实失败，绝不无限重试。
- ✅ **启动握手、群过滤与安全边界**：
  - `start()` 必须同时具备有效 `botToken` 与真实 `botId`（手动填写时必填，扫码会自动写入），不以 `getconfig` 猜调机器人自身 ID；启动后进入 `connecting` 并发起首轮 `POST /ilink/bot/getupdates` 长轮询，首轮 `getupdates` 成功响应（`200` 且 `ret/errcode === 0`）后才转为 `connected`；若遇 `-14` / `401` / `403` 立即置为 `disconnected` 并拒绝启动；若服务端在短暂等待窗内保持长轮询挂起或网络暂时波动，状态诚实维持 `connecting`（不中止挂起请求，也不伪造 `connected`），直至首轮 `getupdates` 真正成功后再切为 `connected`；
  - 游标 `sync-buf.json` 与会话令牌 `context-tokens.json` 落盘时均带 `botId`；重新扫码换号（`botId` 变化，或旧文件无 `botId`）时启动会丢弃旧游标与旧 `context_token`，首轮 `getupdates` 从空游标开始，避免回复串到旧账号会话；
  - 当开启 `allowGroup=true` 且 `listenAllInGroup=false` 时，严格只放行 `mentioned_me === true` 的群消息；缺失具体成员 `sender` 的群消息直接丢弃，不回退猜成群 ID；
  - 出站/拉取 `media.url` 统一走与平台核心一致的 SSRF 校验（禁止内网/本机 IP、禁用 `file://`、手动跟踪最多 5 跳重定向并逐跳重检）；`media.path` 在平台端默认 fail-closed（未传 `allowedLocalDirs` 时直接拦截本地路径），宿主机注入动态 `allowedLocalDirs`（工作区、`dataDir`、`files.dirs`）并经 `realpath` 解析做目录边界包含校验；`fetch(media)` 不直接读取本地路径。

### 3.2 不能做 / 默认关闭

- ❌ **不做群管（`group-admin` 永不加载）**：ClawBot / iLink 没有可靠的群主/管理员校验与禁言/踢人接口。
- ❌ **默认不开群聊**：`allowGroup` 与 `listenAllInGroup` 默认均为 `false`；个人微信 ClawBot 群聊依赖官方灰度放开，未经真机证实群聊已通时保持仅开放 1:1 私聊。
- ❌ **无原生表情包接口**：`sticker: false`，发出的表情包统一按普通图片降级；`qq_import_stickers` 不会出现在工具面。
- ❌ **原生语音条需要 SILK 编码依赖**：默认开启 `voiceOutbound` 并尝试 SILK；没有 `silk-wasm` / `mpg123-decoder`、或源音频不是 WAV/MP3/SILK 时，按音频文件发送，不谎称语音条。可关闭 `voiceOutbound` 强制只发文件。
- ❌ **不支持拉取聊天历史、群成员列表、合并转发、@、戳一戳、撤回、卡片**：`history` / `memberList` / `forwardExpand` / `quoteReply` / `mention` / `recall` / `card` 均为 `false`。

---

## 四、内置模块兼容矩阵

| 模块 | 状态 | 行为 |
|---|---|---|
| `mood` / `memory` / `purpose` / `autotelic` | ✅ 可用 | 纯平台无关中枢逻辑 |
| `chat-tools` | ✅ 部分开放 | `send_message`、`send_file`、`search_chatlog` 可用；`chat_history` 因 `history:false` 自动隐藏 |
| `stickers` | ✅ 图片降级 | `send_sticker`/`save_sticker` 等通用工具保留（按图片发）；`qq_import_stickers` 绝不出现 |
| `voice` | ✅ 原生/降级 | 入站优先读平台文字转写；出站优先 SILK 语音条，缺依赖/转码失败按文件发送 |
| `imagegen` / `bili` / `song` / `video` | ✅ 可用 | 全走 `sendParts` 与标准媒体降级 |
| `speakup` | ✅ 限频发送 | 遵守 `proactive: 'limited'`（依赖已有 `context_token` 与频控） |
| `group-admin` | ❌ **不加载** | `platforms` 不含 `wechat-clawbot` |
| `qq-tools` / `qq-api` / `profile` / `contacts` / `diary` / `qzone-social` | ❌ **不加载** | QQ 专属模块，完全隔离 |

---

## 五、W0 实测核对清单与风控提醒

1. **账号与风控提醒**：ClawBot 使用个人微信账号接入 iLink 协议，受腾讯官方《微信 ClawBot 功能使用条款》及个人号风控策略约束；请避免高频群发或长时间无人响应下强行高频主动触达，会话返回 `errcode: -14`（授权失效/超时）时会立即断开并在面板提示重新扫码，不会死循环重连。
2. **W0 真实个人微信扫码验收清单**（实测确认一项后再决定是否放开对应配置开关）：
   - [ ] 面板一键生成二维码并手机微信确认登录后状态变为 `connected`
   - [ ] 1:1 私聊文本收发与超长分条
   - [ ] 1:1 图片收发（含 AI 看图解密与生图回发）
   - [ ] 1:1 语音入站转写与 SILK 语音条出站（失败时按文件发送）
   - [ ] 1:1 视频 / 通用文件收发
   - [ ] 会话 `context_token` 重启持久化与过期报错提示
   - [ ] 个人账号灰度群聊测试（若微信端允许拉入群再按需开启 `allowGroup`）
