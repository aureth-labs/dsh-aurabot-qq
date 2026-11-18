# 自驱引擎 v4 → v5：迁移与回滚说明

> 本文回答维护者对本 PR 的两个问题：「+5801/-2094、删 engine.js/runtime.js 属大改，迁移怎么做？」
> 以及「v4→v5 状态文件兼容吗？出问题怎么回滚？」
> 设计权威仍是 `docs/design/autotelic-v5/00-v5-final.md`；本文只写**升级/降级的具体动作与数据影响**。

## 一、一句话结论

| 问题 | 结论 |
| --- | --- |
| 配置键会丢吗？ | **不丢**，旧键原样留在配置里，只是 v5 不再读。v4 专属的 9 个键语义失效，其余保留同名同义。 |
| 状态文件会坏吗？ | **不坏**。`ledger.json` / `audit/` / `notes/` / `proposals/` / `env.json` / `say-pending.json` 的路径与格式**一字未改**；v5 新增 7 个自有文件，v4 根本不读它们。 |
| 删掉的 engine.js / runtime.js 有人引用吗？ | **没有**。全仓 `src/**`、`test/`、`client/` 均无 `autotelic/engine`、`autotelic/runtime` 的 import（实测 grep 零命中）。它们只被 v4 的模块壳 `src/modules/autotelic/index.js` 内部使用，而该文件在本 PR 里同步重写。 |
| 能回滚吗？ | **能，且是纯代码回滚**。`enabled` 默认 `false` 时 v5 零 IO；把代码退回到 beta 的 v4 时，v5 新增的状态文件成为不生效的孤儿文件，v4 不读、不崩。账本格式未变，v4 接着记同一本账。 |

## 二、配置键迁移对照

v5 的 `defaults` 与 `settings` 都是全新的一份，但**旧配置值留在 `config.ext.autotelic` 里不会丢**：宿主合并配置时以 `defaults` 兜底、以现存值为准，未声明的键只是没被读，不会删除。

### 2.1 语义等价、键名未变（直接沿用，无需动手）

`enabled`、`allowPython`、`allowUserModules`、`pythonBin`、`scriptTimeoutMs`、`maxSteps`、`maxTasksActive`、`budgetActionsPerHour`、`takeover`、`presetIdOverride`（内部键）、`takenOver`（内部键）。

### 2.2 改名 / 换口径（**需要主人重设一次**）

| v4 键 | v5 键 | 说明 |
| --- | --- | --- |
| `quietFrom` / `quietTo`（安静时段，字符串 `HH:MM`） | `awakeFrom` / `awakeTo`（醒着窗口，整点数字） | **口径反转**：v4 直接写「不许打扰」的区间，v5 写「醒着」的区间、安静时段取其补集。默认 `quietFrom 23:30 → quietTo 07:30` 对应 v5 的 `awakeFrom 8 / awakeTo 23`（近似，**不自动换算**：分钟级精度在 v5 里不存在，凌晨半小时的差异属于刻意简化）。 |
| `actTimeoutMs`（做事回合超时） | 无 | v5 的 token 预算替换了单步时长闸（`intent*/gate*/review*MaxTokens`）。 |
| `dailyReviewHour`、`minBatchForReview` | 无 | v5 的复盘由决策环每日落 `decisions.jsonl`，不再攒批。 |
| `dreamFrom` / `dreamTo` | 无 | v5 无「做梦」窗口。 |
| `evalModel`、`eval`、`screen`、`minCuriosity`、`maxCandidates` | 无 | 好奇判分管线整体退役，改由 `plan.js` 三段决策环取代。 |
| `allowAct` | 无 | 退役。v5 的「能不能动手」由行动单三级分级（只读 / write-data / touch-owner）+ `constraintRules` + `autoConfirmOwner` 表达，面板管理卡里指向该键的过期行已删。 |

### 2.3 v5 新增（默认值即安全档）

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `awakeFrom` / `awakeTo` | 8 / 23 | 醒着窗口，安静时段 = 补集 |
| `minIntervalMinutes` / `maxIntervalMinutes` | 90 / 240 | 回味间隔区间（随机 + 向主人常回话的小时轻推） |
| `maxPerDay` | 3 | 单日回味上限（0 = 不限，仍受安静时段约束） |
| `igniteCooldownMinutes` | 45 | 心念点火的事件侧冷却 |
| `constraintRules` | 空 | **主人的缰绳**：逐行一条，把关前置否决 + 执行上下文注入 |
| `autoConfirmOwner` | false | touch-owner 豁免确认（默认全要确认） |
| `confirmWindowMinutes` | 720 | 确认等待时长，超时自动取消 |
| `responseWindowHours` | 48 | 投递后观察窗；主人在窗内没回应 = `ignored` |
| `chillHalfLifeDays` / `chillParkThreshold` | 14 / 3 | 冷度半衰与自动 park 阈值（park 90 天后可复活） |
| `chat/intent/gate/review` 各 `MaxInputTokens`/`MaxOutputTokens` | 见 `defaults` | §9.3 四组 token 预算，`chat` 组预留给对话轮前缀段 |

## 三、状态文件兼容性

数据目录 = `api.dataDir()`（`modules-data/autotelic/`；多人格时按 `persona-data/<人格>/autotelic/`）。

