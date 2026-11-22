// 数据目录、JSON 读写（UTF-8 无 BOM、先写临时文件再改名）。

import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync, writeSync, mkdirSync, renameSync, existsSync } from 'node:fs'
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

export function readJson(file, fallback) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch (error) {
    return typeof fallback === 'function' ? fallback() : fallback
  }
}

export function writeJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 原子写入 JSON 并对临时文件执行 fsync，避免进程崩溃留下截断内容。 */
export function writeJsonAtomicFsync(filePath, data, { mode = 0o600 } = {}) {
  ensureDir(dirname(filePath))
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  const payload = Buffer.from(JSON.stringify(data, null, 2), 'utf8')
  const fd = openSync(tmp, 'w', mode)
  try {
    let offset = 0
    while (offset < payload.length) {
      offset += writeSync(fd, payload, offset, payload.length - offset)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, filePath)
}

export { existsSync }
