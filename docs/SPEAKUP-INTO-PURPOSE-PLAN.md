# 主动搭话并入目的引擎方案（speakup → purpose 归并 + 退场）

> **日期：2026-11-16**
> **状态：已拍板 · 待排期。** 四个开放问题已由用户 2026-11-16 拍板（结论见 §9 各小节）：
> Q1 purpose **新装也默认开启**；Q2 小闹钟**迁进 purpose**（独立中 PR 批次 P2b）；Q3/Q4 作息与白名单键
> **保键冻结 + 语义归属注记**（键留在 `speakUp.*` 命名空间，由 purpose 维护，评估过程见 §9-Q3）。
> **实施时机：本方案先搁置**，等「管理功能卡片化」收尾与上游 review 完成后再排期。
> **性质：设计稿 · 未实施。** 本文只做设计，不改任何源码/测试/面板。
> 用户决策：不再保留「主动搭话」（speakup）作为独立功能，只保留「目的引擎」（purpose）；
> 本方案给出能力归并、配置迁移、UI 归并、模块退场、数据处理的完整路径。
> 侦察基线：主检出 `repo/`（v1.2.0 线，speakup/purpose 均在主仓 `src/modules/`，**不在模块库 mods-fork**，已核实）。

---

## 1. 现状盘点

### 1.1 speakup（主动搭话）

| 维度 | 现状 |
| --- | --- |
| 模块注册 | `repo/src/modules/index.js` L12/L21，`BUILTINS` 内置，id `speakup`，`tab: 'speakup'` |
| 实现 | `src/features/companion.js`（`createSpeakUp`），模块壳 `src/modules/speakup/index.js`（76 行薄壳） |
| 驱动 | `api.every(60_000, speakUp.tick)`，主人一阵子没理 → 私聊主动说一句（随机由头现想，非模板） |
| 工具 | `qq_set_reminder` / `qq_close_reminder`（主人私聊常驻，受 `speakUp.reminderEnabled` 门控） |
| 路由 | `/speakup/fire`（手动触发）、`/speakup/reminder/close`（面板关闹钟） |
| 数据落盘 | `modules-data/speakup/speakup.json`（当日 count/nextAt/nudge 去重）、`speakup-reminders.json`（小闹钟） |
| 配置键 | `config.speakUp.*`（`src/core/config.js` L306-319 + 归一化 L697-706）：`enabled`、`idleMinutes`、`min/maxIntervalMinutes`、`maxPerDay`、`allow[]`（白名单）、`nudge`（追问）、`reminderEnabled/Limit/Retry`、`awakeFrom/awakeTo`（醒着窗口） |

### 1.2 purpose（目的引擎）

| 维度 | 现状 |
| --- | --- |
| 模块注册 | 同文件 L13/L21，`BUILTINS` 内置，id `purpose`，`tab: 'speakup'`（**与 speakup 共用同一面板页**），默认关（`ext.purpose.enabled=false`） |
| 实现 | 引擎纯函数 `src/purpose/engine.js` + 接线 `src/purpose/module.js`（`createPurpose`）+ 壳 `src/modules/purpose/index.js` |
| 驱动 | 同样 60s tick；素材（记忆+聊天流水+人格+浏览模块素材口）→ 目标假设 → 选目的 → 生成 → 投递 |
| 路由 | `/purpose/fire|status|preview`；宿主另有 `/panel/purpose/*` 聚合代理（status/preview/run/config） |
| 数据落盘 | `purpose/purpose-state.json`、`purpose/friends/<qq>.json`、`purpose/nudge.json` |
| 配置键 | `config.ext.purpose.*`：`enabled`、`minMaterials`、`initialDelayMinutes`、`maxCandidates`、`promptMaxChars`、`carrier`、`petFallbackToQQ`、`pacing`、`scoringModel` + 一批调参；**排程类参数目前回退读 speakUp**（见 1.3） |

### 1.3 两者已有的依赖关系（关键事实：purpose 已经在吃 speakup 的配置）

`src/purpose/module.js` 的 `purposeConfig()`（L52-82）：

- **醒着窗口唯一真相 = `speakUp.awakeFrom/awakeTo`**，引擎安静时段由它派生；`ext.purpose.awakeFrom/awakeTo` 可覆写（面板 `/panel/purpose/config` 目前把醒着窗口**写回 speakUp.\***，见 `test/panel-purpose.test.js` L98「保持单一真相」注释）。
- `ext.purpose.minIntervalMinutes ?? speakUp.minIntervalMinutes`（gap）、`maxPerDay ?? speakUp.maxPerDay`（dailyMax）、`idleMinutes ?? speakUp.idleMinutes`（idleThreshold）——**覆写位优先、speakUp 兜底**的双层结构已在。
- **追问（nudge）已复刻**：`maybeNudge()`（module.js L719-748）读 `speakUp.nudge` 开关 + 15~40 分钟窗口 + 提问句判定，去重标记落 `purpose/nudge.json`，不占今日次数。
- **白名单朋友线已复用**：`tick()` 里遍历 `cfg.speakUp.allow`，每人独立状态文件（`purpose/friends/<qq>.json`）。
- **次数迁移已做**：`loadState()` L117-121 对旧 `speakup.json` **只读迁移当日 count**，之后弃用该文件。

