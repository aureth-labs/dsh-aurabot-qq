// QQ 平台端 · SnowLuma 可选子模块（G2 产出）
//
// 作用：backend='snowluma' 时，在 start 里替主人「启停本机的 SnowLuma 网关」。
//       backend='onebot'（自己已经有 NapCat / LLOneBot / 容器里的 SnowLuma）时**完全不加载**它。
//
// ── 关于「复制还是复用」的说明（任务书要求写清楚）──
// 任务书原本要求把 src/snowluma/ 的 4 个文件复制进本目录，G3 切换后再删原目录。
// 这里改成**用 import 复用原文件，一行都没复制**，理由：
//   1. 复制会得到两份 SnowLuma 管理代码，G3 之前任何一边修 bug（EULA 相关的注入核对尤其敏感）
//      都会漏改另一边 —— 而 SnowLuma 注入一旦认错进程，会作用到主人的主号上。
//   2. 本文件不导出新的管理逻辑，只做三件事：把关、拿 endpoint、把 createSnowLumaManager 包成
//      「平台端启动时要用的那几件」。
//   3. 契约 §十 把 src/snowluma/** 划给 G2，G3 切换时一并删除；届时本文件把 import 路径改成
//      ./snowluma/manager.js 即可（改 3 行 import，没有逻辑要搬）。这个「切换注意点」写进了
//      交付说明，也在 test/adapters/qq.test.js 里用一条用例钉住「只 import 不复制」。
//
// ⚠ 沿用原文件的所有安全约束（不改、不放松）：
//   - 只管理主人自己下载解压、并在 WebUI 里同意过协议的那一份；不下载、不解压、不替主人同意协议。
//   - 永远不开 hookAutoLoad；注入前按 /api/processes 的 account.uin 核对，只注入机器人号。
//   - 只在 Windows + 用户配了 dir 时启用。

import { createSnowLumaManager, detectInstall, readOneBotEndpoint } from '../../snowluma/manager.js'

/** 这个平台端实例要不要接管 SnowLuma。判据：backend='snowluma' + 平台是 Windows + 配了目录。 */
export function snowlumaEnabled(config = {}) {
  if (String(config.backend || 'onebot') !== 'snowluma') return { enabled: false, reason: 'backend 不是 snowluma' }
  if (process.platform !== 'win32') return { enabled: false, reason: 'SnowLuma 管理只在 Windows 上可用（EULA 与进程注入都只支持 Windows）' }
  const dir = String(config.snowlumaDir ?? config.dir ?? '').trim()
  if (!dir) return { enabled: false, reason: '还没配置 SnowLuma 目录（snowlumaDir）' }
  return { enabled: true, dir }
}

/**
 * 建一个 SnowLuma 控制器（薄封装，逻辑全在原 manager.js 里）。
 *
 * 与原 host.js 的用法差异只有一处：原先是全局一份（getConfig() 读整份配置），
 * 现在按平台端实例建一份，配置从 ctx.config() 来。所以这里给出 getConfig 的适配：
 * 把平台端实例配置拼成 manager.js 期望的形状（它只读 snowluma.* 与顶层 botQQ）。
 *
 * @param {object} o
 * @param {() => object} o.config 返回平台端实例配置（ctx.config()）
 * @param {() => string} o.account  机器人号（whoami 之后才有；注入核对要用）
 * @param {object} o.log
 * @param {(password: string, auto?: boolean) => void} [o.savePassword] 写回控制台密码
 * @param {object} [o.managerFactory] 测试注入（默认真 manager）
 */
export function createSnowlumaSidecar({ config, account, log, savePassword, managerFactory = createSnowLumaManager }) {
  const cfg = () => config() || {}
  // manager.js 读 getConfig().snowluma.{dir,webuiPort,webuiPassword} 与顶层 botQQ / gateway
  const getConfig = () => {
    const c = cfg()
    return {
      botQQ: account() || '',
      gateway: 'snowluma',
      snowluma: {
        dir: String(c.snowlumaDir ?? c.dir ?? '').trim(),
        webuiPort: Number(c.snowlumaPort ?? c.webuiPort) || 15099,
        webuiPassword: String(c.snowlumaPassword ?? c.webuiPassword ?? ''),
      },
    }
  }
  const manager = managerFactory({ getConfig, log, savePassword })
  return {
    manager,
    /** 主人装好的那份在哪、什么版本。 */
    detect: () => detectInstall(getConfig().snowluma.dir),
    /** 从它的配置里读 OneBot HTTP/WS 地址（用户没手填 wsUrl/httpUrl 时用）。 */
    endpoint: () => readOneBotEndpoint(getConfig().snowluma.dir, getConfig().botQQ),
    /** 启动：已经在跑就复用，没跑就后台拉起（不弹窗）。 */
    start: () => manager.start(),
    /** 停：只停插件自己启动的那一个。 */
    stop: () => manager.stop(),
    /** OneBot 连上后核对登录的号是不是机器人号（不是就撤销注入并断开）。 */
    confirmLogin: (uin) => manager.confirmLogin(uin),
    /** 只给机器人号注入。 */
    attachBot: () => manager.attachBot(),
    /** DSH 退出时连带停掉自己启动的 SnowLuma。 */
    dispose: () => manager.dispose(),
  }
}

export { createSnowLumaManager, detectInstall, readOneBotEndpoint }
