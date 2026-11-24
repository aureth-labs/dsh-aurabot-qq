import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const compatibilityDir = dirname(fileURLToPath(import.meta.url))
const aurabotRoot = resolve(compatibilityDir, '..', '..')
const args = process.argv.slice(2)
const release = args[0] === '--release'
if (release) args.shift()
const target = args[0] || process.env.AURABOT_DSH_SOURCE
if (args.length > 1 || !target) {
  console.error('请传入目标 DSH 源码目录，或设置 AURABOT_DSH_SOURCE。')
  process.exit(2)
}

const dshRoot = resolve(target)
const vitest = join(dshRoot, 'node_modules', 'vitest', 'vitest.mjs')
if (!existsSync(join(dshRoot, 'tsconfig.base.json')) || !existsSync(vitest)) {
  console.error('需要目标 DSH 源码目录，且该目录已安装本地测试依赖（含 Vitest）。')
  process.exit(2)
}

function run(cwd, args) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(dshRoot, [
  vitest, 'run', '--no-cache', '--configLoader', 'runner', '--maxWorkers', '1',
  '--config', join(compatibilityDir, 'vitest.config.mjs'),
])

if (release) {
  const npm = process.env.npm_execpath
  if (!npm) {
    console.error('请用 npm run test:release 启动发布检查。')
    process.exit(2)
  }
  run(aurabotRoot, [npm, 'run', 'test:types'])
  run(aurabotRoot, [npm, 'run', 'test:qr-decode'])
  run(aurabotRoot, [npm, 'test'])
}