即：purpose 对 speakup 的**运行时依赖只剩配置键与白名单**，行为能力（时机/频率/追问/白名单/迁移）已经全部在 purpose 里了。归并的主要工作在**配置真相翻转、UI、策略源装配与模块退场**。

### 1.4 出站治理（outbound-policy）双策略源

- `src/chat/outbound-policy.js`：`ACTIVE_MODES = ['purpose','speakup','auto']`；auto 优先 purpose、其次 speakup；speakup 策略源 `createSpeakupPolicy`（proactive-policy.js L839+，落盘 `speakup-policy.json`，结算「一律不退款」）。
- `src/host.js` `wirePolicySources`（L1090-1145）：`cfg.speakUp?.enabled !== false && use('speakup')` 才注册 speakup 策略源；面板可写 `activePolicy: 'auto'|'purpose'|'speakup'`（L1730-1767）。
- 概览页 `outboundView()` 用 `use('speakup')?.state?.()` 取今日次数（L1484）；安静时段真相同样从 `cfg.speakUp` 派生（L1512-1516）。

### 1.5 speakUp.\* 的「全局作息」外溢（退场的最大牵连面）

`speakUp.awakeFrom/awakeTo` 不只服务主动搭话，还是全插件自动任务的醒着窗口：

| 消费方 | 位置 |
| --- | --- |
| 空间说说 | `repo/src/features/qzone-social.js` L204 |
| B 站 | `repo/src/bili/duty.js` L484 |
| 模块库 douyin | `mods-fork/modules/douyin/lib/duty.mjs` L724（及其测试多处） |
| 模块库 heybox | `mods-fork/modules/heybox/lib/site.mjs`（`speakUpWindow()`） |
| 模块库 xhs | `mods-fork/modules/xhs/lib/duty.mjs` L949（已做 `?? 8/23` 缺省守卫） |
| 模块库 phone | `mods-fork/modules/phone/index.mjs` L572（有缺省守卫） |
| 模块库 pet（碎碎念/面板文案） | `mods-fork/modules/pet/index.mjs` L1884 |

另有 `use('speakup')` / `api.has('speakup')` 的跨模块消费：

- `mods-fork/modules/autonomy/index.mjs` L737（`speak` 动作跳转到 speakup 模块执行）
- `mods-fork/modules/love-mode/index.mjs` L389、panel.js L187（`speakUpOn = api.has('speakup')`，用于「建议开启」黄条提示）

白名单 `speakUp.allow` 的其他消费：`src/features/memory.js` L1100/L1193（相识判定）、`src/chat/commands.js` L154-165（QQ 内 `/speak add/remove`）。

### 1.6 面板现状（repo/client/client.js）

- 导航 tab `speakup`，label「主动搭话」，显隐 flag `speakUp.enabled`（L947）。
- `TAB_MODS.speakup = ['speakup','purpose']`（L965）——两模块已同页。
- 「管理功能」页条目「主动搭话」：`{ key:'speakup', flag:'speakUp.enabled', cli:'speakup' }`（L1305）。
- speakup 页卡片（L3759-3786）：总开关、小闹钟（开关/上限/重试）、追问、多久没聊才找你、两次间隔、白名单、每天最多、醒着时间、今日次数 + 「现在就让ta来找我」（`/speakup/fire`）+ 她的小闹钟列表卡。
- 同页还有「目的引擎（实验）」卡（L4020-4103，走 `/panel/purpose/*`）与「目的机制」状态卡；出站治理卡的活跃策略下拉含 `speakup` 选项（L1736-1767 在 host.js 侧）；抖音/桌宠/碎碎念等多处文案写着「主动搭话」。

### 1.7 受影响测试清单（现存）

| 测试文件 | 波及点 |
| --- | --- |
| `test/speakup.test.js`、`speakup-allow.test.js`、`speakup-reminder.test.js` | speakup 本体与配置归一化——退场批次删除/改写 |
| `test/chat-time-poke.test.js` | 直接实例化 `createSpeakUp` + 写 `speakup.json` |
| `test/i3-owner-identity.test.js` | L233-358 同时实例化 speakup 本体与 `createSpeakupPolicy` |
| `test/proactive-policy.test.js` | speakup 策略源整节（L184+）——随策略源退场删除 |
| `test/outbound-policy.test.js` / `outbound-wiring.test.js` | `'speakup'` 策略源注册/降级/activePolicy 用例 |
| `test/panel-purpose.test.js` | 「醒着窗口写 speakUp.\*」断言（P1 批次需翻转） |
| `test/modules.test.js` L193、`modules-v2.test.js` L126/L152 | BUILTINS 期望清单含 `speakup` |
| `test/scheduler-gateway-idle.test.js` L7 | `MODULES = ['bili','diary','qzone-social','speakup']` |
| `test/memory-follow-up.test.js`、`persona-tags.test.js`、`self-name.test.js`、`person-delete-forget.test.js` | 用 `speakUp.allow` / `speakUp.*` 造场景（键仍在即可不破） |
| `test/panel-root-render.test.js`、`panel-stage2.test.js` | config 里带 `speakUp` 字段的渲染用例 |
| `test/usage.test.js` | `system:purpose` 标签（不受影响）；`usage.js` L123 有 `speakup` 标签（历史账单保留） |
| 模块库测试 | `mods-fork/modules/pet/test/panel-purpose.test.mjs`（同款断言）、douyin/heybox/pet 测试里的 `speakUp.awake*` 造数（键保留即不破） |

