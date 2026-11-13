# 通用接入端协议（bridge）

> 面向：**不写插件代码**的人。你有一个自己搭的平台、脚本、或者临时想接进来的东西，
> 按这份文档实现收发，它就成了 Aurabot 的一个「平台」。
> 契约依据：[src/gateway/contracts.d.ts](../src/gateway/contracts.d.ts)、[CONTRACTS.md](CONTRACTS.md) 第六～八节。
> 协议版本：`protocol: 1`。实现位置：[src/adapters/bridge/index.js](../src/adapters/bridge/index.js)。

读完这份文档你应该能写出第三个客户端（前两个在 `examples/bridge/`：`echo.mjs` 和 `echo.py`）。
它不假设你懂插件内部结构，也不假设你用哪种语言。

---

## 0. 三十秒版本

```
你（外部程序）                                 Aurabot（bridge 接入端）
    │  POST /platform/<实例>/hello            │   声明：我的机器人账号 + 我支持什么能力
    │ ──────────────────────────────────────► │
    │                                          │
    │  POST /platform/<实例>/inbound           │   有人在我的平台上说了话
    │ ──────────────────────────────────────► │   ── 进中枢，她开始想
    │                                          │
    │  GET  /platform/<实例>/outbound?wait=true│   长轮询：她要回话了，把消息给我
    │ ◄────────────────────────────────────── │
    │  POST /platform/<实例>/ack               │   回执：我真的发出去了 / 我确定没发出去
    │ ──────────────────────────────────────► │
```

四件事：**hello（我是谁、我会什么）→ inbound（我收到的话）→ outbound（她要发的话）→ ack（发没发成功）**。

---

## 1. 接入前：面板里要填什么

在面板的「平台 / 接入端」里加一个实例。配置是个键值，键就是**实例名**（也就是这个平台的名字），
写 `"adapter": "bridge"` 表示这个平台由通用接入端来跑：

```jsonc
"platforms": {
  "mychat": {                      // 实例名 = 平台名，地址里就是 mychat:private:<账号>
    "enabled": true,
    "adapter": "bridge",
    "token": "换成你自己的随机串",   // 必填，见下节
    "timeoutMs": 15000,            // 可选：等回执的时限
    "maxBytes": 4194304            // 可选：单条消息上限
  }
}
```

- **`token` 必填**。没有 token 的实例不工作：接入端状态会停在 `unconfigured`，所有请求一律 401。
- **平台名不能和内置平台重名**（`qq`、`feishu`、`qqbot`、`bridge`…）。重名会被拒绝启动——
  否则你的程序就能冒充那个平台上的人。
- 地址形态是 `mychat:private:<对方账号>`、`mychat:group:<群号>`。账号是**你平台里**的编号，
  不是 `PersonId`（那是插件内部的不透明字符串，不要解析它）。
- 这个平台上的人**默认谁也不是**（不是主人）。要把某个账号认作主人，走和其它平台一样的口令绑定，
  配置里没有「这个账号就是主人」的捷径。

---

## 2. 传输与端点

