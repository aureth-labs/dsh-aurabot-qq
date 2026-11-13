# QQ 官方机器人平台端（qqbot）——文档核对与能力评估

> F3 工作包。核对对象：QQ 开放平台 / QQ 机器人官方文档（q.qq.com、bot.q.qq.com），
> API 版本 v2。核对日期：2026-11-13。
> 实现：[src/adapters/qqbot/index.js](../src/adapters/qqbot/index.js)
> 测试：[test/adapters/qqbot.test.js](../test/adapters/qqbot.test.js)
> 契约：[src/gateway/contracts.d.ts](../src/gateway/contracts.d.ts)、[CONTRACTS.md](CONTRACTS.md) §八.4

**一句话结论**：这是一个很好的「商场柜台」，不是「她住的家」。
它擅长「用户问、机器人答」的一问一答；一旦你希望她像住在 QQ 里的伙伴那样
主动找你、在群里自然插话、发个表情包、引用回复、记住谁是谁——平台的策略与接口
会一层层把这些挡住。下面逐条给出官方依据和差距判断。

---

## 一、核对结论（逐项）

### 1. 事件订阅方式：WebSocket 还是 Webhook？

**两种都支持，官方没有说「主推哪种」，但两者的能力门槛不同。**

| 维度 | WebSocket | Webhook |
|---|---|---|
| 官方文档 | [WebSocket 方式](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html) | [Webhook 方式](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html) |
| 接入点 | 先调 `/gateway` 或 `/gateway/bot` 拿 `wss://` 地址，再 op=2 Identify | 管理端填 HTTPS 回调地址 |
| 端口限制 | 无（主动外连） | **只允许 80 / 443 / 8080 / 8443** |
| 鉴权 | `op:2 Identify`，`token: "QQBot {AccessToken}"`，`intents` 位图 | Webhook 签名（Ed25519）+ 回调地址验证（op=13） |
| 补发 | 支持 `op:6 Resume` + `s` 序号补发遗漏事件 | 靠平台重推 |
| 心跳 | `op:1` / `op:11`，周期由 `op:10 Hello` 下发（示例 45000ms） | 无 |
| 分片 | `shard: [i, n]`，最多受 `session_start_limit.remaining` 限制 | 无 |

**本包的选择**：默认 **Webhook**（用 `ctx.route('/callback')` 挂，验签自己做），
因为宿主已经有 HTTP 服务、Webhook 才有「回调地址验证」这套标准握手；
`transport: 'websocket'` 也支持，但**本包不加 npm 依赖**，没有内置 WebSocket 客户端，
需要宿主通过 `connectEvents` 注入事件源（见 `start()` 的 websocket 分支）。

> 未确认点：官方文档没有「哪种更推荐」的明确表述，也没有说明 Webhook 是否有事件量上限。
> 官方 FAQ 里提到 Webhook 中断优先排查防火墙，说明 Webhook 在部分环境不稳。

### 2. 鉴权：AppID + AppSecret → access_token

来源：[获取访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)

- 接口：`POST https://api.bot.qq.com/app/getAppAccessToken`
  body：`{ "appId": "...", "clientSecret": "..." }`
- 返回：`{ "access_token": "...", "expires_in": "7200" }`
- **有效期默认 7200 秒（2 小时）**；有效期内重复获取返回**同一个** token；
  **在过期前 60 秒内**再获取会拿到新 token，旧 token 在这 60 秒内仍有效。
- 调用其他接口时带 `Authorization: QQBot ACCESS_TOKEN`（注意是大写 `QQBot` + 空格）。
- **坑**：这个接口失败时 **HTTP 仍然是 200**，必须看响应体的 `code`
  （100001 太频繁 / 100007 appid 无效 / 100016 appid 或 secret 错 / 10004 机器人不存在）。
- 旧版 `Token` 鉴权**已废弃**，文档明确写了「请使用更安全的 Access Token 鉴权」。

