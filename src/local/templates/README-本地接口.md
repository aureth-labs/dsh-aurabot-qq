# Aurabot 本地接口

这个文件夹里的脚本可以接管大肥鱼的几项能力，换成你电脑上自己的模型或服务。
插件升级不会动这个文件夹。脚本改完保存就生效，不用重启 DSH。

| 文件 | 接管什么 | 什么时候用 |
|---|---|---|
| `tts.mjs` | 语音合成（她发的语音条） | 每次她要发语音 |
| `image.mjs` | 生图 | 她调用画图工具时 |
| `song-convert.mjs` | 翻唱里「人声 → 她的声音」这一步 | 每次翻唱（下载、分离、混音、发送还是插件做） |
| `asr.mjs` | 别人发来的语音条转文字 | 收到语音条时最先试 |

每个文件要在面板「本地接口」页**打开开关**才会用；文件不存在或开关关着，就用插件内置的方式。

## 写法约定

- 是 Node.js 的 ES 模块（`.mjs`），`export default async function (参数) { ... }`。
- 可以用 Node 自带的一切：`fetch`、`node:fs`、`node:child_process`（调你的 Python 项目）……不能 `npm install` 第三方包。
- 出错就 `throw new Error('原因')`：语音、识别会退回内置方式；生图、翻唱会让她告诉对方没成功和原因。
- 用参数里的 `log.info()` / `log.warn()` 打日志，会出现在面板「日志」页。
- 超时：语音 60 秒、识别 60 秒、生图 5 分钟、翻唱换声 20 分钟。

## 各脚本的参数和返回值

### tts.mjs
- 参数：`{ text, outDir, log }`
- 返回：音频文件路径（wav / mp3 / silk），或 `{ file }`

### image.mjs
- 参数：`{ prompt, size, image?, images?, outDir, log }`（`size` 形如 `"1024x1024"`，`prompt` 已带上面板里的固定风格）
- `image` 是可选参考图的纯 base64，不带 `data:` 前缀；来自当前聊天收到 / 引用的图或她自己的画作。没传时照常文生图，传了就必须使用参考图。
- 支持参考图时，在脚本顶层加 `export const supportsImage = true`，并把 `image` 接到服务的图生图接口（模板用 SD WebUI 的 `img2img` / `init_images`）。已有脚本不会自动覆盖，需要自行适配。
- 没声明支持，或服务本身不支持时，应报「这个生图服务不支持参考图」，不能忽略 `image` 继续文生图。
- 返回：图片 `Buffer`，或 `{ buffer }` / `{ file }` / `{ base64 }` / `{ url }`

多图脚本声明 `export const supportsImages = true`，可选 `export const maxReferenceImages = 4`（1–8，未声明取 8）。多图请求通过 `images: string[]` 接收纯 base64 数组；单图时也会补充单元素 `images`。旧 `supportsImage` 脚本仍只收 `image`。外貌文字及实际传入图片的备注已加入 `prompt`。脚本应使用所有传入图片，不静默丢弃。

### song-convert.mjs
- 参数：`{ input, output, pitch, voice, voiceFile, indexFile, log }`
  - `input`：分离出来的人声 wav；`output`：要写出的 wav 路径
  - `pitch`：变调半音；`voice`：面板里选的音色名；`voiceFile` / `indexFile`：导入过的 .pth / .index 路径（可能为空）
- 返回：换好声音的 wav 路径（一般就是 `output`）
- 开了这个之后，翻唱不再需要内置的 Applio 和音色模型（人声分离环境还是要装）

#### Windows Applio 的可选 CPU 配置

已使用 Applio、且 CPU 推理在 `ConvTranspose1d` 崩溃时，可把插件安装目录 `src/local/templates/song-cpu-infer.py` 复制到翻唱根目录的 `setup/`（同级应有 `Applio/`）。让现有 `song-convert.mjs` 用翻唱环境的 Python 调用这个文件，替代 `core.py`；后面的 `infer --input-path ... --output-path ...` 等参数保持不变。

这个入口关闭 MKLDNN、保留短分段并限定 PyTorch 线程数；默认单线程。在现有 `spawn` 的子进程 `env` 中加入 `AURABOT_RVC_CPU_THREADS: '4'`，可试用四线程，删掉该字段便恢复默认。不用修改系统环境变量或人格，也不改变普通 TTS。只在这条本地换声路径启用，不会自动改变其他用户的内置推理。

先用同一段已分离的人声比较 1、2、4 线程，再用完整长片段验证：线程越多不一定越快，短片段通过也不代表长输入不会崩溃。i5-12450H / 16 GB / PyTorch 2.11 CPU 的一次10秒同源测试，含启动和加载耗时约68、50、41秒；这是换声阶段，不是点歌到发送的总耗时。音色模型、RMVPE、检索比例和采样率保持不变。未通过稳定性检查时回到原线程数，不要为速度撤掉已有防崩溃措施。

### asr.mjs
- 参数：`{ file, log }`（`file` 是 16kHz 单声道 wav）
- 返回：识别出的文字，或 `{ text }`；听不清返回空字符串

## 让 DSH 帮你改

在面板「本地接口」页点「复制给 DSH 的话」，粘给 DSH，再补一句你用的是什么服务、地址和关键参数，它会读这份说明、帮你把脚本改好。
