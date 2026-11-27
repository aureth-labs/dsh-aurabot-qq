# 坑记录（docs/pitfalls.md）

> 规则（见 AGENTS.md）：遇到问题先读本文件；每次问题解决后，必须把坑（现象/原因/解决）追加进来。

## 2026-11-13 合并 origin/beta 后 backup.test.js 2 个用例挂（上游自带，非合并引入）

- **现象**：`git merge origin/beta`（56 commits，零冲突）后跑 `npm test`，2167 项挂 2：
  - `恢复中途移动失败时回退已完成的移动…`（backup.test.js:310，期望抛 `/模拟写入拒绝/`）
  - `LA-21 提交标记移动失败时回退…`（backup.test.js:392，期望抛 `/模拟提交拒绝/`）
  - 断言均为 `Missing expected exception`，即 `api.applyPendingRestore()` 根本没抛。
- **原因**：在临时 worktree 检出纯 `origin/beta` 跑 `node --test test/backup.test.js`，同样挂这 2 个 → 上游 beta 自带失败，与本地超集/合并无关。两个用例依赖 `t.mock.method(fs, 'renameSync')` + `syncBuiltinESMExports()` 劫持内置 fs——上游 commit `1adc076 fix(security): 备份恢复与敏感命令授权加固` 后 `backup.js` 的恢复路径很可能改走了不被该劫持方式命中的调用（如 `fs.promises.rename` 或解构引用），Windows/当前 Node 版本下 mock 不生效。
- **解决**：本次更新按「上游自带失败」放行，不阻塞本机升级；若要修，应改上游 `backup.js` 让恢复走 `fs.renameSync`（可被 `syncBuiltinESMExports` 劫持），或改测试的 mock 方式——留给上游 PR。
- **涉及文件/命令**：`repo/test/backup.test.js`（L310-337、L392-431）、`repo/src/core/backup.js`；命令 `git worktree add ..\beta-check origin/beta && node --test test/backup.test.js`。

- 解决：改用 glob：
ode --test "test/replay/**/*.test.js"；package.json 里 npm test 本来就是 glob 写法，不受影响。
- 涉及文件/命令：test/replay/*（新增）；命令 
ode --test "test/replay/**/*.test.js"。

## 2026-11-13 · Windows 下 `node --test <目录>` 不生效
- 现象：`node --test test/replay/` 报 `Cannot find module ...\test\replay`，整个目录作为入口失败。
- 原因：Node 的 test runner 在 Windows 上不接受裸目录参数（把目录当模块解析）。
- 解决：改用 glob：`node --test "test/replay/**/*.test.js"`；package.json 里 npm test 本来就是 glob 写法，不受影响。
- 涉及文件/命令：test/replay/*（新增）；命令 `node --test "test/replay/**/*.test.js"`。

## 2026-11-13 · `npx tsc` 拉到同名假包，校验假通过
- 现象：`npx tsc --noEmit ...` 输出「This is not the tsc command you are looking for」还 exit 0，contracts.d.ts 的语法校验等于没跑。
- 原因：npm 上有个叫 `tsc` 的摆烂恶搞包，npx 找不到本地 typescript 时按名字拉到了它。
- 解决：显式指定包名：`npx -y -p typescript tsc --noEmit --strict ...`（P0 校验 contracts.d.ts 用这个，实测 exit 0 才算数）。
- 涉及文件/命令：src/gateway/contracts.d.ts；命令 `npx -y -p typescript tsc`。

## 2026-11-13 I1 身份库：SQLite 错误包装不能罩住业务错误
- 现象：identity-store 的 transact 把 fn 里的所有异常都包成「身份库损坏」，导致 link 的 IdentityConflict 被 test 判 instanceof 失败。
- 原因：try 块同时包住了「开库/初始化」和「fn 执行」，坏库包装范围过宽。
- 解决：只在开库+initialize 阶段做损坏包装（且仅当文件已存在），fn 的错误原样抛出。涉及 src/gateway/identity-store.js。
- 另：createIdentity 原本懒开库，库损坏要到第一次调用才炸；改成构造时 transact(() => {}) 预热，启动当场报错（任务书过关条件要求「启动报清楚的错」）。

