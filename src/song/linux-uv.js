// Linux 翻唱安装使用固定版本的 uv，校验后只取 wheel 里的可执行文件。
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { readZip } from './zip.js'

const WHEELS = {
  x64: {
    path: 'packages/3a/ad/3c2a81d66d1839063662e5b6c0002ec31f8ee987dbc5295747627ca6160a/uv-0.13.5-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
    sha256: 'fa8d26e08e34c29c0c4e820cf3181757086d547240b4f4d31ff1d8bd810ca946',
  },
  arm64: {
    path: 'packages/e8/2e/5bf9acf9d11fb790420e258a875e13bba36bc890858350642aca185efe0e/uv-0.13.5-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl',
    sha256: '2386c2dc9b59fc1d39b1c500e4319d71d3268232eb3b38e29cd6775d6269e8d4',
  },
}

/** 下载并安装对应 CPU 架构的 uv。 */
export async function installLinuxUv(dest, { arch = process.arch, fetcher = fetch, note } = {}) {
  const wheel = WHEELS[arch]
  if (!wheel) throw new Error('这个 Linux 架构没有内置 uv 下载源，请先安装 uv 或设置 AURABOT_UV')
  const stage = dest + '.' + randomUUID() + '.download'
  let lastError
  for (const base of ['https://mirrors.aliyun.com/pypi/', 'https://files.pythonhosted.org/']) {
    try {
      const response = await fetcher(base + wheel.path, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (createHash('sha256').update(bytes).digest('hex') !== wheel.sha256) throw new Error('下载的 uv 校验不通过')
      const uv = readZip(bytes, (name) => name === 'uv-0.13.5.data/scripts/uv')[0]
      if (!uv) throw new Error('安装包里找不到 uv')
      mkdirSync(dirname(dest), { recursive: true })
      try {
        writeFileSync(stage, uv.data, { mode: 0o755, flag: 'wx' })
        renameSync(stage, dest)
      } finally {
        rmSync(stage, { force: true })
      }
      return dest
    } catch (error) {
      lastError = error
      note?.('  从 ' + new URL(base).host + ' 下载 uv 失败：' + error.message)
    }
  }
  throw new Error('uv 下载失败：' + lastError?.message)
}
