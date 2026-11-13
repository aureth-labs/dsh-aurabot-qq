# 接一个新平台要做什么（平台端接入指南）

> 初稿：P0 工作包。每做完一个真实平台端，由那个包的负责人按实际经验修订本文。
> 契约权威：[src/gateway/contracts.d.ts](../src/gateway/contracts.d.ts) 与 [CONTRACTS.md](CONTRACTS.md)。
> 契约版本：`contract: 1`。

平台端（`src/adapters/<id>/`）的职责只有一件事：**翻译**。把平台的事件翻译成
`AdapterInbound` 交给网关，把网关给的 parts 翻译成平台调用。它不查身份、不拼
给模型看的文字、不判断「回不回」、不碰白名单、不认识 `PersonId`。

## 六步清单

### 1. 复制模板

把 `src/adapters/_template/` 整个目录复制成 `src/adapters/<你的平台名>/`（平台名：
小写字母开头，只能有小写字母、数字、`-`，如 `feishu`、`qqbot`）。删掉模板里
「模拟平台」那一段（`adapter.platform` 及相关闭包），换成你平台的真实客户端。

### 2. 实现 PlatformAdapter

对照 `contracts.d.ts` 的 `PlatformAdapter`，一个都不能少：

| 成员 | 要做什么 |
|---|---|
| `id` / `name` | 平台名 / 显示名。`id` 就是地址和身份表里的平台名 |
| `contract` | 写死 `1`。契约升级时网关会拒绝旧平台端 |
| `caps()` | 返回完整能力表（见第 3 步） |
| `settings` | 面板表单，写法同模块的 settings（见第 6 步） |
| `start(ctx)` | 连平台 → `ctx.state('connecting')` → 连上 → `ctx.state('connected')`。挂好收消息的通道（WS 推送或 `ctx.route()` 回调），挂 `ctx.route()` 时**验签必须在这一步写好** |
| `stop()` | 断开、撤掉路由等资源，最后 `ctx.state('stopped')`。停了之后绝不能再 `emit` |
| `whoami()` | 返回 `{ account, name }`。网关连上后核对「登录的是不是配置里的那个机器人」，不是就断开这个实例 |
| `send(message)` | parts → 平台调用，返回 `{ messageId }`。失败抛 `SendError`（见下文「错误分类」） |
| `fetch?` / `toParts?` / `native?` | 可选：拉媒体 / 展开合并转发 / 历史消息；把平台原生格式转成 parts；平台独有本事 |

### 3. 填 caps

`caps()` 必须给全所有键（网关直接拿它做降级判断，缺键 = 撒谎）。规则（CONTRACTS 第八节）：

- **说真话**。能力取决于对面的具体网关时（QQ 那种），启动先按**最保守**报，连上探测，
  探测完更新并调 `ctx.capsChanged()` 让网关重读。
- `proactive`：`free` 随便发 / `limited` 平台端自己记账、超了抛 `SendError('not-sent', code:'proactive-limit')` / `none` 只能被动回复。
- `replyWindowMs > 0` 或 `proactive` 不是 `free` 的平台就是「被动回复的平台」，平台端 `send`
  收到不带 `inResponseTo` 的消息也应自己拒绝（网关会先拦一道，这是双保险）。
- 用户可在实例配置里把能力**往弱改**（网关叠 `config.caps`），平台端不用管这件事。

### 4. 入站转 AdapterInbound / 出站 parts → send

**入站**（CONTRACTS 第六节）：平台事件 → `AdapterInbound`，只做翻译：

- `messageId` 用平台内唯一标识，**非空**（网关按 `实例 + messageId` 去重，重连后重复推送是允许的）。
- `at` 用平台给的发送时间，**毫秒**时间戳。
- `chat.kind` / `chat.id` / `sender.account` / `sender.name` / `sender.role`（群身份，私聊空串）/ `mentionedMe` / `parts` / `raw` 都要给。
- 机器人自己发的消息**不走 `emit`**，走 `ctx.emitEvent({ type: 'self-sent', … })`。
- 平台专属附加信息放 `ext`，中枢需要的字段发现缺了要去改约定，不许塞 `ext` 让中枢读。

**出站**（CONTRACTS 第七节）：网关已经按 caps 降级过，`send` 收到的 `parts` 里只会有
你声明支持的类型。你只负责把它们翻译成平台调用；`inResponseTo` 用来取被动回复凭证
（有的平台只许在收到消息后一段时间内、带着那条消息的标识回复）。`replyTo` 平台不支持
就丢掉这个字段，照常发。返回真发的平台 `messageId`。

### 5. 错误分类

见下文「错误分类怎么定」。

### 6. 写 settings

