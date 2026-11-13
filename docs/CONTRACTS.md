# 各部分之间的约定

类型写在 [contracts.d.ts](contracts.d.ts)，那是权威。这份写类型表达不了的规则。两份有出入时以类型文件为准，并马上提出来改掉这份。

每条规则后面写了「谁守」，方便审 PR 的人对照。

## 一、改约定的规矩

1. 约定只在一个地方改：新仓库的 `src/gateway/contracts.d.ts` 和 `docs/CONTRACTS.md`（P0 把这两份放进去）。
2. 改约定单独提 PR，标题以 `contract:` 开头，不夹带实现。所有正在做的包的负责人看过才合。
3. 发现约定不够用时，先停手提出来，不在自己的包里私下加字段或绕过去。绕过去的代码在另一个人那边一定接不上。
4. 约定合并后，受影响的包各自跟进，跟进的 PR 里写明对应哪次约定改动。

## 二、分层：谁能知道什么

| 层 | 能知道 | 不许知道 |
|---|---|---|
| 中枢（`src/chat`、`src/features`、`src/purpose`、`src/persona`） | `InboundMessage`、`PersonId`、`ChatId`、`Caps` | 任何平台名、平台的账号格式、OneBot 消息段 |
| 网关（`src/gateway`） | 所有约定类型、身份表 | 任何一个具体平台的接口、人格、记忆内容 |
| 平台端（`src/adapters/<id>`） | 自己平台的一切、`AdapterContext` | 别的平台、`PersonId`、记忆、会话 |
| 绑平台的模块（清单里写了 `platforms`） | 上面中枢能知道的，加上自己声明的平台的 `native` 和 `ext` | 没声明的平台 |

检查办法（P0 写成测试，之后每个 PR 都跑）：

- `src/chat`、`src/features`、`src/purpose`、`src/persona` 里不出现字符串 `'qq'`、`'feishu'`、`onebot`、`snowluma`、`send_private_msg`、`send_group_msg`。G3 和 I3 合并前这个测试对尚未清理的文件开白名单，白名单只许缩短。
- `src/adapters/<id>` 不 import `src/features`、`src/chat`。
- `src/gateway` 不 import `src/adapters`（平台端是注册进来的，不是引用进来的）。

## 三、地址

1. 全仓库处理地址只用 `normalizeChatId`、`parseChatId`、`sameChat`、`formatChatId`。禁止 `split(':')`，禁止用 `===`、`startsWith('private:')` 比较或判断地址。**谁守：所有包。**
2. 写入一律写规范形态（`qq:private:10001`）。包括 `sessions.json` 的键、流水行的 `chatId`、记忆条目的 `chatId`、预算域的键、静音表、补发队列。**谁守：G3、I2。**
3. 读取一律先规范化。旧数据里的 `private:10001` 不回写、不批量改，读的时候换算。**谁守：G3、I2、I4。**
4. 私聊地址里的编号是对方的平台账号，不是 `PersonId`。要从人得到地址，只能 `gateway.routeTo(person)` 或 `identity.accountOn(person, platform)` 之后 `formatChatId`。**谁守：I2、I3。**
5. `system:*` 是内部后台会话，不经过网关，三个函数对它原样放行或返回 null（见类型注释）。

## 四、人

1. `PersonId` 不透明。除了 `src/gateway/identity.js`，任何地方不许对它用正则、不许 `Number()`、不许比较长度、不许拼进地址。**谁守：所有包；I3 负责清掉存量。**
2. 平台端不接触 `PersonId`。平台端只报账号，网关查表。**谁守：G2、F1。**
3. 身份只按 `Platform` 记，不按 `Instance` 记。同一个平台开两个机器人账号，对面的人还是同一个人。**谁守：I1。**
4. 默认不合并人。只有三种途径能把两个账号并到一个人：主人在面板操作、一次性口令、从 QQ 版导入。不按昵称、头像、相同的号码串自动合并。**谁守：I1、I4、U1。**
5. 主人是一个 `PersonId`。判断主人只用 `identity.isOwner(person)` 或 `InboundMessage.sender.isOwner`。`config.ownerQQ` 只在启动换算时读一次。**谁守：I3。**
6. 隐私隔离按人和聊天，不按平台。群记忆只属于那个群的 `ChatId`。**谁守：I2。**