所有端点都挂在插件的 HTTP 服务上，完整路径是 `/platform/<实例名>/<端点>`。
实例名是 `mychat` 时，`hello` 就是 `POST /platform/mychat/hello`。

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/hello` | 声明的身份与能力（每次（重）连上都发一次） |
| `POST` | `/inbound` | 推一条入站消息（有人说话） |
| `GET` 或 `POST` | `/outbound` | 长轮询取一条待发消息 |
| `POST` | `/ack` | 回执：取走的那条发没发出去 |

**请求**：`content-type: application/json`，body 是 UTF-8 JSON 对象。
**响应**：也是 JSON 对象，恒定带 `protocol: 1`，以及 `ok: true|false`；错误时带 `error`（机器码）和 `message`（人话）。

### 鉴权

**每个**请求都要带：

```
x-bridge-token: <你配置里填的 token>
```

不对、缺了、或者实例没配 token → `401 {"ok":false,"error":"unauthorized"}`，且这条消息**不会**进中枢。
不要用 URL 查询参数传 token（会进日志）。

> token 等于这个接入口的钥匙。拿到它的人可以让「某人说了某话」进入她的记忆。
> 别写进客户端源码，从环境变量读。

---

## 3. `POST /hello` —— 我是谁、我会什么

每次连上（包括重连）都发一次。它决定了网关**往你这里发什么**。

```jsonc
{
  "protocol": 1,
  "self": { "account": "bot-001", "name": "我的自建平台机器人" },
  "caps": {
    "image": true,
    "sticker": false,
    "voice": false,
    "video": false,
    "file": true,
    "maxFileBytes": 10485760,
    "quoteReply": true,
    "mention": true,
    "mentionAll": false,
    "poke": false,
    "typing": false,
    "recall": false,
    "card": false,
    "listenAllInGroup": true,
    "proactive": "free",
    "replyWindowMs": 0,
    "repliesPerMessage": 0,
    "history": false,
    "memberList": false,
    "forwardExpand": false
  }
}
```

响应：

```jsonc
{ "protocol": 1, "ok": true, "instance": "mychat", "caps": { /* 实际生效的 caps */ } }
```

### caps 每一项是什么意思

| 键 | 类型 | 含义 |
|---|---|---|
| `image` | bool | 能发图片 |
| `sticker` | bool | 能发表情包 |
| `voice` | `'native'` \| `'file'` \| `false` | 语音条 / 只能当音频文件 / 发不了 |
| `video` | bool | 能发视频 |
| `file` | bool | 能发文件 |
| `maxFileBytes` | number | 单文件上限（字节），`0` = 不能发文件 |
| `quoteReply` | bool | 支持引用回复 |
| `mention` | bool | 支持 @ 人 |
| `mentionAll` | bool | 支持 @全体 |
| `poke` | bool | 支持戳一戳 |
| `typing` | bool | 支持「正在输入」 |
| `recall` | bool | 支持撤回 |
| `card` | bool | 支持分享卡片 |
| `listenAllInGroup` | bool | **能收到群里没 @ 机器人的消息**。填 `false` 时她在你平台的群里只做「被叫必回」 |
| `proactive` | `'free'` \| `'limited'` \| `'none'` | 不是在回应某条消息时能不能主动发。`none` = 只能被动回复 |
| `replyWindowMs` | number | 被动回复时限（毫秒），`0` = 没有时限 |
| `repliesPerMessage` | number | 一条入站最多回几条，`0` = 不限 |
| `history` | bool | 能拉历史消息 |
| `memberList` | bool | 能列群成员 |
| `forwardExpand` | bool | 能展开合并转发 |

**说真话**：网关按这张表降级。你报了 `voice: false`，她就永远不会往你这里发语音
（宁可少发，也不发出去变成一堆乱码）。不认识的键会被忽略，类型不对的项保持默认值。

**在 `/hello` 之前**，caps 是「全 false + `proactive: 'none'`」——最保守，什么都不发。
所以客户端启动的第一件事就该是 `/hello`。进程重启后也要重发（能力不会被跨重启记住）。

### 常见组合

```jsonc
// 只能被动回复的公众号式平台
"caps": { "proactive": "none", "replyWindowMs": 300000 }
// 一个只会打字的脚本
"caps": { "image": false, "file": false, "mention": true, "proactive": "free" }
// 全功能自建 IM
"caps": { "image": true, "sticker": true, "voice": "file", "video": true, "file": true,
          "maxFileBytes": 20971520, "quoteReply": true, "mention": true, "mentionAll": true,
          "listenAllInGroup": true, "proactive": "free", "typing": true }
