// SnowLuma 版本兼容性：面板据此提示升级，避免用户跑到已知有 bug 的版本上。
//
// 版本范围（以插件实际验证过的为准）：
//   < 2.3.4   已知问题：私聊引用解析会把引用接到很久以前的同号消息（2.3.4 修复）
//   2.3.4–2.4.1  可用；2.4.1 是当前验证过的版本
//   > 2.4.1   没验证过，遇到问题先回退
import { compareVersions } from '../core/update.js'

export const SNOWLUMA_MIN = '2.3.4'
export const SNOWLUMA_RECOMMENDED = '2.4.1'
export const SNOWLUMA_TESTED_MAX = '2.4.1'
export const SNOWLUMA_QQ_MIN = '9.9.33'

const QQ_NOTE = 'SnowLuma 2.4.x 需要 QQ NT ' + SNOWLUMA_QQ_MIN + ' 及以上；QQ 版本太低会卡在「等待登录」。'

/**
 * 判断一个 SnowLuma 版本和当前插件的兼容性。
 * @param {string} version 例如 '2.2.0'
 * @returns {{ status: 'ok'|'outdated'|'update'|'untested'|'unknown', label: string, message: string, version: string, min: string, recommended: string, testedMax: string }}
 */
export function snowlumaCompat(version) {
  const v = String(version || '').trim().replace(/^v/i, '')
  const base = { version: v, min: SNOWLUMA_MIN, recommended: SNOWLUMA_RECOMMENDED, testedMax: SNOWLUMA_TESTED_MAX, qqMin: SNOWLUMA_QQ_MIN }
  if (!/^\d+(\.\d+)*$/.test(v)) {
    return { ...base, status: 'unknown', label: '版本未知', message: '读不到 SnowLuma 版本；如果是从很旧的版本升级上来的，建议升级到 ' + SNOWLUMA_RECOMMENDED + '。' }
  }
  if (compareVersions(v, SNOWLUMA_MIN) < 0) {
    return {
      ...base,
      status: 'outdated',
      label: '有已知问题，建议升级',
      message: 'SnowLuma v' + v + ' 有已知的私聊引用解析问题（引用会接到很久以前的同号消息，v' + SNOWLUMA_MIN + ' 修复），建议升级到 v' + SNOWLUMA_RECOMMENDED + ' 或更新版本。' + QQ_NOTE,
    }
  }
  if (compareVersions(v, SNOWLUMA_RECOMMENDED) < 0) {
    return {
      ...base,
      status: 'update',
      label: '建议升级',
      message: 'SnowLuma v' + v + ' 已修复引用问题；建议升级到 v' + SNOWLUMA_RECOMMENDED + '（当前验证过的版本）。' + QQ_NOTE,
    }
  }
  if (compareVersions(v, SNOWLUMA_TESTED_MAX) > 0) {
    return {
      ...base,
      status: 'untested',
      label: '比验证过的版本新',
      message: 'SnowLuma v' + v + ' 比插件验证过的 v' + SNOWLUMA_TESTED_MAX + ' 新，行为可能有变化；遇到连接或引用问题时先回退到 v' + SNOWLUMA_TESTED_MAX + '。' + QQ_NOTE,
    }
  }
  return { ...base, status: 'ok', label: '兼容', message: 'SnowLuma v' + v + ' 与插件兼容。' }
}