## 五、会话

1. 一个 `ChatId` 一个 DSH 会话。不同平台的聊天永远不共用会话，哪怕是同一个人。**谁守：G3。**
2. 跨平台的连续感只通过记忆传递：人物档案、短期状态、带 `via` 的流水。流水行的 `via` 写平台名。**谁守：I2。**
3. 平台实例关掉时只撤挂载，`sessions.json` 里的记录保留，重新打开后接着用。**谁守：G3。**

## 六、入站

1. 平台端只做翻译：平台事件 → `AdapterInbound`。不查身份、不拼给模型看的文字、不判断「回不回」、不碰白名单。**谁守：G2、F1。**
2. 给模型看的文字（`text`、`wakeText`）只由网关的 `renderParts()` 生成，所有平台同一套口径：图片写「[图片]」，表情包写它的 `label` 或「[表情包]」，视频「[视频]」，文件「[文件 名字]」，合并转发「[合并转发]」，戳一戳「[戳一戳]」，`@别人` 写「@名字 」。口径以 beta 的 `src/chat/inbound.js` 现在的输出为准。**谁守：G1 写，G2 用回归测试证明 QQ 这条路的输出与 `parseMessageEvent` 逐字段相同。**
3. 去重在网关：键是 `实例 + messageId`，保留最近 2000 条。平台端重连后重复推送是允许的。**谁守：G1。**
4. 机器人自己发的消息不走 `emit`，走 `emitEvent({ type: 'self-sent' })`。**谁守：G2、F1。**
5. `ext` 只放平台专属、中枢用不上的东西。中枢需要的信息必须进正式字段；发现中枢要读 `ext`，说明约定缺字段，去改约定。**谁守：G3。**
6. `emit` 是唯一能让「某人说了某话」进入记忆的口子。`hub.receiveOwnerMessage` 保留给已有模块，内部改成走同一条入站路径。**谁守：G3。**

## 七、出站

顺序固定，各做各的，不重复做：

```
中枢：总开关 / 试运行 / 清洗 / send 钩子 / 模拟测试截获
  → gateway.send：规范化地址 → 查实例 → 按 caps 降级 → 平台端 send → 失败分类 → 入队
    → 平台端：parts → 平台调用
```

1. 中枢和模块只调 `gateway.send`。**谁守：G3、U1。**
2. 降级只在网关，规则只有这一张表。平台端收到的 `parts` 里不会有自己声明不支持的类型；中枢不写平台判断。**谁守：G1。**

| 内容 | 平台不支持时 |
|---|---|
| `voice`，平台是 `'file'` | 当音频文件发 |
| `voice`，平台是 `false` | 丢掉这一条，记进 `degraded`。中枢事先查 `caps` 决定要不要合成语音，所以正常不会走到这里 |
| `sticker` | 当 `image` 发；连图也不支持就丢掉 |
| `image` / `video` / `file` | 丢掉，记进 `degraded` |
| `file` 超过 `maxFileBytes` | 抛 `SendError('not-sent', code: 'too-large')` |
| `mention` | 换成文字「@名字 」 |
| `mention` 且 `account='all'` | 换成文字「@全体成员 」 |
| `replyTo` | 去掉引用，照常发 |
| `poke` | 丢掉，记进 `degraded` |
| `face` | 换成文字「[名字]」 |
| `card` | 换成文字：`text`，有 `url` 就接在后面 |
| 降级后 `parts` 空了 | 不调平台端，抛 `SendError('not-sent', code: 'nothing-to-send')` |
| 主动消息，平台 `proactive='none'` | 不调平台端，抛 `SendError('not-sent', code: 'proactive-not-allowed')`，不入队 |