## 2026-11-16 git rebase 把主检出的分支切走了，后续 merge 落错线
- 现象：阶段二收尾执行 `git rebase dev local/runtime` 后主检出从 dev 切到 local/runtime，紧接着的 `git merge --ff-only` 实际快进了 local/runtime，dev 停在阶段一；下一阶段 port 时成员发现 worktree 基线缺阶段二组件（VoiceTab/Manage 计数为 0），险些照错基线硬合。
- 原因：`git rebase <upstream> <branch>` 会把主检出切到 branch；后续命令的落点全部跟着变，而汇报里只看了 log 没核对 `git branch --show-current`。
- 解决：port 前先用 `git branch --show-current` + `git log -1 <线>` 核对落点；本机统一口径以 local/runtime 为准（本机运行线），dev 用 `git branch -f` 对齐。涉及命令 `git rebase` / `git merge --ff-only` / `git worktree add`。
- 教训：任何 rebase/checkout 后，紧接的 merge/push 前必须重新确认「当前在哪个分支」。

## 2026-11-16 在途编辑的测试文件被截断出中文引号，node --check 都过不了
- 现象：qa-tests 预写 test/panel-stage3.test.js 时 L37 中文引号被截断（`'…要跟着改?)`），整文件 Invalid or unexpected token，实现成员差点把它当实现 bug 排查。
- 原因：编辑器/工具对含中文标点的行做流式写入时截断（与 MEMORY.md §3.12 pwsh Get-Content/Set-Content 转写毁 UTF-8 同族）。
- 解决：编辑工具统一用 read/edit/write 而非 pwsh 转写；文件损坏先 `node --check` 分清「语法坏」还是「逻辑坏」，语法坏的先修语法再谈对齐。qa 已在该测试文件头加禁用 pwsh 转写提醒注释。

## 2026-11-17 「三方合并 0 冲突」不等于能跑——`git merge-file` 把本机独有的 import 也带了过来

- **现象**：把 `local/runtime` 上的心情合并改动移植到基于 `origin/beta` 的分支时，用 `git merge-file` 三方合并 6 个文件，实测**全部 0 冲突块**，看着很干净。结果一跑测试全炸：`Cannot find module 'src/gateway/address.js'`。
- **原因**：`git merge-file` 做的是**文本**层面的三方合并，"0 冲突"只说明两边没改到同一行。而 `local/runtime` 比 `origin/beta` 多了 184 个提交（多平台网关/身份库等），`config.js` 里那行 `import { normalizeChatId } from '../gateway/address.js'` 在 beta 是**整行都不存在**的——三方合并把它当"本机一侧新增"原样保留，于是移植结果引用了 beta 根本没有的目录。合并没冲突，但产物跑不起来。
- **解决**：**以目标分支的文件为基底，再把本次改动逐条 edit 上去**，不要用三方合并整个文件。判断依据：先 `git rev-parse HEAD:<f>` 与 `origin/beta:<f>` 比对，若 HEAD 版本与 beta 相同（说明本地那些提交没碰过这文件），才可以整文件移植；不同就必须逐条套。
- **教训**：
  1. **"能自动合并"和"能运行"是两件事**。移植到另一条线时，冲突块数量不是可行性指标，`import` 的目标文件在目标分支是否存在才是。
  2. 移植后**必须真跑测试**，而不是看 `git diff --stat` 干净就放心。
  3. 判断某文件能否整拷，用 `git rev-parse <ref>:<file>` 比哈希，比 `git diff` 看内容更快也更准。
- **涉及文件/命令**：`git merge-file -p <local> <base> <other>`、`git rev-parse origin/beta:<file>`；受害文件 `src/core/config.js`（多平台 import）、`src/purpose/module.js`（identity/parseChatId）。