---

## 2. 能力归并：speakup 什么留、什么废

### 2.1 保留并已在 purpose 中（本批次只需「扶正」）

| speakup 能力 | 去向 |
| --- | --- |
| 时机（主人沉默 idleMinutes） | purpose `idleThresholdMs` 已有（`ext.purpose.idleMinutes ?? speakUp.idleMinutes`） |
| 频率（min/max 间隔随机 + 每日上限） | purpose gap/dailyMax 已有，同名覆写位已在 |
| 醒着窗口（作息唯一真相） | purpose 安静时段已由它派生；**拍板：键不迁，冻结在 `speakUp.awake*`，语义归属 purpose 维护**（评估见 §9-Q3），面板由目的引擎卡继续读写该键（与今日 `/panel/purpose/config` 行为一致） |
| 追问 nudge | purpose `maybeNudge` 已复刻，P1 批次改为 `ext.purpose.nudge ?? speakUp.nudge ?? true`（nudge 无外部模块读，可安全翻键） |
| 白名单朋友线 | purpose friends 线已吃 `speakUp.allow`；**拍板：键冻结在 `speakUp.allow`，语义归属 purpose 维护**（随 Q3 结论），memory.js / `/speak` 命令零改动 |
| 手动触发「让ta现在来找你」 | purpose `/purpose/fire` 已有，面板按钮改指向它 |
| 旧次数承接 | `speakup.json` 只读迁移已实现，无需新增 |

### 2.2 需要新增迁移的能力

- **她的小闹钟（reminder）**：speakup 独有（工具 `qq_set_reminder/qq_close_reminder` + `speakup-reminders.json` + 触发走 companion tick）。purpose 目前没有对应物。两个选项：
  - A：把小闹钟整体迁进 purpose 模块（工具定义、context 注入、`/purpose/reminder/close` 路由、tick 内触发判定照搬，数据文件沿用 `speakup-reminders.json` 兼容读、新写 `purpose/reminders.json`）。工作量约一个中批 PR。
  - B：随 speakup 一并废弃（提示用户存量闹钟失效）。
  - **【已拍板 2026-11-16】选 A**：小闹钟迁进 purpose，作为独立中 PR 批次 **P2b**（排在 P2 之后、P4 之前，可独立回退）。

### 2.3 直接废弃

- `createSpeakUp` 本体（companion.js 的 tick/素材句式/随机由头生成）——被 purpose 的「素材→目的→生成」管线完全替代。companion.js 文件暂留（`mood` 模块 `files` 声明与旧测试依赖，PURPOSE_MODULE_API.md §6 明示「勿删」），标 `@deprecated`，清理批次再处置（§6-P5）。
- speakup 自己的排程状态（`speakup.json` 的 nextAt、min/max interval 抽签逻辑）——purpose 有独立排程，已迁移 count。
- speakup 策略源（`createSpeakupPolicy` + `speakup-policy.json` 账本）——purpose 策略源（`createPurposePolicy`，双额度口径）继续承担出站治理。
- 模块壳 `src/modules/speakup/index.js` 整体。
- 出站治理 `ACTIVE_MODES`/面板下拉里的 `'speakup'` 档位（存量值归一化，见 §4-P3）。

---

## 3. 配置迁移

### 3.1 策略：**读取兼容（fallback），不做一次性破坏性转换**

purpose 现成的 `ext.purpose.x ?? speakUp.x` 双层读法就是迁移机制。按 Q3 拍板，**作息（awake）、白名单（allow）、间隔/idle/每日上限等仍被多模块读取的键一律冻结在 `speakUp.*`，不翻写入位置**；只有无外部读者的键才翻到 ext.purpose：

1. `purposeConfig()` 已按此顺序取值，**不改取值逻辑**；新增同款 fallback 的键：`nudge`（`ext.purpose.nudge ?? speakUp.nudge ?? true`）、`reminderEnabled/reminderLimit/reminderRetry`（小闹钟按 P2b 迁入时）。
2. `normalizePurposeConfig` / `src/core/config.js` 归一化：`speakUp.*` 键**继续保留归一化与钳制**（它是很多模块的读源，也是 purpose 的维护键）；新增 `ext.purpose.nudge` 等键的归一化与默认值。
3. `host.js` `/panel/purpose/config` **写入位置不变**（醒着窗口继续写 `speakUp.*`，`test/panel-purpose.test.js` L98 断言保持，不改）；仅新增 `nudge`/`reminder*` 的透传。
4. **一次性播种（唯一的一次性转换，只发生一次、只写 ext.purpose）**：模块 setup 首次运行时若 `ext.purpose.enabled` 为 undefined 且 `cfg.speakUp.enabled === true` → 写 `ext.purpose.enabled = true`（P1 批次，兜住「升级瞬间老用户目的引擎状态与旧搭话状态不一致」的窗口；`enabled` 在 purposeConfig 里是 `ext.enabled === true` 精确判，undefined 不会误开，播种安全）。日志打一行「主动搭话已并入目的引擎，已为你开启目的引擎」。
   - 由于 Q1 拍板新装默认开（见 3.2），播种主要覆盖「老配置里从没碰过 ext.purpose」的存量用户，显式关过（false）的不覆盖。