```

---

## 4. `POST /inbound` —— 有人在我的平台上说了话

把平台事件翻译成 `AdapterInbound` 的 JSON 形态，推过来。

```jsonc
{
  "protocol": 1,
  "chat":   { "kind": "private", "id": "user-42", "title": "可选：聊天/群名" },
  "sender": { "account": "user-42", "name": "张三", "role": "", "alt": "可选：备用标识" },
  "messageId": "my-plat-msg-9001",
  "at": 1700000000000,
  "mentionedMe": false,
  "replyTo": "可选：被引用的那条的 messageId",
  "parts": [ { "type": "text", "text": "在吗" } ],
  "ext": { "可选": "平台专属附加信息，中枢不读" },
  "raw": { "可选": "平台原始事件，排障用" }
}
```

成功：`200 {"ok":true,"instance":"mychat","messageId":"my-plat-msg-9001"}`

### 必填与校验

| 字段 | 规则 | 不满足时 |
|---|---|---|
| `chat.kind` | `"private"` 或 `"group"` | 400 `bad-inbound` |
| `chat.id` | 非空字符串（群号 / 对方账号） | 400 |
| `sender.account` | 非空字符串 | 400 |
| `messageId` | 非空字符串，**你平台内唯一** | 400 |
| `parts` | 非空数组，每项要有 `type` | 400 |

可选但有意义的：`sender.name`（默认空串）、`sender.role`（`owner`/`admin`/`member`/`""`，
私聊填 `""`；**这只表示平台里的身份，不决定她认不认主人**）、`at`（毫秒时间戳，缺省用当前时间）、
`mentionedMe`（是否 @ 了她）、`replyTo`、`title`、`alt`、`ext`、`raw`。

规则：
- **`messageId` 要稳定**：网关按「实例 + messageId」去重，同一条重复推是安全的（重连后补推也行）。
  但别对不同的消息复用同一个 id，那样后面的会被当成重复丢掉。
- **机器人自己发的消息不要推 `/inbound`**。否则她会在记忆里看见「自己对自己说话」。
  真需要告诉中枢「我发了这条」，协议版本 1 没有对应端点，先别推。
- **`text` 不用你拼给模型看的文字**（不要写「[图片]」这种），你只管给结构化的 `parts`，
  口径统一由网关生成。
- `ext` 只放你的平台专属信息，中枢不会读它。

### `parts`：消息内容

每一项是下面之一（与契约的 `Part` 一一对应）：

```jsonc
{ "type": "text", "text": "你好" }
{ "type": "mention", "account": "user-7", "name": "李四" }   // account:"all" 表示 @全体
{ "type": "image",  "media": { "url": "https://…/a.png", "mime": "image/png" } }
{ "type": "sticker","media": { "url": "https://…/s.png" }, "label": "[啊？]" }
{ "type": "voice",  "media": { "url": "https://…/a.mp3" }, "durationMs": 1200 }
{ "type": "video",  "media": { "url": "https://…/v.mp4" } }
{ "type": "file",   "media": { "url": "https://…/f.pdf", "name": "说明.pdf", "size": 12345 } }
{ "type": "face",   "name": "微笑", "value": "可选" }
{ "type": "card",   "text": "分享了一篇文章", "title": "标题", "url": "https://…" }
{ "type": "forward","id": "合并转发在你的平台里的 id" }
{ "type": "poke" }
{ "type": "other",  "text": "[闪传文件]", "native": { } }     // 认不出的东西用这个占位，别丢
```

`media` 里至少给一个来源：`url` / `path`（本机路径）/ `id`（你平台内的文件标识）/ `bytes`（base64）。
推荐 `url`；`bytes` 只用于小文件（它要过 JSON，很快就撞上 `maxBytes`）。

### 错误码

| 状态 | `error` | 什么时候 |
|---|---|---|
| 400 | `bad-inbound` | 字段缺失/类型不对（`message` 里有人话说明） |
| 400 | `protocol-unsupported` | 带了 `protocol` 但不是 `1` |
| 401 | `unauthorized` | token 不对 |
| 409 | `not-connected` | 接入端还没启用 / 没填 token |
| 413 | `too-large` | 请求体超过 `maxBytes` |

**4xx 时这条消息没有进中枢**。修好再推一次是安全的（不会重复，因为根本没进去）。

---

## 5. `GET /outbound` —— 取她要发的话（长轮询）

这是最容易写错的一段，请慢慢看。

```
GET /platform/mychat/outbound?wait=true&timeoutMs=30000
x-bridge-token: <token>
```

也可以 `POST`，body 是 `{"wait":true,"timeoutMs":30000}`。两者等价，`GET` 更好写。

| 参数 | 含义 |
|---|---|
| `wait` | `true` 时长轮询：没有消息就挂着等；不填立刻返回 |
| `timeoutMs` | 最多挂多久（服务端上限 60000，超了按 60000） |

响应：

```jsonc
// 200：给你一条
{
  "protocol": 1, "ok": true,
  "message": {
    "id": "b-3-1700000000000",        // 回执时用这个
    "chat": { "kind": "private", "id": "user-42" },
    "parts": [ { "type": "text", "text": "我在" } ],
    "replyTo": "可选：你要引用的那条 messageId",
    "inResponseTo": "可选：这条是在回应哪条入站消息",
    "recovered": true                  // 只在「重启前没取走、重启后补给你」时出现
  }
}

// 204：这次没取到（没有消息 / 到点 / 接入端正在停）
{ "protocol": 1, "ok": true, "message": null }
```

`chat` + `parts` 的形状与入站完全一样（同一套 `Part`），所以你发出去的渲染逻辑和收进来的解析可以复用。

### 客户端主循环（伪代码）

```
hello()                                    # 一次
loop forever:
    r = GET /outbound?wait=true&timeoutMs=30000
    if r.status == 204: continue           # 空手而归很正常，接着轮询
    if r.status == 401: 检查 token
    if r.status == 409: 接入端没开（面板里看）
    msg = r.message
    try:
        realId = my_platform.send(msg.chat, msg.parts)      # 真正发出去
        POST /ack { "id": msg.id, "ok": true, "messageId": realId }
    except DefinitelyNotSent as e:                          # 确定没发出去
        POST /ack { "id": msg.id, "ok": false, "error": e.code }
    # 注意：如果是「不确定有没有发出去」（超时、连接中途断），**不要回任何 ack**，
    #      也不要自己重发 —— 让服务端按 unknown 结算。见第 6 节。
