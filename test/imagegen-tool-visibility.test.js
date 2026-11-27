// #47：生图配好了却没有 qq_draw_image —— 工具注册只看内置开关会漏掉本地接口/外部生图模块接管。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import imagegenModule from '../src/modules/imagegen/index.js'
import { normalize } from '../src/core/config.js'

const log = { info() {}, warn() {}, debug() {} }

function buildTool ({ config, localActive = false, external = null } = {}) {
  let build = null
  imagegenModule.setup({
    config: () => config,
    log,
    dsh: {},
    lazy: (id) => id === 'dsh-image' ? external : { addEvent () {} },
    route () {},
    tool: (fn) => { build = fn },
    core: { hub: {}, local: { active: (slot) => slot === 'image' && localActive } },
  })
  return (kind = 'private') => build({ chat: { kind, chatId: 'private:10001', userId: '10001' }, sessionId: 'visibility-test' })
}

const userConfig = () => normalize({
  imageGen: {
    enabled: true,
    provider: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: 'sk-user-key',
    model: 'Kwai-Kolors/Kolors',
    size: '1024x1024',
  },
})

test('工单环境（OpenAI 格式 + 开关开 + 地址/Key/模型齐全）工具必须注册', () => {
  const tool = buildTool({ config: userConfig() })()
  assert.ok(tool && typeof tool.execute === 'function', '应该有 qq_draw_image')
  assert.equal(tool.name, 'qq_draw_image')
  assert.deepEqual(tool.parameters.required, ['prompt', 'notice'])
})

test('内置开关关着但本地接口接管生图：工具仍要注册（否则配了本地画图也没有工具）', () => {
  const cfg = normalize({ imageGen: { enabled: false } })
  const tool = buildTool({ config: cfg, localActive: true })()
  assert.equal(tool?.name, 'qq_draw_image')
})

test('内置开关关着但外部生图模块（dsh-image）已就绪：工具仍要注册', () => {
  const cfg = normalize({ imageGen: { enabled: false } })
  const external = { ready: () => true, generate: async () => null }
  const tool = buildTool({ config: cfg, external })()
  assert.equal(tool?.name, 'qq_draw_image')
})

test('什么接法都没开时不要凭空挂一个画图工具', () => {
  const cfg = normalize({ imageGen: { enabled: false } })
  assert.deepEqual(buildTool({ config: cfg })(), [])
  assert.deepEqual(buildTool({ config: cfg, external: { ready: () => false } })(), [])
})

test('system 会话永远不挂画图工具（后台会话没有聊天可发）', () => {
  const tool = buildTool({ config: userConfig() })('system')
  assert.deepEqual(tool, [])
})

test('配置归一化：baseUrl / model / apiKey / stylePrompt 去掉首尾空白，开关只认布尔值', () => {
  const cfg = normalize({
    imageGen: {
      enabled: true,
      baseUrl: '  https://api.siliconflow.cn/v1 \n',
      model: ' Kwai-Kolors/Kolors\t',
      apiKey: ' sk-abc \n',
      stylePrompt: ' 日系 ',
    },
  })
  assert.equal(cfg.imageGen.baseUrl, 'https://api.siliconflow.cn/v1')
  assert.equal(cfg.imageGen.model, 'Kwai-Kolors/Kolors')
  assert.equal(cfg.imageGen.apiKey, 'sk-abc')
  assert.equal(cfg.imageGen.stylePrompt, '日系')
  assert.equal(cfg.imageGen.enabled, true)
  // 手改配置写成字符串 "true" 不算开：面板显示和工具注册必须一致，避免「看着开了其实没开」。
  assert.equal(normalize({ imageGen: { enabled: 'true' } }).imageGen.enabled, false)
})
