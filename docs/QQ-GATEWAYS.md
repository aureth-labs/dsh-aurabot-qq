# QQ 平台端 · 能力探测表（G2）

> 本文件记录 `src/adapters/qq/probe.js` 里每个探针的**动作名、判定方法、影响哪个 caps 项**。
> 面板据「当前网关不支持 X」的提示来自这张表；G3 切换后这张表仍然是 OneBot 网关能力的权威清单。
> 契约：`src/gateway/contracts.d.ts` 的 `Caps`；规矩：`docs/CONTRACTS.md` §八.1。

## 为什么必须探测

OneBot v11 标准只规定了十来个小动作，「历史消息 / 文件地址 / 戳一戳 / 输入状态 / 改资料 /
空间 / 收藏表情 / 语音转文字」全是各家网关自己加的扩展。同一个插件接 SnowLuma、NapCat、
LLOneBot、Lagrange 得到的能力完全不同，所以能力表只能在连上之后问，不能写死。

## 三条硬规矩

1. **探测前按最保守报**（`CAPS_CONSERVATIVE`），探测完调 `ctx.capsChanged()` 让网关重读。
2. **单项失败只降级那一项**，并记一条「当前网关不支持 X」的日志，不让一次失败打死整张表。
3. **探测绝无副作用**：只做只读调用，或用「一定被拒」的参数问存在性。绝不发真消息、
   绝不改真资料、绝不动群管理（`MUTATING_PROBES` 的注释逐条写了理由）。

## 判定方法

```
调用成功                        → exists = true（有）
retcode 1404 / 404              → exists = false（没有这个动作）
文本含 不支持/未实现/unknown action → exists = false
超时 / 连不上 / 读不懂            → exists = 'unknown'（按不支持处理，不许升级）
其余失败（参数错、权限不够）        → exists = true（动作在，只是这次没调对）
```

`unknown` 一律按「不支持」落进 caps，这是「宁可少声明，也不谎报」的落地方式。

## 探针清单

### 基础（连上就该有）

| 探针名 | 动作 | 判定 | 影响 caps |
|---|---|---|---|
| `version` | `get_version_info` | 只读；顺便决定缓存还认不认 | — |
| `status` | `get_status` | 只读 | — |
| `login` | `get_login_info` | 只读 | — |
| `can_send_image` | `can_send_image` | 只读；`{yes:false}` 才算不能发 | `image`、`sticker` |
| `can_send_record` | `can_send_record` | 只读；`{yes:false}` 才算不能发 | `voice` |
| `friend_list` | `get_friend_list` | 只读；结果给后面的探针当目标 | — |
| `group_list` | `get_group_list` | 只读；结果给后面的探针当目标 | — |

### 历史消息

| 探针名 | 动作 | 判定 | 影响 caps |
|---|---|---|---|
| `history` | `get_group_msg_history`（有群）/ `get_friend_msg_history`（没群） | 用探到的真实群号/好友号，`count:1` | `history` |

### 群成员 / 合并转发 / 撤回 / 表情回应

| 探针名 | 动作 | 判定 | 影响 caps |
|---|---|---|---|
| `members` | `get_group_member_list` | 真实群号 | `memberList` |
| `forward` | `get_forward_msg` | 不存在的 id | `forwardExpand` |
| `recall` | `delete_msg` | `message_id: 0`（不存在） | `recall` |
| `emoji_like` | `set_msg_emoji_like` | `message_id: 0` | 只进清单 |

### 戳一戳 / 输入状态

| 探针名 | 动作 | 判定 | 影响 caps |
|---|---|---|---|
| `poke` | `send_poke` | `user_id: 0`（不存在，必然被拒） | `poke` |
| `typing` | `set_input_status` | `user_id: 0` | `typing` |

### 文件地址 / 上传

| 探针名 | 动作 | 判定 | 影响 caps |
|---|---|---|---|
| `group_file_url` | `get_group_file_url` | 不存在的 file_id | 只进清单 |
| `private_file_url` | `get_private_file_url` | 不存在的 file_id | 只进清单 |
| `upload_group_file` | `upload_group_file` | `file: ''`（必然 file not found） | `file`、`maxFileBytes` |
| `upload_private_file` | `upload_private_file` | `file: ''` | 只进清单（任一成功即算能发文件） |

### 改资料（**一定被拒**的参数，改不动真数据）