3. 失败分类（`SendError.certainty`）是防重复发送的根基，定义见类型注释。拿不准就是 `'unknown'`。**谁守：G2、F1；G1 的测试包对每个平台端都验这一条。**
4. 补发队列只收 `'not-sent'`，且只收不含媒体的消息（沿用 `outbox.js` 现在的规则）。有效期按 `SendKind`。实例重新连上时网关自动补发这个实例名下的。**谁守：G1。**
5. 补发成功的消息要回到中枢留痕（流水、`sentIds`），这是 #327 的修法，在网关这一层一次解决。**谁守：G1 提供回调，G3 接上。**

## 八、能力表

1. `caps()` 说真话。能力取决于对面的具体网关时（QQ），连上之后探测，探测完调 `ctx.capsChanged()`。探测前按最保守的报。**谁守：G2。**
2. 中枢想做一件平台可能不支持的事，先查 `gateway.caps(chatId)`，不 try/catch 试错。**谁守：G3。**
3. `listenAllInGroup=false` 的平台，中枢在它的群里只做「被 @ 必回」，不做插话，不把群消息记进群记忆（因为根本收不到）。**谁守：G3。**

4. **被动回复的平台**（`replyWindowMs > 0` 或 `proactive` 不是 `free`）。有的平台只许在收到消息后的一段时间内回复，主动消息有限额或根本不许发。规则：
   - 中枢在一个回合里发的每一条都带 `inResponseTo`（触发这个回合的那条入站消息的 `messageId`）。主动发言不带。**谁守：G3。**
   - 网关在调平台端之前检查：没有 `inResponseTo` 且 `proactive='none'` → 抛 `SendError('not-sent', code:'proactive-not-allowed')`；带了但已超过 `replyWindowMs` → 当主动消息处理，同样按 `proactive` 判断。**谁守：G1。**
   - `repliesPerMessage > 0` 时，网关把同一个 `inResponseTo` 下超出条数的文字合并进最后一条允许的消息里，不丢内容。**谁守：G1。**
   - 这类失败不进补发队列（过了时限补发也没用）。**谁守：G1。**
   - 中枢要主动找人之前查 `gateway.routeTo(person)`，它已经排除了 `proactive='none'` 的平台；`limited` 的平台额度由平台端自己记，超了抛 `'not-sent'`。**谁守：G3。**
5. 靠回调地址收事件的平台用 `ctx.route()` 挂路径。验签在平台端，验不过不 `emit`。**谁守：各平台端。**

## 八之二、可配置

目标是：接一个新平台不改核心，调一个平台的行为不改代码。

1. **平台是配置项。** `config.platforms` 的每个键是一个实例，`enabled` 即开即关，不重启。**谁守：G1。**
2. **同平台多实例从第一版起就支持。** 网关里一切按实例名索引，不按平台名。两个 QQ 号、一个个人号加一个官方机器人，都只是多写几段配置。身份按平台记（见第四节第 3 条）。**谁守：G1、G3。**
3. **能力可以手动关小。** 用户在某个实例上写 `caps`，网关叠在平台端的声明上，只能往弱改。用途：这个号不想发语音、这个群机器人不想被当成能旁听的。**谁守：G1。**
4. **行为按实例可调。** `behavior` 里的开关（插话、主动找人、记不记群、新聊天默认开不开）覆盖全局设置。中枢读设置时一律通过 `settingFor(chatId, key)`：先看这个聊天的单独设置，再看实例的 `behavior`，最后看全局。**谁守：G3 提供这个函数，之后所有读这几项设置的地方都用它。**
5. **平台端的设置自己声明。** 面板表单从 `settings` 生成，网关和面板里没有任何一个平台的专属界面。**谁守：U1。**
6. **路由可调。** 给某个人固定平台；给某类消息（`SendKind`）指定优先用哪个实例。**谁守：G1。**
7. **新平台三条路**，从重到轻：
   - 写一个平台端目录（`src/adapters/<id>/`），实现 `PlatformAdapter`。内置平台都这么做。
   - 平台模块：模块清单声明 `platform` 能力，在 `setup` 里 `gateway.register()`。两个以上内置端跑稳、契约定稿后开放。
   - 不写代码：让外部程序连「通用接入端」（F4），按一份简单的 JSON 协议收发。适合自建平台、脚本、临时接个什么东西。