```

**一次只能有一个 `/outbound` 在飞**。多个并发会各拿到不同的消息（服务端不拦，但你的发送顺序会乱）。

---

## 6. `POST /ack` —— 回执：到底发出去没有

```jsonc
// 发出去了
{ "protocol": 1, "id": "b-3-1700000000000", "ok": true, "messageId": "my-plat-msg-9002" }

// 确定没发出去（要重试就报这个）
{ "protocol": 1, "id": "b-3-1700000000000", "ok": false, "error": "user-blocked-bot" }
```

响应 `200 {"ok":true,"id":"…"}`；找不到这条在途消息时 `404 {"error":"unknown-id"}`
（说明它已经超时结算成 `unknown` 了——**别因此再发一次**）。

### 失败分类：为什么这一节最重要

这个接入端的出站是**异步**的：她说完话，消息先进队列，等你的程序来取。
所以「到底发出去没有」有**三种**状态，而它们不能混：

| 状态 | 服务端怎么判断 | 结果 | 会不会重发 |
|---|---|---|---|
| 消息还在队列里，没被任何一次 `/outbound` 取走 | 超时到点时它还在 `queue` 里 | `not-sent`（`code: not-taken`） | **会**，可以安全重试 |
| 已被 `/outbound` 取走，但一直没等到 `/ack` | 超时到点时它已在 `inflight` 里 | `unknown`（`code: no-ack`） | **绝不**重发 |
| 你回了 `ack ok:false` | —— | `not-sent`，`code` 用你报的 | **会**，可以安全重试 |

为什么第二行必须是 `unknown`：消息已经在你手里了。你可能已经发出去了，也可能进程刚好死在这一刻。
服务端**无法区分**这两种情况。此时重发一次的风险是「用户收到两条一样的消息」；
不重发的风险是「用户可能漏掉一条」。宁可漏一条，也不能连发两条——所以拿不准就是 `unknown`。

**你该怎么配合**：

- 确定发成功了 → `ok: true`。
- 确定没发出去（被拉黑、目标不存在、你的平台明确拒了）→ `ok: false` + `error`。
- **不确定**（你的 HTTP 请求超时了、连接断了、响应读不懂）→ **什么都不回**。
  让服务端按 `unknown` 结算。不要自己再发一遍，也不要回 `ok: true` 骗它。

### 如果你取走了但没回执

`timeoutMs` 到了，服务端把这条记成 `unknown` 并**不再重试**。之后你补发的 `/ack`
会收到 `404 unknown-id`。这是预期行为，不用重试回执。

---

## 7. 超时与重连

| 情形 | 客户端该做什么 |
|---|---|
| `/outbound` 返回 204 | 接着轮询（建议 0.2~1 秒间隔；用 `wait=true` 时立刻重发请求即可） |
| `/outbound` 返回 409 | 接入端没启用或没配 token，等几秒再试（面板里改完配置会自动重启实例） |
| 网络断了 | 重连。重连后**先发 `/hello`**（能力不跨重启保留），再继续轮询 |
| 收到 `recovered: true` 的消息 | 这是重启前没来得及取走的旧消息，可能已经过时。照常发，或在你的平台里加「（延迟送达）」标记 |
| 请求超时 | **不要**盲目重试 `/inbound`（其实安全，去重兜底）和 `/outbound` 里的「发送」（危险，见第 6 节） |

服务端不会主动连你，所以「在线」这件事完全由你的轮询体现。

---

## 8. 完整 curl 示例

```bash
HOST=http://127.0.0.1:8787     # 换成插件的实际端口
INST=mychat
TOK=paste-your-token-here

# 1) 声明能力
curl -s -X POST "$HOST/platform/$INST/hello" \
  -H "x-bridge-token: $TOK" -H 'content-type: application/json' \
  -d '{"protocol":1,
       "self":{"account":"bot-001","name":"我的自建平台"},
       "caps":{"image":true,"file":true,"maxFileBytes":10485760,
               "mention":true,"quoteReply":true,"listenAllInGroup":true,
               "proactive":"free"}}'

