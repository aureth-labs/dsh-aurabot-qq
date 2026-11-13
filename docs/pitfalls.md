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