### 3.2 ext.purpose 默认值调整

- `enabled`：**【已拍板 Q1】模块 defaults 改为 `true`（新装也默认开启目的引擎）**。老用户由 §3.1 播种兜底；显式写过 `false` 的保持关。注意实现细节：`normalize` 必须区分「undefined（用默认 true）」与「显式 false（尊重）」，面板开关写入的 false 不可被默认值洗掉；模块 description/hint 里「默认关」的文案同步改。
- 其余 defaults 不动（minMaterials=2、initialDelayMinutes=15、maxCandidates=6）；排程类默认值继续以 speakUp 归一化值为兜底（60/180 分钟、20 次/天、40 分钟 idle、8~23 点）——**语义不变，只是读法链变化**。
- 新增：`nudge: true`；`awakeFrom/awakeTo` 不设 defaults、不迁键（Q3 拍板冻结在 speakUp.\*）。

---

## 4. 模块退场路径（speakup 从 BUILTINS 移除）

### 4.1 步骤（与 §8 分批对齐）

1. **P1（配置播种 + 默认开 + nudge 翻键）**：ext.purpose.enabled 默认改 true（含 normalize 的 undefined/false 区分）、播种逻辑、nudge fallback；**醒着窗口/白名单等共享键不翻写入位置**（Q3 拍板），`/panel/purpose/config` 落盘行为基本不变；此时 speakup 仍在跑，双引擎互不影响（purpose.test.js 已证「speakUp 关着不影响 purpose」）。
2. **P2（UI 归并）**：见 §5。
3. **P2b（小闹钟迁移，拍板新增）**：按 §2.2-A 把小闹钟整体迁进 purpose（工具/context/路由/tick 触发 + 数据兼容读旧文件），插在 P2 之后、P4 之前，可独立回退。
4. **P3（策略源收拢）**：`wirePolicySources` 只注册 purpose；`outbound-policy` 的 `ACTIVE_MODES` 收为 `['purpose','auto']`；**存量 `activePolicy:'speakup'` 读取时归一化为 `'purpose'`**（不弹错、面板下拉不再出现 speakup 项）；`createSpeakupPolicy` 停止注册但代码暂留。`outboundView` 的今日次数改 `use('purpose')?.state?.() ?? {count:0}`；概览安静时段派生改读 `purposeConfig` 的结果。
5. **P4（模块移除）**：`src/modules/index.js` 删 speakup import 与数组项；删 `src/modules/speakup/`；`modules.test.js`/`modules-v2.test.js`/`scheduler-gateway-idle.test.js` 期望清单同步；usage.js `speakup` 标签**保留**（历史账单还要显示）。兼容提示：P1 的默认开 + 播种已保证老用户不空窗；删除后若有用户手动把 `ext.purpose.enabled` 改回 false，行为就是「不主动搭话」——这是目的引擎的正常开关，不再单独提示。
6. **P5（清理期，可延后）**：删 `src/features/companion.js`（先改 mood 模块 files 声明与 mood/index.js L31 的 origin 判定）、`createSpeakupPolicy`、`outbound-policy` 内 speakup 分支注释与测试节；`speakUp.awake*/allow` 键按 Q3/Q4 拍板**长期保留**（语义归属注记落在 PURPOSE_MODULE_API.md §5 与 config.js 注释），本批不动键。

### 4.2 对 mods-fork 的影响

- speakup/purpose 都在主仓，模块库无需发版即不受直接破坏；但两类跨仓消费要在 P4 前后各自提 PR：
  - `autonomy`：L737 `api.use('speakup')` 移除模块后拿 null——需确认该处已有空值守卫，`speak` 动作改为 fallback 到 purpose（`api.use('purpose').fire()`）或标记不可用跳过。
  - `love-mode`：`api.has('speakup')` 恒 false → `speakUpOn:false` → panel 黄条会一直提示「建议开启主动搭话」——需把判定改为 `ext.purpose.enabled`（读 `api.core.getConfig()`，遵守 MEMORY.md §3.5 读配置规范）。
  - 各刷库模块读的 `cfg.speakUp.awake*`：**Q3 拍板保键冻结**，模块库**零改动**（评估过程见 §9-Q3）。

### 4.3 兼容期窗口

P1~P3 合入后、P4 之前为一个自然兼容期：两模块共存但 UI 只露 purpose；用户此时手动开关任一引擎都不出错（purpose 开关独立，speakup 开关仍被 companion 尊重）。P4 一刀切移除即可，不需要长期的「speakup 静默禁用」状态——因为播种已把老用户无感切到 purpose。

