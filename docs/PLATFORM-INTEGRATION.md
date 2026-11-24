# 通讯平台接入指南与规范

本文是 Aurabot 通讯平台接入的总入口，面向：

- 新增平台适配器的维护者；
- 修改网关、身份、共享会话或多平台行为的贡献者；
- 阅读代码前需要建立系统模型的 AI 编程工具。

平台端实现的详细步骤仍以 [ADAPTER.md](ADAPTER.md) 为准；协议字段以
[src/gateway/contracts.d.ts](../src/gateway/contracts.d.ts) 和
[CONTRACTS.md](CONTRACTS.md) 为准。本文负责说明**为什么这样分层、哪些边界不能越、改动要交什么证据**。

## 1. 先分清四个概念

| 概念 | 例子 | 谁负责 |
|---|---|---|
| Platform | `qq`、`feishu`、`qqbot`、`wechat-clawbot`、`bridge` | 适配器与网关 catalog |
| Instance | `qq`、`qq#2`、`feishu` | 网关实例配置与路由 |
| Account | 机器人自己的账号、主人绑定的账号 | identity + 平台事件 |
| ChatId | `qq:private:10001`、`feishu:group:oc_xxx`、`qq#2:private:10002` | `gateway/address.js` 统一格式 |

规则：

- 平台名小写，只能以小写字母开头，包含小写字母、数字、`-`；
- 同一平台可以有多个实例，实例名用 `#` 区分；
- 地址必须带实例名；没有 `#` 的旧地址由规范化层处理，但新代码不要依赖裸地址；
- 不要用 `qq` 字符串同时表示 platform、instance、account，三者必须分开；
- 新平台不要自己拼 ChatId，统一调用 `formatChatId` / `parseChatId` / `normalizeChatId`。

## 2. 分层与职责

```text
平台 SDK / WebSocket / Webhook
        │
        ▼
src/adapters/<platform>/       翻译平台事件、执行平台发送
        │  AdapterInbound / parts / SendError
        ▼
src/gateway/                    实例管理、路由、能力、去重、降级、补发、迁移
        │
        ├── identity/           平台账号 → 主人/人物
        ├── hub/                会话、模型、工具、共享私聊
        └── modules/            业务能力与工具
```

### 2.1 适配器只做翻译

适配器**不**：

- 查主人身份或白名单；
- 拼给模型看的提示词；
- 决定回不回、回哪一条；
- 读写 `config.json` / `sessions.json`；
- 直接读主人绑定表；
- 决定共享私聊路由。

适配器**只**：

- 把平台事件翻译成 `AdapterInbound`；
- 把网关给它的 parts 翻译成平台调用；
- 返回平台真实 messageId；
- 按 `SendError.certainty` 报告「确定没发」或「不确定发没发」；
- 实现平台能力表和平台独有 fetch/native。

### 2.2 网关负责跨平台规则

网关负责：

- 实例启动、停止、重连、catalog；
- 能力探测与 caps 合并；
- 去重 `实例 + messageId`；
- 出口降级、补发队列、reply window、proactive 限制；
- 迁移租约；
- 给 hub 提供统一 `send/fetch/native/caps/instances`。

### 2.3 Hub 负责会话与业务语义

Hub 负责：

- 当前会话到底是普通私聊、群聊还是共享私聊；
- 哪个平台账号是主人；
- 回复用哪条入站凭据；
- 主动搭话规则；
- 共享分支的 checkpoint 和恢复；
- 工具暴露和权限。

## 3. 新平台准入条件

新增平台前先确认：

- [ ] 有稳定的官方 API / WebSocket / Webhook；
- [ ] 能获得稳定的平台消息 ID；
- [ ] 能区分私聊、群聊、机器人自己发的消息；
- [ ] 能拿到发送者稳定账号与显示名；
- [ ] 能表达文本、图片、语音、文件等至少一种内容；
- [ ] 能明确判断「发失败了」还是「结果未知」；
- [ ] 平台允许机器人主动发送，或能明确声明 `proactive: 'none'`；
- [ ] 不依赖把用户密码写进日志或面板；
- [ ] 有可重复的本地 mock 或测试后门。