### 3.1 路径与格式完全未变（v4 与 v5 互读同一份）

| 文件 | 谁写 | 说明 |
| --- | --- | --- |
| `ledger.json` | `book.js` | **`book.js` 在本 PR 中零改动**（`git diff origin/beta -- src/autotelic/book.js` 为空），schema 一字未变 → v5 写的账 v4 能读，反之亦然。 |
| `audit/<YYYY-MM-DD>.jsonl` | `audit.js` | 哈希链审计账本，零改动。 |
| `notes/<YYYY-MM-DD>-<标题>.md` | 模块壳 | 同一命名约定。v5 去掉了 v4 的 `<taskId>.` 文件名前缀，面板归账改为按 mtime 落在任务窗口内 —— **老文件照常能被读到**（v4 的兜底分支本来就是「没前缀按 mtime」）。 |
| `proposals/*.md` | 模块壳 | 同一目录同一格式。 |
| `env.json` | `python.js` | 零改动。 |
| `say-pending.json` | 模块壳 | 同一路径同一数组结构（`{at,text,reason}`，保留最近 20 条）。 |
| `skills/<id>/manifest.json` | `skills.js` | 三层技能库在同一目录上扩展；v4 写的 manifest 仍可被 `createSkills()`（v5 里保留的函数）读取。 |

### 3.2 v5 新增（v4 不读、不感知；回滚后成为无害孤儿）

| 文件 | 作用 |
| --- | --- |
| `observations.jsonl` | 感知层观察流水（只积累不决策） |
| `decisions.jsonl` | 决策环哈希链审计（`intent`/`gate`/`review` 各一行） |
| `feedback.json` | 抑制偏好表 + 冷度 |
| `feedback-events.jsonl` | 反馈事件流水（**另立文件，不写进 `decisions.jsonl`，不破哈希链**） |
| `parked.json` | 90 天挂起表 |
| `schedule.json` | 双轨触发排程状态（`nextFireAt` / `lastRunAt` / `countToday` / `replyHours`） |
| `constraints.txt` | `constraintRules` 的解析镜像（只读展示用） |
| `tags-user.json` | 用户自定义标签（封闭词表的扩展） |

**升级不会破坏任何 v4 数据**：v5 只在自己新增的文件里记账，对 v4 文件全部是「同一路径、同一格式、继续追加」。

## 四、升级步骤

1. 拉到含本 PR 的版本，重启插件（模块壳随插件加载）。
2. 面板「自驱引擎（实验）」页：先确认 `awakeFrom`/`awakeTo` 是你要的作息（v5 不自动换算 v4 的 `quietFrom`/`quietTo`，见 §2.2）。
3. **先配 `constraintRules`（主人的缰绳）**，再考虑开 `autoConfirmOwner`（默认关 = 所有碰主人侧的行动都排队等确认）。
4. 与「目的引擎 / 主动搭话」是两套独立排程，安静时段共用同一套醒着窗口口径 —— 建议错开时段或只开一套。
5. 最后再打开总开关 `enabled`。关着的时候模块零 IO、零模型调用，行为与升级前完全一致。

## 五、回滚步骤

**触发条件**：v5 行为不如预期、或需要在生产上退回到已验证的 v4。

1. **软回滚（推荐，零风险）**：面板关掉 `enabled`。v5 立刻停止一切排程与模型调用，状态文件原样留在盘上（下次开回来接着跑）。这不需要改代码、不改配置、不丢数据。
2. **代码回滚**：把 `src/modules/autotelic/index.js` 与 `src/autotelic/` 整体退回到 beta 的 v4 版本（`git revert` 本 PR 的合并提交）。此时：
   - `ledger.json` / `audit/` / `notes/` / `proposals/` / `env.json` / `say-pending.json` / `skills/` **全部原样可读**，v4 接着记同一本账；
   - §3.2 的 7 个 v5 文件留在盘上成为孤儿（不读、不写、不报错），想清理就整目录删掉，**不影响 v4**；
   - 配置里 v5 新增的键同样成为未读键，不删也不会影响 v4（v4 的 `defaults` 会为它自己声明的键兜底）。
3. **回滚后需要重设的**：v4 的 `quietFrom`/`quietTo`（v5 新增的 `awakeFrom`/`awakeTo` 不被 v4 读；v4 原有的 `quietFrom`/`quietTo` 值其实一直留在配置里，通常无需重设）。

## 六、验证记录

- `git diff origin/beta -- src/autotelic/book.js`、`audit.js`、`reflect.js`、`takeover.js`、`reconcile.js`、`python.js` —— **全部为空**（legacy 件零改动）。
- 全仓 grep `autotelic/engine`、`autotelic/runtime` —— **零引用**（删掉的两个文件没有外部使用者）。
- 全量 `npm test`：2802 项 / 2790 过 / 6 skip / **6 挂**。6 挂中 4 项（`backup.test.js` 2 + `song-cpu-profile.test.js` 2）在**干净 `origin/beta`** 上同样复现（已建独立 worktree 实测），属基线自带的 Windows 平台项；另 2 项（`e2e.test.js` 的「#6 改资料」）单独复跑两次均全绿，是满载并发下的已知抖动。