---

## 5. UI 归并（client/client.js）

> **状态（2026-11-17）：界面已按面板统一口径重构完成。** 下面 1-5 条是原计划，逐条标注落地情况；
> 末尾新增「5.6 界面重构落地记录」记录实际分组、键位对照与验收。

### 5.0 原计划（保留备查）



1. **页签**：tab id `speakup` 保留（避免动 `NAV_GROUPS`/`TAB_MODS`/搜索索引一串白名单），label 改「主动搭话 · 目的引擎」，显隐 flag 从 `speakUp.enabled` 改为 `ext.purpose.enabled || speakUp.enabled`（过渡）→ P4 后纯 `ext.purpose.enabled`。`TAB_KEYS.speakup` 从 `['speakUp']` 改 `['ext']`（取 ext.purpose 键），搜索关键词串「搭话 主动」追加「目的」。
2. **speakup 页卡片处置**：
   - 「主动搭话」总开关卡（L3759）→ 删，开关语义并入目的引擎卡（已有「启用目的引擎」行）。
   - 「多久没聊才找你 / 两次之间隔 / 每天最多 / 醒着时间」→ 移入目的引擎卡（**Q3 拍板：绑定键不变**——醒着时间仍写 `speakUp.awake*`、每日上限/间隔/idle 沿用现状双层读写，仅卡片位置与文案变），hint 注明「这个醒着时间也是刷抖音/逛小黑盒等自动任务的作息」。
   - 「主动搭话白名单」→ 保留在该卡（键仍 `speakUp.allow`，hint 去掉「目的引擎开着时也按这份名单」的旧说法，改为「目的引擎按这份名单找朋友」）；QQ 内 `/speak` 命令不动。
   - 「追问」→ 移入目的引擎卡，键 `ext.purpose.nudge`。
   - 「她的小闹钟」卡与相关行 → **已拍板迁 purpose（P2b）**：整卡移入目的引擎卡区块，接口换 `/purpose/reminder/*`，数据兼容读旧 `speakup-reminders.json`。
   - 「现在就让ta来找我」按钮 → 改调 `/panel/purpose/run`（面板代理已有），按钮文案不变。
   - 概览页 `/speakup/fire` 快捷按钮（L1279）与「今天已经找过你 N 次」改读 purpose 字段。
3. **「管理功能」页条目**（L1305）：key 换 `purpose`，label「主动搭话（目的引擎）」，flag 换 `ext.purpose.enabled`，cli 保持 `purpose`；desc 改写为「像人一样主动找你说话：攒素材→立目标→到点来找你」。
4. **出站治理卡**：活跃策略下拉去掉 `speakup` 选项；存量 `'speakup'` 由 host.js 归一化显示为「目的引擎」（ACTIVE_VIEW 删 speakup 键前先做读取归一）。
5. **文案扫尾**：抖音/heybox/xhs/桌宠/碎碎念各页 hint 里「只在『主动搭话』里设的醒着时间内」统一改「目的引擎设置的醒着时间内」（纯文案，键不动）；logs 筛选下拉 `speakup` 标签改「目的引擎」（日志源名不改，只改显示）。

### 5.6 界面重构落地记录（2026-11-17）

**口径**：沿用面板已验证的统一规范——可见区 2~3 个高频组行（`ab-grp-row`，行内自由流式排版、≤10 项），
其余收进「更多设置（N 项）」折叠卡（`collapsible + defaultOpen:false + ab-fold-sub`）。

#### 盘点：11 个配置键（全部为跨模块冻结键，一个未丢）

盘点法：对 `SpeakUp` 全量正则抽 `f.*('键')`/`setPath`，再与 `src/core/config.js` 的 `speakUp` 默认字面量双向核对 —— **11/11 键在默认值中，零虚键**。

| # | 配置键 | 控件 | 新位置 |
| --- | --- | --- | --- |
| 1 | `speakUp.idleMinutes` | 数字（分钟） | 可见组行 ① |
| 2 | `speakUp.minIntervalMinutes` | 数字 | 可见组行 ① |
| 3 | `speakUp.maxIntervalMinutes` | 数字 | 可见组行 ① |
| 4 | `speakUp.maxPerDay` | 数字 | 可见组行 ① |
| 5 | `speakUp.awakeFrom` | 数字（小时） | 可见组行 ① |
| 6 | `speakUp.awakeTo` | 数字（小时） | 可见组行 ① |
| 7 | `speakUp.allow` | 列表（QQ 号） | 可见组行 ② |
| 8 | `speakUp.reminderEnabled` | 开关 | 可见组行 ③ |
| 9 | `speakUp.nudge` | 开关 | 可见组行 ③ |
| 10 | `speakUp.reminderLimit` | 数字（1~10） | 可见组行 ③ |
| 11 | `speakUp.reminderRetry` | 开关 | 组行 ③ 的「更多设置」(1 项) |

> **冻结键说明（§9-Q3 拍板）**：`awakeFrom/awakeTo` 仍是**全局作息**，被抖音/小黑盒/小红书/日记等模块读取；
> 本次重构**只移动呈现位置、不改键名不改语义**。`allow` 仍供 `/speak add` 命令与目的引擎共用。