不满足这些条件时，不应把它硬塞进 adapter；可以先做只读 bridge，或只做被动回复。

## 4. 接入步骤

完整细节见 [ADAPTER.md](ADAPTER.md)，这里是总流程：

1. 复制 `src/adapters/_template/` 为 `src/adapters/<id>/`；
2. 实现 `id`、`name`、`contract`、`caps()`、`settings`、`start/stop/whoami/send`；
3. 实现可选 `fetch/toParts/native`；
4. 填全能力表，不允许缺键；
5. 接收入站并 `ctx.emit(inbound)`，机器人自己发的走 `ctx.emitEvent({type:'self-sent'})`；
6. 按 `SendError` 规则分类错误；
7. 通过 `test/contract/adapter-kit.js`；
8. 补平台文档、配置示例、测试矩阵；
9. 更新 README 文档表或平台目录。

### 4.1 平台 ID 与文件结构

```text
src/adapters/<id>/
  index.js          适配器主体
  README.md         可选：平台端详细说明
```

平台 ID 一经发布不要改名。改名会影响：

- 配置键；
- identity 平台字段；
- ChatId；
- 历史会话；
- 模块 `platforms` 门控；
- 数据库记录。

如必须迁移，提供旧 ID → 新 ID 的兼容映射和迁移测试。

## 5. 能力表 caps 规范

`caps()` 必须返回完整对象，不能只给部分字段。缺键等于对网关撒谎。

### 5.1 一级能力

| 字段 | 含义 | 规则 |
|---|---|---|
| `image` | 图片 | 不确定就 false |
| `sticker` | 原生表情包 | 不支持就 false，不要假装 |
| `voice` | 语音 | `'native'` / `'file'` / false |
| `video` | 视频 | 不确定就 false |
| `file` | 文件 | 不确定就 false |
| `maxFileBytes` | 文件上限 | 0 表示未知/不限制要有明确语义 |
| `quoteReply` | 引用回复 | 平台是否支持 |
| `mention` / `mentionAll` | @ | 群聊能力 |
| `poke` | 拍一拍 | 仅平台支持时 true |
| `recall` | 撤回 | 不确定就 false |
| `proactive` | 主动发送 | `free` / `limited` / `none` |
| `replyWindowMs` | 被动回复窗口 | 0 表示无窗口概念 |
| `repliesPerMessage` | 单条消息可回复次数 | 0 表示不限 |
| `history` / `memberList` / `forwardExpand` | 扩展读取能力 | 按需 |

### 5.2 L2 features

只声明真实支持项，例如：

```text
message.history.read
message.quote.read
message.reaction
media.fetch
chat.member.read
sticker.collect
sticker.sync.native
```

网关和模块可能按 features 决定挂不挂工具。**不要乐观声明**；不支持时返回 false，不要返回 undefined 让下游猜。

### 5.3 探测与冻结

- 启动时可以先报保守能力；
- 连上平台后探测，探测完调用 `ctx.capsChanged()`；
- 探测不得修改用户资料、发消息、改群；
- 如果平台能力会因权限/账号变化，运行期失败时按 `unsupported` 懒降级；
- 不要把平台 SDK 的「未知」当成「支持」。

### 5.4 配置覆盖

用户可以在实例配置里把能力往弱改（如关闭 `image`）。网关会把 `config.caps` 叠到适配器 caps 上。适配器不要自己读 config 后再改 caps；网关统一处理。

## 6. 入站规范

每个入站消息必须给：

```text
messageId        平台内唯一、非空
at               毫秒时间戳
chat.kind        private | group
chat.id          平台会话 ID
sender.account   稳定账号
sender.name      显示名
sender.role      群身份（私聊空串）
mentionedMe      是否 @ 机器人
parts            内容 parts
raw              平台原始事件（可裁剪，但不能伪造）
```