`settings` 是面板表单数组，写法与模块的 settings 相同（参考 `src/modules` 里任一模块）。
平台专属配置（token、appSecret、网关地址……）都声明在这里；网关把实例配置原样从
`ctx.config()` 给你，不要自己另读 config 文件。密码类字段用 `type: 'password'`（不回传面板）。

### 7. 过 runAdapterContract

`test/contract/adapter-kit.js` 是平台端通用测试包，**每个平台端都必须过**：

```js
// test/contract/<你的平台>-kit.test.js
import { test } from 'node:test'
import { runAdapterContract } from './adapter-kit.js'
import adapterModule from '../../src/adapters/<id>/index.js'

const harness = {
  // 形状要求见 adapter-kit.js 文件头；注入点用你平台端的测试后门（如模板的 adapter.platform）
}

test('<平台名> 平台端过全套契约', async () => {
  await runAdapterContract(() => <建一个全新实例>, harness)
})
```

过关项（kit 会逐条断言）：

1. `start` 后状态到 `connected`，`whoami()` 返回账号，`caps()` 键给全。
2. 入站字段齐全：`messageId` 非空、`at` 毫秒、`chat` / `sender` / `mentionedMe` / `parts` / `raw`。
3. `send` 收到 caps 声明支持的 parts 不抛错，返回非空 `messageId`。
4. 连不上抛 `SendError('not-sent')`；超时抛 `SendError('unknown')`。
5. `stop` 后不再 emit，再 `start` 能恢复。
6. `proactive='none'` 时，不带 `inResponseTo` 的发送抛 `not-sent`；带它能发出去。
7. `ctx.route()` 的平台验签不过不 emit；验签通过恰好 emit 一条。
8. （可选）断线重连后状态回 `connected`、send 恢复。

## 错误分类怎么定

`SendError.certainty` 是整个系统防重复发送的根基，只有两个值：

- **`'not-sent'`** —— **确定没发出去**。只有这种可以入补发队列、重试、换方式重发。典型情形：
  - 还没连上平台（`not connected`）、实例被停了；
  - 平台**明确拒绝**（返回了错误码：权限不够、被限流、目标不存在）；
  - 请求在发出前就被你自己的检查拦下（`proactive-not-allowed`、`nothing-to-send`、文件 `too-large`）。
- **`'unknown'`** —— **不知道发没发出去**。一律不重发（重发可能发两条）。典型情形：
  - 超时（按 `message.timeoutMs` 算，到了就抛，别傻等）；
  - 连接**中途**断开（请求发出去了，响应没等到）；
  - 响应读不懂（格式不对、状态码含义不明）。

判定口诀：**「确定没到 → not-sent；有没有到不确定 → unknown；拿不准必须 unknown。」**
宁可让用户重发一遍，也不能让机器人连发两条。

技术细节：网关的 `errors.js`（G1）还没合并之前，SendError 就用普通 `Error` 挂上
`certainty` / `code` / `instance` 三个字段，形状与契约一致（模板和 fake-adapter 都是这么做的）。
抛别的错误（普通 Error、TypeError……）网关一律当 `'unknown'` 处理，所以别指望抛个裸 Error
能进补发队列。

## 「emit 是特权口」

`ctx.emit` 是唯一能让「某人说了某话」进入中枢、进记忆的口子（CONTRACTS 第六节第 6 条）。
正因为它直通记忆，规则最严：

1. **只报真的发生了的对话**。翻译平台事件 → `AdapterInbound`，一个字段都不许编；
   认不出的内容用 `{ type: 'other' }` 占位，不猜。
2. **验签不过绝不 emit**。靠回调地址收事件的平台（`ctx.route()`）必须在 handler 里先验签，
   验不过返回 4xx 直接拒绝——否则任何人都能伪造一条消息写进她的记忆。
3. **停了就不许再发**。`stop()` 之后平台再推消息，直接丢弃；重连后的重复推送可以照发
   （网关按 `实例 + messageId` 去重），但前提是平台端处于运行状态。
4. **机器人自己的话不走 emit**（走 `emitEvent({ type: 'self-sent' })`），否则她会在记忆里
   看见「自己对自己说话」。
5. **不查身份、不拼提示文字**。`text` / `wakeText` 由网关统一生成，平台端拼了就会各平台口径不一。

## 平台端测试工具

- `test/contract/adapter-kit.js` —— 通用契约测试包（上文第 7 步）。
- `test/helpers/fake-adapter.js` —— 内存假平台端：给你的中枢 / 网关 / 模块测试当平台用
  （`makeFakeAdapter(overrides)`，能注入入站、记录出站 `adapter.sent`、按指令抛
  `not-sent` / `unknown`、模拟断线重连、运行中改 caps）。它自己先过了全套契约。