#### 最终分组表

| 位置 | 卡片标题 | 行内项 | 项数 |
| --- | --- | --- | --- |
| **可见组行 ①** | 什么时候来找你 | idle / 间隔上下限 / 每天最多 / 醒着时间（from-to） | **4**（6 个键） |
| **可见组行 ②** | 找谁 | 白名单（`speakUp.allow`） | **1** |
| **可见组行 ③** | 小闹钟与追问 | 小闹钟开关 / 追问 / 最多保留 | **3** |
| 折叠 | 小闹钟与追问 › 更多设置 | 触发失败时保留提醒 | **1** |
| 保留 | 待触发小闹钟列表 | 每条含时间+内容+「关闭」按钮（调 `/purpose/reminder/close`） | — |
| 保留 | `PurposeStatus` / `OutboundPolicy` | 两块功能卡原样挂载 | — |

「现在就让ta来找我」按钮保留在组行 ① 底部（调 `/panel/purpose/run`）。

#### 文案口径统一

| 位置 | 改动 |
| --- | --- |
| 页内主卡标题 | 「主动搭话（目的引擎）」→ **3 张语义化卡**（什么时候来找你 / 找谁 / 小闹钟与追问） |
| 小闹钟 hint | 「到点由主动搭话的系统提醒叫醒她」→「到点由**目的引擎**的系统提醒叫醒她」 |
| 白名单 hint | 去掉旧的「目的引擎开着时也按这份名单」，改为直接说明名单用途 |
| 「管理功能」条目 | label「主动搭话（目的引擎）」→ **「目的引擎」**（desc 保持「攒素材 → 立目标 → 到点来找你」） |
| 跨页 hint（5 处） | 「只在『**主动搭话**』里设的醒着时间内」→「只在『**目的引擎**』里设的醒着时间内」（涉及空间日记/抖音×2/小黑盒/私信，纯文案键不动） |
| `NAV_ALIAS.speakup` | `'搭话 主动'` → `'搭话 主动 目的引擎 目的 素材 立目标 小闹钟 追问'`（Alt+K 可搜到） |
| `TAB_KEYS.speakup` | `['speakUp']` → `['speakUp', 'ext']`（目的引擎开关改动也计入未保存标记） |

#### 验收结果

| 项 | 方式 | 结果 |
| --- | --- | --- |
| 语法 | `node --check` | **exit 0** |
| 冻结键零缺失 | 11 键逐个核对 | **11/11 全在** |
| 可见组行 | 数 `ab-grp-row` | **3 个**；行内项 **[4, 1, 3]**，均 ≤10 |
| 折叠卡 | 数 `more()` | **1 张**（标题带「（1 项）」、`defaultOpen:false`、`ab-fold-sub`） |
| 接口不丢 | 源码断言 | `/panel/purpose/run`、`/purpose/reminder/close` 均在 |
| 子组件不丢 | 源码断言 | `PurposeStatus`、`OutboundPolicy` 均仍挂载 |
| 回归 | `node --test test/panel-purpose.test.js test/purpose-p1.test.js` | **15/15 pass** |
| 整树渲染 | vm：首帧 + ready+tab=speakup + SpeakUp 两种数据态 | **6/6 不抛异常** |

---

## 6. 数据与记忆

| 数据 | 处置 |
| --- | --- |
| `modules-data/speakup/speakup.json`（count/nextAt/nudge 去重） | purpose 已只读迁移当日 count（module.js L117-121）；文件**保留不删不写**（speakup-policy.js 的接管逻辑也按同天读它，删除该读取随 P5） |
| `modules-data/speakup/speakup-reminders.json` | 小闹钟迁 purpose（P2b，已拍板）：purpose 兼容读旧文件、新写 `purpose/reminders.json`（首写后旧文件冻结，不删） |
| `modules-data/speakup/speakup-policy.json`（策略源账本） | speakup 策略源停止注册后成为死账本；purpose 策略源有自己的账本文件，不合并（两套口径不同），保留原文以便审计 |
| `purpose/nudge.json` | 已存在，追问去重沿用 |
| 记忆条目（memory 模块） | speakup 不直接写记忆；`memory.js` 读 `speakUp.allow` 做相识判定——键保留则无迁移；mood 的 `origin='speak-up'` 判定保留（purpose 投递 userText 仍带【系统提醒】前缀，origin 判定照常生效，见 PURPOSE_MODULE_API.md §4） |
| usage 账单 | `speakup` 模块标签保留映射，历史花费照常显示 |

---

## 7. 测试与验收

### 7.1 受影响测试（按批次）