必须遵守：

- 机器人自己发的消息不能走 `emit`，要走 `self-sent`；
- 平台重复推送允许，网关按 `实例 + messageId` 去重；
- 无法识别的附件用 `other` 占位，不能猜成文本；
- 平台验签失败绝不能 emit；
- `stop()` 后迟到的推送直接丢弃；
- 平台专属字段放 `ext`，不要让 hub 直接解析平台原始格式；
- 不查身份、不拼提示词、不判断白名单。

## 7. 出站规范

`send(message, { replyGuard, proactiveGuard })`：

- `parts` 是网关已经按 caps 降级后的跨平台结构；
- 只翻译自己声明支持的类型；
- `inResponseTo` 是取被动回复凭据的关键；没有它时，`limited`/`none` 平台应拒绝主动发送；
- 平台不支持 `replyTo` 就忽略该字段，不要因此拒发整条消息；
- 必须返回真实平台 `messageId`；
- 不能把「请求已发出、响应没回来」报成 `not-sent`；
- 主动发送受平台频控/额度限制时，要返回可识别的错误码，不能无限重试。

### 7.1 错误分类

```text
not-sent  = 确定没发出去
unknown   = 不知道发没发出去
```

口诀：

```text
确定没到 → not-sent
有没有到不确定 → unknown
拿不准 → unknown
```

只有 `not-sent` 可以重试、换方式、入补发队列。`unknown` 绝不能重试，否则可能发两条。

### 7.2 平台频控

适配器必须自己知道平台频控，并向网关报告：

- 微信 ClawBot 主动发送有最小间隔；
- QQBot 主动消息有日额度；
- 飞书有 230020 频控和 230053 用户屏蔽；
- 其他平台按官方文档。

不要把频控静默吞掉；返回 `proactive-limit` 等明确错误，让上层决定等待、降级或告诉主人。

## 8. 身份与主人

- `identity` 只由网关/宿主维护，适配器不读写；
- 平台账号 → person 的绑定由 `identity.accountsOf/accountOn/lookup` 提供；
- 主人候选只能来自 identity，不允许适配器自己根据昵称或群名片判断；
- 同一个主人可以绑定多个平台账号；
- 修改主人绑定必须走宿主确认流程，不能由普通消息自动完成；
- 适配器日志不能打印 token、secret、完整 Cookie。

## 9. 配置与密钥

平台配置写在 `config.platforms.<instance>`，通过 `ctx.config()` 读取。

规则：

- 密码/token 字段使用 `type: 'password'`；
- 面板只回显 `xxxSet`，不回传 secret；
- 日志和错误消息必须脱敏；
- 平台端不能自己读写 config 文件；
- 不能把 secret 放进 ChatId、URL、工具返回或 prompt；
- 新增配置要有默认值、归一化、保存/回显测试。

### 9.1 平台认证驱动与 Host Auth API

扫码、Device Code 等交互式登录必须接入统一认证会话管理器（[src/gateway/auth.js](../src/gateway/auth.js)）与本地 QR 编码器（[src/core/qr.js](../src/core/qr.js)，ISO Version 1–16，上限 450 UTF-8 字节），不要按平台各自重写扫码接口或面板轮询器。

