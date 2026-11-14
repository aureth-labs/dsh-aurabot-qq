// 插件配置：默认值 + 归一化 + 读写。配置文件 ~/.dsh/plugins-data/aurabot/config.json

import { randomUUID } from 'node:crypto'
import { normalizeChatEfforts } from '../chat/effort-command.js'
import { dataDir, readJson, writeJson } from './store.js'
import { DEFAULT_GROUP_POLICY } from '../chat/group-policy.js'
import { LEVELS, PROFILE_PERM_KEYS, PROFILE_PERM_LEVELS, profilePermDefault } from '../chat/access.js'
import { normalizeChatModels } from '../chat/chat-model.js'
import { DELEGATED_COMMANDS, isDelegatedCommandKey } from '../chat/delegated-commands.js'
import { DIARY_AUDIENCES } from '../features/qzone-audience.js'
import { DEFAULT_TIER_DAYS } from '../features/memory-rules.js'

export const DEFAULTS = {
  enabled: false, // 总开关：关着一句都不发
  dryRun: true, // 试运行：只记日志不真发
  debug: false, // 调试：不真发 + 不写记忆/流水，只在日志里看（和试运行互斥）
  setupDone: false, // 首次使用向导走完了没有
  communityMigrated: {}, // 搬到社区库的模块处理过没有（id → installed / skipped / kept），只处理一次
  botQQ: '', // 机器人 QQ 号（向导里填）
  ownerQQ: '', // 主人 QQ 号（向导里填）
  ownerName: '主人',
  ownerLevel: 'full', // full | social | chat
  approvalNotify: true, // DSH 要授权时把请求发到主人私聊
  // 什么情况往主人 QQ 上报：enabled 是总开关，approval = 工具要授权，question = 她要向人提问选选项。
  // workspaces 按工作区单独覆盖：{ "<工作区路径>": { approval?: bool, question?: bool } }，没写的项跟随总开关。
  notice: { enabled: true, approval: true, question: true, workspaces: {} },
  qqApi: { enabled: true }, // 她能用 qq_api_call 调 QQ 接口：别人只能查当前群，写操作只听主人
  approvalViaQQ: true, // 主人私聊会话要授权时，在 QQ 回复「确认」直接批准这一次
  profilePerms: { qqNickname: 'owner', qqSignature: 'owner', qqAvatar: 'owner', biliSign: 'owner', biliAvatar: 'owner', biliComment: 'owner', qqFriendRequest: 'owner', whitelist: 'owner', douyinBrowse: 'owner', douyinLike: 'owner', douyinComment: 'owner', douyinShareOwner: 'owner', douyinDm: 'owner' }, // 改资料类操作（含抖音浏览 / 点赞 / 评论 / 分享）的权限：off 关 / owner 仅主人私聊 / all 所有人。抖音项默认仅主人，总开关默认关
  capabilityAllow: { image: [], song: [], video: [] },
  commandAllow: Object.fromEntries(DELEGATED_COMMANDS.map((name) => [name, []])),
  longTasks: true, // 长任务模式：主人私聊（完整权限）额外挂 dsh-tool-jobs + dsh-tool-schedule，会多一点工具定义、稍慢
  // 后台子智能体委派（默认关）：模块用 hub.runSubagentTurn 派子智能体时，正常要求「主人开口」的来源；
  // 定时任务这类没人应答的场合，只有打开这个开关才允许派活。关着 = 一律拒绝（一审 #177 的审批策略）。
  subagentBackground: false,
  allow: { private: [], groups: [] }, // 主人永远能私聊，不用写进白名单
  // 用什么接 QQ：snowluma = 插件帮你管 SnowLuma（Windows）；onebot = 接你已有的 OneBot v11 机器人（NapCat、LLOneBot、Lagrange、Docker 里的 SnowLuma……），
  // 这时只按下面 snowluma.httpUrl / wsUrl / token 去连，不启动、不注入任何东西
  gateway: 'snowluma',
  // 多平台（P0 起预留）：键是实例名（qq、qq#2、feishu……），值见 contracts.d.ts §9 InstanceConfig。
  // 现在还没有网关消费它——旧字段 gateway + snowluma.* 照常可读、行为不变；
  // normalize 时会把旧字段换算成 platforms.qq 一份（见下方 normalizePlatforms），G1 接手后以新字段为准。
  platforms: {},
  workspaceDir: '', // QQ 会话放在哪个文件夹（DSH 里的「Aurabot · QQ」工作区）；留空 = 默认（用户目录下 Aurabot\\qq-chats）
  // 发文件（#52）：默认开但限制很多——她只能把 QQ 工作区（workspaceDir）和 dirs 里列的目录中的文件当文件发出去；
  // 单个文件有大小上限；主人私聊里能触发，群里只在主人开口那一轮能触发（可以发给白名单里的人和群）。日志里会记下发了什么。
  // imageByPath（#169）：本地图片先按路径直发，被网关明确拒绝才改用 base64；网关和 NapCat 没共享挂载时会自动回退。
  files: { enabled: true, maxMB: 50, imageByPath: true, dirs: [] },
  // 危险命令确认（默认开）：她在私聊里执行删根目录/格式化/关机/下载后直接执行等
  // 终端命令前，先发 QQ 私聊问主人，回复「确认」才执行；超时或「取消」就拦下。
  // panelRemoteAccess：允许远端（非回环）访问管理接口；默认 false = 只有本机能管。
  // trustedProxy：可信反向代理地址（逗号分隔）；只有请求确实从这些地址进来，才采信
  //   X-Forwarded-For 的最后一跳作为真实来源。留空 = 从不相信任何转发头（最安全）。
  // publicHostname：面板经反代对外时的域名（如 panel.example.com），可填多个、逗号分隔；CSRF 同源校验把
  //   这个域名的 Origin 也算同源。留空 = 只有回环 Origin 算同源。
  security: { dangerConfirm: true, ssrfMode: 'strict', panelRemoteAccess: false, trustedProxy: '', publicHostname: '' },
  // 浏览器（全局）：useDshSidebar = 需要浏览器的模块（逛网页 / 刷抖音 / 小红书 / 小黑盒验证）
  // 连 DSH 侧边浏览器的共享实例（ego，画面在 DSH 右侧实时可见），不为每个模块各开一个独立窗口。
  browser: { useDshSidebar: false },
  // DeepSeek 峰谷省钱模式（默认关，现有行为不变）：打开后只把「不着急的后台模型调用」尽量挪到谷时，
  // 聊天回复/工具/审批/定时任务本身不变。offPeakHolidays 是中国法定节假日（北京时间日期 'YYYY-MM-DD'）。
  cost: { offPeak: false, offPeakHolidays: [] },
  update: { unstable: null }, // 订阅不稳定版本（beta、rc）；null = 没选过，按正在用的版本定
  snowluma: {
    dir: 'C:\\Aurabot\\snowluma', // 主人自己下载解压到这里（EULA 不允许自动部署）
    autoStart: true, // 随 DSH 启动它（只启动主人已安装并同意过协议的副本）
    webuiPort: 15099, // SnowLuma 控制台端口；5099 在开了 Hyper-V 的 Windows 上常落在系统保留段，默认改用 15099
    webuiPassword: '', // 插件自动生成并保存（第一次启动 SnowLuma 时）；用来调 /api/processes 只给机器人号注入
    passwordAuto: false,
    autoAttach: true, // 自动给机器人号所在的 QQ 进程注入（绝不碰别的号）
    httpUrl: '', // 留空 = 从 SnowLuma 配置里自动读
    wsUrl: '',
    httpToken: '',
    wsToken: '',
  },
  model: { provider: '', model: '', reasoningEffort: 'low', vision: 'auto' }, // 留空 = 跟随 DSH 默认；vision: auto/on/off
  // 按聊天选模型（主人在面板「模型」页设）：私聊 QQ 号 > 群号 > 所有私聊 / 所有群默认 > 上面的全局模型；没写的一级退到下一级
  chatEfforts: {}, // QQ 聊天单独选择的思考档位
  chatModels: { privateDefault: { provider: '', model: '', reasoningEffort: '' }, groupDefault: { provider: '', model: '', reasoningEffort: '' }, privates: {}, groups: {} },
  merge: { enabled: true, waitSec: 2.5, maxSec: 8, groupWaitSec: 5, groupMaxSec: 15 }, // 连发合并：对方停顿 waitSec 秒再一起回，最多等 maxSec 秒；群里等得久一点，把一段话攒齐
  forward: { expandEarly: false, expandHistory: false }, // 合并转发：expandEarly=消息一进来就展开成文字存进上下文（哪怕这条不交给她，代价是每条转发多调一次 get_forward_msg）；expandHistory=交给她之前把缓冲里还没展开过的转发补展开（每条只拉一次）
  imageGen: {
    enabled: false,
    provider: 'openai', // openai / custom；codex = 实验性订阅接法（需单独登录）
    baseUrl: '',
    baseUrlOptions: [], // 面板「服务地址」下拉里用户自己添加的常用地址（官方推荐的赞助商地址固定第一项，不存这里）
    apiKey: '',
    model: '',
    fallbackEnabled: false,
    fallbacks: [],
    size: '1024x1024',
    shape: 'her', // 工具可选构图；her 时未指定就沿用 size
    stylePrompt: '', // 每次生图自动加在前面的风格描述
    ownerOnly: true, // 只有主人能让她画
    seeOwn: true, // 「让她画完自己看一眼」：开着才把画好的图交给她看
    img2img: true, // 允许参考聊天图片 / 自己的画作来改画
    galleryShown: 20, // 面板「她的画作」显示最近几张（1~50；只影响显示，不删文件）
    // 自定义接法：url 里可以用 {prompt} {model} {size} {width} {height} {image}（参考图 base64）；params 是参数名/值（值里也能用这些占位符）
    custom: { method: 'GET', url: '', bodyType: 'json', responsePath: '', params: [] },
    // 实验性订阅接法；登录令牌独立保存在数据目录，不进入配置。
    codex: { model: 'gpt-image-2', quality: 'auto', background: 'auto' },
  },
  persona: { current: 'dafeiyu' },
  // 主人私聊里问起群里的事：把最近 24 小时的群聊流水补进这一轮（默认关，开启前先把群加进白名单）
  group: { ...DEFAULT_GROUP_POLICY, overrides: {}, ownerTools: 'off', ownerToolsGroups: [], ownerBrief: { enabled: true, lines: 24, groups: [] } },
  // 按群头衔不回：勾选的群里，专属头衔正好是 title 的成员（一般是别的机器人）说话、戳她都不理。没勾群就不起作用
  titleFilter: { enabled: true, groups: [], title: '大肥鱼' },
  voice: {
    enabled: true,
    // auto = 先 edge-tts，不行用 Windows 语音；edge / windows / cosyvoice / gptsovits / volcano / breeze / minimax / http = 指定引擎（失败都会退回 Windows 语音）
    engine: 'auto',
    cosyvoice: { url: 'http://127.0.0.1:50000', mode: 'sft', spkId: '中文女', instruct: '', sampleRate: 22050 },
    gptsovits: { url: 'http://127.0.0.1:9880', refAudio: '', promptText: '', promptLang: 'zh', textLang: 'zh' },
    // 通用 HTTP 引擎：GET 时地址里带 {text}；POST 时填接口地址，请求头一行一个，请求体里 {text} 自动替换（已做 JSON 转义）
    http: { urlTemplate: '', method: 'GET', headers: '', body: '', sampleRate: 24000 },
    // 豆包语音（火山引擎）预设：地址、请求头、请求体全内置，只留 API Key + 音色给人填
    // resourceId 留空 = 按音色自动配（1.0 音色配 seed-tts-1.0，2.0 音色配 seed-tts-2.0）
    volcano: { apiKey: '', resourceId: '', voiceType: 'zh_female_vv_uranus_bigtts', speedRatio: 1 },
    // Breeze 语音：cloud 走 BreezeBlue（`POST {url}/v1/text-to-speech/{音色id}` + xi-api-key），
    // local 走本机自建 breeze_infer（`POST {url}/v1/audio/speech` 的 multipart 表单）；语气写在 instructions 里（中文）。
    breeze: {
      mode: 'cloud',
      url: 'https://api.breeze.blue',
      // 站点：登录 / 领每日额度走这里（跟合成接口不是同一个域名）
      siteUrl: 'https://breezeblue.ai',
      key: '',
      // 云端额度：填了邮箱密码 + 打开自动领取，就每小时醒一次去领（一天最多一次）
      email: '',
      password: '',
      autoClaim: true,
      voiceId: '',
      model: 'breeze-tts-2',
      languageCode: 'zh',
      instructions: '',
      outputFormat: 'mp3_24000_128',
      guidanceScale: 0,
      timeoutMs: 60000,
    },
    // MiniMax 语音：开放平台「接口密钥」+ 音色库里的 Voice ID（也能填声音设计 / 复刻的自定义 id）；
    // emotion 留 auto 就不传，交给模型按文字自己匹配
    minimax: { apiKey: '', baseUrl: 'https://api.minimax.cn', voiceId: 'Chinese (Mandarin)_Soft_Girl', model: 'speech-2.8-turbo', emotion: 'auto', speed: 1, pitch: 0 },
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+0%',
    pitch: '+0Hz',
    autoChance: 0.15, // 短回复自动变语音的概率
    autoMaxChars: 80,
    asr: true, // 听语音
    // 云端语音识别（可选）：OpenAI 兼容 /audio/transcriptions；provider 为空 = 不用。
    // prefer=qq 时顺序是 本地 → QQ 自带 → 云端 → DSH；prefer=cloud 时云端提前到 QQ 前面。
    asrApi: { provider: '', baseUrl: '', model: '', apiKey: '', language: '', prefer: 'qq' },
    emojiSeparate: true, // 语音条里的表情/emoji 不念出来，单独补一条文字发出去
    // 语音条变声：用翻唱里导入的 RVC 音色模型（先 TTS 念，再变声）。留空 = 不变声
    songVoice: '',
    songPitch: 0, // 变调半音：男声模型转女声一般 +12
  },
  stickers: {
    enabled: true,
    faces: true, // 回复里能夹 QQ 自带的小黄脸（<face:名字>）
    autoChance: 0.35, // 文字回复自动配一张表情的概率
    // 主动给对方的原消息贴 QQ 表情：这是新行为，默认关；开了之后按自己的概率算，
    // 不从 autoChance 取值（两者是不同动作，隐式联动会让升级后的人莫名其妙被贴表情，#216 review）
    react: false, // 主动贴表情总开关，默认关
    reactChance: 0.15, // 主动贴表情的概率，独立默认值
    reactMaxPerHour: 10, // 每个会话每小时最多主动贴几次
    collect: true, // 偷表情
    // 怎么偷：auto = 看到就收（默认，保持原行为）；ask = 她挑（先记着，喜欢才凭编号收）；owner = 只听主人的（只有主人语境下才提示/允许收）
    collectMode: 'ask',
    fromGroups: true,
    fromPrivate: true,
    maxPerHour: 20,
    maxLibrary: 300, // 表情库最多存多少张（QQ 收藏表情有上限），超了就清掉最少用的
    caption: true, // 用视觉模型起备注
    // 起名单独挑的模型：{ provider, model }；留空 = 跟随聊天用的模型
    captionModel: { provider: '', model: '' },
  },
  diary: {
    enabled: true,
    timesPerDay: 2,
    windowStart: '10:00',
    windowEnd: '23:30',
    minGapMinutes: 180,
    attachImage: true, // 写日记时配一张图（优先今天她画的，其次今天收的表情包）
    // 可选图文日记：关着时沿用原来的聊天摘录和配图流程；本地目录必须由主人填写。
    rich: { enabled: false, stickers: false, browsing: false, local: false, folder: '', maxImages: 2 },
    archive: { enabled: false, folder: '' }, // 已有公开浏览图按浏览日期归档；必须由主人指定输出目录
    minChars: 60,
    maxChars: 140,
    visibility: 'all', // all | friends | selected | self | excluded，和 QQ 空间自身的可见范围一致
    audienceQQs: '', // selected / excluded 时可见（或不可见）的好友 QQ 号，换行或逗号分隔
  },
  // 本地接口：数据目录 local/ 里的脚本接管这几项（文件要在、开关要开）
  local: { tts: false, image: false, song: false, asr: false, video: false, videoTimeoutMin: 20 },
  bili: {
    enabled: false,
    sessdata: '', // B 站 Cookie 里的 SESSDATA（登录凭证）
    biliJct: '', // B 站 Cookie 里的 bili_jct（发评论要用）。两个都不填也能看视频，只是不能评论
    buvid3: '', // 设备指纹之一：扫码登录时跟票一起发下来，重启后要沿用同一个，不然容易被风控
    buvid4: '', // 设备指纹之一：跟 buvid3 配套，一起发下来、一起保存
    dedeUserId: '', // 这个号自己的 UID（Cookie 里的 DedeUserID），跟票绑在一起
    ownerName: '', // 主人的 B 站昵称：她写 @主人 时 @ 这个号
    cookie: '', // 由上面几个拼出来给接口用；老配置的整串会自动拆到上面几个里
    autoBrowse: true, // 定时自己去刷
    intervalHours: 4, // 多久刷一轮
    maxRunsPerDay: 3,
    perRun: 3, // 一轮看几个视频
    keywords: [], // 额外想让她搜的方向（另外还会参考她的兴趣和记忆里你喜欢的东西）
    minViews: 5000, // 播放量门槛
    maxAgeDays: 60, // 只看最近多少天发的
    comment: true, // 自己发评论
    maxCommentsPerDay: 3,
    reply: true, // 回别人回她的评论
    maxRepliesPerDay: 6,
    danmakuEnabled: false, // 主人主动打开后才允许发送弹幕
    autoDanmaku: false, // 刷完自己发弹幕，另行开启
    maxDanmakuPerDay: 3, // 手动和自动共用提交上限（失败也计数）
    shareToOwner: true, // 看到好玩的私聊分享给主人
    like: false, // 顺手点赞
    vision: false, // 可选：ffmpeg 抽帧交给视觉模型
    visionFrames: 6,
    ffmpegPath: '', // 留空从 PATH 查找
    shotChance: 0.35, // 刷完发截图给主人；0 = 不自动发
    shotLibrary: 300,
    // 想发到群里的时候不直接发：先攒成待批，私聊问主人「发几号」。默认关，开了才考虑。
    groupShare: {
      enabled: false, // 默认关：开了才会把想发群的攒起来问主人
      groupId: '', // 目标群号；空 = 不生效。生产群号留在部署侧 config.json，不进默认值（上游开源）
      dailyLimit: 3, // 每天最多真发几条到群
      pendingTtlHours: 24, // 待批多久没回就当不发
      queueLimit: 1, // 一次最多攒几条待批：默认 1，一次只问一条、只发一条（发多了像刷屏）
    },
  },
  // 刷抖音：专用浏览器（独立登录资料，不碰你平时的浏览器），经 CDP 控制。浏览 / 点赞 / 评论 / 分享各项权限在 profilePerms.douyin*。
  douyin: {
    enabled: false, // 总开关：默认关，先在面板里扫码登录再打开
    autoBrowse: true, // 定时自己去刷
    intervalHours: 4,
    maxRunsPerDay: 3,
    perRun: 5, // 一轮看几个视频
    maxWatchPerDay: 30, // 每天最多看几个（手动让她刷也算；主人亲口让她找视频时不受这个限制）
    dwellMin: 8, // 每个视频停留的秒数（随机取一个）
    dwellMax: 40,
    browserPath: '', // 留空 = 自动找 Edge（找不到再找 Chrome / Chromium）；也可填完整路径
    shareBias: 'proactive', // stingy | normal | proactive：刷到好看的视频，分享给主人的积极程度
    ownerDm: true, // 主人在抖音上私信她时回（只认核对过的主人抖音号）
    dmPollMinutes: 3, // 隔几分钟看一次主人的抖音私信
    shareTo: 'douyin', // douyin = 在抖音里私信分享给主人（要先核对主人抖音号，没核对 / 发不出去就改发 QQ）| qq = QQ 私聊发链接 | both = 两边都发
    owner: { input: '', secUid: '', uid: '', nickname: '', confirmedInput: '' }, // 主人的抖音号：面板填抖音号 / 主页链接，「核对」后才写入 secUid（真·@主人只认它）
    caps: { like: 30, comment: 3, share: 5, atOwner: 3 }, // 每天上限（登录后前 newAccountDays 天减半）；atOwner = 评论里真·@主人
    gate: {
      maxWritesPerDay: 40, // 点赞 + 评论合计上限
      minWriteGapSec: 20, // 两次点赞 / 评论之间至少隔这么多秒
      newAccountDays: 3, // 首次登录起这么多天内，上限都减半
    },
  },
  // 刷小黑盒：用主人的账号逛游戏社区（读多写少）。点赞 / 评论 / 发帖各项权限在 profilePerms.heybox*。
  heybox: {
    enabled: false, // 总开关：默认关，先在面板里填 Cookie 再打开
    cookie: '', // 整串 Cookie（pkey 必须有；要写操作还得有 x_xhh_tokenid）
    autoBrowse: true, // 定时自己去逛（只读）
    intervalHours: 4, // 多久逛一圈
    maxRunsPerDay: 6, // 每天最多逛几轮
    perRun: 3, // 一圈看几条
    likeDaily: 10, // 每天最多点赞
    commentDaily: 3, // 每天最多评论
    maxPostsPerDay: 3, // 每天最多发帖（硬上限，多了容易被限）
    defaultTopic: 7214, // 发帖默认分区：7214 盒友杂谈 / 18745 数码硬件 / 806933 AI
    postStyle: 'mix', // 发帖风格：diary 大肥鱼日记 / news 热搜文 / mix 肥鱼热搜
    shareToOwner: true, // 逛到有意思的帖子，私聊分享给主人（和 B 站同一个思路）
    shareBias: 'normal', // stingy | normal | proactive：分享给主人的积极程度
    shareDaily: 3, // 每天最多分享几条（避免刷屏）
    // 谷时逛：只在非峰时跑自动逛，避开工作日 9-12 / 14-18 的高峰，省 token
    // 分区：manual = 总是用默认分区；auto = 按正文内容自动挑（挑不到回落默认）
    topicMode: 'manual',
    // 发帖字数范围：0 = 用风格自带的；填了就覆盖（对所有风格生效）
    postWordsMin: 0,
    postWordsMax: 0,
    // 每天每篇的排期：空数组 = 用全局设置；填几项就按几篇发，每篇用自己的配置
    dailyPosts: [],
    offPeakOnly: false, // 开关：默认关（行为不变）
    peakStartAM: 9, // 上午峰时开始（含）
    peakEndAM: 12, // 上午峰时结束（不含）
    peakStartPM: 14, // 下午峰时开始（含）
    peakEndPM: 18, // 下午峰时结束（不含）
    peakWeekend: false, // 周末是否也算峰时（默认不算，周末全天可逛）
  },
  qzoneSocial: {
    enabled: true,
    replyOwn: true, // 回复自己说说下别人的新评论
    commentFriends: true, // 逛好友动态，偶尔评论
    friendChance: 0.3, // 看到一条好友说说时互动（点赞 + 可能评论）的概率
    ownerChance: 0.7, // 主人的说说互动概率
    like: true, // 互动时顺手点赞
    maxPerDay: 8, // 每天最多评论几条（点赞不算）
    intervalMin: 30, // 多久逛一次空间
  },
  speakUp: {
    enabled: true, // 只在和主人的私聊里主动找你，群里不会
    idleMinutes: 40,
    minIntervalMinutes: 60,
    maxIntervalMinutes: 180,
    maxPerDay: 20, // 每个人每天最多几次；留空就是 20
    allow: [], // 主动搭话白名单：除主人外还会主动找谁（QQ 号）
    nudge: true, // 她问了你一句、你一直没回时，偶尔轻轻追一句
    awakeFrom: 8,
    awakeTo: 23,
  },
  mood: { enabled: true, halfLifeHours: 3, judge: false, base: 60 }, // base：心情基线（0~100 里算「平常」的那个值）；judge：每轮聊完用模型判一次心情（更准，每轮多一次很短的调用）；关着用关键词
  // seedHistory：新会话第一次说话时先补最近几条历史（默认关）
  // everyStep：一轮里她分几段说就发几条（默认关 = 只发最后一段）。私聊多是闲聊，连着说的几句可能是不同话题，
  //   只发最后一段会让人以为她只回了一个话题；干活时前面多是工具调用前后的过程话，开着会显得啰嗦
  // rescueFromThinking：整轮一段正文都没写时，从思考里捞出她自己定稿的那段（默认关，捞不到就不发）
  // turnTimeoutMinutes：一轮跑超过这么多分钟就强制放开（模型/工具卡死时 turn/end 永远不来，
  // 私聊新消息会被一直当成 steer 塞进那一轮，看上去就是「不理人」）。填 0 关掉兜底。
  // thinkingGuard：出站前的正文污染闸。模型偶尔把思考直接写进正文（英文判断 + 中文真话），
  //   或者思考塌缩成「做。做。做。…」。开着就切掉思考前缀、拦住退化内容；拦下就当她这轮没说话（默认开）。
  // replyMarker：代码注入格式要求，模型必须用 ⟦REPLY⟧ 包住要发的话；没有标记就要求重写一次，
  //   重写后仍然没有就不发。默认关：打开会改变所有会话的输出格式，先在面板/配置里手动开。
  chat: { seedHistory: false, seedHistoryCount: 20, everyStep: false, rescueFromThinking: false, turnTimeoutMinutes: 30, thinkingGuard: { enabled: true }, replyMarker: { enabled: false } },
  // 原话档案独立于摘要记忆；默认关闭，由使用者明确开启并管理保留期限。
  conversationContext: { enabled: false },
  memory: {
    enabled: true, recallCount: 6, recallMinRelevance: 0, recallMode: 'always', recallTriggers: ['上次', '上回', '之前', '以前', '那天', '那次', '还记得', '记不记得', '说过', '提过', '答应', '约好', '那时候'],
    dailyConsolidate: true, consolidateTimes: ['04:00', '16:00'], keepChatlogDays: 7, keepChatlogSet: false, mergeGroups: false, compress: true, compressAfterDays: 14, instantCommands: true, groupMemory: true, searchRrf: true,
    profileOnlyAcquainted: true, profileFieldChars: 40, profilePeople: 2, profileChars: 240, chatImpression: true, chatImpressionChars: 120, dislikeSilence: 0.85,
    followUp: true, // 惦记尚无结果的重要事，主动聊天时顺口问问
    shortTerm: true, shortTermHours: 2, shortTermIdleMinutes: 3, shortTermChars: 150,
    gistEnabled: true, gistDays: 180, impressionDays: 365, gistDailyBatches: 6, tierDays: { ...DEFAULT_TIER_DAYS },
    extractIdleMinutes: 30, extractMinLines: 20, extractDailyBatches: 24, capacity: { auto: 2000, event: 600, diary: 400 }, eventExpireDays: 90, vector: {
      enabled: false,
      // provider 只影响面板预置的地址/模型；请求统一走 OpenAI 兼容的 {baseUrl}/embeddings
      provider: 'siliconflow',
      baseUrl: '',
      model: '',
      apiKey: '',
      dimensions: 0, // 0 = 不传；Qwen3 / OpenAI 的 MRL 模型可以截断
      batchSize: 10, // 方舟等单次 input 上限小，10 最稳
      queryTimeoutMs: 3000,
      headers: '', // 自定义请求头，一行一个；有 Authorization 时不再自动加 Bearer
    },
    // 可选精排：对已经过滤好的候选重新打分；失败/超时回退原顺序
    rerank: {
      enabled: false,
      baseUrl: '', // 留空复用 vector.baseUrl
      model: 'BAAI/bge-reranker-v2-m3',
      apiKey: '', // 留空复用 vector.apiKey
      topN: 20,
      timeoutMs: 2000,
    },
    // 向量联想（记忆联想）：按意思给记忆建边，召回时最多带 3 条；支持多跳（A→B→C）但封顶。
    assoc: { enabled: true, minSim: 0.45, limit: 4, recall: 3, hops: 2, hopDecay: 0.55 },
    // 真正交给模型的记忆条数：直接命中几条 + 联想几条（各自独立上限，最后合起来进上下文）。
    // recallCount 是「直接命中」的上限；recallTotal 是总数护栏（0 = 不额外限制）。
    recallTotal: 0,
    // 行为驱动的档位升档：被想起的天数 + 时间把 importance 慢慢涨上去，够门槛就升档。
    // assocPerHitDay：几次联想折算成「想起来一天」（联想也算加深，但比直接命中轻）。
    tierGrow: { enabled: true, perDay: 0.02, minHitDays: 3, cap: 0.85, assocPerHitDay: 2, tier2: { hitDays: 5, imp: 0.6 }, tier3: { hitDays: 10, imp: 0.75 } },
    // 遗忘曲线的时间基数（天）。默认 20：普通记忆约 60 天才淡忘，长期用不容易「刚说过就忘」。
    // 调到 8 左右更像人类（1 天后剩 75%、1 个月后剩 5%），但记住的东西会明显变少。
    retentionBase: 20,
    // beta 侧新增：本地保留配置 + 面板折叠状态
    residentMaxChars: 1200, preferPersonal: true,
    // 面板「记忆库」里四组进阶设置的折叠状态（true = 收起）；改动会立即写回配置文件
    uiCollapsed: { people: true, tiers: true, vector: true, rerank: true },
  }, // residentMaxChars / preferPersonal 为本地保留配置；extractIdleMinutes 为 0 时关闭空闲提炼；手动记忆不受容量限制
  song: {
    enabled: false,
    root: '', // 翻唱环境目录，留空 = 自动（老安装 C:\Aurabot\rvc，新安装在用户目录下）
    voice: '', // 用哪个音色（models 目录里的 .pth 文件名），留空 = 第一个
    pitch: 0, // 默认变调（半音）；她点歌时会按原唱是男声还是女声自己定
    neteaseCookie: '', // 网易云 Cookie（MUSIC_U），下会员歌用
    separatorModel: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt', // 人声分离模型
    maxVoiceSec: 120, // 语音条最长多少秒，歌更长就截一段
    clipStart: 'auto', // auto = 从副歌附近截；head = 从头截
    vocalVolume: 1,
    instVolume: 0.8,
    ownerOnly: true, // 只有主人能点歌
    keepWork: false, // 留着中间文件（调试用）
    pypiMirror: 'auto', // 安装时用的下载源：auto = 先测一下，官方源慢就用国内镜像；cn = 一直用国内镜像；off = 只用官方源
  },
  // 云备份：每天到点自动打包并把最新备份推到 Gitee 私有仓库（走本机 git）或 WebDAV
  backup: {
    remote: {
      enabled: false, // 到点自动「打包 + 推送」；关了就只剩面板手动推
      provider: 'gitee', // gitee | webdav
      // WebDAV：填服务器地址（自动建 aurabot-backups），密码按密钥处理
      webdav: { url: '', username: '', password: '', configOnly: true },
      owner: '', // Gitee 用户名
      repo: '', // 仓库名（没有的话推送时按 autoCreate 自动建私有的）
      token: '', // 私人令牌（要 projects + repo 权限），存配置时按密钥处理
      branch: 'master', // 推到哪个分支
      time: '03:30', // 每天几点自动备份并推送
      keep: 7, // 远端保留最近几份
      autoCreate: true, // 远端没有这个仓库时自动建一个私有的
      forceOverwrite: false, // 允许覆盖「已有内容但不是本工具推的」仓库（清空远端历史重推）：面板显式勾选才开
    },
  },
  tabs: {}, // 面板记住的小偏好
  // 模块：内置的和数据目录 modules/ 里自己写的。{ 模块id: { enabled, useBuiltin } }，没写的算开着
  // useBuiltin：自己写了同名模块，但想先用回内置的
  modules: {},
  safeMode: false, // 安全模式：自己写的模块一个都不加载（排查问题用）
  ext: {}, // 自己写的模块的设置：{ 模块id: {...} }
  // token 用量与花费：面板「概览」里看。pricing 留空就用内置价目表（DeepSeek 官方价 + 其它厂商按 LiteLLM 价 ×7.2）；
  // 要覆盖就写 { models: { "我的模型": { match: "^my-llm-", in: 2, out: 8, cached: 0.5 } } }（元/百万 tokens）
  usage: { pricing: {} },
  // 联动：让别的程序、DSH 里别的会话和插件也能用她
  bridge: {
    dshTools: false, // DSH 里别的会话（比如你平时写代码的会话）能用工具让她发 QQ、查记忆
    http: false, // 开放 HTTP 接口（要带密钥）
    token: '', // 第一次打开时自动生成
    allowTargets: 'whitelist', // 外部能发给谁：whitelist = 白名单里的人和群；owner = 只能发给主人
  },
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function deepMerge(base, over) {
  if (!isObj(over)) return structuredClone(base)
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v)
    else if (v !== undefined) out[k] = v
  }
  return out
}

