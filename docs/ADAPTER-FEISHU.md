# 飞书平台端（feishu）接入说明

`src/adapters/feishu/` 的实现依据。**开工前先读这份**：第一节写清哪些是逐条核对过官方文档的、
哪些还没在真机上验过。

> 契约权威：[src/gateway/contracts.d.ts](../src/gateway/contracts.d.ts)、[CONTRACTS.md](CONTRACTS.md)。
> 核对时间：2026-11-13。核对方式：用浏览器渲染飞书开放平台文档站（它是 SPA，`web_fetch` 只能拿到标题，
> 必须真的把页面渲染出来才能读正文），逐页抄下字段名与限制。

## 一、文档核对结论

### ✅ 已逐条核实（每条都给了官方链接）

| # | 项目 | 结论 | 来源 |
|---|---|---|---|
| 1 | 两种收事件方式 | **长连接（WebSocket）** 与 **Webhook（发到开发者服务器）** 都支持，二选一 | [使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case) |
| 2 | 长连接是什么 | 「长连接是飞书 SDK 内提供的能力，你可以在本地服务器集成飞书 SDK，与开放平台建立一条 WebSocket 全双工通道（你的服务器需要能够访问公网）」 | 同上 |
| 3 | 长连接是否必须用官方 SDK | 官方文档的叙述是「集成飞书 SDK」，四种语言示例都用 SDK 的 WSClient。**协议本身是自己能实现的**（见第 4、5 条），本端就是自己实现的，没有引依赖 | 同上 |
| 4 | 长连接鉴权与加密 | 「长连接方式内置了通信加密和鉴权的逻辑，事件数据网络上传输时为加密传输，对于开发者而言**无需额外解密、验签逻辑**」。**只在建连时鉴权，后续推送是明文** | [步骤三：接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case) |
| 5 | 长连接的限制 | ① 仅支持企业自建应用（商店应用走 Webhook）；② 收到消息后**3 秒内**处理完且不抛异常，否则超时重推；③ 每应用最多 50 个连接；④ **集群模式，不广播**——同一应用多个 client 只有一个随机收到 | [使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case) |
| 6 | 长连接的建连前置 | 「必须确保本地客户端启动正常，有长连接在线的情况下，才能保存成功」（在后台选「使用长连接接收事件」时） | 同上 |
| 7 | Webhook 的前置要求 | 请求地址必须 **IPv4 + 公网可访问**（`http://` 或 `https://` 开头）；官方明确说内网穿透工具不稳定 | [常见问题](https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/faq?lang=zh-CN) |
| 8 | challenge 校验 | 配好请求地址后飞书会推一个 POST，带 `challenge`；应用要在 **1 秒内**把 `challenge` 值**原样返回**，否则报「Challenge code 没有返回」 | [将事件发送至开发者服务器](https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server?lang=zh-CN) |
| 9 | 验签算法 | `X-Lark-Signature = sha256(X-Lark-Request-Timestamp + X-Lark-Request-Nonce + Encrypt Key + 原始 body)` 的十六进制；官方给了 Python/Java/Go/Node/C#/PHP 六种示例，**Node 三行就能写完** | 同上 |
| 10 | 加密算法 | AES-256-CBC；`key = SHA256(Encrypt Key)`；PKCS7Padding；密文是 `base64(iv(16 字节) + encrypted)` | 同上 |
| 11 | 官方解密测试向量 | `key="test key"`、密文 `P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=` → 明文 `hello world`。**本端测试里断言了这条**（`test/adapters/feishu.test.js`） | 同上 |
| 12 | Encrypt Key / Verification Token 的定位 | Encrypt Key 管**加密传输**，Verification Token 管**校验来源**；两者都在「开发者后台 → 开发配置 → 事件与回调 → 加密策略」里配 | 同上 |
| 13 | 接收消息事件类型 | `im.message.receive_v1`（v2.0 结构：`{ schema, header:{event_id,event_type,create_time,token,app_id,tenant_key}, event:{sender,message} }`） | [接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive) |
| 14 | 事件体字段名 | `event.sender.sender_id.{open_id,union_id,user_id}`、`event.sender.sender_type`、`event.message.{message_id,root_id,parent_id,create_time,chat_id,chat_type,message_type,content,mentions}`、`mentions[].{key,id.open_id,name}` | 同上（官方示例 JSON 逐字段抄的，测试里用的是那份样例） |
| 15 | `chat_type` 取值 | `p2p`（单聊）/ `group`（群组）/ `topic_group`（话题群） | 同上 |
| 16 | 去重口径 | 官方：「特殊情况下可能会收到重复的推送，如有幂等需求请使用 **message_id** 去重，**不要依赖 event_id**」 | 同上 |
| 17 | `sender_type` | 用来区分消息发送者是 `user` 还是 `bot` | 同上 |
| 18 | 发送消息接口 | `POST /open-apis/im/v1/messages`，`Authorization: Bearer <tenant_access_token>`，body `{receive_id, msg_type, content}`，`content` 是 **JSON 序列化后的字符串** | [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create) |
| 19 | `receive_id_type` | query 参数，可选 `open_id` / `union_id` / `user_id` / `email` / `chat_id`。官方推荐：**「如果消息接收者为用户，推荐使用用户的 open_id」** | 同上 |
| 20 | open_id vs union_id | open_id「标识一个用户在**某个应用中**的身份。同一个用户在不同应用中的 Open ID 不同」；union_id「标识一个用户在**某个应用开发商**下的身份……同一用户在同一开发商下的应用中的 Union ID 是相同的」 | 同上 |
| 21 | `msg_type` 可选值 | `text` / `post` / `image` / `file` / `audio` / `media` / `sticker` / `interactive` / `share_chat` / `share_user` / `system` | 同上 |
| 22 | 消息体大小限制 | 文本 ≤ **150 KB**；卡片、富文本 ≤ **30 KB** | 同上 |
| 23 | 频控 | 向同一用户发送 5 QPS；向同一群组发送**群内机器人共享** 5 QPS；接口频率 1000 次/分钟、50 次/秒 | 同上 |
| 24 | 媒体必须先上传 | 「图片需要先上传图片，然后使用图片的 Key 发消息。音频、视频、文件需要先上传文件，然后使用文件的 Key 发消息」 | 同上 |
| 25 | 上传图片 | `POST /open-apis/im/v1/images`，multipart，`image_type=message`（发消息）或 `avatar`（头像），字段名 `image`；≤ **10MB**；支持 JPG/JPEG/PNG/WEBP/GIF/BMP/ICO/TIFF/HEIC（TIFF/HEIC 会转 JPG）；GIF ≤2000×2000，其他 ≤12000×12000。返回 `data.image_key` | [上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create) |
| 26 | 上传文件 | `POST /open-apis/im/v1/files`，multipart，字段 `file_type` + `file_name` + `file`（+ 可选 `duration` 毫秒）；≤ **30MB**，不能是空文件。返回 `data.file_key` | [上传文件](https://open.feishu.cn/document/server-docs/im-v1/file/create) |
| 27 | 语音必须是 opus | `file_type` 的 `opus` 项写着「**OPUS 音频文件。其他格式的音频文件，请转为 OPUS 格式后上传**」，官方还给了 ffmpeg 命令：`ffmpeg -i SourceFile.mp3 -acodec libopus -ac 1 -ar 16000 TargetFile.opus` | 同上 |
| 28 | 各 msg_type 的 content 结构 | `text`→`{text}`；`image`→`{image_key}`；`file`→`{file_key}`；`audio`→`{file_key}`；`media`→`{file_key, image_key?}`；`sticker`→`{file_key}`；`interactive`→卡片 JSON；`share_chat`→`{chat_id}`；`share_user`→`{user_id}` | [发送消息内容结构](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json) |
| 29 | text 里的 @ 语法 | `<at user_id="ou_xxx">名字</at>`，`user_id` 填 open_id / union_id / user_id；@所有人用 `user_id="all"`，且群要开启「@所有人」 | 同上 |
| 30 | 卡片 | 有 `interactive` 类型，content 是卡片 JSON（`{config, header, elements}`，元素有 `div`/`markdown`/`action`/`button` 等） | 同上 |
| 31 | 回复消息 | `POST /open-apis/im/v1/messages/:message_id/reply`，body `{content, msg_type, reply_in_thread?, uuid?}`；**就是引用回复** | [回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply) |
| 32 | 群消息权限（三层） | ① 单聊：`im:message.p2p_msg` 或 `im:message.p2p_msg:readonly`；② 群 @ 机器人：`im:message.group_at_msg`（或 `:readonly`、含机器人的 `im:message.group_at_msg.include_bot:readonly`）；③ **群全部消息（旁听全群）**：`im:message.group_msg`，含机器人的是 `im:message.group_msg.include_bot:read`。「如果需要同时接收单聊和群聊消息，需要**分别申请**对应的单聊消息权限和群聊消息权限」 | [接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive) |
| 33 | 群旁听是敏感权限 | 「获取群组中所有消息（**敏感权限**）」——权限表里明确标注 | 同上 |
| 34 | 主动私聊的前提 | 应用机器人可给「**可用范围内**」的用户发单聊；范围外报 `230013`。可用范围在「应用发布 → 版本管理与发布 → 可用范围」配，改完要**发布版本**才生效 | [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create) + [消息常见问题](https://open.feishu.cn/document/server-docs/im-v1/faq) |
| 35 | 单聊按可用范围补充管控 | 2024-12-30 起，单聊里若用户不在可用范围，`im/v1/messages` / `reply` / `patch` / `delete` 等一律返回 **230013** | [平台公告](https://open.feishu.cn/document/platform-notices/breaking-change/app-availability-range-additional-control) |
| 36 | 用户屏蔽机器人 | `230053`「用户已设置不再接收机器人消息，无法主动给用户发送单聊消息」——**这是主动消息的真实限制** | [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create) |
| 37 | 错误码表 | 逐条抄进 `NOT_SENT_CODES`：230001/230002/230006/230013/230015/230017/230018/230019/230020/230022/230025/230027/230028/230029/230034/230035/230038/230049/230053/230054/230055/230099，上传侧 234001/234002/234006/234007/234010/234011/234039 | 同上 + 上传图片/上传文件 |
| 38 | 获取机器人自身信息 | `GET /open-apis/bot/v3/info`，**无权限要求**，返回 `bot.{activate_status, app_name, avatar_url, ip_white_list, open_id}` | [获取机器人信息](https://open.feishu.cn/document/client-docs/bot-v3/obtain-bot-info) |
| 39 | tenant_access_token | `POST /open-apis/auth/v3/tenant_access_token/internal`，body `{app_id, app_secret}`，返回 `{tenant_access_token, expire}`；**有效期 2 小时**；剩余 <30 分钟时调用会发新 token（期间两个都有效） | [自建应用获取 tenant_access_token](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal) |
| 40 | 长连接端点发现 | 官方 Go SDK：`GenEndpointUri = "/callback/ws/endpoint"`，POST body `{AppID, AppSecret}`，返回 `{code,msg,data:{URL, ClientConfig}}`。**不能**直接连 `wss://open.feishu.cn/event/ws`（那不是 WS 端点，会回 HTTP 200 + JSON） | [oapi-sdk-go/ws 文档](https://pkg.go.dev/github.com/larksuite/oapi-sdk-go/v3/ws) |
| 41 | 长连接帧格式 | protobuf `pbbp2.Frame`：`1 SeqID` `2 LogID` `3 service` `4 method` `5 headers(repeated Header{1:key,2:value})` `6 payload_encoding` `7 payload_type` `8 payload(bytes)` `9 LogIDNew` | 同上（`Frame` / `Header` 类型定义） |
| 42 | 长连接帧类型常量 | `MessageTypeEvent="event"` / `MessageTypeCard="card"` / `MessageTypePing="ping"` / `MessageTypePong="pong"`；`FrameTypeControl=0` / `FrameTypeData=1`；错误码 `AuthFailed=514`、`ExceedConnLimit=1000040350` | 同上（`const.go`） |
| 43 | 长连接应答 | 上行响应放在 `Frame.Payload`，结构 `{code, headers, data}`；handler 出错时 Go SDK 回 `code=500`，正常回 `code=200` | 同上（`NewResponseByCode` / `client_message.go`） |

### ⚠️ 仍未确认（诚实交代，**没有任何真实凭证，未真机联调**）

1. **自己实现的 protobuf 编解码没有和真实服务器对过。** 字段号照搬官方 Go SDK 的结构体标签，
   往返测试只能证明「我编的我解得开」，不能证明「飞书服务器认」。这是本方案最大的风险点，
   见下面第四节的选择建议。
2. **长连接应答帧的 `headers` 具体要带哪些 key 没查到。** 本端按 `type=event` 回，
   并带上同 `SeqID/LogID/Service/Method`。若真实服务器要求别的字段，表现会是「事件收到了但平台
   一直重推」——排查时先看这个。
3. **`ClientConfig` 里除 `PingInterval` 外的字段**（如 `ReconnectInterval`、`ReconnectNonce`）
   存在但语义未核实，本端只用了 `PingInterval`（默认 120 秒），重连用自家指数退避。
4. **群身份 `sender.role` 拿不到真实值。** 接收消息事件里**没有**群主/管理员字段，本端群聊一律报
   `'member'`、私聊报 `''`。要做真正的权限判定得另外调群成员接口（本端未实现，`caps.memberList=false`）。
5. **发送者昵称拿不到。** 接收消息事件里没有发送者姓名（只有 `mentions[].name`），本端 `sender.name`
   一律空串，不编造。
6. **`merge_forward` 只拿到占位。** 官方说 content 固定是 `"Merged and Forwarded Message"`，
   子消息要调「获取指定消息的内容」展开；本端没实现（`caps.forwardExpand=false`）。
7. **撤回（recall）没实现。** 官方有 `DELETE /open-apis/im/v1/messages/:message_id`，本次没做，
   所以 `caps.recall=false`。同理 `history` / `memberList` 都是 false——有接口但没实现，就不声明。
8. **长连接在多副本部署下会「只有一个副本收到消息」**（官方原文：集群模式，不广播）。
   如果用户跑多实例，需要自己做转发，本端不管。
9. **`msg_type=audio` 之外的音频时长**：上传文件时 `duration` 是可选的，本端有 `durationMs` 就传，
   没核实「不传会怎样」（官方说「不传值时无法显示文件的具体时长」）。

## 二、为什么默认长连接，以及依赖问题

官方两条路都能走。本端**默认 `transport='websocket'`**，理由：

| | 长连接 | Webhook |
|---|---|---|
| 需要公网地址 | **不需要**（只要本机能出网） | 需要 IPv4 公网地址 |
| 加密/验签 | 内置，只在建连时鉴权，后续明文 | 自己做（Encrypt Key + Verification Token） |
| 是否需要 SDK | 官方推荐用 SDK | 不需要 |
| 多副本 | 只有一个副本收到 | 都能收到（各自验签） |

**依赖结论：本端没有新增任何 npm 依赖，`package.json` 未改动。**

- Node >= 22 自带全局 `WebSocket`，所以连接本身不需要 `ws` 包。
- 官方推荐 `@larksuiteoapi/node-sdk` 的 `WSClient`，能省掉「自己实现 protobuf 帧」这件事。
  **如果允许加依赖，建议加它**，改动点只有 `connectWebsocket()` 一处（换成 `new Lark.WSClient(...)` +
  `EventDispatcher.register('im.message.receive_v1', ...)`），其余翻译/发送/验签代码一行都不用动。
- **不加依赖的备选方案（当前实现）**：`POST /callback/ws/endpoint` 拿 URL → 原生 `WebSocket` 连 →
  自己编解码 `pbbp2.Frame`。风险见第一节第 1、2 条。
- **最稳的零依赖方案**：`transport='webhook'`。这条路完全按官方文档实现，验签/解密的正确性有
  官方测试向量兜底（`hello world` 那条），且不需要自己实现任何私有协议。

## 三、用户要做的操作

1. **建应用**：飞书开放平台 → 开发者后台 → 创建**企业自建应用**（长连接不支持商店应用）。
2. **开启机器人能力**：应用能力 → 添加应用能力 → 机器人。**不开启就没有发消息与收消息能力**
   （未开启会报 `230006` / `234007`）。
3. **拿凭证**：应用详情 → 凭证与基础信息 → 记下 **App ID**（`cli_` 开头）与 **App Secret**。
4. **申请权限**（按需，别多申请，多了要审核）：

   | 权限 | 用来干什么 | 必需？ |
   |---|---|---|
   | `im:message.p2p_msg:readonly`（或 `im:message.p2p_msg`） | 收**单聊**消息 | 要私聊就要 |
   | `im:message.group_at_msg`（或 `:readonly`） | 收群里 **@ 机器人**的消息 | 要群聊就要 |
   | `im:message.group_msg`（**敏感权限**） | 收**群里全部**消息（旁听） | 想让她记住群里的事才要；**拿不到就把 `listenAllInGroup` 留 false** |
   | `im:message`（或 `im:message:send_as_bot`、`im:message:send`） | **发**消息（三选一） | 必需 |
   | `im:resource`（获取与上传图片或文件资源） | 上传图片/文件换 key | 要发图/文件就要 |

   注意：官方原文「如果需要同时接收单聊消息和群聊消息，**需要分别申请**对应的单聊消息权限和群聊消息权限」。
5. **订阅事件**：开发配置 → 事件与回调 → 事件配置：
   - 订阅方式选「**使用长连接接收事件**」（推荐）或「**将事件发送至开发者服务器**」。
   - 选长连接：**先把 Aurabot 跑起来**（有长连接在线才能保存成功）；选 Webhook：请求地址填
     `https://<你的公网域名>/platform/feishu/callback`，并确保地址是 IPv4 公网可达。
   - 添加事件：至少 **`接收消息 im.message.receive_v1`**。
6. **配加密策略**（Webhook 必配，长连接可选）：开发配置 → 事件与回调 → 加密策略 → 填
   **Encrypt Key** 与 **Verification Token**。
7. **配可用范围**：应用发布 → 版本管理与发布 → 创建版本 → **可用范围**里把要对话的人加进去
   （范围外的人发消息会 `230013`，机器人也收不到他们的单聊）。
8. **发布应用**：保存 → 申请发布 → 等审核通过。**权限和可用范围的改动都要发布版本才生效。**
9. **填面板**：Aurabot 面板 →「平台」→ 飞书 → 填 App ID / App Secret（Webhook 还要填
   Encrypt Key / Verification Token），选事件订阅方式。
10. **验证**：私聊机器人发一句话。日志里能看到入站事件、她回得出来，就算通了。
    Webhook 模式保存订阅方式时若报「Challenge code 没有返回」，说明本地服务还没接住 challenge。

## 四、能力表（`caps`）的依据

| 字段 | 值 | 依据 |
|---|---|---|
| `voice` | `'file'` | 语音条必须 `file_type=opus`，其他格式要先转码；本端不转码，只保证「当音频文件发」。**媒体本来就是 opus 时才发成 `msg_type=audio`** |
| `sticker` | `false` | 官方：表情包只能「拿收到的那个 `file_key` 原样重发」，拿不到通用表情包 → 让网关降级成图片 |
| `image` | `true` | `im/v1/images`，≤10MB |
| `video` | `true` | `im/v1/files` + `file_type=mp4` → `msg_type=media` |
| `file` | `true` | `im/v1/files`，≤30MB |
| `maxFileBytes` | 30MB | 官方上传文件硬限制（本端不做分片上传） |
| `quoteReply` | `true` | `/messages/:message_id/reply` 就是引用回复 |
| `mention` / `mentionAll` | `true` / `true` | text 里可写 `<at user_id="ou_x"></at>` / `<at user_id="all"></at>`（群要允许 @所有人） |
| `poke` | `false` | 飞书没有戳一戳 |
| `typing` | `false` | 平台没有 typing |
| `recall` | `false` | 官方有接口，本端未实现，**不声明** |
| `card` | `true` | `msg_type=interactive`，本端发「标题 + markdown + 链接按钮」的最小卡片 |
| `listenAllInGroup` | `false` | 旁听全群要敏感权限 `im:message.group_msg`；默认按收不到报，用户确认批下来后在配置里打开 |
| `proactive` | `'free'` | 飞书**没有**被动回复窗口（不像 QQ 官方机器人有 5 分钟限制），可用范围内可随时发；真实限制是「可用范围」与「用户屏蔽」，由错误分类兜住 |
| `replyWindowMs` | `0` | 没有窗口 |
| `repliesPerMessage` | `0` | 没有「一条消息只能回 N 条」的限制 |
| `history` / `memberList` / `forwardExpand` | `false` | 官方都有对应接口，本端未实现，**不撒谎** |

## 五、身份：open_id 与 union_id

- **`open_id` 按应用区分**：换一个飞书应用，同一个人的 `open_id` 就变了（官方原文）。
- **`union_id` 跨应用不变**（同一开发者主体下，官方原文）。

所以本端：

- `sender.account` = `open_id`（发消息要用它，也是私聊会话 id）
- `sender.alt` = `union_id`

换应用后网关第一次看到新的 `open_id` 时，I1 的「alt 找回」会把新账号挂回原来那个人——
这就是为什么身份表里必须同时存 `union_id`（见 [CONTRACTS.md](CONTRACTS.md) §四与包-I1）。

## 六、已知缺口与设计取舍

1. **媒体必须先上传换 key。** 本端在 `send` 里支持：`media.id` 直接当 key 用（入站拿到的就是它）；
   否则用 `bytes` / `path` / `url` 自己取字节后上传（图片走 `im/v1/images`、其他走 `im/v1/files`）。
   都没有就抛 `not-sent / media-needs-upload`，让上层补。**不做分片上传**，超 30MB 直接 `too-large`。
2. **语音不做转码。** 非 opus 的语音按 `msg_type=file` 发（诚实降级），不假装成语音条。
   要真正的语音条，需要在上游用 ffmpeg 转 opus（官方给的命令见第一节第 27 条）。
3. **富文本（`post`）只做入站读取**，出站一律降级成文本 + 多条消息。
4. **入站媒体没有 URL。** 飞书只给 `file_key` / `image_key`，所以 `media` 上是
   `{ id: '<key>', messageId: '<om_…>' }`，`fetch({kind:'media'})` 用官方
   `GET /im/v1/messages/:message_id/resources/:file_key?type=image|file` 换字节。
   **`messageId` 是必需的**——官方这个接口要用消息 ID 定位资源。
5. **卡片按钮回调没做**（`card.action.trigger`）——`【要授权】` 那类按钮点了之后怎么处理，
   要等 U1 定面板交互时一起做。
6. **一个入站消息可能被拆成多条发出。** 因为一条飞书消息只能带一种 `msg_type`，
   文本 + 图片 + 文件会拆成 2~3 次调用；`send` 返回**最后一条**的 `messageId`。
7. **超长文本会分条**（默认 4000 字符，可配 `maxTextChars`），优先在换行处断开，
   再按 150KB 字节上限兜底。分条后拼起来与原文逐字相同（有测试守着）。