- **Host API**：统一使用 `POST /platforms/auth/start`、`POST /platforms/auth/poll`、`POST /platforms/auth/cancel`（当前旧 `/platforms/wechat-clawbot/qr/*` 仅为兼容包装）；`/platforms` 响应通过 `authMethods` 列出可用认证方法；
- **状态机与唯一会话**：同一 `instance + method` 仅允许一个活跃会话，重新 `start` 会中止旧会话 `AbortSignal` 并阻止迟到 `poll` 落盘；并发 `poll` 去重；尊重 `slow_down` 退避与 `domain_switched`；
- **严格隔离**：`AuthSessionView` 绝不回传 `secret`、`deviceCode`、`qrcode` 或 `driverSession` 原文；终态隐藏二维码、`verificationUrl` 与 `userCode`；`configPatch` 禁止夹带敏感键或临时字段，所有秘钥必须走 `secretPatch` 且键在 `PLATFORM_SECRET_KEYS` 内；
- **连接与身份门控**：凭据写入并触发 `gateway.sync()` 后，宿主 `verifyInstance` 必须等待实例到达 `connected` 且完成 `whoami`（`self.account` 非空且与预期一致），未连通、超时或不符一律停用实例并报错（`auth.verify`），同时绝不自动认主或触碰共享会话；
- **独立解码基准与 Phase 0 现状**：二维码编码可通过 `npm run test:qr-decode` 经第三方 `jsqr` 对 V1–V16 矩阵与 SVG Data URI 独立还原原文；当前实际接入的平台驱动为 `wechat-clawbot`（`qr-link`），其余平台驱动（飞书 / QQBot / 钉钉 / 企业微信）与 `oauth-callback` / `manual` 会在后续 Phase 分批补齐。

## 10. 共享私聊会话

共享私聊是 hub 的能力，不是 adapter 的能力。

当前规则：

- 需要网关管理的主账号；
- 旧直连 QQ 是普通会话，不参与共享；
- 所有平台共享同一个 DSH 会话；
- 一条入站消息的回复使用该消息所在平台的回复凭据；
- 主动搭话必须发到固定的主账号平台，不能回退到「最近平台」；
- 跨平台另发消息必须显式指定目标，且只允许主人已绑定账号；
- 适配器不能替 hub 决定共享路由。

新增平台若要参与共享私聊，至少要保证：

- 平台能稳定收发私聊；
- 主人账号可绑定；
- 平台有可识别的连接实例；
- 主动发送能力有明确 caps；
- 回复凭据语义清晰；
- 有真实 host-compat 测试。

### 10.1 send_to_platform 类工具

跨平台发送工具必须：

- 只对主人私聊/共享主人轮次暴露；
- 只发主人自己已绑定账号；
- 不允许任意好友、群号、文件路径；
- 目标平台/实例必须在线且允许主动发送；
- 不改变当前共享回复和 checkpoint；
- 发送失败不能报成功；
- 部分成功返回 `partial` 和真实计数；
- 目标平台不支持原生表情时优先按图片降级，连图片也不支持才失败；
- 目标平台有频控时按平台能力等待，不能盲目重试；
- 图片本地路径必须是真实路径，不能把 `%E6...` URL 编码直接交给平台 SDK。

## 11. 模块与工具命名

模块声明：

```js
platforms: ['*']          // 平台无关
platforms: ['qq', 'feishu'] // 特定平台
```

规则：

- 跨平台模块的工具用：

```text
<verb>_<noun>
<module>_<verb>_<noun>
```

- 平台专属工具才使用：

```text
<platform>_<verb>_<noun>
```

- 不允许把 `qq_` 前缀伪装成通用工具；
- 改工具名必须提供 `toolAliases`；
- 工具挂载必须按平台/capabilities/features 过滤；
- 新增平台后要跑 `test/tool-naming.test.js`，确认没有旧平台前缀泄露。

## 12. 迁移、停止和资源

参与 QQ 网关迁移的适配器必须实现：

- `stopAndWait({ timeoutMs, signal })`
- `confirmStopped()`

要求：

- `stopAndWait` 只有在确认旧连接关闭后才成功；
- 超时/中止要报告失败；
- `confirmStopped()` 在旧连接确实关闭且不能重连后才返回 true；
- 迟到事件不能在接任实例上 emit；
- 停止后绝不能再发送。

## 13. 测试矩阵

新增或修改平台必须交：

```text
test/contract/<platform>-kit.test.js
  适配器全套契约
test/adapters/<platform>.test.js
  平台特有协议、错误、媒体、路由
test/tool-naming.test.js
  多平台工具命名/可见性
npm test
test:types
npm run test:host-compat -- <DSH 源码目录>
```

