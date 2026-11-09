// 测试用的假 DSH 宿主：只实现 Aurabot 用到的那几样服务。
// 「模型」是个脚本：按用户消息内容决定回什么、调不调工具，用来验证插件的整条链路。

import { randomUUID } from 'node:crypto'

process.env.AURABOT_REGISTRY_URL ||= 'http://127.0.0.1:9/index.json' // 测试不碰真的社区库

export function createFakeDsh({ brain }) {
  const disposers = []
  const listeners = new Map()
  const routes = new Map()
  const variables = new Map()
  const agents = new Map()
  const workspaces = []
  const turns = [] // 记录每一轮：{ sessionId, preset, userText, images, reply, toolCalls }
  const logs = []

  const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args) }

  function makeAgent(sessionId, preset) {
    const tools = new Map()
    const contexts = new Map()
    const restrictions = new Map()
    const events = []
    let turn = 0
    let chain = Promise.resolve()
    const session = {
      id: sessionId,
      append: (type, data) => events.push({ type, data }),
    }
    const agent = {
      id: sessionId,
      preset,
      session,
      tools,
      contexts,
      events,
      denied: new Set(),
      guestLocked: 0,
      ctx: {
        tools: {
          register: (t) => {
            if (tools.has(t.name)) throw new Error(`tool "${t.name}" is already registered in this scope`)
            tools.set(t.name, t)
            let active = true
            return () => { if (active && tools.get(t.name) === t) tools.delete(t.name); active = false }
          },
          restrict: ({ deny = [], allow } = {}) => {
            // 只给 allow 不给 deny：空 allow 集 = 全局工具全部不可见（真实宿主同义）
            if (allow !== undefined) {
              agent.guestLocked = (agent.guestLocked || 0) + 1
              let open = true
              return () => { if (open) { open = false; agent.guestLocked -= 1 } }
            }
            const names = [...new Set(deny)]
            for (const n of names) { restrictions.set(n, (restrictions.get(n) || 0) + 1); agent.denied.add(n) }
            let active = true
            return () => {
              if (!active) return
              active = false
              for (const n of names) {
                const count = restrictions.get(n) - 1
                if (count) restrictions.set(n, count)
                else { restrictions.delete(n); agent.denied.delete(n) }
              }
            }
          },
        },
        systemPrompt: { context: (c) => {
          if (contexts.has(c.name)) throw new Error(`prompt context "${c.name}" is already registered in this scope`)
          contexts.set(c.name, c)
          let active = true
          return () => { if (active && contexts.get(c.name) === c) contexts.delete(c.name); active = false }
        } },
      },
      steered: [],
      // 假的 steer：记下来，并当作下一步输入（这里简化成排在当前这一轮之后再跑一轮）
      steer(msg) {
        agent.steered.push(msg)
        return agent.followup(msg)
      },
      followup(msg) {
        chain = chain.then(async () => {
          turn++
          const myTurn = turn
          const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
          const inputText = msg.content.filter((c) => c.type === 'text').at(-1)?.text || ''
          const images = msg.content.filter((c) => c.type === 'image')
          const ctxText = [...contexts.values()].map((c) => c.text()).filter(Boolean).join('\n')
          const persona = variables.get('aurabot_persona')?.() || ''
          const calls = []
          const callTool = async (name, args) => {
            const t = tools.get(name)
            if (!t) { calls.push({ name, args, result: { ok: false, message: 'no such tool' } }); return null }
            const result = await t.execute(args, { agent })
            calls.push({ name, args, result })
            return result
          }
          const reply = await brain({ preset, text, inputText, images, ctxText, persona, callTool, toolNames: [...tools.keys()], source: msg.source })
          turns.push({ source: msg.source, sessionId, preset, userText: text, inputText, images: images.length, reply, toolCalls: calls, ctxText })
          emit('session/event', session, { type: 'assistant/message', data: { turn: myTurn, message: { content: [{ type: 'text', text: reply }] } } })
          emit('session/event', session, { type: 'turn/end', data: { turn: myTurn, reason: { kind: 'completed' } } })
        })
        return chain
      },
    }
    return agent
  }

  const globalTools = new Map() // 全局工具（DSH 所有会话都能看到）
  const provided = new Map() // ctx.provide 登记的服务
  const ctx = {
    globalTools,
    tools: { register: (t) => { if (globalTools.has(t.name)) throw new Error('dup ' + t.name); globalTools.set(t.name, t); let active = true; return () => { if (active && globalTools.get(t.name) === t) globalTools.delete(t.name); active = false } } },
    provide(name, value) { provided.set(name, value); disposers.push(() => provided.delete(name)) },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name).delete(fn)
    },
    interval(fn, ms) {
      const t = setInterval(fn, ms)
      return () => clearInterval(t)
    },
    systemPrompt: { variable: (n, fn) => { variables.set(n, fn); return () => variables.delete(n) } },
    webServer: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) } },
    workspaceRegistry: {
      archivedSessionIds: [],
      archiveSession(id) { this.archivedSessionIds.push(id) },
      list: () => workspaces,
      async create(path, title) {
        const w = { id: randomUUID(), path, title, sessionIds: [] }
        workspaces.push(w)
        return w
      },
    },
    agents: { get: (id) => agents.get(id) },
    attachments: {
      async admitPromptContent(content) {
        return content.map((c) => (c.type === 'image' ? { type: 'image', attachment: { attachmentId: randomUUID() }, mediaType: c.mediaType } : c))
      },
    },
    llm: {
      listProviders: () => ['fake'],
      async listModels() { return ['fake-1', 'm-pdef', 'm-gdef', 'm-owner', 'm-g777'].map((id) => ({ id, name: id })) },
      async *stream({ system } = {}) {
        const text = system?.includes('整理长期记忆') ? '[]' : '可爱的小鲸鱼 #开心 #卖萌'
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    services: {
      sessionController: {
        async create({ workspaceId, agentPreset }) {
          const id = randomUUID()
          agents.set(id, makeAgent(id, agentPreset))
          workspaces.find((w) => w.id === workspaceId)?.sessionIds.push(id)
          return { sessionId: id, agentPreset }
        },
        async rename() { return {} },
        async resolveAgent(id) {
          const a = agents.get(id)
          return a ? { agent: a } : { error: { code: 'session/not-found', message: 'not found' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) },
    },
    get(name) {
      return this.services[name] ?? provided.get(name) ?? this[name]
    },
  }

  async function call(path, body, headers = {}, socket, method) {
    const full = '/aurabot/api' + path.split('?')[0]
    // 先精确匹配，再找最长的前缀路由（和 DSH 的网页服务一样）
    const r = routes.get(full) || [...routes.values()].filter((x) => x.kind === 'prefix' && (full === x.path || full.startsWith(x.path + '/'))).sort((a, b) => b.path.length - a.path.length)[0]
    if (!r) throw new Error('no route ' + path)
    let out = ''
    let status = 200
    const req = {
      url: '/aurabot/api' + path,
      // 默认带本机 Host：真实场景里本机面板/测试直调都带 127.0.0.1 的 Host，
      // 而管理面的 Host 允许名单（DNS rebinding 防护）会拒绝没有 Host 的请求。
      // 测试要模拟异常 Host（rebinding / 反代域名）时在 headers 里显式覆盖。
      headers: { host: '127.0.0.1:5099', ...headers },
      // 默认带 body 的调用按 POST 处理；要测别的写方法（PUT/DELETE…）用第五个参数显式给
      method: method || (body != null ? 'POST' : 'GET'),
      async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body) },
    }
    // 模拟真实连接的来源地址：不传 = 进程内直调（无 socket，插件按本机处理）；
    // 传 '203.0.113.7' = 外网直连；传 '127.0.0.1' = 本机/反代接入。
    if (socket) req.socket = { remoteAddress: socket }
    const res = { set statusCode(v) { status = v }, setHeader() {}, end(s) { out = s } }
    await r.handler(req, res)
    return { status, raw: () => out, json: () => JSON.parse(out) }
  }

  return { ctx, emit, routes, variables, agents, workspaces, turns, logs, call, dispose: () => disposers.splice(0).reverse().forEach((d) => { try { d() } catch (e) {} }) }
}