- **P1**：新增/改用例：`ext.purpose.enabled` 默认 true（normalize 区分 undefined 与显式 false——显式 false 不被洗掉）、播种逻辑（`speakUp.enabled=true` + ext 未设 → purpose 被开；ext 已显式 false 不覆盖）、`ext.purpose.nudge` fallback 用例；`panel-purpose.test.js` 的「醒着窗口写 speakUp.\*」断言**保持不变**（Q3 拍板不翻键）；`speakup.test.js` 等旧用例保持绿。
- **P2b**：小闹钟迁 purpose 的工具/context/路由用例（照 `speakup-reminder.test.js` 场景改写为 purpose 入口）+ 旧 `speakup-reminders.json` 兼容读用例。
- **P3**：`outbound-policy.test.js`/`outbound-wiring.test.js`/`proactive-policy.test.js` 删 speakup 源用例，新增 activePolicy `'speakup'`→`'purpose'` 归一化用例；`i3-owner-identity.test.js` 移除 speakupPolicy 节。
- **P4**：`modules.test.js`/`modules-v2.test.js`/`scheduler-gateway-idle.test.js` 清单去 speakup；删 `speakup*.test.js`、`chat-time-poke.test.js` 的 createSpeakUp 部分（改用 purpose 等价场景）；`panel-root-render`/`panel-stage2` 的 speakUp 字段可保留（config 兼容读取仍在）。
- **P5**：删 `proactive-policy` speakup 节与 companion 相关残件；layering.test.js 路径清单复查。

### 7.2 迁移验收标准

1. 存量用户（`speakUp.enabled=true`、ext.purpose 未设）升级后：`ext.purpose.enabled` 被播种为 true，重启后目的引擎按原醒着窗口/频率照常搭话，QQ 侧体验连续。
2. 存量用户显式关过目的引擎（`ext.purpose.enabled=false`）→ 播种不覆盖，保持关。
3. 【Q1 拍板后】全新安装：目的引擎**默认开启**；用户可在面板一键关闭（写显式 false，重启/升级不被默认值洗回）。
4. `activePolicy:'speakup'` 的存量配置读取不报错、显示为「目的引擎」、行为等价。
5. 面板无任何指向已删接口的调用（`/speakup/fire`、`/speakup/reminder/close`、`speakUp.*` 表单绑定除醒着时间/白名单等冻结键外全量 grep 复核，client.js 拷成 .mjs 过 `node --check`——按 MEMORY.md §3.13，面板验证走单测+语法检查）。
6. `cd repo && npm test` 全绿；模块库受影响测试（pet/panel-purpose、love-mode、autonomy）各自全绿。
7. 老配置文件（speakup.json / speakup-policy.json）不被删除或改写；`speakUp.awake*/allow` 键的值在升级前后逐字段一致（保键冻结验收）。

---

## 8. 分批交付建议（每批可独立回退）

| 批次 | 内容 | 回退方式 |
| --- | --- | --- |
| **P1** | ext.purpose.enabled 默认开（Q1）+ undefined/false 区分归一化 + 首启播种 + nudge fallback；共享键（awake/allow/间隔/idle/每日上限）**不翻写入位置**（Q3/Q4 拍板） | revert 单 PR；speakUp.\* 读写链未动，行为可逆 |
| **P2** | 面板归并（页签 label/flag、卡片迁移——醒着时间/白名单等卡保留原键、管理功能项、文案扫尾） | revert 单 PR，回到双卡旧页 |
| **P2b** | 小闹钟迁 purpose（Q2 拍板）：工具/context/路由/tick 触发 + 旧数据兼容读 | revert 单 PR，闹钟功能回到 speakup 模块（P4 之前有效） |
| **P3** | 策略源收拢（wirePolicySources 只注册 purpose、ACTIVE_MODES 收拢、activePolicy 归一化、概览计数换源） | revert 后 speakup 策略源恢复注册；activePolicy 已被归一化写盘的值仍是合法值（'purpose'），无需回写 |
| **P4** | speakup 模块退场（BUILTINS/目录/模块测试/usage 标签保留）、mods-fork 的 autonomy/love-mode 适配 PR | revert 恢复模块；因 P1 默认开+播种已发生，回退后双引擎状态仍一致 |
| **P5** | 清理期：companion.js / createSpeakupPolicy / outbound-policy speakup 分支删除；`speakUp.awake*/allow` 键长期保留（Q3/Q4），仅补语义归属注记 | 各子项独立成 commit，可逐个回退 |

顺序依赖：P1 → P2 → P2b → P3 → P4 → P5（P2/P2b 可与 P3 并行，但都依赖 P1；P2b 须在 P4 前完成，否则闹钟随模块一起消失；P4 依赖 P3，否则出站治理无源可注册）。
**实施时机【已拍板】：方案先搁置**，等「管理功能卡片化」收尾与上游 review 完成后再起 P1；每批合入后按 REPO-STATE.md 流程 cherry-pick 进 `local/runtime`（AGENTS.md §0.0 铁律）。

---

## 9. 风险与开放问题（2026-11-16 已全部拍板）

