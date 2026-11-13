# 飞书平台端（feishu）接入说明

`src/adapters/feishu/` 的实现依据。**开工前先读这份，里面标清了哪些是核实过的、哪些不是。**

## 一、文档核对情况（诚实交代）

写这份实现时用 `web_search` / `web_fetch` 查过飞书开放平台官方文档，但**官方文档站是单页应用（SPA），正文抓不到**（`web_fetch` 只返回标题）。所以下面分两栏：

### ✅ 已核实（来自官方文档页面的搜索结果摘要）

| 项 | 结论 | 来源 |
|---|---|---|
| 接收事件两种方式 | **长连接**（官方 Node SDK 提供 WebSocket）与**自建 HTTP 服务（Webhook）** 都支持 | [处理事件](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events?lang=zh-CN) |
| Webhook 的前置要求 | 请求地址必须 **IPv4 + 公网可访问**（http/https 开头）；官方明确说内网穿透工具不稳定 | [常见问题](https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/faq?lang=zh-CN) |
| URL 校验 | 必须在 **1 秒内**把收到的 `challenge` 以 JSON 原样返回 | 同上 |
| 加密策略 | 有 **Encrypt Key**（加密传输）与 **Verification Token**（校验来源）两个参数 | [将事件发送至开发者服务器](https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server?lang=zh-CN) |
| 验签头 | `X-Lark-Signature`，对 **timestamp + nonce + encryptKey + body** 做 HMAC/SHA256 | 多个第三方实现一致（`ongrid`、`OpenFeishu` 等） |
| 加密算法 | AES-256-CBC，`key = sha256(encrypt_key)`，密文 base64 解码后前 16 字节是 IV | 同上 |

### ⚠️ 未逐条核实（按业界通行实现 + 官方 API 常见形态写的，**上线前必须真机验一遍**）

- `im.message.receive_v1` 事件 body 的**完整字段名**（`event.message.content` / `chat_id` / `chat_type` 取值 `p2p`/`group` / `sender.sender_id.open_id` / `union_id`）
- 发消息接口 `POST /open-apis/im/v1/messages?receive_id_type=open_id|chat_id` 的请求体与返回 `data.message_id`
- `tenant_access_token` 接口路径 `/open-apis/auth/v3/tenant_access_token/internal`、有效期 7200 秒
- 图片/文件上传 `/open-apis/im/v1/images`、`/files` 的字段名（`image_type` / `file_type` / `file_name`）
- 机器人自身信息 `/open-apis/bot/v3/info`
- 各种 `msg_type`（`text` / `image` / `file` / `audio` / `media` / `post` / `interactive`）的 content 结构
- **群旁听权限的具体 scope 名称**（推测是 `im:message.group_msg`）

**这些点的验法**：建好应用后，用面板的「平台」页连上，随便发一条消息，看日志里收到的原始事件 JSON，逐字段对一遍即可（`docs/ADAPTER-FEISHU.md` 的这一节就是给你的核对清单）。

## 二、为什么用 Webhook 而不是长连接

官方两种都行。选 Webhook 的理由：

1. 长连接要装 `@larksuiteoapi/node-sdk`（本仓库铁律：能不加依赖就不加，见 README 待定事项第 4 条）。
2. 宿主 `host.js` 本来就有 HTTP 服务，`ctx.route()` 直接能挂——webhook 是零新增设施。
3. 代价：**插件必须有公网可达地址**（或反代）。这一条是硬门槛，写在下面的用户步骤里。

如果以后要改成 WebSocket，只需换 `start()` 里的事件来源，`toParts` / `send` / 验签都不用动。

## 三、用户要做的操作

1. **建应用**：飞书开放平台 → 开发者后台 → 创建企业自建应用。记下 **App ID** 与 **App Secret**。
2. **开权限**（按需，少开不行、多开会被审核）：
   - `im:message`（读写消息，收发的基础）
   - `im:message:send_as_bot`（以机器人身份发消息）
   - `im:resource`（上传/下载图片文件）
   - 想在群里被 @ 就有反应：默认即可（机器人只收 @ 自己的消息）
   - **想让她记住群里的事**：申请「获取群组中所有消息」这类敏感权限。**拿不到就把 `listenAllInGroup` 留 false**，她在群里只做「被 @ 必回」，这是诚实的降级。
   - 想主动私聊：申请主动消息权限（飞书对此有频控）
3. **配事件订阅**：
   - 订阅方式选「**将事件发送至开发者服务器**」
   - 请求地址填 `https://<你的公网域名>/platform/feishu/callback`（宿主会把 `/platform/<实例>/` 前缀拼好）
   - 加密策略里填 **Encrypt Key** 和 **Verification Token**（强烈建议填，否则等于谁都能往你的入站口推消息）
   - 订阅事件：至少 `im.message.receive_v1`
4. **填面板**：Aurabot 面板 →「平台」→ 飞书 → 填 App ID / App Secret / Encrypt Key。
5. **验证**：私聊机器人发一句话。日志里能看到入站事件；她回得出来就算通了。

## 四、能力表（`caps`）的依据

| 字段 | 值 | 依据 |
|---|---|---|
| `voice` | `'file'` | 飞书语音要 opus 且走文件接口；本端只保证「当音频文件发」 |
| `sticker` | `false` | 飞书没有表情包消息类型 → 网关降级成图片 |
| `listenAllInGroup` | `false` | 需申请敏感权限，拿不到就是收不到；按最保守报（约定 §八.1） |
| `proactive` | `'limited'` | 飞书允许主动消息但有频控，平台端自己记账 |
| `replyWindowMs` | `0` | 飞书没有「必须 N 分钟内回复」的硬限制 |
| `repliesPerMessage` | `0` | 没有条数硬限制 |
| `card` | `true` | 交互卡片可用——`【要授权】` 的确认可以做成带按钮的卡片 |
| `quoteReply` | `true` | 支持 reply 到某条消息 |
| `maxFileBytes` | 30MB | 文件接口上限（本端不做分片上传） |

## 五、身份：open_id 与 union_id

- **`open_id` 按应用区分**：换一个飞书应用，同一个人的 `open_id` 就变了。
- **`union_id` 跨应用不变**（同一开发者主体下）。

所以本端：`sender.account` 用 `open_id`（发消息要用它），`sender.alt` 存 `union_id`。
换应用后网关第一次看到新的 `open_id` 时，I1 的「alt 找回」会把新账号挂回原来那个人——
这就是为什么身份表里必须同时存 union_id（见 `docs/CONTRACTS.md` §四与 `包-I1`）。

## 六、已知缺口

1. **媒体必须先上传换 key**：飞书发图/文件要先调上传接口拿 `image_key` / `file_key`。
   本端在 send 里支持三种来源：平台内 `media.id` 直接用；有 `url`/`path`/`bytes` 就自己取字节后上传；
   都没有就抛 `not-sent / media-needs-upload`（让上层补）。**不做分片上传**，超 30MB 直接拒绝。
2. **富文本（`post`）只做单向读取**，出站不发 `post`，一律降级成文本+多条消息。
3. **卡片按钮的回调没做**（`card.action.trigger`）——`【要授权】` 的按钮点了之后怎么处理，
   要等 U1 定面板交互时一起做。
4. **群旁听权限没验过**（见第一节未核实项）。
