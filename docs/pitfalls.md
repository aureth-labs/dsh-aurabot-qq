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
