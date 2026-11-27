// QQ 版本软判断：只用来给提示，不拦注入。
//
// SnowLuma 2.4.x 只能注入 QQ NT 9.9.33+；更低版本会卡在「等待登录」。
// 版本号读不到时退回路径判断：QQNT 目录 = NT，QQ\Bin 目录 = 老版。
// 判定结果只有 nt=true / false / null（未知），调用方决定怎么提示。

export const QQ_MIN_SNOWLUMA = '9.9.33'

/** @param {string} version @param {string} exePath */
export function classifyQqVersion(version, exePath = '') {
  const v = String(version || '').trim()
  const p = String(exePath || '')
  const m = v.match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (m) {
    const major = Number(m[1])
    const minor = Number(m[2])
    const patch = Number(m[3] || 0)
    if (major > 9) return { nt: true, label: 'NT' }
    if (major === 9 && minor > 9) return { nt: true, label: 'NT' }
    if (major === 9 && minor === 9) {
      if (patch < 33) return { nt: true, tooOld: true, min: QQ_MIN_SNOWLUMA, label: 'NT（低于 9.9.33）' }
      return { nt: true, label: 'NT' }
    }
    return { nt: false, label: '老版（非 NT）' }
  }
  if (/QQ[ _-]?NT/i.test(p)) return { nt: true, label: 'NT（按安装目录判断）' }
  if (/[\\/]QQ[\\/]Bin[\\/]/i.test(p)) return { nt: false, label: '老版（按安装目录判断）' }
  return { nt: null, label: '版本未知' }
}