至少覆盖：

- start/stop/重连；
- whoami 不符；
- 入站字段完整；
- 验签失败；
- 去重；
- caps 全键；
- `proactive: none/limited`；
- 图片/语音/表情/文件降级；
- `not-sent` vs `unknown`；
- 共享会话/跨平台发送（如涉及）；
- 多平台共存时无旧前缀、无串台。

## 14. 文档交付

每个新平台至少补：

- `docs/ADAPTER-<PLATFORM>.md` 或在 `ADAPTER.md` 增加章节；
- 平台配置字段说明；
- 能力表；
- 已知限制；
- 平台错误码表；
- 生命周期/重连/停止说明；
- 安全注意事项；
- 测试命令和结果；
- 用户手册中的配置入口。

## 15. AI 编程工具工作规范

给 AI/自动化工具的硬性要求：

1. **先读** `contracts.d.ts`、`CONTRACTS.md`、`ADAPTER.md`、对应平台文档；
2. 不要跨层修：适配器问题不要用 hub hack 解决，hub 问题不要改平台 SDK；
3. 不要绕过 `SendError.certainty`；
4. 不要在适配器里读身份、白名单、config 文件或拼提示词；
5. 不要在日志/错误/工具结果里暴露 secret；
6. 不要新增平台专属前缀到跨平台模块；
7. 新增字段先确认宿主契约和兼容性；
8. 改动必须带测试，不能只改源码；
9. 全量测试失败时不能声称“全绿”，要说明失败文件和原因；
10. host-compat 未运行时必须明确写“未运行”，不能把专项测试当成宿主测试。

### 15.1 提交前自检

- [ ] 没有跨层 hack；
- [ ] 没有伪造平台事件；
- [ ] 没有用 `unknown` 当 `not-sent`；
- [ ] 没有在日志中泄露 secret；
- [ ] 平台/caps/features 缺失时有安全降级；
- [ ] 共享会话回复凭据没有被跨平台复用；
- [ ] 平台专属工具名没有污染通用工具面；
- [ ] 单测、类型、全量、host-compat 的结果都已记录。

## 16. 常见坑

- **把 platform 当 instance**：`qq` 既是平台名又是默认实例名时最容易出错。
- **喜欢猜能力**：缺 caps 键会绕过网关降级，造成虚假成功。
- **把超时当失败**：超时通常是 `unknown`，重试会发两条。
- **在适配器里查主人**：身份判断必须集中在 identity/hub。
- **用 `%E6...` 文件 URL 直接读盘**：`file://` 必须解码成真实路径。
- **把平台原生消息格式直接塞进 prompt**：先转 parts，再交给网关/hub。
- **共享回复使用最近平台**：共享主动消息必须固定主账号，普通回复使用本条入站凭据。
- **表情不支持就直接失败**：只要目标平台支持图片，优先走网关的 sticker→image 降级。
- **频控后无限重试**：只对确定未发送且平台允许的情况等待一次，不能循环。
- **改了工具名不保留 alias**：旧脚本和旧会话会坏。

## 17. 相关文档

- [ADAPTER.md](ADAPTER.md)：平台端六步接入清单
- [CONTRACTS.md](CONTRACTS.md)：网关与平台端契约
- [BRIDGE-PROTOCOL.md](BRIDGE-PROTOCOL.md)：通用 bridge 协议
- [ADAPTER-FEISHU.md](ADAPTER-FEISHU.md)
- [ADAPTER-QQBOT.md](ADAPTER-QQBOT.md)
- [ADAPTER-WECHAT-CLAWBOT.md](ADAPTER-WECHAT-CLAWBOT.md)
- [网关契约类型](../src/gateway/contracts.d.ts)
- [模块 API](../src/modules/API.md)
- [用户手册](USER-MANUAL.md)
