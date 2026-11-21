// 更新命令/链接要按宿主平台和安装形态给，不能写死 Windows 桌面版路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { githubTarballUrl, hostEnv, mirrorLabel, mirrorUrl, resolveMirror, updateAttempts, updateCommand, updatePlan } from '../src/core/update.js'

test('updateCommand：Windows 用 PowerShell 写法，Linux/macOS 用 shell 写法', () => {
  const win = updateCommand('a/b', 'beta', { env: hostEnv({ platform: 'win32', cli: 'C:\\tools\\dsh.cmd', profile: 'desktop' }) })
  assert.match(win, /^& "C:\\tools\\dsh\.cmd" plugin --profile desktop add github:a\/b#beta$/)
  const lin = updateCommand('a/b', 'main', { env: hostEnv({ platform: 'linux', cli: '/usr/bin/dsh', profile: 'work' }) })
  assert.match(lin, /^"\/usr\/bin\/dsh" plugin --profile work add github:a\/b$/)
})

test('updatePlan：带平台标签、发布页和 tag 链接', () => {
  const plan = updatePlan({ repo: 'a/b', channel: 'beta', latest: '1.3.0-beta.1', env: hostEnv({ platform: 'darwin', cli: '/Applications/dsh', profile: 'desktop' }) })
  assert.equal(plan.platformLabel, 'macOS')
  assert.equal(plan.releaseUrl, 'https://github.com/a/b/releases')
  assert.equal(plan.tagUrl, 'https://github.com/a/b/releases/tag/v1.3.0-beta.1')
  assert.match(plan.command, /plugin --profile desktop add github:a\/b#beta/)
})

test('镜像配置：空 = 直连；预设认 id / 域名 / 完整前缀；自定义补斜杠，非法地址忽略', () => {
  assert.equal(resolveMirror(''), '')
  assert.equal(resolveMirror('   '), '')
  assert.equal(resolveMirror('gh-proxy'), 'https://gh-proxy.com/')
  assert.equal(resolveMirror('gh-proxy.com'), 'https://gh-proxy.com/')
  assert.equal(resolveMirror('https://gh-proxy.com'), 'https://gh-proxy.com/')
  assert.equal(resolveMirror('ghfast'), 'https://ghfast.top/')
  assert.equal(resolveMirror('ghfast.top'), 'https://ghfast.top/')
  assert.equal(resolveMirror('https://mirror.example.com/gh/'), 'https://mirror.example.com/gh/')
  assert.equal(resolveMirror('not a url'), '')
  assert.equal(mirrorLabel('gh-proxy'), 'gh-proxy.com')
  assert.equal(mirrorLabel('https://mirror.example.com/gh/'), 'mirror.example.com')
  assert.equal(mirrorUrl('https://github.com/a/b/archive/refs/tags/v1.0.0.tar.gz', 'gh-proxy'), 'https://gh-proxy.com/https://github.com/a/b/archive/refs/tags/v1.0.0.tar.gz')
  assert.equal(mirrorUrl('https://gh-proxy.com/https://github.com/a/b/x.tar.gz', 'gh-proxy'), 'https://gh-proxy.com/https://github.com/a/b/x.tar.gz', '已套过镜像不重复套')
})

test('githubTarballUrl：Release Tag 走 refs/tags，没 Tag 时按分支走 refs/heads', () => {
  assert.equal(githubTarballUrl('a/b', { ref: 'v1.2.0' }), 'https://github.com/a/b/archive/refs/tags/v1.2.0.tar.gz')
  assert.equal(githubTarballUrl('a/b', { channel: 'beta' }), 'https://github.com/a/b/archive/refs/heads/beta.tar.gz')
  assert.equal(githubTarballUrl('a/b', { channel: 'main' }), 'https://github.com/a/b/archive/refs/heads/main.tar.gz')
})

test('updateAttempts：配镜像先走镜像 tarball，失败再回退原来的 github: 直连', () => {
  const attempts = updateAttempts({ repo: 'a/b', channel: 'main', ref: 'v1.2.0', profile: 'desktop', mirror: 'gh-proxy' })
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].kind, 'mirror')
  assert.equal(attempts[0].spec, 'https://gh-proxy.com/https://github.com/a/b/archive/refs/tags/v1.2.0.tar.gz')
  assert.deepEqual(attempts[0].args, ['plugin', '--profile', 'desktop', 'add', 'https://gh-proxy.com/https://github.com/a/b/archive/refs/tags/v1.2.0.tar.gz'])
  assert.equal(attempts[1].kind, 'direct')
  assert.deepEqual(attempts[1].args, ['plugin', '--profile', 'desktop', 'add', 'github:a/b#v1.2.0'])
})

test('updateAttempts：默认没配镜像时和以前完全一样，只有一条直连命令', () => {
  const attempts = updateAttempts({ repo: 'a/b', channel: 'beta' })
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].kind, 'direct')
  assert.deepEqual(attempts[0].args, ['plugin', '--profile', 'desktop', 'add', 'github:a/b#beta'])
  assert.equal(updateAttempts({ repo: 'a/b', channel: 'main', mirror: '不是地址' }).length, 1)
})

test('updateCommand / updatePlan：面板显示的也是镜像命令，并带直连兜底命令', () => {
  const env = hostEnv({ platform: 'linux', cli: '/usr/bin/dsh', profile: 'work' })
  const cmd = updateCommand('a/b', 'main', { env, ref: 'v1.2.0', mirror: 'ghfast' })
  assert.match(cmd, /plugin --profile work add https:\/\/ghfast\.top\/https:\/\/github\.com\/a\/b\/archive\/refs\/tags\/v1\.2\.0\.tar\.gz$/)
  const plan = updatePlan({ repo: 'a/b', channel: 'main', latest: '1.2.0', tag: 'v1.2.0', env, mirror: 'ghfast' })
  assert.equal(plan.mirror, 'https://ghfast.top/')
  assert.equal(plan.mirrorLabel, 'ghfast.top')
  assert.equal(plan.installUrl, 'https://ghfast.top/https://github.com/a/b/archive/refs/tags/v1.2.0.tar.gz')
  assert.match(plan.directCommand, /plugin --profile work add github:a\/b#v1\.2\.0$/)
})
