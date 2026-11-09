// 解析 PowerShell 输出的「PID|exe路径|文件版本」行。
// 路径里可能有空格/中文，Windows 文件名不会含 |，所以按 | 分三段是安全的。
export function parseProcessLines(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\|(.*)\|([^|]*)\s*$/)
    if (!m) continue
    out.push({ pid: Number(m[1]), path: String(m[2] || '').trim(), version: String(m[3] || '').trim() })
  }
  return out
}