| 探针名 | 动作 | 判定 | 影响 caps |
|---|---|---|---|
| `profile_nickname` | `set_qq_profile` | 400 字超长昵称（QQ 侧长度校验先拒） | 只进清单 |
| `profile_avatar` | `set_qq_avatar` | `file: 'base64://'`（空图，解码就失败） | 只进清单 |
| `longnick` | `set_self_longnick` | 400 字超长签名 | 只进清单 |

### 空间 / 收藏表情 / 语音转文字

| 探针名 | 动作 | 判定 | 影响 caps |
|---|---|---|---|
| `qzone_list` | `get_qzone_msg_list` | 只读，`num:1`（绝不发说说） | 只进清单 |
| `custom_faces` | `fetch_custom_face` | 只读，`count:1` | 只进清单 |
| `ptt_text` | `fetch_ptt_text` | `message_id: 0` | 只进清单 |

### 其余常用扩展（只进清单，供 `native()` 白名单与面板提示）

`sys_faces`、`image_download`、`record_download`、`stranger_info`、`group_info`、
`friend_requests`、`group_msg`。

## caps 映射规则

```
image      ← can_send_image 没被明确拒
sticker    ← image（表情包当图片发）
voice      ← 'native'；can_send_record 明确拒 + 能发文件 → 'file'；都不能发 → false
video      ← false（v11 没有 video 段的正式定义，也没有能安全试探的动作）
file       ← 任一 upload_* 探到
maxFileBytes ← 能发文件时 30MB（OneBot 没有「查上限」的动作，报小不报大），否则 0
quoteReply / mention / mentionAll ← true（v11 消息段标准）
poke       ← send_poke 探到
typing     ← set_input_status 探到
recall     ← delete_msg 探到
card       ← false（出站方向 OneBot 没有可靠的卡片段）
history    ← 历史消息探到
memberList ← get_group_member_list 探到
forwardExpand ← get_forward_msg 探到
listenAllInGroup ← true（WS 推送本来就带群里所有消息）
proactive  ← 'free'（QQ 个人号的性质，不是网关能力；探测期间也不掐主动消息）
replyWindowMs / repliesPerMessage ← 0（没有被动回复限制）
```

## caps 缓存策略

- **位置**：`ctx.dataDir('caps.json')`，即网关给每个实例的独立数据目录。
  **只接受绝对路径**：`ctx.dataDir` 缺席或返回相对路径时**不落盘**
  （否则会把 `caps.json` 写进当前工作目录，污染仓库根目录，还会让不同实例互相串用能力表）。
- **内容**：`{ v, gateway: {app, version, protocol}, caps, supported, probedAt }`，`v` 是缓存格式版本。
- **启动顺序**：读缓存 → 立刻套用（`caps` + 动作白名单同时生效，`probeInfo().fromCache = true`）
  → 连上后读 `get_version_info` 比对版本 → 版本一致就先报缓存、**后台**复探；
  版本变了（换了网关/升级了网关）→ 直接重探。
- **只认契约里的取值**：缓存里的 `voice: 'yes'`、`proactive: 'maybe'` 这类怪值会被丢掉并落回保守值。
- **坏了不影响启动**：读不出来、JSON 坏、版本号对不上都当「没有缓存」，从保守表起步。
- **写失败不影响功能**：写不进去只记一条 debug。

## 已知的判定边界（给后面的包）

1. **`native()` 的白名单**只硬编码 OneBot 标准动作；扩展动作必须探到才放行。
   所以网关不支持 `set_qq_avatar` 时，模块调 `api.native('qq','set_qq_avatar')` 会立刻拿到
   「当前网关不支持」而不是一个转了半天的网络错误。
2. **`video` 永远是 false**：v11 没有标准的 video 段定义，唯一能「安全试探」的办法是发一条真视频，
   这违反「探测无副作用」。如果哪天确定要支持，改成由用户配置显式打开，不要靠探测猜。
3. **`maxFileBytes` 是猜的 30MB**：OneBot 没有查询上限的动作。报小的代价是网关提前抛
   `too-large`，报大的代价是真发出去才发现失败 —— 选前者。
4. **实机验证还没做**：任务书要求连 SnowLuma 2.4.1 与 NapCat 各跑一遍探测并写进本文件。
   这一步需要真实网关，本包只做了假 client 的等价测试；实机表格留待有环境时补，
   **不要凭印象填**。
