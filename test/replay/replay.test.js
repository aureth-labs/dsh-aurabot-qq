// 回放测试（P0 第 9 条）：逐场景跑 run.js，与 baseline/ 下的基线快照逐字节对比。
//   - 基线缺失时：自动生成一份并标记 todo（首次入库用，见「生成基线」注释）；
//   - 基线存在时：逐字节对比，不一致即失败（G3 合并后这是硬门槛，CONTRACT §11.4）；
//   - 零抖动：所有时间戳来自场景 timeBase / 事件 time，随机来自 seed，序列化键排序。
// 重新生成全部基线：删掉 test/replay/baseline/ 后跑一遍本测试即可。
import { test } from 'node:test'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runScenario, stableStringify } from './run.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, 'fixtures')
const baselineDir = join(here, 'baseline')

// 场景清单按文件名排序，不依赖文件系统返回序
const fixtures = readdirSync(fixtureDir).filter((f) => f.endsWith('.json')).sort()

for (const file of fixtures) {
  const name = file.replace(/\.json$/, '')
  test(`replay: ${name}`, async (t) => {
    const scenario = JSON.parse(readFileSync(join(fixtureDir, file), 'utf8'))
    // 跑两遍先自证零抖动（同一进程内两次输出一致）
    const a = stableStringify(runScenario(scenario))
    const b = stableStringify(runScenario(scenario))
    if (a !== b) throw new Error('回放输出不稳定（两次运行不一致），检查 timeBase / seed / 排序')
    const baselinePath = join(baselineDir, `${name}.json`)
    if (!existsSync(baselinePath)) {
      // 基线缺失：生成一份入库，标 todo 提醒人工确认后再算硬门槛
      mkdirSync(baselineDir, { recursive: true })
      writeFileSync(baselinePath, a + '\n', 'utf8')
      t.todo(`已生成基线 baseline/${name}.json，请人工核对后入库`)
      return
    }
    const expected = readFileSync(baselinePath, 'utf8')
    // 逐字节对比（基线文件以换行结尾，补齐后比较）
    if (a + '\n' !== expected) {
      const diffHint = `预期前 200 字：${expected.slice(0, 200)}\n实际前 200 字：${a.slice(0, 200)}`
      throw new Error(`回放快照与基线不一致：${name}\n${diffHint}`)
    }
  })
}

test('replay: 场景数量达标（≥12，包-P0-地基 第 9 条素材清单）', () => {
  if (fixtures.length < 12) throw new Error(`fixtures 只有 ${fixtures.length} 个场景，要求至少 12 个`)
})
