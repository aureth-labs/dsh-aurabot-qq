// Step 0A TypeScript 契约编译校验夹具（由 npx -y -p typescript tsc --noEmit --strict 检查）：
// 验证 PlatformAdapter.fetch? 可选重载、Gateway.fetch 重载顺序、必填 Gateway.features / onCapsChanged 与负向收窄约束。

import type {
  AuthCompletion,
  AuthDriverPollResult,
  AuthErrorDetail,
  AuthErrorStage,
  AuthMethod,
  AuthSessionState,
  AuthSessionView,
  Caps,
  Feature,
  FetchRequest,
  FetchedForwardResult,
  FetchedHistoryPage,
  FetchedMessage,
  Gateway,
  Part,
  PlatformAdapter,
  PlatformAuthDriver,
} from '../../src/gateway/contracts.js'

declare const capsSample: Caps
declare const gw: Gateway
declare const adapter: PlatformAdapter

// 1. PlatformAdapter 省略可选 fetch? 应合法
export const minimalAdapter: PlatformAdapter = {
  id: 'qq',
  name: 'QQ',
  contract: 1,
  settings: [],
  async whoami() { return { account: '1', name: 'bot' } },
  async start() {},
  async stop() {},
  async send() { return { messageId: '1' } },
  caps: () => capsSample,
}

// 2. PlatformAdapter 实现 fetch?（方法写法）应兼容所有 overload
export const fullAdapter: PlatformAdapter = {
  id: 'qq',
  name: 'QQ',
  contract: 1,
  settings: [],
  async whoami() { return { account: '1', name: 'bot' } },
  async start() {},
  async stop() {},
  async send() { return { messageId: '1' } },
  caps: () => capsSample,
  async fetch(req: FetchRequest): Promise<any> {
    if (req.kind === 'message') return { messageId: req.messageId, parts: [] } satisfies FetchedMessage
    if (req.kind === 'forward') return { messages: [] } satisfies FetchedForwardResult
    if (req.kind === 'history') return { messages: [], hasMore: false } satisfies FetchedHistoryPage
    return null
  },
}

// 3. 调用方 overload 解析与负向约束断言（@ts-expect-error 必须报错才算通过）
export async function verifyContractTypes() {
  const m: FetchedMessage = await gw.fetch('feishu:private:ou_1', { kind: 'message', messageId: 'om_1' })
  const f: FetchedForwardResult = await gw.fetch('qq:private:1', { kind: 'forward', id: 'f1' })
  const h: FetchedHistoryPage = await gw.fetch('qq:private:1', { kind: 'history', chat: { kind: 'private', id: '1' } })
  const media = await gw.fetch('qq:private:1', { kind: 'media', media: { id: 'img1' } })

  // @ts-expect-error forward 必须返回 FetchedForwardResult，禁止退回裸 Part[][]
  const badForward: Part[][] = await gw.fetch('qq:private:1', { kind: 'forward', id: 'f1' })

  // @ts-expect-error history 必须返回 FetchedHistoryPage，禁止直接返回 FetchedMessage[]
  const badHistory: FetchedMessage[] = await gw.fetch('qq:private:1', { kind: 'history', chat: { kind: 'private', id: '1' } })

  // @ts-expect-error message 必须返回 FetchedMessage
  const badMsg: FetchedForwardResult = await gw.fetch('qq:private:1', { kind: 'message', messageId: 'm1' })

  // @ts-expect-error sender.idType 仅允许 'open_id' | 'union_id' | 'user_id'
  const badIdType: FetchedMessage = { messageId: '1', sender: { account: 'u1', idType: 'openid' }, parts: [] }

  // 缺失 sender 与可选 account='' 合法
  const noSender: FetchedMessage = { messageId: 'deleted_1', parts: [] }
  const emptyAccount: FetchedMessage = { messageId: 'sys_1', sender: { account: '', isBot: false }, parts: [] }

  const feat: Record<Feature, boolean> = gw.features('qq')
  const off: () => void = gw.onCapsChanged((info) => {
    const _collect: boolean = info.features['sticker.collect']
    void _collect
  })

  if (adapter.fetch) {
    const am: FetchedMessage = await adapter.fetch({ kind: 'message', messageId: 'om_1' })
    const af: FetchedForwardResult = await adapter.fetch({ kind: 'forward', id: 'f1' })
    const ah: FetchedHistoryPage = await adapter.fetch({ kind: 'history', chat: { kind: 'private', id: '1' } })

    // @ts-expect-error 可选 PlatformAdapter.fetch? overload 同样禁止返回裸 Part[][]
    const badAf: Part[][] = await adapter.fetch({ kind: 'forward', id: 'f1' })
    void am; void af; void ah; void badAf
  }

  return { m, f, h, media, badForward, badHistory, badMsg, badIdType, noSender, emptyAccount, feat, off }
}

// 4. Phase 0 统一认证契约正反校验
export const validAuthDriver: PlatformAuthDriver = {
  platform: 'wechat-clawbot',
  methods: [{ method: 'qr-link', label: '微信扫码登录', defaultTtlMs: 600_000, defaultPollIntervalMs: 2000 }],
  allowedConfigKeys: ['botId', 'baseUrl', 'routeTag'],
  async start() {
    return {
      state: 'qr_ready',
      qrContent: 'https://example.com/qr/1',
      driverSession: { qrcode: 'q1' },
    }
  },
  async poll(): Promise<AuthDriverPollResult> {
    return {
      state: 'authorized',
      completion: {
        configPatch: { botId: 'b1' },
        secretPatch: { botToken: 'secret-value' },
        self: { account: 'b1', name: 'Bot' },
      } satisfies AuthCompletion,
    }
  },
}

export const validAuthView: AuthSessionView = {
  sessionId: 'auth-1',
  platform: 'wechat-clawbot',
  instance: 'wechat-clawbot',
  method: 'qr-link',
  state: 'qr_ready',
  expiresAt: Date.now() + 60_000,
  pollIntervalMs: 2000,
  qrDataUri: 'data:image/svg+xml;base64,AAAA',
  message: '请扫码',
  error: {
    code: 'qr-encode-failed',
    stage: 'auth.qr.encode',
    message: '编码失败',
    retryable: true,
    platform: 'wechat-clawbot',
  } satisfies AuthErrorDetail,
}

// @ts-expect-error AuthMethod 仅允许预定义认证方式
export const badAuthMethod: AuthMethod = 'magic-link'

// @ts-expect-error AuthSessionState 仅允许状态机预定义状态
export const badAuthState: AuthSessionState = 'confirmed'

// @ts-expect-error AuthErrorStage 仅允许 auth.* 预定义阶段
export const badAuthStage: AuthErrorStage = 'auth.unknown'

// @ts-expect-error AuthCompletion.secretPatch 键值必须为 string
export const badAuthCompletion: AuthCompletion = { configPatch: {}, secretPatch: { botToken: 123 } }