# 2) 推一条入站（有人说话）
curl -s -X POST "$HOST/platform/$INST/inbound" \
  -H "x-bridge-token: $TOK" -H 'content-type: application/json' \
  -d '{"protocol":1,
       "chat":{"kind":"private","id":"user-42"},
       "sender":{"account":"user-42","name":"张三","role":""},
       "messageId":"my-msg-1",
       "at":1700000000000,
       "mentionedMe":false,
       "parts":[{"type":"text","text":"在吗"}]}'

# 3) 长轮询取她的回复（最多等 30 秒）
curl -s "$HOST/platform/$INST/outbound?wait=true&timeoutMs=30000" \
  -H "x-bridge-token: $TOK"

# 4) 回执：说我发出去了
curl -s -X POST "$HOST/platform/$INST/ack" \
  -H "x-bridge-token: $TOK" -H 'content-type: application/json' \
  -d '{"protocol":1,"id":"b-3-1700000000000","ok":true,"messageId":"my-msg-2"}'

# 5) 反例：不带 token
curl -s -i -X POST "$HOST/platform/$INST/inbound" \
  -H 'content-type: application/json' -d '{}'
# → HTTP/1.1 401 ... {"protocol":1,"ok":false,"error":"unauthorized"}
```

---

## 9. 安全须知

1. **token 就是钥匙**。拿到它的人能往她的记忆里塞任意对话。别写死在客户端仓库里，从环境变量读；
   泄露了就换一个（面板里改，实例会自动重启）。
2. **默认只听本机**。接入端口经插件 HTTP 服务暴露，插件自己默认只绑回环。
   要把这个接入端暴露到公网，**必须自己在前面加一层**（反向代理 + TLS + 你自己的认证）。
   本协议没有内置 TLS，也没有重放保护——HTTP 层的 `x-bridge-token` 明文可见。
3. **这个平台上的人默认谁也不是**。要认主人走口令绑定，不要在客户端里伪造 `sender.role: "owner"`——
   那不改变身份判定（`role` 只是平台内的身份标记，主人由身份表决定）。
4. **别把 `parts` 当可信 HTML**。你收到的 `text` 是要发给你平台用户的文字，按你自己的转义规则处理。
5. **入站有大小上限**（`maxBytes`，默认 4MB）。大文件请给 `url`，别塞 base64。

---

## 10. 常见错误对照表

| 你看到的 | 多半是 |
|---|---|
| 所有请求都 401 | token 不一致；或者实例里没填 token（状态会是 `unconfigured`） |
| `/inbound` 一直 409 | 实例没启用、或没填 token。看面板里那个实例的状态 |
| 她从不主动说话 | `/hello` 里 `proactive: "none"`，或没发过 `/hello` |
| 她从不发图片/语音 | caps 里对应项是 `false`，网关降级掉了 |
| `/outbound` 总是 204 | 还没发过 `/hello`（`proactive: none` 时她无法主动发）；或者确实没消息 |
| 收到 404 `unknown-id` | 你回执太晚，那条已按 `unknown` 结算 |
| 消息重复 | 你对不同的消息复用了同一个 `messageId`，被去重逻辑当成同一条；或你在「不确定」时自己重发了 |
| 群里她不理人 | `listenAllInGroup: true` 但你们推的群消息里没设 `mentionedMe`；或中枢那边的群权限没开 |

---

## 11. 客户端自检清单

写完之后逐条对一遍：

- [ ] 每个请求都带 `x-bridge-token`
- [ ] 启动后先 `POST /hello`，重连后也重发
- [ ] `messageId` 稳定且不重复
- [ ] 机器人自己发的消息**不**推 `/inbound`
- [ ] `parts` 给的是结构化内容，没有自己拼「[图片]」这类占位
- [ ] `/outbound` 只有一个循环在跑
- [ ] 204 就继续轮询，不报错
- [ ] 发送成功回 `ok:true`，明确失败回 `ok:false`，**不确定就不回**
- [ ] 处理 409（接入端没开）不崩
- [ ] token 从环境变量读，没写进代码

---

## 附：与契约类型的对应

程序里怎么对应回 `contracts.d.ts`，方便你查类型：

| 协议里的东西 | 契约类型 |
|---|---|
| `/inbound` 的整个 body | `AdapterInbound`（`raw`/`ext` 可选） |
| `parts` 的每一项 | `Part` |
| `/hello` 的 `caps` | `Caps` |
| `/hello` 的 `self` | `whoami()` 的返回 `{ account, name }` |
| `/outbound` 的 `message` | `PlatformAdapter.send()` 的入参去掉 `timeoutMs`/`ext` |
| `/ack` 的 `ok:false` + `error` | `SendError`（`certainty: 'not-sent'`，`code` = `error`） |
| `/outbound` 取走但不回执 | `SendError`（`certainty: 'unknown'`） |