**实现**：`ensureToken()` 缓存 token 与过期时间；距过期不足 60 秒主动换新；
接口返回 401/403 时强制换一次 token 并**重试一次**；失败按响应体 `code` 报
`SendError('not-sent', 'token-100016')` 这类错误码。测试覆盖「有效期内不重复获取」
「进入 60 秒窗口后换新」「真过期后换新」「401 重试成功」四条。

### 3. 消息发送 API

来源：[发送消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html)、
[消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)

| 场景 | 接口 |
|---|---|
| QQ 单聊 | `POST /v2/users/{openid}/messages` |
| QQ 群聊 | `POST /v2/groups/{group_openid}/messages` |
| 文字子频道 | `POST /channels/{channel_id}/messages` |
| 频道私信 | `POST /dms/{guild_id}/messages` |

请求体关键字段：`content`、`msg_type`（0 文本 / 2 markdown / 3 ark / 4 embed / 7 富媒体）、
`markdown`、`keyboard`、`ark`、`media`、`msg_id`、`event_id`、`msg_seq`、
`message_reference`（**官方标注「暂未支持」**）。
返回：`{ "id": "...", "timestamp": ... }`。

> **2026-08-10 变更**：所有接口域名统一为 `api.bot.qq.com`。本包 `API_BASE` 用它。

### 4. 被动回复：msg_id / event_id、时限、条数 ★

**这是整个平台端最关键的一节。**

**机制**：
- 被动回复要在发消息时带上**前置收到的那条消息的 ID**（`msg_id`），
  或者带**前置事件的 ID**（`event_id`）。
- `event_id` 支持的被动回复事件，单聊：`INTERACTION_CREATE`、`C2C_MSG_RECEIVE`、`FRIEND_ADD`；
  群聊：`INTERACTION_CREATE`、`GROUP_ADD_ROBOT`、`GROUP_MSG_RECEIVE`。
- **`msg_seq`**：与 `msg_id` 联合使用，避免同一消息 ID 重复发送；**相同的 `msg_id` + `msg_seq`
  重复发送会失败**。所以同一条入站消息的第 N 次回复必须递增 `msg_seq`。

**时限与条数（官方两处口径不一致，均已列出）**：

| 场景 | 被动回复有效期 | 每条消息可回复次数 | 来源 |
|---|---|---|---|
| **单聊** | **60 分钟** | **4 次**（概述页）/ **5 次**（send.md） | 概述页 vs send.md |
| **群聊** | **5 分钟** | **5 次** | 概述页与 send.md 一致 |
| 频道 | 5 分钟 | — | — |
| 频道私信 | 5 分钟 | — | — |

> **本包的取值**：`replyWindowMs = 5 分钟`、`repliesPerMessage = 4`。
> 理由：`Caps` 里这两个字段各只有一个值，而单聊/群聊限制不同，**一律取较严的那个**——
> 宁可早一点把超窗回复判成主动消息，也不要发出去被平台拒。
> 这两个常量导出为 `REPLY_WINDOW_MS` / `REPLIES_PER_MESSAGE`，测试用例直接引用，
> 避免 caps 和实现里各写一个数。
>
> **计数口径**：`repliesPerMessage` 按「一次 `send`（= 一次回复）」计，不按平台 API 调用数计。
> 因为一次回复里若含多个富媒体，平台一条消息只能带一个 `media`，会被拆成多条 API 调用，
> 那不是「多回了几条」。这一点在测试里专门有断言。

**实现要点**：
- `message.inResponseTo` **就是** `msg_id`（或 `event_id`，由 `settings.replyAs` 选）。
- 平台端自己维护 `msgSeq`（每条入站消息递增），不依赖网关也不会撞 `msg_id+msg_seq`。
- 超出 `replyWindowMs` 的回复按主动消息处理：`proactive='none'` 直接
  `SendError('not-sent','proactive-not-allowed')`；`limited` 则继续走主动消息额度。