const BIG = 1e6 // 没有天然上限的数值：只防手滑填出离谱值，不当真限制
const num = (v, d, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const qq = (v) => String(v ?? '').replace(/\D/g, '')
const qqList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,，;；]+/)).map(qq).filter(Boolean))]
const hhmm = (v, d) => (/^\d{1,2}:\d{2}$/.test(String(v)) ? String(v) : d)
// 严格校验 'YYYY-MM-DD'（面板手填/配置文件手改都可能乱），非法日期当没填。
const dateKey = (v) => {
  const s = String(v ?? '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return ''
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? s : ''
}
// 请求头：正常是字符串（一行一个）；手写成对象 / 数组时展开成同样的多行文本，
// 免得下游按行解析时认不出来，静默把头全丢掉。
const headerLines = (v) => {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((x) => String(x ?? '')).join('\n')
  if (isObj(v)) return Object.entries(v).map(([k, x]) => `${k}: ${x ?? ''}`).join('\n')
  return v == null ? '' : String(v)
}
// 请求体：正常是字符串；手写成对象 / 数组时序列化回去（占位符 {text} / {reqid} 照样能替换）
const bodyText = (v) => {
  if (typeof v === 'string') return v
  if (isObj(v) || Array.isArray(v)) return JSON.stringify(v, null, 2)
  return v == null ? '' : String(v)
}

// 上报开关：总开关 + 按工作区的覆盖。工作区路径原样当键（调用方会先规范化），
// 覆盖项只认布尔值，别的（0、''、null）一律当「没写」，跟随总开关。
function normalizeNotice(v, legacyNotify) {
  const o = isObj(v) ? v : {}
  const approvalDefault = legacyNotify === false ? false : true
  const out = { enabled: bool(o.enabled, true), approval: typeof o.approval === 'boolean' ? o.approval : approvalDefault, question: bool(o.question, true), workspaces: {} }
  const ws = isObj(o.workspaces) ? o.workspaces : {}
  for (const [key, val] of Object.entries(ws)) {
    const path = String(key || '').trim()
    if (!path) continue
    const w = isObj(val) ? val : {}
    const item = {}
    if (typeof w.approval === 'boolean') item.approval = w.approval
    if (typeof w.question === 'boolean') item.question = w.question
    out.workspaces[path] = item
  }
  return out
}

// 旧字段 → platforms.qq 的读入换算（P0）：gateway + snowluma.{httpUrl,wsUrl,httpToken,wsToken,dir,…}
//   → platforms.qq.{enabled, backend, wsUrl, httpUrl, httpToken, wsToken, dir,…}。
// 只做读入派生：旧字段原样保留、现有代码仍读旧字段，行为不变；G1 起以新字段为准。
// 用户已手写 platforms.qq 时以用户的为准，不覆盖。
function normalizePlatforms(raw, gateway) {
  const out = {}
  const written = isObj(raw?.platforms) ? raw.platforms : {}
  // 用户手写的实例原样保留（enabled、caps、behavior、平台设置都不动）
  for (const [k, v] of Object.entries(written)) if (isObj(v)) out[k] = { ...v }
  if (!out.qq) {
    const s = isObj(raw?.snowluma) ? raw.snowluma : {}
    const qq = { enabled: bool(raw?.enabled, false), backend: gateway === 'onebot' ? 'onebot' : 'snowluma' }
    for (const key of ['httpUrl', 'wsUrl', 'httpToken', 'wsToken', 'dir', 'webuiPort', 'webuiPassword']) {
      if (s[key] !== undefined) qq[key] = s[key]
    }
    out.qq = qq
  }
  return out
}

export function normalize(raw) {  const c = deepMerge(DEFAULTS, raw)
  c.enabled = bool(c.enabled, false)
  c.dryRun = bool(c.dryRun, true)
  c.debug = bool(c.debug, false)
  if (c.debug) c.dryRun = true
  c.conversationContext = { enabled: bool(c.conversationContext?.enabled, false) }
  c.botQQ = qq(c.botQQ)
  c.ownerQQ = qq(c.ownerQQ)
  c.approvalNotify = bool(c.approvalNotify, true)
  // 老配置只有 approvalNotify：没写过 notice 时用它当审批上报的默认值，免得更一次版本被重新打开
  c.notice = normalizeNotice(isObj(raw?.notice) ? raw.notice : null, raw?.approvalNotify)
  c.approvalViaQQ = bool(c.approvalViaQQ, true)
  c.qqApi.enabled = bool(c.qqApi.enabled, true)
  c.gateway = c.gateway === 'onebot' ? 'onebot' : 'snowluma'
  c.platforms = normalizePlatforms(raw, c.gateway)
  // 只认绝对路径（Windows 的 D:\\… 或 Linux 的 /…），别的当没填
  c.workspaceDir = String(c.workspaceDir || '').trim()
  if (c.workspaceDir && !/^([a-zA-Z]:[\\/]|\/)/.test(c.workspaceDir)) c.workspaceDir = ''
  // 视觉能力：auto = 问 DSH 的模型元数据；on / off = 主人手动声明（覆盖元数据）
  c.model.vision = c.model.vision === 'on' || c.model.vision === 'off' ? c.model.vision : 'auto'
  c.setupDone = bool(c.setupDone, false)
  c.ownerLevel = LEVELS.includes(c.ownerLevel) ? c.ownerLevel : 'full'
  c.longTasks = bool(c.longTasks, true)
  c.subagentBackground = bool(c.subagentBackground, false)
  c.chatModels = normalizeChatModels(c.chatModels)
  c.chatEfforts = normalizeChatEfforts(c.chatEfforts)
  c.profilePerms = Object.fromEntries(PROFILE_PERM_KEYS.map((k) => [k, PROFILE_PERM_LEVELS.includes(c.profilePerms?.[k]) ? c.profilePerms[k] : profilePermDefault(k)]))
  c.capabilityAllow = Object.fromEntries(['image', 'song', 'video'].map((key) => {
    const ids = Array.isArray(c.capabilityAllow?.[key]) ? c.capabilityAllow[key] : []
    return [key, [...new Set(ids.map(String).map((id) => id.trim()).filter((id) => /^\d{5,}$/.test(id)))]]
  }))
  const commandKeys = [...new Set([...DELEGATED_COMMANDS, ...Object.keys(c.commandAllow || {}).filter(isDelegatedCommandKey)])]
  c.commandAllow = Object.fromEntries(commandKeys.map((key) => {
    const ids = Array.isArray(c.commandAllow?.[key]) ? c.commandAllow[key] : []
    return [key, [...new Set(ids.map(String).map((id) => id.trim()).filter((id) => /^\d{5,}$/.test(id)))]]
  }))
  // 旧版 douyinDm 是「回别人私信」的权限，含义已不同（现在是主动发私信），老配置一律回到默认「仅主人」
  if (isObj(raw?.profilePerms) && 'douyinDm' in raw.profilePerms) c.profilePerms.douyinDm = profilePermDefault('douyinDm')
  c.allow = { private: qqList(c.allow.private), groups: qqList(c.allow.groups) }
  // 发文件：开关、大小上限、额外允许的目录（只认绝对路径；空行忽略）
  if (!isObj(c.files)) c.files = {}
  if (!isObj(c.security)) c.security = {}
  c.security.dangerConfirm = bool(c.security.dangerConfirm, true)
  c.security.ssrfMode = c.security.ssrfMode === 'loose' ? 'loose' : 'strict'
  // 远端管理开关与可信反代：放 security 段（顶层对象，不会被下面「ext 只留对象」的规则删掉）
  c.security.panelRemoteAccess = bool(c.security.panelRemoteAccess, false)
  c.security.trustedProxy = String(c.security.trustedProxy || '').trim()
  c.security.publicHostname = String(c.security.publicHostname || '').trim().toLowerCase()
  // 浏览器后端开关（老配置没有 browser 段也要补出默认值）
  if (!isObj(c.browser)) c.browser = {}
  c.browser.useDshSidebar = bool(c.browser.useDshSidebar, false)
  // DeepSeek 峰谷省钱模式：默认关；节假日列表去重、只留合法的 'YYYY-MM-DD'（北京时间日期）
  if (!isObj(c.cost)) c.cost = {}
  c.cost.offPeak = bool(c.cost.offPeak, false)
  const rawHolidays = Array.isArray(c.cost.offPeakHolidays) ? c.cost.offPeakHolidays : String(c.cost.offPeakHolidays || '').split(/[\n,，;；\s]+/)
  c.cost.offPeakHolidays = [...new Set(rawHolidays.map(dateKey).filter(Boolean))].sort().slice(0, 60)
  c.update = { unstable: typeof c.update?.unstable === 'boolean' ? c.update.unstable : null }
  c.files.enabled = bool(c.files.enabled, true)
  c.files.maxMB = num(c.files.maxMB, 50, 1, BIG)
  c.files.imageByPath = bool(c.files.imageByPath, true)
  c.files.dirs = (Array.isArray(c.files.dirs) ? c.files.dirs : String(c.files.dirs || '').split(/[\n,，;；]+/))
    .map((s) => String(s).trim()).filter((s) => /^([a-zA-Z]:[\\/]|\/)/.test(s)).slice(0, 20)
  const g = c.group
  g.wakeWords = (Array.isArray(g.wakeWords) ? g.wakeWords : String(g.wakeWords || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean)
  g.interjectChance = num(g.interjectChance, 0.15, 0, 1)
  g.cooldownSec = num(g.cooldownSec, 90, 0, BIG)
  g.maxPerHour = num(g.maxPerHour, 6, 0, BIG)
  g.mustMaxPerHour = num(g.mustMaxPerHour, 100, 0, BIG)
  g.minRecentMessages = num(g.minRecentMessages, 3, 0, BIG)
  g.activeWindowSec = num(g.activeWindowSec, 300, 1, BIG)
  if (!Array.isArray(g.quietHours) || g.quietHours.length !== 2) g.quietHours = DEFAULT_GROUP_POLICY.quietHours
  g.quietHours = g.quietHours.map((h) => num(h, 0, 0, 23))
  if (!isObj(g.overrides)) g.overrides = {}
  if (!isObj(g.ownerBrief)) g.ownerBrief = { enabled: true, lines: 24, groups: [] }
  g.ownerBrief.enabled = bool(g.ownerBrief.enabled, true)
  g.ownerBrief.lines = num(g.ownerBrief.lines, 24, 1, 30)
  g.ownerBrief.groups = qqList(g.ownerBrief.groups)
  // 群聊里的本机工具：默认关；只有明确写了 owner 才开（all 已移除，写 all 也按 off 处理）
  g.ownerTools = g.ownerTools === 'owner' ? 'owner' : 'off'
  g.ownerToolsGroups = qqList(g.ownerToolsGroups)
  c.voice.autoChance = num(c.voice.autoChance, 0.15, 0, 1)
  c.voice.autoMaxChars = num(c.voice.autoMaxChars, 80, 1, BIG)
  c.voice.emojiSeparate = c.voice.emojiSeparate !== false
  // 通用 HTTP 引擎（接火山 / 阿里 / 讯飞这类云 TTS）：method 只认 GET / POST，其余当 GET；
  // 地址、请求头、请求体一律转成字符串——手改 config.json 写成对象、数组或数字时，也按原意
  // 拼得出去，不会变成 "[object Object]" 或者带着填错的空格。
  if (!isObj(c.voice.http)) c.voice.http = structuredClone(DEFAULTS.voice.http)
  c.voice.http.urlTemplate = String(c.voice.http.urlTemplate ?? '').trim()
  c.voice.http.method = String(c.voice.http.method ?? '').trim().toUpperCase() === 'POST' ? 'POST' : 'GET'
  c.voice.http.headers = headerLines(c.voice.http.headers)
  c.voice.http.body = bodyText(c.voice.http.body)
  c.voice.http.sampleRate = num(c.voice.http.sampleRate, 24000, 8000, 48000)
  // 豆包预设：Key 去两端空白并限长（粘整段文件时不会把整个配置撑爆），音色 id 也限长；
  // resourceId 只认这两个合法值，填别的当没填（留空时按音色自己认）
  if (!isObj(c.voice.volcano)) c.voice.volcano = structuredClone(DEFAULTS.voice.volcano)
  c.voice.volcano.apiKey = String(c.voice.volcano.apiKey ?? '').trim().slice(0, 400)
  c.voice.volcano.voiceType = String(c.voice.volcano.voiceType ?? '').trim().slice(0, 120) || DEFAULTS.voice.volcano.voiceType
  c.voice.volcano.resourceId = ['seed-tts-1.0', 'seed-tts-2.0'].includes(String(c.voice.volcano.resourceId))
    ? String(c.voice.volcano.resourceId)
    : ''
  c.voice.volcano.speedRatio = num(c.voice.volcano.speedRatio, 1, 0.5, 2)
  // Breeze 语音：地址 / 音色 id / 语气说明；Key 不回显（publicConfig 里换成 keySet）
  if (!isObj(c.voice.breeze)) c.voice.breeze = structuredClone(DEFAULTS.voice.breeze)
  const bz = c.voice.breeze
  bz.mode = ['cloud', 'local'].includes(String(bz.mode)) ? String(bz.mode) : 'cloud'
  bz.url = String(bz.url ?? '').trim().slice(0, 400) || DEFAULTS.voice.breeze.url
  bz.key = String(bz.key ?? '').trim().slice(0, 400)
  bz.voiceId = String(bz.voiceId ?? '').trim().slice(0, 200)
  bz.siteUrl = String(bz.siteUrl ?? '').trim().slice(0, 400) || DEFAULTS.voice.breeze.siteUrl
  bz.email = String(bz.email ?? '').trim().slice(0, 200)
  bz.password = String(bz.password ?? '').slice(0, 400)
  bz.autoClaim = bz.autoClaim !== false
  bz.model = String(bz.model ?? '').trim().slice(0, 100) || DEFAULTS.voice.breeze.model
  bz.languageCode = String(bz.languageCode ?? '').trim().slice(0, 20) || DEFAULTS.voice.breeze.languageCode
  bz.instructions = String(bz.instructions ?? '').trim().slice(0, 500)
  bz.outputFormat = String(bz.outputFormat ?? '').trim().slice(0, 60) || DEFAULTS.voice.breeze.outputFormat
  bz.guidanceScale = num(bz.guidanceScale, 0, 0, 20)
  bz.timeoutMs = num(bz.timeoutMs, 60000, 5000, 600000)
  // MiniMax 语音：地址 / 音色 id / 模型 / 情绪；Key 不回显（publicConfig 里换成 apiKeySet）
  if (!isObj(c.voice.minimax)) c.voice.minimax = structuredClone(DEFAULTS.voice.minimax)
  c.voice.minimax.apiKey = String(c.voice.minimax.apiKey ?? '').trim().slice(0, 400)
  c.voice.minimax.baseUrl = String(c.voice.minimax.baseUrl ?? '').trim().slice(0, 400) || DEFAULTS.voice.minimax.baseUrl
  c.voice.minimax.voiceId = String(c.voice.minimax.voiceId ?? '').trim().slice(0, 200) || DEFAULTS.voice.minimax.voiceId
  c.voice.minimax.model = ['speech-2.8-turbo', 'speech-2.8-hd', 'speech-2.6-turbo', 'speech-2.6-hd'].includes(String(c.voice.minimax.model))
    ? String(c.voice.minimax.model)
    : DEFAULTS.voice.minimax.model
  c.voice.minimax.emotion = ['auto', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'].includes(String(c.voice.minimax.emotion))
    ? String(c.voice.minimax.emotion)
    : 'auto'
  c.voice.minimax.speed = num(c.voice.minimax.speed, 1, 0.5, 2)
  c.voice.minimax.pitch = num(c.voice.minimax.pitch, 0, -12, 12)
  // 云端语音识别：provider 只认内置两项和 custom；地址/模型留空时由 asr.js 用预置默认值
  if (!isObj(c.voice.asrApi)) c.voice.asrApi = structuredClone(DEFAULTS.voice.asrApi)
  const asrApi = c.voice.asrApi
  asrApi.provider = ['', 'siliconflow', 'openai', 'custom'].includes(asrApi.provider) ? asrApi.provider : ''
  for (const k of ['baseUrl', 'model', 'apiKey', 'language']) asrApi[k] = String(asrApi[k] ?? '').trim()
  asrApi.baseUrl = asrApi.baseUrl.replace(/\/+$/, '')
  asrApi.prefer = ['qq', 'cloud'].includes(asrApi.prefer) ? asrApi.prefer : 'qq'
  c.stickers.autoChance = num(c.stickers.autoChance, 0.35, 0, 1)
  // 主动贴表情：自己的概率（默认 0.15），不从 autoChance 取值；老配置里存成 null 的按默认算
  c.stickers.reactChance = num(c.stickers.reactChance ?? 0.15, 0.15, 0, 1)
  c.stickers.reactMaxPerHour = num(c.stickers.reactMaxPerHour, 10, 0, BIG)
  c.stickers.react = bool(c.stickers.react, false)
  c.stickers.faces = c.stickers.faces !== false
  c.stickers.collectMode = ['ask', 'auto', 'owner'].includes(c.stickers.collectMode) ? c.stickers.collectMode : 'ask'
  c.stickers.maxPerHour = num(c.stickers.maxPerHour, 20, 0, BIG)
  c.stickers.maxLibrary = num(c.stickers.maxLibrary, 300, 1, BIG)
  c.stickers.maxSide = num(c.stickers.maxSide, 520, 80, 4096)
  // 起名单独挑的模型：两半都填了才认；填一半 / 脏数据都当没填（回落到聊天模型）
  c.stickers.captionModel = (() => {
    const m = isObj(c.stickers.captionModel) ? c.stickers.captionModel : {}
    const provider = String(m.provider || '').trim()
    const model = String(m.model || '').trim()
    return provider && model ? { provider, model } : { provider: '', model: '' }
  })()
  c.diary.timesPerDay = num(c.diary.timesPerDay, 2, 0, 48)
  c.diary.windowStart = hhmm(c.diary.windowStart, '10:00')
  c.diary.windowEnd = hhmm(c.diary.windowEnd, '23:30')
  c.diary.minGapMinutes = num(c.diary.minGapMinutes, 180, 0, 1440)
  c.diary.attachImage = bool(c.diary.attachImage, true)
  if (!isObj(c.diary.rich)) c.diary.rich = { ...DEFAULTS.diary.rich }
  for (const key of ['enabled', 'stickers', 'browsing', 'local']) c.diary.rich[key] = bool(c.diary.rich[key], DEFAULTS.diary.rich[key])
  c.diary.rich.folder = typeof c.diary.rich.folder === 'string' ? c.diary.rich.folder.trim() : ''
  if (c.diary.rich.folder && !/^([a-zA-Z]:[\\/]|\/)/.test(c.diary.rich.folder)) c.diary.rich.folder = ''
  delete c.diary.rich.cards
  c.diary.rich.maxImages = Math.round(num(c.diary.rich.maxImages, 2, 1, 9))
  if (!isObj(c.diary.archive)) c.diary.archive = { ...DEFAULTS.diary.archive }
  c.diary.archive.enabled = bool(c.diary.archive.enabled, false)
  c.diary.archive.folder = typeof c.diary.archive.folder === 'string' ? c.diary.archive.folder.trim() : ''
  if (c.diary.archive.folder && !/^([a-zA-Z]:[\\/]|\/)/.test(c.diary.archive.folder)) c.diary.archive.folder = ''
  c.diary.minChars = num(c.diary.minChars, 60, 1, BIG)
  c.diary.maxChars = num(c.diary.maxChars, 140, 1, BIG)
  c.diary.visibility = DIARY_AUDIENCES.includes(c.diary.visibility) ? c.diary.visibility : 'all'
  c.diary.audienceQQs = qqList(c.diary.audienceQQs).slice(0, 200).join('\n')
  c.speakUp.idleMinutes = num(c.speakUp.idleMinutes, 40, 1, BIG)
  c.speakUp.nudge = bool(c.speakUp.nudge, true)
  c.speakUp.minIntervalMinutes = num(c.speakUp.minIntervalMinutes, 90, 1, BIG)
  c.speakUp.maxIntervalMinutes = Math.max(c.speakUp.minIntervalMinutes, num(c.speakUp.maxIntervalMinutes, 240, 1, BIG))
  // 留空就是 20，上限不封顶
  c.speakUp.maxPerDay = c.speakUp.maxPerDay === '' || c.speakUp.maxPerDay == null ? 20 : num(c.speakUp.maxPerDay, 20, 0, BIG)
  c.speakUp.allow = [...new Set((Array.isArray(c.speakUp.allow) ? c.speakUp.allow : []).map((q) => String(q).trim()).filter((q) => /^\d{5,}$/.test(q)))]
  const q = c.qzoneSocial
  q.enabled = bool(q.enabled, true)
  q.replyOwn = bool(q.replyOwn, true)
  q.commentFriends = bool(q.commentFriends, true)
  q.like = bool(q.like, true)
  q.friendChance = num(q.friendChance, 0.3, 0, 1)
  q.ownerChance = num(q.ownerChance, 0.7, 0, 1)
  q.maxPerDay = num(q.maxPerDay, 8, 0, BIG)
  q.intervalMin = num(q.intervalMin, 30, 1, BIG)
  c.mood.halfLifeHours = num(c.mood.halfLifeHours, 3, 0.1, BIG)
  c.mood.base = num(c.mood.base, 60, 0, 100)
  c.mood.judge = bool(c.mood.judge, false)
  for (const k of ['tts', 'image', 'song', 'asr', 'video']) c.local[k] = bool(c.local[k], false)
  c.local.videoTimeoutMin = num(c.local.videoTimeoutMin, 20, 1, BIG)
  const b = c.bili
  Object.assign(b, splitBiliCookie(b))
  for (const k of ['enabled', 'autoBrowse', 'comment', 'reply', 'shareToOwner', 'like', 'vision', 'danmakuEnabled', 'autoDanmaku']) b[k] = bool(b[k], DEFAULTS.bili[k])
  b.visionFrames = Math.round(num(b.visionFrames, 6, 1, 100))
  b.ffmpegPath = String(b.ffmpegPath || '').trim()
  b.shotChance = num(b.shotChance, 0.35, 0, 1)
  b.shotLibrary = Math.round(num(b.shotLibrary, 300, 1, BIG))
  if (!isObj(b.groupShare)) b.groupShare = {}
  b.groupShare.enabled = bool(b.groupShare.enabled, false)
  b.groupShare.groupId = qq(b.groupShare.groupId)
  b.groupShare.groups = [...new Set((Array.isArray(b.groupShare.groups) ? b.groupShare.groups : []).map(qq).filter(Boolean))].slice(0, 20)
  b.groupShare.dailyLimit = Math.round(num(b.groupShare.dailyLimit, 3, 0, BIG))
  b.groupShare.pendingTtlHours = Math.round(num(b.groupShare.pendingTtlHours, 24, 1, 24 * 30))
  b.groupShare.queueLimit = Math.round(num(b.groupShare.queueLimit, 1, 1, 20))
  b.intervalHours = num(b.intervalHours, 4, 0.1, BIG)
  b.maxRunsPerDay = num(b.maxRunsPerDay, 3, 0, BIG)
  b.perRun = num(b.perRun, 3, 1, BIG)
  b.minViews = num(b.minViews, 5000, 0, BIG * 1e6)
  b.maxAgeDays = num(b.maxAgeDays, 60, 0, BIG)
  b.maxCommentsPerDay = num(b.maxCommentsPerDay, 3, 0, BIG)
  b.maxRepliesPerDay = num(b.maxRepliesPerDay, 6, 0, BIG)
  b.maxDanmakuPerDay = Math.round(num(b.maxDanmakuPerDay, 3, 1, 20))
  b.keywords = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(/[\n,，]+/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 30)
  const hb = c.heybox
  hb.shareToOwner = bool(hb.shareToOwner, true)
  hb.shareBias = ['stingy', 'normal', 'proactive'].includes(hb.shareBias) ? hb.shareBias : 'normal'
  hb.shareDaily = Math.round(num(hb.shareDaily, 3, 0, BIG))
  hb.cookie = String(hb.cookie || '').trim()
  hb.topicMode = hb.topicMode === 'auto' ? 'auto' : 'manual'
  hb.postWordsMin = Math.round(num(hb.postWordsMin, 0, 0, 2000))
  hb.postWordsMax = Math.round(num(hb.postWordsMax, 0, 0, 3000))
  if (hb.postWordsMax && hb.postWordsMin && hb.postWordsMax < hb.postWordsMin) [hb.postWordsMin, hb.postWordsMax] = [hb.postWordsMax, hb.postWordsMin]
  // 每天每篇的排期：最多 5 篇；hashtags 和 hashtagsText 都保留（面板靠 Text 回显，模块靠数组发帖）
  hb.dailyPosts = Array.isArray(hb.dailyPosts) ? hb.dailyPosts.slice(0, 5).map((p) => {
    const o = p && typeof p === 'object' ? p : {}
    const splitH = (v) => String(v ?? '').split(/[\s,，、]+/).map((x) => String(x).trim()).filter(Boolean)
    const hash = (Array.isArray(o.hashtags) ? o.hashtags : splitH(o.hashtagsText)).map((x) => String(x).trim()).filter(Boolean).slice(0, 4)
    return {
      style: ['diary', 'news', 'mix', 'deal'].includes(o.style) ? o.style : '',
      topic: /^\d{3,7}$/.test(String(o.topic ?? '')) ? String(o.topic) : '',
      hashtags: hash,
      hashtagsText: hash.join(','),
      wordsMin: Math.round(num(o.wordsMin, 0, 0, 2000)),
      wordsMax: Math.round(num(o.wordsMax, 0, 0, 3000)),
      hint: String(o.hint || '').trim().slice(0, 120),
    }
  }) : []   // ⚠ 不能在这里过滤全空项：排期是按下标取的（module 侧 currentPostPlan 用 postsToday() 索引），
             //    过滤掉「第 1 篇留空跟全局、第 2 篇单独配」里的空项，会让第 2 篇的配置被当成第 1 篇用。
             //    空项就代表「这一篇走全局设置」，原样保留位置。
  hb.offPeakOnly = bool(hb.offPeakOnly, false)
  hb.peakStartAM = num(hb.peakStartAM, 9, 0, 23)
  hb.peakEndAM = num(hb.peakEndAM, 12, 0, 24)
  hb.peakStartPM = num(hb.peakStartPM, 14, 0, 23)
  hb.peakEndPM = num(hb.peakEndPM, 18, 0, 24)
  hb.peakWeekend = bool(hb.peakWeekend, false)
  const d = c.douyin
  d.enabled = bool(d.enabled, false)
  d.autoBrowse = bool(d.autoBrowse, true)
  d.intervalHours = num(d.intervalHours, 4, 0.1, BIG)
  d.maxRunsPerDay = num(d.maxRunsPerDay, 3, 0, BIG)
  d.perRun = num(d.perRun, 5, 1, BIG)
  d.maxWatchPerDay = num(d.maxWatchPerDay, 30, 0, BIG)
  d.dwellMin = num(d.dwellMin, 8, 1, BIG)
  d.dwellMax = Math.max(d.dwellMin, num(d.dwellMax, 40, 1, BIG))
  d.browserPath = String(d.browserPath || '').trim()
  d.shareTo = ['douyin', 'qq', 'both'].includes(d.shareTo) ? d.shareTo : 'douyin'
  d.ownerDm = bool(d.ownerDm, true)
  d.dmPollMinutes = num(d.dmPollMinutes, 3, 1, BIG)
  d.shareBias = ['stingy', 'normal', 'proactive'].includes(d.shareBias) ? d.shareBias : d.shareBias === 'off' ? 'stingy' : 'proactive'
  if (!isObj(d.caps)) d.caps = {}
  if (raw?.douyin?.caps?.share == null && raw?.douyin?.caps?.shareOwner != null) d.caps.share = raw.douyin.caps.shareOwner // 1.0.x 叫 shareOwner
  d.caps = { like: num(d.caps.like, 30, 0, BIG), comment: num(d.caps.comment, 3, 0, BIG), share: num(d.caps.share, 5, 0, BIG), atOwner: num(d.caps.atOwner, 3, 0, 30) }
  if (!isObj(d.owner)) d.owner = {}
  d.owner = Object.fromEntries(['input', 'secUid', 'uid', 'nickname', 'confirmedInput'].map((k) => [k, String(d.owner[k] ?? '').trim().slice(0, 400)]))
  if (!isObj(d.gate)) d.gate = {}
  d.gate = { maxWritesPerDay: num(d.gate.maxWritesPerDay, 40, 1, BIG), minWriteGapSec: num(d.gate.minWriteGapSec, 20, 0, BIG), newAccountDays: num(d.gate.newAccountDays, 3, 0, 30) }
  // 1.0.x 的 douyin-im / 私信相关设置都不用了
  for (const k of ['atOwnerOnLikeChance', 'minimize', 'socialInterruptBrowse', 'replyPollMinutes']) delete d[k]

  delete c.mood.maxInjectPerDay // 旧版的「每天最多提醒几次」，现在心情明显时每轮都会带上
  c.snowluma.webuiPort = num(c.snowluma.webuiPort, 15099, 1, 65535)
  // 老配置只有一个 consolidateAt：换成两个时间点（它 + 12 小时后）
  if (!Array.isArray(raw?.memory?.consolidateTimes) && raw?.memory?.consolidateAt) {
    const [hh, mm] = hhmm(raw.memory.consolidateAt, '04:00').split(':').map(Number)
    c.memory.consolidateTimes = [`${hh}:${String(mm).padStart(2, '0')}`, `${(hh + 12) % 24}:${String(mm).padStart(2, '0')}`]
  }
  delete c.memory.consolidateAt
  c.memory.consolidateTimes = [...new Set((Array.isArray(c.memory.consolidateTimes) ? c.memory.consolidateTimes : String(c.memory.consolidateTimes || '').split(/[\s,，]+/)).map((t) => hhmm(t, '')).filter(Boolean).map((t) => t.padStart(5, '0')))].sort().slice(0, 4)
  if (!c.memory.consolidateTimes.length) c.memory.consolidateTimes = ['04:00', '16:00']
  c.chat = c.chat || {}
  c.chat.seedHistory = bool(c.chat.seedHistory, false)
  c.chat.seedHistoryCount = num(c.chat.seedHistoryCount, 20, 1, BIG)
  c.chat.everyStep = bool(c.chat.everyStep, false)
  c.chat.rescueFromThinking = bool(c.chat.rescueFromThinking, false)
  c.chat.thinkingGuard = { enabled: bool(c.chat.thinkingGuard?.enabled, true) }
  c.chat.replyMarker = { enabled: bool(c.chat.replyMarker?.enabled, false) }
  c.chat.turnTimeoutMinutes = num(c.chat.turnTimeoutMinutes, 30, 0, 180)
  c.memory.recallCount = num(c.memory.recallCount, 6, 0, BIG)
  // 总数护栏：0 表示不限制（直接 recallCount + 联想 assoc.recall）；设了就封顶，防止上下文爆掉
  c.memory.recallTotal = Math.round(num(c.memory.recallTotal, 0, 0, BIG))
  // beta 侧新增：召回最低相关度门槛
  c.memory.recallMinRelevance = num(c.memory.recallMinRelevance, DEFAULTS.memory.recallMinRelevance, 0, 1)
  c.memory.recallMode = c.memory.recallMode === 'trigger' ? 'trigger' : 'always'
  // 遗忘基数：1~365 天。超出范围或非数字回默认 20，不让脏配置把记忆一夜清空。
  c.memory.retentionBase = Math.round(num(c.memory.retentionBase, 20, 1, 365))
  c.memory.recallTriggers = [...new Set((Array.isArray(c.memory.recallTriggers) ? c.memory.recallTriggers : String(c.memory.recallTriggers || '').split(/[\n,，;；]+/)).filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, 40)).filter(Boolean))].slice(0, 100)
  for (const k of ['chatImpression', 'gistEnabled', 'shortTerm', 'followUp', 'profileOnlyAcquainted']) c.memory[k] = bool(c.memory[k], true)
  c.memory.dislikeSilence = num(c.memory.dislikeSilence, 0.85, 0, 1)
  c.memory.shortTermHours = num(c.memory.shortTermHours, 2, 0.1, BIG)
  c.memory.shortTermIdleMinutes = num(c.memory.shortTermIdleMinutes, 3, 0, BIG)
  c.memory.shortTermChars = Math.round(num(c.memory.shortTermChars, 150, 1, BIG))
  for (const k of ['profileFieldChars', 'profilePeople', 'profileChars', 'chatImpressionChars', 'gistDays', 'impressionDays', 'gistDailyBatches']) c.memory[k] = Math.round(num(c.memory[k], DEFAULTS.memory[k], 0, BIG))
  if (!isObj(c.memory.tierDays)) c.memory.tierDays = {}
  for (const k of Object.keys(DEFAULT_TIER_DAYS)) c.memory.tierDays[k] = Math.round(num(c.memory.tierDays[k], DEFAULT_TIER_DAYS[k], 0, BIG))
  // 老版本的 0 是当时的默认值，不是谁选的：升级后改成留 7 天，以后面板里再选 0 才算数
  const keepUnset = raw?.memory?.keepChatlogDays === 0 && !raw.memory.keepChatlogSet
  c.memory.keepChatlogDays = keepUnset ? 7 : num(c.memory.keepChatlogDays, 7, -1, 3650)
  c.memory.keepChatlogSet = true
  c.memory.mergeGroups = bool(c.memory.mergeGroups, false)
  c.memory.residentMaxChars = num(c.memory.residentMaxChars, 1200, 200, 4000)
  c.memory.preferPersonal = bool(c.memory.preferPersonal, true)
  for (const k of ['instantCommands', 'groupMemory', 'searchRrf']) c.memory[k] = bool(c.memory[k], true)
  c.memory.crossContext = bool(c.memory.crossContext, false)
  c.memory.extractIdleMinutes = num(c.memory.extractIdleMinutes, 30, 0, BIG)
  c.memory.extractMinLines = Math.round(num(c.memory.extractMinLines, 20, 1, BIG))
  c.memory.extractDailyBatches = Math.round(num(c.memory.extractDailyBatches, 24, 0, BIG))
  if (!isObj(c.memory.capacity)) c.memory.capacity = {}
  for (const k of ['auto', 'event', 'diary']) c.memory.capacity[k] = Math.round(num(c.memory.capacity[k], DEFAULTS.memory.capacity[k], 0, BIG))
  c.memory.eventExpireDays = num(c.memory.eventExpireDays, 90, -1, BIG)
  // 记忆压缩：具体的事慢慢淡忘、概括成长期印象（默认开；可以关；多少天以前的细节才参与概括）
  c.memory.compress = bool(c.memory.compress, true)
  c.memory.compressAfterDays = Math.round(num(c.memory.compressAfterDays, 14, 1, 365))
  if (!isObj(c.memory.vector)) c.memory.vector = structuredClone(DEFAULTS.memory.vector)
  const vector = c.memory.vector
  vector.enabled = bool(vector.enabled, false)
  vector.provider = ['siliconflow', 'ark', 'openai', 'ollama', 'custom'].includes(vector.provider) ? vector.provider : 'siliconflow'
  for (const k of ['baseUrl', 'model', 'apiKey']) vector[k] = String(vector[k] || '').trim()
  vector.baseUrl = vector.baseUrl.replace(/\/+$/, '')
  vector.dimensions = Math.round(num(vector.dimensions, 0, 0, 8192))
  vector.batchSize = Math.round(num(vector.batchSize, 10, 1, 64))
  vector.queryTimeoutMs = Math.round(num(vector.queryTimeoutMs, 3000, 500, 15000))
  vector.headers = headerLines(vector.headers)
  // 检索方式：本地小模型（离线，推荐）或自己配的在线服务。
  // 老配置只有 baseUrl、没有 mode（DEFAULTS 会补上 'local'，所以要拿原始输入判断），
  // 这时按「填了地址就是在用在线服务」跑，不然升级后向量检索会悄悄失效。
  const rawVec = isObj(raw?.memory?.vector) ? raw.memory.vector : {}
  const declaredMode = String(rawVec.mode || '').trim().toLowerCase()
  // mode 是**派生值**（本地小模型 / 在线服务），不是用户直接填的配置项：
  // 定义成不可枚举属性，这样 Object.entries / deepEqual 看不到它（升级兼容测试要求
  // 配置结构和 DEFAULTS 完全一致），但 cfg.memory.vector.mode 仍能正常读。
  Object.defineProperty(vector, 'mode', {
    value: declaredMode === 'remote' || declaredMode === 'local' ? declaredMode : (vector.baseUrl ? 'remote' : 'local'),
    enumerable: false,
    writable: true,
    configurable: true,
  })
  if (!isObj(c.memory.rerank)) c.memory.rerank = structuredClone(DEFAULTS.memory.rerank)
  const rerank = c.memory.rerank
  rerank.enabled = bool(rerank.enabled, false)
  for (const k of ['baseUrl', 'model', 'apiKey']) rerank[k] = String(rerank[k] || '').trim()
  rerank.baseUrl = rerank.baseUrl.replace(/\/+$/, '').replace(/\/rerank$/i, '')
  rerank.model = rerank.model || DEFAULTS.memory.rerank.model
  rerank.topN = Math.round(num(rerank.topN, 20, 2, 50))
  rerank.timeoutMs = Math.round(num(rerank.timeoutMs, 2000, 500, 10_000))
  // 向量联想：建边阈值、每个节点最多几条边、每次召回最多带几条
  if (!isObj(c.memory.assoc)) c.memory.assoc = structuredClone(DEFAULTS.memory.assoc)
  c.memory.assoc.enabled = bool(c.memory.assoc.enabled, true)
  c.memory.assoc.minSim = num(c.memory.assoc.minSim, DEFAULTS.memory.assoc.minSim, 0.3, 0.95)
  c.memory.assoc.limit = Math.round(num(c.memory.assoc.limit, DEFAULTS.memory.assoc.limit, 1, 8))
  c.memory.assoc.recall = Math.round(num(c.memory.assoc.recall, DEFAULTS.memory.assoc.recall, 0, 5))
  // 跳数：0 = 只建边不联想，1 = A→B，2 = A→B→C。**封顶 3**，再多就是套娃了。
  c.memory.assoc.hops = Math.round(num(c.memory.assoc.hops, DEFAULTS.memory.assoc.hops, 0, 3))
  c.memory.assoc.hopDecay = num(c.memory.assoc.hopDecay, DEFAULTS.memory.assoc.hopDecay, 0.1, 1)
  // 想起总数护栏：0 = 不额外限制（= 直接 recallCount + 联想 assoc.recall）
  c.memory.recallTotal = Math.round(num(c.memory.recallTotal, 0, 0, BIG))
  // 行为驱动的档位升档
  if (!isObj(c.memory.tierGrow)) c.memory.tierGrow = structuredClone(DEFAULTS.memory.tierGrow)
  c.memory.tierGrow.enabled = bool(c.memory.tierGrow.enabled, true)
  c.memory.tierGrow.perDay = num(c.memory.tierGrow.perDay, DEFAULTS.memory.tierGrow.perDay, 0, 0.2)
  c.memory.tierGrow.minHitDays = Math.round(num(c.memory.tierGrow.minHitDays, DEFAULTS.memory.tierGrow.minHitDays, 0, 60))
  c.memory.tierGrow.cap = num(c.memory.tierGrow.cap, DEFAULTS.memory.tierGrow.cap, 0, 1)
  // 几次联想折算成一天。1 表示联想和直接命中一样重；默认 2 表示联想更轻。
  c.memory.tierGrow.assocPerHitDay = Math.round(num(c.memory.tierGrow.assocPerHitDay, DEFAULTS.memory.tierGrow.assocPerHitDay, 1, 20))
  for (const key of ['tier2', 'tier3']) {
    if (!isObj(c.memory.tierGrow[key])) c.memory.tierGrow[key] = { ...DEFAULTS.memory.tierGrow[key] }
    c.memory.tierGrow[key].hitDays = Math.round(num(c.memory.tierGrow[key].hitDays, DEFAULTS.memory.tierGrow[key].hitDays, 0, 365))
    c.memory.tierGrow[key].imp = num(c.memory.tierGrow[key].imp, DEFAULTS.memory.tierGrow[key].imp, 0, 1)
  }
  g.interests = (Array.isArray(g.interests) ? g.interests : String(g.interests || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean)
  g.minRelevance = num(g.minRelevance, 0.25, 0, 1)
  // @ 了别人时不算叫她（只挡必回，仍然可以插话）；默认关，保持原行为
  g.ignoreAtOthers = bool(g.ignoreAtOthers, false)
  // 看白名单里别的群：off 关 / private 主人和私聊里的群成员（默认）/ group 群里的成员也行
  g.crossRead = ['off', 'group'].includes(g.crossRead) ? g.crossRead : 'private'
  c.merge.enabled = bool(c.merge.enabled, true)
  c.merge.waitSec = num(c.merge.waitSec, 2.5, 0, BIG)
  c.merge.maxSec = Math.max(c.merge.waitSec, num(c.merge.maxSec, 8, 0, BIG))
  c.merge.groupWaitSec = num(c.merge.groupWaitSec, 5, 0, BIG)
  c.merge.groupMaxSec = Math.max(c.merge.groupWaitSec, num(c.merge.groupMaxSec, 15, 0, BIG))
  c.forward = c.forward && typeof c.forward === 'object' ? c.forward : {}
  c.forward.expandEarly = bool(c.forward.expandEarly, false)
  c.forward.expandHistory = bool(c.forward.expandHistory, false)
  c.titleFilter.enabled = bool(c.titleFilter.enabled, true)
  c.titleFilter.groups = qqList(c.titleFilter.groups) // 和群白名单同一套规则
  c.titleFilter.title = String(c.titleFilter.title ?? '').replace(/[​-‍﻿]/g, '').trim().slice(0, 30) || '大肥鱼'
  g.burstMax = num(g.burstMax, 8, 1, BIG)
  g.engagedMax = num(g.engagedMax, 6, 0, BIG)
  g.burstWindowSec = num(g.burstWindowSec, 120, 1, BIG)
  if (!['auto', 'edge', 'windows', 'cosyvoice', 'gptsovits', 'http', 'volcano', 'breeze', 'minimax'].includes(c.voice.engine)) c.voice.engine = 'auto'
  c.voice.songVoice = String(c.voice.songVoice || '').slice(0, 120)
  c.voice.songPitch = Math.max(-24, Math.min(24, Math.round(Number(c.voice.songPitch) || 0)))
  c.voice.cosyvoice.sampleRate = num(c.voice.cosyvoice.sampleRate, 22050, 8000, 48000)
  if (!['sft', 'instruct'].includes(c.voice.cosyvoice.mode)) c.voice.cosyvoice.mode = 'sft'
  // edge-tts 的语速 / 音调：只认 ±N% 和 ±NHz，写着玩的回落默认值，超范围的夹回来。
  // ⚠ 0 也必须带符号：面板的选项是 '+0%' / '+0Hz'，少了正号既对不上下拉框，
  //   又会让 `rate !== '+0%'` 成立、把 --rate=0% 传给 edge-tts（它会直接报错）。
  const signed = (n, unit) => (n < 0 ? '-' : '+') + Math.abs(n) + unit
  const pct = /^([+-]?\d{1,3})\s*%$/.exec(String(c.voice.rate || '').trim())
  c.voice.rate = signed(pct ? Math.max(-50, Math.min(50, Number(pct[1]))) : 0, '%')
  const hz = /^([+-]?\d{1,3})\s*Hz$/i.exec(String(c.voice.pitch || '').trim())
  c.voice.pitch = signed(hz ? Math.max(-80, Math.min(80, Number(hz[1]))) : 0, 'Hz')
  c.imageGen.fallbackEnabled = bool(c.imageGen.fallbackEnabled, false)
  c.imageGen.fallbacks = (Array.isArray(c.imageGen.fallbacks) ? c.imageGen.fallbacks : []).map(e => ({ id: String(e?.id || '').slice(0, 100), provider: e?.provider === 'codex' ? 'codex' : 'openai', baseUrl: String(e?.baseUrl || '').trim(), apiKey: String(e?.apiKey || ''), model: String(e?.model || '').trim() })).filter(e => e.id)
  c.imageGen.enabled = bool(c.imageGen.enabled, false)
  c.imageGen.ownerOnly = bool(c.imageGen.ownerOnly, true)
  c.imageGen.seeOwn = bool(c.imageGen.seeOwn, true)
  c.imageGen.img2img = bool(c.imageGen.img2img, true)
  if (!/^\d{3,4}x\d{3,4}$/.test(String(c.imageGen.size))) c.imageGen.size = '1024x1024'
  c.imageGen.galleryShown = Math.min(50, Math.max(1, Math.round(Number(c.imageGen.galleryShown) || 20)))
  c.imageGen.shape = ['her', 'square', 'portrait', 'landscape', 'wide'].includes(c.imageGen.shape) ? c.imageGen.shape : 'her'

  // provider：custom = 自己填接口（GET/POST + 自定义参数），其它按 OpenAI 兼容
  c.imageGen.provider = ['custom', 'codex'].includes(c.imageGen.provider) ? c.imageGen.provider : 'openai'
  // 「服务地址」下拉的用户自添地址：{ name, url }；只要 http(s) 链接，按地址去重，最多 20 条
  // （官方推荐的赞助商地址固定第一项，不存这里；旧版只存字符串的自动用域名当名字）
  c.imageGen.baseUrlOptions = (Array.isArray(c.imageGen.baseUrlOptions) ? c.imageGen.baseUrlOptions : [])
    .map((o) => typeof o === 'string' ? { name: '', url: o } : { name: String((o && o.name) || '').trim().slice(0, 60), url: String((o && o.url) || '').trim().slice(0, 500) })
    .filter((o) => /^https?:\/\//.test(o.url) && o.url !== 'https://ntmd.cn/v1')
    .map((o) => { if (o.name) return o; try { return { ...o, name: new URL(o.url).hostname } } catch { return { ...o, name: o.url } } })
    .filter((o, i, a) => a.findIndex((x) => x.url === o.url) === i)
    .slice(0, 20)
  if (!isObj(c.imageGen.codex)) c.imageGen.codex = { ...DEFAULTS.imageGen.codex }
  const igx = c.imageGen.codex
  igx.model = ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'].includes(igx.model) ? igx.model : 'gpt-image-2'
  igx.quality = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(igx.quality) ? igx.quality : 'auto'
  igx.background = ['auto', 'transparent', 'opaque'].includes(igx.background) ? igx.background : 'auto'
  if (!c.imageGen.custom || typeof c.imageGen.custom !== 'object') c.imageGen.custom = { ...DEFAULTS.imageGen.custom }
  const igc = c.imageGen.custom
  igc.method = String(igc.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
  igc.bodyType = igc.bodyType === 'form' ? 'form' : 'json'
  igc.url = String(igc.url || '').trim().slice(0, 2000)
  igc.responsePath = String(igc.responsePath || '').trim().slice(0, 200)
  igc.params = (Array.isArray(igc.params) ? igc.params : [])
    .map((p) => ({ key: String((p && p.key) || '').trim().slice(0, 60), value: String(p && p.value != null ? p.value : '').slice(0, 500) }))
    .filter((p) => p.key)
    .slice(0, 30)

  c.song.enabled = bool(c.song.enabled, false)
  c.song.ownerOnly = bool(c.song.ownerOnly, true)
  c.song.pitch = num(c.song.pitch, 0, -24, 24)
  c.song.maxVoiceSec = num(c.song.maxVoiceSec, 120, 1, BIG)
  c.song.vocalVolume = num(c.song.vocalVolume, 1, 0, 10)
  c.song.instVolume = num(c.song.instVolume, 0.8, 0, 10)
  if (!['auto', 'head'].includes(c.song.clipStart)) c.song.clipStart = 'auto'
  // 老配置：'' 是以前的默认（没开），改成自动；tuna 是以前的「用镜像」
  c.song.pypiMirror = { '': 'auto', tuna: 'cn' }[c.song.pypiMirror] ?? c.song.pypiMirror
  if (!['auto', 'cn', 'off'].includes(c.song.pypiMirror)) c.song.pypiMirror = 'auto'
  c.song.root = String(c.song.root || '').trim()
  // 云备份：owner/repo 去空格，令牌按密钥处理（SECRETS 里有登记）。
  // owner/repo 只留 URL 白名单字符（@ : / ? # 空格等能改语义的直接去掉，push 时还有白名单硬校验兜底）；
  // branch 拒 .. 与 - 开头，防 refspec/选项注入。
  c.backup = c.backup || {}
  if (!isObj(c.backup.remote)) c.backup.remote = { ...DEFAULTS.backup.remote }
  const br = c.backup.remote
  br.enabled = bool(br.enabled, false)
  br.owner = String(br.owner || '').trim().replace(/^https?:\/\//i, '').replace(/^gitee\.com\//i, '').split(/[/?]/)[0].replace(/\.git$/, '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100)
  br.repo = String(br.repo || '').trim().replace(/\.git$/, '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100)
  br.token = String(br.token || '').trim()
  br.branch = String(br.branch || '').trim().replace(/^refs\/heads\//, '').replace(/[^A-Za-z0-9._/-]/g, '').replace(/^[.\-]+/, '').replace(/\.\.+/g, '.').slice(0, 100) || 'master'
  br.time = hhmm(br.time, '03:30')
  br.keep = Math.round(num(br.keep, 7, 1, 365))
  br.autoCreate = bool(br.autoCreate, true)
  br.forceOverwrite = bool(br.forceOverwrite, false)
  if (!isObj(c.modules)) c.modules = {}
  for (const [id, m] of Object.entries(c.modules)) {
    if (!isObj(m)) { delete c.modules[id]; continue }
    m.enabled = bool(m.enabled, true)
    m.useBuiltin = bool(m.useBuiltin, false)
  }
  if (!isObj(c.ext)) c.ext = {}
  for (const k of Object.keys(c.ext)) if (!isObj(c.ext[k])) delete c.ext[k] // 传 null = 删掉这个模块的设置
  c.safeMode = bool(c.safeMode, false)
  // 花费估算的价格表：手动填了就用手填的（手填的部分覆盖内置价），没填就用内置 DeepSeek 价
  if (!isObj(c.usage)) c.usage = { pricing: {} }
  if (!isObj(c.usage.pricing)) c.usage.pricing = {}
  c.bridge.dshTools = bool(c.bridge.dshTools, false)
  c.bridge.http = bool(c.bridge.http, false)
  c.bridge.token = String(c.bridge.token || '')
  if (!['whitelist', 'owner'].includes(c.bridge.allowTargets)) c.bridge.allowTargets = 'whitelist'
  return c
}

// 面板里不回传原文的字段：路径（几层都行）
const SECRETS = [['snowluma', 'webuiPassword'], ['snowluma', 'httpToken'], ['snowluma', 'wsToken'], ['imageGen', 'apiKey'], ['voice', 'asrApi', 'apiKey'], ['memory', 'vector', 'apiKey'], ['memory', 'rerank', 'apiKey'], ['song', 'neteaseCookie'], ['bili', 'cookie'], ['bili', 'sessdata'], ['bili', 'biliJct'], ['heybox', 'cookie'], ['bridge', 'token'], ['voice', 'volcano', 'apiKey'], ['voice', 'breeze', 'key'], ['voice', 'breeze', 'password'], ['voice', 'minimax', 'apiKey'], ['backup', 'remote', 'token'], ['backup', 'remote', 'webdav', 'password']]
// 扩展模块设置里的密码类字段（模块加载时登记）：['ext', 模块id, 字段]
const extraSecrets = new Map()
export function registerSecretField(path) { extraSecrets.set(path.join('\u0000'), path) }
const allSecrets = () => [...SECRETS, ...extraSecrets.values()]
const parentOf = (obj, path, create) => {
  let cur = obj
  for (const k of path.slice(0, -1)) {
    if (!isObj(cur[k])) { if (!create) return null; cur[k] = {} }
    cur = cur[k]
  }
  return cur
}
const getAt = (obj, path) => { const p = parentOf(obj, path, false); return p ? p[path.at(-1)] : undefined }
// 这些密钥在面板里显示结尾几位（「已保存（结尾 …a1b2）」），方便认出存的是哪一份；完整值不回传
const HINTED = [['bili', 'sessdata'], ['bili', 'biliJct']]

/** 从一串 Cookie 里取某个值（「SESSDATA=xxx; bili_jct=yyy」）。 */
export function cookieValue(raw, key) {
  for (const part of String(raw || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === key) return part.slice(i + 1).trim()
  }
  return ''
}

/**
 * 把票和设备指纹拼成接口要的 Cookie 串。字段顺序固定：SESSDATA → bili_jct → buvid3 → buvid4 → DedeUserID。
 * 扫码登录、配置归一化、手工粘贴三条路都走这里——各拼一份的话，字段或顺序漂移一次，票就和指纹对不上了。
 */
export function buildBiliCookie({ sessdata = '', biliJct = '', buvid3 = '', buvid4 = '', dedeUserId = '' } = {}) {
  return [
    sessdata && `SESSDATA=${sessdata}`,
    biliJct && `bili_jct=${biliJct}`,
    buvid3 && `buvid3=${buvid3}`,
    buvid4 && `buvid4=${buvid4}`,
    dedeUserId && `DedeUserID=${dedeUserId}`,
  ].filter(Boolean).join('; ')
}

/**
 * B 站 Cookie 整理成完整指纹：粘了整串 / 带了「SESSDATA=」前缀的都认得；老配置只有整串的拆开。
 * 返回 {sessdata, biliJct, buvid3, buvid4, dedeUserId, cookie}，cookie 是拼好给接口用的。
 * 设备指纹三项优先用字段，为空时从整串 cookie 里补（扫码登录写回配置后，重启也沿用同一个指纹）。
 */
export function splitBiliCookie({ sessdata = '', biliJct = '', cookie = '', buvid3 = '', buvid4 = '', dedeUserId = '' } = {}) {
  const a = String(sessdata || '').trim()
  const b = String(biliJct || '').trim()
  // 框里粘的是「xxx=…」这种整串或带前缀的：从里面取；纯值原样用
  const isRaw = (v) => /(^|;\s*)(SESSDATA|bili_jct)=/.test(v)
  let s = isRaw(a) ? '' : a
  let j = isRaw(b) ? '' : b
  for (const v of [a, b]) {
    if (!isRaw(v)) continue
    s = cookieValue(v, 'SESSDATA') || s
    j = cookieValue(v, 'bili_jct') || j
  }
  if (!s && !j && cookie) {
    s = cookieValue(cookie, 'SESSDATA')
    j = cookieValue(cookie, 'bili_jct')
  }
  // 指纹：字段优先；没填就从整串 cookie / 粘进来的整串里找。都没有就保持空串，不产生空段。
  let b3 = String(buvid3 || '').trim()
  let b4 = String(buvid4 || '').trim()
  let uid = String(dedeUserId || '').trim()
  if (!b3 || !b4 || !uid) {
    const sources = [cookie, isRaw(a) ? a : '', isRaw(b) ? b : ''].filter(Boolean)
    for (const src of sources) {
      if (!b3) b3 = cookieValue(src, 'buvid3')
      if (!b4) b4 = cookieValue(src, 'buvid4')
      if (!uid) uid = cookieValue(src, 'DedeUserID')
    }
  }
  return { sessdata: s, biliJct: j, buvid3: b3, buvid4: b4, dedeUserId: uid, cookie: buildBiliCookie({ sessdata: s, biliJct: j, buvid3: b3, buvid4: b4, dedeUserId: uid }) }
}

const FILE = () => dataDir('config.json')

/** 在某次更新里新增、会替她公开发东西的功能。以后再加这类功能，把配置键名加到这里。 */
export const OPT_IN_ON_UPDATE = ['qzoneSocial', 'bili', 'douyin']

export function loadConfig() {
  const raw = readJson(FILE(), {})
  // 老配置（向导上线前就填好了两个号）直接算向导已完成
  if (raw && raw.setupDone === undefined && raw.botQQ && raw.ownerQQ) raw.setupDone = true
  // 更新插件后新增的、会公开发东西的功能：老用户先关着，等他们自己在面板里打开（新安装照常默认开）
  if (raw && raw.setupDone) for (const k of OPT_IN_ON_UPDATE) if (raw[k] === undefined) raw[k] = { enabled: false }
  return normalize(raw)
}

export function ownerAuthorizationRevision(cfg) {
  const binding = cfg.ownerAuthorization
  return cfg.ownerQQ && binding?.owner === cfg.ownerQQ && typeof binding.revision === 'string'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(binding.revision) ? binding.revision : ''
}

export function saveConfig(cfg, previous = loadConfig()) {
  const c = normalize(cfg)
  // Only the previous authoritative configuration can carry an authorization forward.
  if (c.ownerQQ) {
    const revision = c.ownerQQ === previous.ownerQQ ? ownerAuthorizationRevision(previous) : ''
    c.ownerAuthorization = { owner: c.ownerQQ, revision: revision || randomUUID() }
  } else delete c.ownerAuthorization
  writeJson(FILE(), c)
  return c
}

/** 给面板看的版本：密码 / token 不回传原文，只告诉有没有填。 */
export function publicConfig(cfg) {
  const c = structuredClone(cfg)
  delete c.ownerAuthorization
  // 面板上的「试运行」只表示「试运行但不调试」：调试开着时它显示为关
  c.dryRun = Boolean(c.dryRun && !c.debug)
  // 面板要能显示/修改「单个聊天的思考档位」（chatEfforts），所以回传这份配置；
  // 它本来就不含敏感内容，只是「聊天 → 模型 → 档位」的映射。
  for (const [g, k] of HINTED) c[g][`${k}Hint`] = c[g][k] ? '…' + String(c[g][k]).slice(-4) : ''
  for (const path of allSecrets()) {
    const p = parentOf(c, path, false)
    if (!p) continue
    const k = path.at(-1)
    p[`${k}Set`] = Boolean(p[k])
    p[k] = ''
  }
  for (const e of c.imageGen.fallbacks || []) { e.apiKeySet = Boolean(e.apiKey); e.apiKey = '' }
  return c
}

/** 面板保存时：没改的密码字段（空串）保留原值。 */
export function mergeFromPanel(current, incoming) {
  const next = deepMerge(current, incoming || {})
  // 面板明确带了非空 chatEfforts（面板上改过单个聊天的档位）就以面板为准；
  // 没带或带的是空对象（旧版面板 / 面板没动过）时保留当前值——QQ 里 /effort 设过的不被清掉。
  const incomingEfforts = incoming && incoming.chatEfforts
  next.chatEfforts = incomingEfforts && typeof incomingEfforts === 'object' && Object.keys(incomingEfforts).length
    ? incomingEfforts
    : current.chatEfforts
  for (const path of allSecrets()) {
    const v = getAt(incoming || {}, path)
    const p = parentOf(next, path, v !== undefined)
    if (!p) continue
    const k = path.at(-1)
    if (v === null) p[k] = '' // 明确传 null = 清空
    else if (v === undefined || v === '') p[k] = getAt(current, path) ?? ''
    delete p[`${k}Set`]
    delete p[`${k}Hint`]
  }
  if (Array.isArray(incoming?.imageGen?.fallbacks)) {
    const old = new Map((current.imageGen?.fallbacks || []).map(e => [e.id, e]))
    next.imageGen.fallbacks = incoming.imageGen.fallbacks.map(e => ({ ...e, apiKey: e.apiKey === null ? '' : (e.apiKey || old.get(e.id)?.apiKey || '') }))
  }
  // 主人的抖音 secUid / uid / 昵称只能由「核对」写入，面板存配置时保留原值
  next.douyin.owner = { ...next.douyin.owner, ...Object.fromEntries(['secUid', 'uid', 'nickname', 'confirmedInput'].map((k) => [k, current.douyin?.owner?.[k] ?? ''])) }
  // 联动密钥只由插件生成，面板不能改
  next.bridge.token = current.bridge?.token || ''
  // B 站：只改了其中一个值时，另一个保留；整串粘进来的会在 normalize 里拆开
  if (incoming?.bili && (incoming.bili.sessdata || incoming.bili.biliJct)) next.bili.cookie = ''
  if (incoming?.group?.overrides) next.group.overrides = incoming.group.overrides
  // 按聊天选模型：两张表整张替换（deepMerge 会让删掉的条目又回来）
  if (incoming?.chatModels?.privates) next.chatModels.privates = incoming.chatModels.privates
  if (incoming?.chatModels?.groups) next.chatModels.groups = incoming.chatModels.groups
  if (incoming?.allow) next.allow = { ...current.allow, ...incoming.allow }
  return normalize(next)
}

const LEGACY_NEUTRAL_KEYS = [
  'ownerQQ', 'ownerName', 'ownerLevel',
  'persona', 'personas', 'model', 'chatModels', 'chatEfforts', 'memory',
  'merge', 'forward', 'cost', 'diary', 'group', 'titleFilter', 'allow',
  'capabilityAllow', 'commandAllow', 'longTasks', 'subagentBackground',
  'local', 'stickers', 'mood', 'purpose', 'autotelic', 'schedule',
]

/** 判断旧版（QQ 版）配置是否仍在启用，供跨版导入跳过 sessions.json 等热冲突项。 */
export function isLegacyQQEnabled(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  return raw.enabled === true || raw.platforms?.qq?.enabled === true
}

/** 提取旧配置中与平台/网关/鉴权无关的可迁移字段；排除网关、SnowLuma 密码/令牌及凭据。 */
export function pickPlatformNeutralConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const key of LEGACY_NEUTRAL_KEYS) {
    if (Object.hasOwn(raw, key) && raw[key] !== undefined) out[key] = structuredClone(raw[key])
  }
  return out
}
