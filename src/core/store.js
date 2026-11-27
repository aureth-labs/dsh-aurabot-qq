// 数据目录、JSON 读写（UTF-8 无 BOM、先写临时文件再改名）。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 插件所有数据都放这儿：~/.dsh/plugins-data/aurabot/ */
export function dataDir(...parts) {
  const base = process.env.AURABOT_DATA_DIR || join(dshHome(), 'plugins-data', 'aurabot')
  return join(base, ...parts)
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}

// 重试间隔：只有出错才会有这一次等待，正常路径零开销
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch {}
}

/**
 * 读 JSON。瞬时的读失败会重试两次再回落 fallback：
 * Windows 上杀毒 / 备份 / 同步盘会在文件被短暂占用时抛 EBUSY / EPERM，断电或进程被杀
 * 会留下 0 字节或写了一半的文件 —— 这几种几十毫秒内就自愈，但「一次失败就回落默认值」
 * 会被上层 normalize 成一份全新配置，再被启动期的写盘固化，用户只是重启了一次，
 * 配置却永久变默认。文件不存在（ENOENT）是正常情况，直接回落，不重试。
 */
export function readJson(file, fallback) {
  for (let i = 0; i < 3; i++) {
    try {
      let text = readFileSync(file, 'utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      if (!text.trim()) throw Object.assign(new Error(`文件是空的：${file}`), { code: 'EMPTYFILE' })
      return JSON.parse(text)
    } catch (error) {
      if (error.code === 'ENOENT') break
      if (i < 2) sleepSync(40)
    }
  }
  return typeof fallback === 'function' ? fallback() : fallback
}

export function writeJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

export { existsSync }