## 九、平台独有的本事

1. `native(action, params)` 不进规范化层。只有清单里 `platforms` 包含该平台的模块能调，平台没启用时抛错，模块不加载。**谁守：G1 提供，U1 接进模块内核。**
2. 现有模块接口 `api.onebot(action, params)` 保留，等于 `api.native('qq', action, params)`。**谁守：U1。**
3. 清单声明只防写错，不防恶意：模块和核心同进程，还有 `api.lib()`。真正的闸门是市场审核，规则由 U2 写进 CONTRIBUTING。

## 十、文件归属

同一时间一个文件只归一个包改。要动别人名下的文件，找那个包的负责人，由他改或者等他合并。

| 文件或目录 | 归谁 |
|---|---|
| `src/gateway/contracts.d.ts`、`address.js`、`docs/CONTRACTS.md` | P0，之后按第一节的规矩改 |
| `src/gateway/` 其余（`index.js`、`router.js`、`degrade.js`、`render.js`、`outbox.js`、`errors.js`） | G1 |
| `src/gateway/identity.js`、`identity-store.js` | I1 |
| `src/adapters/qq/`（含搬过来的 `onebot/client.js`、`snowluma/`） | G2 |
| `src/adapters/feishu/` | F1 |
| `src/adapters/qqbot/` | F3 |
| `src/adapters/bridge/` | F4 |
| `src/adapters/_template/`、`docs/ADAPTER.md` | P0 出初稿；每做完一个平台端，那个包的负责人按实际经验修订 |
| `src/modules/` 下除 `memory` 以外的内置模块 | U1 第一段。I3 在它合并后才能进来 |
| `src/chat/hub.js`、`src/host.js`、`src/chat/inbound.js` | G3 独占。I3 在 G3 合并后才能进来 |
| `src/features/memory.js`、`memory-store.js`、`src/modules/memory/` | I2 独占 |
| `src/core/backup.js`、新的 `src/features/import-qq.js` | I4 |
| `src/core/modules.js`、`src/modules/aurabot.d.ts`、`API.md`、`client/` | U1 |
| `src/core/config.js` | P0 加 `platforms` 和换算；之后谁加配置项谁改自己那一段，不动别人的 |
| 其余含 `ownerQQ` 的文件 | I3 |
| `test/contract/`、`test/helpers/fake-adapter.js`、`test/replay/` | P0 建，之后各包只加自己的用例文件 |

## 十一、分支与合并

1. 新仓库的集成分支叫 `dev`，所有包合到 `dev`。`main` 在第一个测试版之前不动。测试版从 `beta` 分支发。
2. 一个包一个分支：`pkg/G1-gateway-core` 这样命名。包太大就拆成几个 PR，但都在这个包的文件归属之内。
3. 合并条件：`npm test` 全绿，第二节的分层测试全绿，包的任务书里的过关条件逐条有证据（测试名或截图）。
4. 回放测试（`test/replay/`）在 G3 合并后是硬门槛：之后任何包让回放结果变了，要么是 bug，要么在 PR 里逐条说明为什么该变。

## 十二、全程不变的几条

写在这里是因为每个包都可能不小心碰到。

- 不合并会话。
- 记忆只有一套，平台只是来源标记。
- `'unknown'` 的发送失败不重发。
- 中枢和记忆里没有平台名。
- 没人需要输入编号；编号不被解析。
- QQ 版仓库和它的数据目录，新仓库的代码一个字节都不写，只读。