- 条数用尽抛 `SendError('not-sent','proactive-limit')`。

### 5. 主动消息额度 ★★

**最重要的一条：主动推送能力已于 2025 年 4 月 21 日起不再提供。**

> 原文：「"主动推送能力于 2025 年 4 月 21 日起不再提供，接口调用时会收到错误信息。"」
> 来源：[send.md](https://raw.githubusercontent.com/tencent-connect/bot-docs/master/docs/develop/api-v2/server-inter/message/send-receive/send.md)、
> 官方公告 [《关于QQ机器人消息推送策略调整通知》](https://q.qq.com/miniapp#/news/detail/974e66a946a5e54c441ca983585a7aab)、
> 媒体侧报道 [IT之家](https://www.ithome.com/0/846/651.htm)（2025-04-20）。

官方文档同时保留了这些**额度表述**（与实际是否放行是两件事）：

| 场景 | 主动消息额度（文档口径） |
|---|---|
| 单聊 | 每月 **4 条**（给同一用户） |
| 群聊 | 每月 **4 条**（给同一群） |
| 频道子频道 | 默认每子频道每天 20 条，每频道每天最多 2 个子频道 |
| 频道私信 | 每机器人每天对一用户 2 条，每天累计 200 条 |

**频控（概述页「主动消息发送频率限制」）**：

| 认证 | 场景 | Bot 维度 | 单关系维度 | 每日上限 |
|---|---|---|---|---|
| 企业认证 | 单聊 | 10/qps | 20/qpm | 1000 条/用户 |
| 个人认证 | 单聊 | 10/qps | 20/qpm | 1000 条/用户 |
| 未认证 | 单聊 | 5/qps & 30/qpm | 20/qpm | 1000 条/用户 |
| 企业认证 | 群 | 60/qpm | 20/qpm | 1000 条/群 |
| 个人认证 | 群 | 60/qpm | 20/qpm | 1000 条/群 |
| 未认证 | 群 | 30/qpm | 20/qpm | 1000 条/群 |

另外：**用户可在 QQ 客户端关闭「允许主动发送」开关，关闭后主动消息一律发送失败**；
还有 `is_wakeup=true` 的「互动召回消息」，用于用户主动对话后的 30 天内、
按当天 / 1-3 天 / 3-7 天 / 7-30 天四个周期各 1 条。

> **未确认点**：公告说「不再提供」，但文档仍保留额度表，且描述里有频控数字。
> 两者矛盾。**本包不赌「能发」**——把 `proactive` 默认填 `'limited'`，
> `settings` 里建议用户改成 `'none'`，并在平台端自己按 `proactivePerDay`（默认 4）
> 记账、超了抛 `proactive-limit`，不依赖平台报错。

### 6. 群能力：@ 才响应？能否旁听？群管理

| 问题 | 结论 | 依据 |
|---|---|---|
| 默认只能收到 @ 机器人？ | **是**。默认推送 `GROUP_AT_MESSAGE_CREATE`（群里 @ 机器人时） | [群@机器人消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html) |
| 能否旁听（收全部群消息）？ | **能，但要群主手动开**。开了之后推 `GROUP_MESSAGE_CREATE`（全量模式），各字段与 @ 事件一致 | [群消息（全量模式）](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html) |
| 怎么开？ | **群主**用最新版手机 QQ，在群成员列表点机器人 → 设置「接收全量消息」 | [FAQ](https://bot.q.qq.com/wiki/bot_FAQ/) |
| 群内角色 | 事件里 `author.member_role`：`member` / `admin` / `owner` | 事件体 `User` 结构 |
| 群管理能力 | 2026-09-03 起有群成员列表、成员信息、批量移除、黑名单；2026-08-10 起有禁言、入群申请审批、自动审批。**这些是「有接口」，本包未实现** | [变更记录](https://bot.q.qq.com/wiki/develop/api-v2/changelog.html) |
| 撤回成员消息 | 机器人被设为群管理员后可撤回成员消息 | FAQ |

> **全量模式的一个细节**：`GROUP_MESSAGE_CREATE` 的 `content` 里，
> @ 某成员会被替换成 `<@member_openid>`，@全体换成 `<@all>`，被 @ 的列表在 `mentions` 字段。
> 而 `GROUP_AT_MESSAGE_CREATE` 的 `content` **已经去掉了 @机器人 的前缀**。
> 实现里对这个差异做了分别处理（全量模式解析 `<@...>`，@事件直接判定 `mentionedMe=true`）。

**`listenAllInGroup` 的取值**：本包填 **`false`**（最保守）。因为收不收得到全量消息
取决于**群主**在手机端的手动开关，平台端在连上时**无法探测**这件事——
只有等真的收到 `GROUP_MESSAGE_CREATE` 才知道。用户明确要求时可经 `settings`
把它设为 `true`，但那时是用户的责任。

### 7. 身份标识：openid / union_openid，能不能拿到 QQ 号？★

**拿不到 QQ 号，这一点是确定的。**

- 事件里的用户标识是 **OpenID 格式**的字符串（如 `A1B2C3D4E5F6...`），字段有：
  `id`、`user_openid`（单聊场景）、`member_openid`（群聊场景）、
  `union_openid`（跨应用统一，**可能为空**）、`union_user_account`。
- 官方**没有任何**「openid → QQ 号」的接口或字段。
- `union_openid` 还需要**单独申请**：邮件给 `qq_bot_api@tencent.com`，
  且要求「提供的 QQ 互联 APPID 应用主体与机器人是同一注册主体」，
  **不支持**绑定微信小程序申请关联的 QQ 互联应用 APPID。1-3 个工作日回复。
  来源：[FAQ「如何申请开通机器人 Union_openid」](https://bot.q.qq.com/wiki/bot_FAQ/)

**实现**：`openid` 做 `sender.account`（群聊用 `member_openid`，单聊用 `user_openid`），
`union_openid` 存 `sender.alt`；`ext` 里另存 `groupOpenid` / `userOpenid` / `unionOpenid`。
测试断言了「openid 做 account、union_openid 进 alt」这一条。

**对接旧 QQ 数据的影响**：QQ 版仓库里的人是 QQ 号（`im.qq.com` 个人号体系）。
官方机器人平台的 openid **与 QQ 号没有任何可推导关系**，所以
「从 QQ 版导入的人」在 qqbot 平台上**无法自动对应上**——
只能靠主人手动 `identity.link()` 或一次性口令。这是 F3 与 I3/I4 之间的一个真实接缝。

### 8. 富媒体：图片 / 语音 / 视频 / 文件

来源：[富媒体消息概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)

- **必须先上传拿 `file_info`，再用 `msg_type=7` + `media.file_info` 发送。**
- 上传方式两种：
  1. **分片上传（官方推荐）**：`upload_prepare` → 分片 PUT 到预签名 URL →
     每片 `upload_part_finish` → 带 `upload_id` 调上传接口合并 → `file_info`。
  2. **URL 上传**：直接给公网 URL，平台自己去下。
- **单聊和群聊的上传接口不互通**：`/v2/users/{user_openid}/files` vs `/v2/groups/{group_openid}/files`，
  上传的文件不能跨场景使用。
- `file_type`：1 图片（png/jpg/gif/webp/bmp）、2 视频（mp4）、3 语音（silk）、4 文件（任意）。

| file_type | 类型 | 软限制 | 硬限制 |
|---|---|---|---|
| 1 | 图片 | 20 MB | 200 MB |
| 2 | 视频 | 30 MB | 200 MB |
| 3 | 语音 | 20 MB | 200 MB |
| 4 | 文件 | 200 MB | 200 MB |

超过软限制会**降级成文件类型**上传，超过硬限制报错。
`file_info` 有时效性（`ttl`），过期要重传。`srv_send_msg=true` 可「上传即发送」，
但**会占用主动消息频次**。

**实现**：只做了 **URL 上传**（`/v2/users|groups/{openid}/files`，`srv_send_msg: false`），
拿到 `file_info` 后再发 `msg_type=7`。
`path` / `bytes` 形态的媒体**会上抛 `SendError('not-sent','media-url-required')`**，
不做「假装发了」——分片上传（`upload_prepare` 三步）**未实现**，这是本包的已知缺口。

> **未确认点**：
> 1. 群聊 URL 上传接口的请求体字段，官方页面只给了路径，字段推测与单聊一致（`file_type` + `url`）。
>    代码里按一致处理，并在响应里宽容取 `file_info` / `fileInfo` / `file_uuid`。
> 2. 语音条要 silk 格式；本包 `voice: 'file'`，即**只能当音频文件发**，发不出原生语音条。

### 9. 其他核对到的规则

- **发送消息要求机器人连在 WebSocket 上保持在线**（send.md 原文，针对频道场景）。
  Webhook 模式下这条如何适用，官方未明说 —— **未确认点**。
- **消息去重**：相同 `msg_id` 可能多次推送，要结合 `msg_seq` / `message_scene.ext` 里的
  `msg_idx` 去重。
- **撤回**：机器人可撤回**自己发的**消息，**超过 2 分钟不可撤回**。
- **Markdown**：`msg_type=2`，单聊和群聊的自定义 Markdown 已开放给所有机器人，无需单独申请模版。
- **@全体**：2026-10-26 起文本/markdown 支持 `<qqbot-at-everyone />`，
  但**机器人必须是该群管理员，且每个群每天只能发 1 次**。
- **消息里含 URL** 要先在 q.qq.com 后台「开发设置 → 消息URL配置」预先配置，否则发送失败。
- **发消息接口 timeout 建议 ≥ 5 秒**（官方原文，避免「实际已发出但没收到返回」）。

### 10. 回调验签（Ed25519）

来源：[安全和授权](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html)

- 算法：把 **Bot Secret 反复翻倍到 32 字节**当 seed → `ed25519.GenerateKey(seed)` → 公私钥。
- 验签：`X-Signature-Timestamp` + **原始 HTTP Body** 拼起来，用 `X-Signature-Ed25519`
  （64 字节，hex）验证。还要检查 `sig[63] & 224 == 0`。
- 回调地址验证（`op=13`）：请求体 `{ "d": { "plain_token": "...", "event_ts": "..." }, "op": 13 }`，
  回 `{ "plain_token": ..., "signature": hex(Ed25519(event_ts + plain_token)) }`。

**实现**：`deriveEd25519()` 用 `node:crypto` 的 PKCS#8 前缀 + seed 造私钥，**零依赖**。
测试断言了**派生的公钥与官方 DEMO 的 32 字节公钥逐字节一致**
（`[215,195,98,254,...,118,103,58]`），这条是硬证据。

> **未确认点（重要）**：官方文档给的**签名示例**（`sig: 865ad13a...`）与它自己给的
> body / timestamp **不自洽**——用同一套密钥（公钥已逐字节对上）签出来的结果不同，
> 且官方那个 sig 也无法被官方公钥验过。推测文档示例是旧版本残留或空格差异。
> 因此测试**不用它当固定向量**，而是「公钥对齐官方 + 签名/验签自洽 + 篡改必失败」。
> 上线前应拿真实回调抓一次包，用真实 secret 验一遍。

---

## 二、权限与申请流程（用户要做的事）

### 第 1 步：注册与认证

1. 打开 [QQ 开放平台](https://q.qq.com/#/)，用要当管理员的 QQ 登录。
2. **主体认证**：个人认证或企业认证。
   - 个人主体：最多创建 **5 个**机器人；**不支持公开使用**（不能公开被添加进群）。
   - 企业主体：最多 10 个机器人（同主体所有账号合计上限 50 个）；**已开放**公开使用。
   - 参考：[FAQ](https://bot.q.qq.com/wiki/bot_FAQ/)
3. 认证完成后，在「机器人」入口进入管理端，创建机器人。
4. 记下 **AppID** 和 **AppSecret**（开发设置页）。AppSecret 可以重置，
   但要求主体已认证且你是超级管理员。

### 第 2 步：配置事件订阅

**Webhook 路线（本包默认）**：

1. 准备一个**公网 HTTPS** 地址，端口只能是 **80 / 443 / 8080 / 8443**。
   本插件的回调路径是 `/platform/<实例名>/callback`，例如
   `https://your-host/platform/qqbot/callback`。
2. 在管理端「开发设置 → 回调配置」填这个地址，勾选要监听的事件。
   至少勾：**单聊消息**、**群 @ 机器人消息**。（要旁听再加「群全量消息」。）
3. 平台会发一次 **op=13** 的验证请求，本平台端会自动回 `plain_token + signature`。
   **验证不通过说明 Bot Secret 填错了。**
4. 把 **AppID / AppSecret / 回调 Bot Secret** 填进 Aurabot 面板的这个实例配置。
5. **宿主必须保留原始 HTTP body 给平台端验签**。
   Ed25519 验的是**原文**——如果宿主先 `JSON.parse` 再 `JSON.stringify` 回去，
   空格/字段顺序变了就会**必然验签失败**。
   平台端优先读 `req.rawBody`（Buffer 或 string），
   其次读 `req.body`（字符串），最后才对对象做 `JSON.stringify`（这条路径不可靠）。
   **接入时要确保 HTTP 层把原始 body 放到 `req.rawBody`。**

**WebSocket 路线**（可选）：需要宿主注入 `connectEvents`（本包不引 ws 依赖），
并在配置里写 `transport: 'websocket'`。

### 第 3 步：开群能力

- **加群**：个人主体的机器人**不能公开被添加**，只能由创建者加到**自己是群主/管理员**的群里
  （用最新版手机 QQ）。
- **要让她听见群里没 @ 她的话**：**群主**在群成员列表点机器人 → 打开「接收全量消息」。
  打开后配置里把 `listenAllInGroup` 设为 `true`。
- **要让她能主动在群里说话**：同一处「主动推送消息」开关（能否真正生效见 §一.5）。
- **要让她能撤回别人的消息**：把机器人设为群管理员。

### 第 4 步：私聊测试对象

个人主体要在管理端「开发设置 → 开发体验用户」里加上对方的 QQ 号，
否则对方无法私聊机器人。

### 第 5 步：主动消息（可选，风险高）

如果坚持要开主动消息：

1. 先确认平台**当前**是否还放行（2025-04-21 起公告说不再提供，文档却留着额度表）。
2. 配置里把 `proactive` 设为 `limited`，`proactivePerDay` 按实际额度填（保守填 4）。
3. 用户/群主可以在客户端关掉「允许主动发送」，关掉后主动消息**一律失败**——
   这属于 `not-sent`，会被网关转成「没发出去」，不要指望重试。

### 第 6 步：配置示例

```json
{
  "platforms": {
    "qqbot": {
      "enabled": true,
      "appId": "102xxxxxx",
      "clientSecret": "（AppSecret）",
      "botSecret": "（回调验签用的 Bot Secret，通常与 AppSecret 相同）",
      "transport": "webhook",
      "proactive": "none",
      "listenAllInGroup": false,
      "replyAs": "msg_id",
      "timeoutMs": 8000
    }
  }
}
```

> 建议 `proactive: 'none'`。这是本包对这个平台的**推荐姿势**——
> 把「主动消息」这件事彻底交给 QQ 版平台端（个人号）去做，官方机器人只做被动应答。

---

## 三、caps 各字段的取值与依据

| 字段 | 值 | 依据 |
|---|---|---|
| `image` | `true` | 富媒体 `file_type=1`，支持 png/jpg/gif/webp/bmp |
| `sticker` | `false` | 平台没有「表情包消息」类型，让网关降级成图片（§七降级表） |
| `voice` | `'file'` | 语音条需 silk + `file_type=3`；本包只保证按音频文件（`file_type=4`）发 |
| `video` | `true` | `file_type=2`，仅 mp4 |
| `file` | `true` | `file_type=4`，任意格式 |
| `maxFileBytes` | `200*1024*1024` | 富媒体硬限制 200MB |
| `quoteReply` | `false` | `message_reference` 官方标注「暂未支持」 |
| `mention` | `true` | 文本里可写 `<@openid>` |
| `mentionAll` | `false` | `<qqbot-at-everyone />` 需机器人是群管理员且每群每天 1 次 |
| `poke` | `false` | 平台无戳一戳 |
| `typing` | `false` | 平台无「正在输入」 |
| `recall` | `true` | 可撤回自己 2 分钟内的消息 |
| `card` | `false` | 出站 ark 卡片未实现（入站 ark 已转成 `card` Part） |
| `listenAllInGroup` | `false` | 需群主手动开「接收全量消息」，平台端无法探测，按收不到报 |
| `proactive` | `'limited'` | 主动能力已收敛：有额度、有总开关、用户可关；平台端自己记账 |
| `replyWindowMs` | `300000`（5 分钟） | 群聊 5 分钟，单聊 60 分钟；caps 只有一个值，**取严** |
| `repliesPerMessage` | `4` | 单聊 4 次 / 群聊 5 次；**取严** |
| `history` | `false` | 平台无拉历史消息接口 |
| `memberList` | `false` | 官方有群成员列表接口（2026-09-03），本包未实现 |
| `forwardExpand` | `false` | 平台无合并转发消息类型 |

---

## 四、「这个平台和『住在 QQ 里的伙伴』差多远」

她的完整人格依赖的不是「能收发消息」，而是这几件事：
**会在没人叫的时候想起你、能在群里自然插话、有表情有语气有语音、记得谁是谁、被引用时知道在说什么。**
逐条对照这个平台：

| 她需要的能力 | qqbot 官方平台 | 差距 |
|---|---|---|
| **主动找你**（想念、日记、晚安） | 主动推送**已于 2025-04-21 停止**；文档残留「每月 4 条」额度，且用户可一键关闭 | **致命**。这是「伙伴」和「客服」的分界线。没有主动消息，她只能等被叫 |
| **在群里插话** | 默认只收 @ 消息；要旁听得**群主**手动开，且平台端探测不到 | **大**。即使开了，`listenAllInGroup` 也只能事后从事件推断 |
| **长回复 / 多段回复** | 一条入站消息最多回 4-5 次，群聊窗口只有 5 分钟 | **大**。她的长思考、分段回复会被窗口和条数硬切 |
| **语音条** | 要 silk 格式 + `file_type=3` | **中**。只能当音频文件发，发不出「一条语音」的观感 |
| **表情包** | 无表情包消息类型 | **大**。表情包是她性格的重要载体（仓库里有整套 sticker 系统） |
| **引用回复** | `message_reference` **暂未支持** | **大**。对话里「她在回哪一句」的连续性会断 |
| **知道对方是谁** | 只有 openid，**拿不到 QQ 号**；`union_openid` 要邮件申请且限同主体 | **中-大**。跨平台认人靠 `identity.link` 手工做；和 QQ 版的人对不上 |
| **群管理 / 群记忆** | 有群成员/黑名单/禁言接口（本包未实现）；全量消息要看群主 | **中** |
| **富媒体大文件** | 200MB 硬限制，URL 上传要公网可达，分片上传未实现 | **小-中** |
| **稳定长连接** | WebSocket 支持 Resume 补发；Webhook 只需公网 HTTPS + 限定端口 | **小** |

**判断**：

> **这个平台能承载她的「应答」，不能承载她的「存在」。**

具体说三条：

1. **能承载的部分**：一问一答、图文并茂、群内 @ 应答、短期上下文（靠网关的会话与记忆）。
   做「一个很聪明的 QQ 机器人」完全够。作为**对外公开的门面**（企业主体可以公开被添加进群），
   它比个人号方案合规得多——个人号方案（`src/adapters/qq/`，SnowLuma/OneBot）本质上
   是**违规使用个人账号**，有封号风险，而 qqbot 是官方通道。

2. **不能承载的部分**：**主动**。她的人格里有很大一块是「自己会想、会主动开口」
   （`src/features/proactive-policy.js`、日记、心情）。在 qqbot 上这部分**几乎全废**——
   主动推送已停止，剩下的额度还被用户开关掐着。她能做的只有「你叫她，她答」。
   这不是实现问题，是平台策略问题，代码层面无解。

3. **最好的用法是「双平台并存，各干各的」**：
   - `qq`（个人号，OneBot）：**她真正住的地方**。有人在群里说话她听得见、
     想说话了能开口、能发表情包、能引用、认得出每个 QQ 号是谁。风险是合规。
   - `qqbot`（官方机器人）：**公开门面 / 合规出口**。给不认识的人用、给企业群用、
     给需要「官方认证」的场景用。只做被动应答，`proactive: 'none'`。

   两者共用同一套记忆与人格（`src/features/memory*`、`src/persona`），
   跨平台的连续感通过记忆传递（CONTRACTS §五.2：流水行的 `via` 写平台名）。
   但**同一个人在两个平台上会是两个人**（openid ≠ QQ 号），需要主人手动 `link`。

---

## 五、已知缺口（本包未做，后续可补）

1. **WebSocket 事件订阅未内置**：不加依赖的前提下做不了，需宿主注入 `connectEvents`。
2. **富媒体分片上传未实现**：只能用公网 URL；本地文件（`path` / `bytes`）发不出去。
3. **语音条（silk）未实现**：`voice: 'file'`，只有音频文件形态。
4. **群管理接口未接**：成员列表、黑名单、禁言、入群审批（官方已有接口）。
5. **ark / markdown / keyboard 出站未实现**：`card: false`。
6. **入站 ark 卡片解析较简**：只取 `title` / `desc` / `jump_url` / `source`。
7. **`msg_idx` 去重未用**：官方建议结合 `msg_seq` / `msg_idx` 去重，本包只依赖网关的
   `实例 + messageId` 去重（已把 `msg_idx` 放进 `ext`，需要时可加）。
8. **`is_wakeup` 互动召回消息未实现**：属于主动消息范畴，先不做。

## 六、参考链接

- [启动接入](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/getting-started.html)
- [获取访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)
- [通用数据结构 / Intents](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html)
- [Webhook 方式](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html)
- [WebSocket 方式](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)
- [安全和授权（Ed25519 验签）](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html)
- [消息收发概述（时限/条数/频控）](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)
- [发送消息（含主动消息停止公告）](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html)
- [富媒体消息概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)
- [单聊消息事件 C2C_MESSAGE_CREATE](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)
- [群@机器人消息 GROUP_AT_MESSAGE_CREATE](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)
- [群消息（全量模式）GROUP_MESSAGE_CREATE](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)
- [变更记录](https://bot.q.qq.com/wiki/develop/api-v2/changelog.html)
- [QQ Bot 常见问题答疑（含 union_openid 申请、群能力开关）](https://bot.q.qq.com/wiki/bot_FAQ/)