- **Q1｜退场后 purpose 的默认开还是关？** —— **【已拍板】新装也默认开启**。`ext.purpose.enabled` 默认值改 true；老用户播种策略保留（显式关过的不覆盖）。实现注意：normalize 要区分 undefined（取默认 true）与显式 false（尊重），模块/面板「默认关」文案同步改；新用户第一印象会多一条主动消息，属已知取舍。
- **Q2｜她的小闹钟迁还是废？** —— **【已拍板】迁进 purpose**（§2.2-A，独立批次 P2b，排在 P4 之前）。
- **Q3｜`speakUp.awakeFrom/awakeTo` 全局作息键：由 purpose 提供新键还是保键冻结？** —— **【已拍板】选 b：保键冻结 + 语义归属注记**。评估过程（基于代码事实，2026-11-16 复核）：

  | 消费方 | 读取方式（证据） |
  | --- | --- |
  | douyin | `mods-fork/modules/douyin/lib/duty.mjs` L724：`g.speakUp.awakeFrom` 直读 `getConfig()` |
  | heybox | `mods-fork/modules/heybox/lib/site.mjs` `speakUpWindow(cfg)`：`cfg.speakUp \|\| {}` 直读 |
  | xhs | `mods-fork/modules/xhs/lib/duty.mjs` L949：`g.speakUp?.awakeFrom ?? 8` 直读（带缺省守卫） |
  | phone | `mods-fork/modules/phone/index.mjs` L572：`api.core.getConfig().speakUp \|\| {}` 直读 |
  | pet | `mods-fork/modules/pet/index.mjs` L1884：`api.config().speakUp \|\| {}` 直读 |
  | qzone-social / bili（主仓） | `src/features/qzone-social.js` L204、`src/bili/duty.js` L484 直读 |

  结论：**没有任何模块经 `use('speakup')` 转发读取作息**——全部是配置键直读，改键名确实是「纯机械替换」。但评估后仍**不推荐 a（purpose 提供新键）**，理由：
  1. **替换不是终点**：老用户配置里只有 `speakUp.awake*`，没有 `ext.purpose.awake*`。机械替换后每个模块必须加 `ext.purpose.awakeFrom ?? speakUp.awakeFrom ?? 8` 三层兜底，否则升级后所有刷库模块的醒着窗口静默回落 8~23 默认值——改过作息的用户行为变化且无提示。兜底层又要长期维护，等于把冻结键的问题原样搬进 5 个模块。
  2. **跨仓成本**：5 个模块库 PR（douyin/heybox/xhs/phone/pet，各含测试造数同步，douyin 测试 6+ 处、heybox helpers 多处）+ 主仓 2 处 + 面板/host.js 读写与 panel-purpose 测试断言，且模块库发版节奏与主仓不同步，存在「主仓已迁键、模块库旧版还读旧键」的中间态窗口。
  3. **收益仅语义洁癖**：键名带历史色彩（speakUp）但不影响任何行为；purpose 面板**已经在读写这个键**（`/panel/purpose/config` 现状就是醒着窗口写回 speakUp.\*），「由 purpose 维护」事实上已成立。
  落地动作：在 `config.js` DEFAULTS 的 `speakUp.awakeFrom/awakeTo` 注释、`PURPOSE_MODULE_API.md` §5、本方案附注三处写明「**此键由目的引擎（purpose）维护，全插件自动任务共用作息真相；speakup 模块退场后键名保留**」。
- **Q4｜白名单 `speakUp.allow` 的键位置** —— **【已拍板】随 Q3 结论：保键冻结**（memory.js、`/speak` 命令、purpose friends 继续读 `speakUp.allow`，语义归属注记同 Q3 落地）。
- **Q5｜双引擎共存期的打扰风险**（未拍板项，按现状维持）：P1~P3 期间老用户若手动同时打开两套会重复打扰（现状已如此，purpose 模块 hint 有提醒）；不加「开启目的引擎自动关 speakup」的软互斥，维持文案建议。
- **Q6｜mood 模块对 companion.js 的依赖**（实施期风险，非拍板项）：mood/index.js L31 的 origin 判定只依赖 userText 前缀，companion 文件本体在 P5 才删；若上游对 companion.js 有在途改动，P5 前需同步确认（PURPOSE_MODULE_API.md §6 的「勿删」注释届时要一并改掉）。

---

## 附：本方案引用的关键文件索引

- `repo/src/modules/index.js`（BUILTINS）、`repo/src/modules/speakup/index.js`、`repo/src/modules/purpose/index.js`
- `repo/src/features/companion.js`（createSpeakUp、reminder、speakup.json）
- `repo/src/purpose/module.js`（purposeConfig 双层读、maybeNudge、friends、迁移）、`repo/src/purpose/engine.js`
- `repo/src/chat/outbound-policy.js`、`repo/src/features/proactive-policy.js`（createSpeakupPolicy/createPurposePolicy）
- `repo/src/host.js` L1090-1145（wirePolicySources）、L1484（outboundView）、L1512-1516（安静时段派生）、L1713-1767（面板 config 读写）
- `repo/src/core/config.js` L306-319、L697-706（speakUp 默认与归一化）
- `repo/client/client.js` L947/L965/L1305/L1279/L3759-3786/L4020-4103/L9050/L9926-9958
- `repo/docs/PURPOSE_MODULE_API.md`（契约与迁移说明，P1/P4 时需同步更新其 §1/§5/§6 的「speakup 保持不变」表述）
- 模块库：`mods-fork/modules/autonomy/index.mjs`、`love-mode/{index.mjs,panel.js}`、`douyin|heybox|xhs|phone|pet` 的 awake 读取
