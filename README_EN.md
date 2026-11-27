<div align="center">

<img src="assets/banner.svg" alt="Aurabot · 大肥鱼" width="100%" />

**"Dafeiyu" — an AI companion living in your chat apps · A DeepSeek Harness plugin**

A persona, a mood, and a memory of her own. She chats, sees images, sends voice notes, collects stickers, sings in her own voice, writes Qzone diaries, browses Bilibili — and sometimes reaches out to you first.
Supports **QQ, QQ Official Bot, Feishu, WeChat ClawBot, WeCom, and DingTalk** — one persona, several platforms.

**English** · [简体中文](README.md)

[![release](https://img.shields.io/github/v/release/aureth-labs/dsh-aurabot-qq?include_prereleases&label=release&color=4a7dff)](https://github.com/aureth-labs/dsh-aurabot-qq/releases)
[![license](https://img.shields.io/github/license/aureth-labs/dsh-aurabot-qq?color=3fb950)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-6a5acd)](https://github.com/deepseek-ai/deepseek-harness)
[![QQ](https://img.shields.io/badge/QQ-SnowLuma%20%2F%20OneBot%20v11-12b7f5)](https://github.com/SnowLuma/SnowLuma)
[![stars](https://img.shields.io/github/stars/aureth-labs/dsh-aurabot-qq?color=f5b301)](https://github.com/aureth-labs/dsh-aurabot-qq/stargazers)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](#-contributing)

<p>
  <img src="https://img.shields.io/badge/QQ-1EBAFC?logo=qq&logoColor=white" alt="QQ">
  <img src="https://img.shields.io/badge/QQ%20Official%20Bot-1EBAFC?logo=qq&logoColor=white" alt="QQ Official Bot">
  <img src="https://img.shields.io/badge/Feishu-3370FF" alt="Feishu">
  <img src="https://img.shields.io/badge/WeChat-07C160?logo=wechat&logoColor=white" alt="WeChat">
  <img src="https://img.shields.io/badge/WeCom-3370FF?logo=wechat&logoColor=white" alt="WeCom">
  <img src="https://img.shields.io/badge/DingTalk-1677FF?logo=dingtalk&logoColor=white" alt="DingTalk">
</p>

</div>

> Aurabot turns the AI inside **DeepSeek Harness (DSH)** into a chat companion with a real persona: she has moods, remembers details, knows your friends, follows group conversations, sends voice notes, sings in her own voice, keeps a Qzone diary, and browses Bilibili.
>
> She is no longer QQ-only: connect QQ Personal via SnowLuma/OneBot, QQ Official Bot, Feishu, WeChat ClawBot, WeCom, or DingTalk. **Each platform is an adapter; persona, memory, tools, and the panel are shared. Owner DMs from multiple platforms can also share one session.**
>
> This is not another keyword-reply bot: every reply, every decision to join a conversation, every model choice, and every outgoing message is a pluggable module. Everything is off by default — **not a single message reaches any platform until you turn it on.**

```
QQ Personal ⇄ SnowLuma (OneBot v11)┐
QQ Official Bot / Feishu / WeChat / WeCom / DingTalk
              ⇅ official long connection / callback / iLink
           Aurabot plugin ⇄ DSH sessions
                         ├─ persona + mood + memory
                         ├─ tools / hot-reloadable modules
                         └─ web panel (DSH Web)
```

## 🌐 Multi-platform support

One DSH persona can live on several platforms at once. Each adapter declares its real `caps` honestly, so platform limits are visible instead of being hidden behind a “fully supported” label.

| Platform | Connection | What she can do / limits |
|---|---|---|
| **QQ Personal** | SnowLuma (OneBot v11), or any existing OneBot v11 gateway | The fullest QQ form: DM/group, images, native voice, quotes, stickers, proactive messages; file/video/recall support depends on the gateway probe. |
| **QQ Official Bot** | AppID + AppSecret, WebSocket or Webhook; QR creation is also supported | Official hosting, DM/group @; images, video, and files; voice is sent as an audio file; no quote reply; proactive messages are quota-limited. |
| **Feishu** | QR-created bot or App ID + App Secret; long connection/callback | DM/group @, images, native voice, video, files, quotes, and cards; reading all group messages requires an extra sensitive permission. |
| **WeChat ClawBot** | WeChat QR bind, iLink long polling | DM-first text chat with images/video/files; voice is sent as a file by default; group chat requires experimental rollout; proactive messages are limited by context token and rate. |
| **WeCom** | QR bind or Bot ID + Secret; official WebSocket | DM/group @, images, native voice, video, files; proactive messages are free; incoming quotes can be read, but no native outgoing quote reply. |
| **DingTalk** | QR creation or Client ID + Client Secret; Stream long connection | DM/group @, images, native voice, files; proactive messages are free; no video or native quote reply. |

> “Group” here means **responding when mentioned or allow-listed** by default. “All group messages” means the platform permits receiving unmentioned group messages for passive listening.
> QQ Personal file/video/recall support depends on the OneBot gateway.
> QQ Zone, Bilibili, and cover-song modules still use their own platform/workspace entry; what is shared across platforms is persona, memory, tools, and session routing.

### Feature matrix

| Platform | DM | Group | Image | Voice | Video | File | Quote reply | Proactive | All group messages |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| QQ Personal (SnowLuma / OneBot v11) | ✅ | ✅ | ✅ | ✅ native | ⚠️ gateway | ⚠️ gateway | ✅ | ✅ free | ✅ |
| QQ Official Bot | ✅ | ✅ @ | ✅ | ⚠️ audio file | ✅ | ✅ | ❌ | ⚠️ limited | ⚠️ group owner opt-in |
| Feishu | ✅ | ✅ @ | ✅ | ✅ native | ✅ | ✅ | ✅ | ✅ availability range | ⚠️ sensitive permission |
| WeChat ClawBot | ✅ | ⚠️ opt-in/gray | ✅ | ⚠️ file default | ✅ | ✅ | ❌ | ⚠️ limited | ❌ |
| WeCom | ✅ | ✅ @ only | ✅ | ✅ native | ✅ | ✅ | ⚠️ inbound read only | ✅ free | ❌ |
| DingTalk | ✅ | ✅ @ only | ✅ | ✅ native | ❌ | ✅ | ⚠️ inbound read only | ✅ free | ❌ |

**Legend:** ✅ native; ⚠️ limited by platform permission, gateway, or configuration; ❌ not declared.
**Note:** proactive messages are also subject to platform quotas, user/group settings, and Aurabot’s own master switch. QQ Personal “gateway” capabilities are shown in the panel when the current gateway does not support them.

---

## ✨ Why Aurabot

<table>
  <tr>
    <td width="25%" valign="top"><h3>🫧 Chats like a person</h3>In groups she waits for a pause and reads the whole stretch before replying; she always answers when called, joins by topic otherwise, can quote, use stickers, send voice — or stay quiet.</td>
    <td width="25%" valign="top"><h3>🧩 Everything is a module</h3>Even “should she reply in this group”, the prompt, message splitting, outgoing content and model selection are hookable. Install community modules from the panel; upgrades never overwrite yours.</td>
    <td width="25%" valign="top"><h3>🧠 Long-term memory</h3>A local memory store: things she noted, daily consolidated facts, per-person profiles, relationship insights and speaking style — recalled by relevance, time and a forgetting curve.</td>
    <td width="25%" valign="top"><h3>🛡️ Safe by default</h3>Master switch off, dry run on; group / non-owner chats get no local tools; sensitive actions require the whole turn to be the owner.</td>
  </tr>
</table>

## 🎭 What she can do

| | Capability | Details |
|---|---|---|
| 💬 | **DM & group chat** | Each platform DM/group usually maps to its own DSH session; with shared private sessions enabled, the owner’s DMs across platforms merge into one. Watch her reasoning and tool calls, or jump in |
| 🎨 | **Persona & mood** | Switchable persona cards edited section by section; mood driven by praise/anger, affecting tone, stickers, voice and reply speed |
| 🗣️ | **Voice notes & singing** | edge-tts, Doubao (Volcano) / MiniMax online voices, local CosyVoice / GPT-SoVITS, or any HTTP TTS; import RVC voices for covers so she talks and sings with the same voice |
| 😀 | **Stickers** | Auto-collect, AI naming/tagging, context-aware sticker choice; marketplace stickers sent as-is |
| 📖 | **Qzone** | Writes diaries from the day’s chats, replies to comments as her persona, browses friends’ feeds |
| 📺 | **Bilibili** | Picks videos from interests and memory, reads info/subtitles/comments, comments, shares to your DM; follows up on replies to her comments |
| 🖼️ | **Image gen & local APIs** | Built-in or your own image/TTS/cover/ASR services; the panel generates scripts that take effect instantly |
| 🧠 | **Memory** | Memory store, per-person profiles, relationship insights, speaking style and diaries go into context; import old notes; search/edit/delete and adjust automatic memory capacity in the panel (default 3,000) |
| 🐟 | **Desktop pet (optional)** | A pet module puts her on your desktop: idle actions, muttering, work-status reactions — never posts to a chat platform |
| 🌙 | **Proactive** | Proactive chats, a purpose engine, good-night moods — with awake hours, frequency and allow-lists |
| 🧩 | **Module market** | One-click community modules (pet, Douyin, Heybox, group admin, phone automation, …), configs and logins kept |
| 🔐 | **Permission page** | Every sensitive action is 关 / owner-DM only / everyone, re-checked at execution; dry run never performs side effects |

> Deeper module, command and API docs live in [the user manual (Chinese)](docs/USER-MANUAL.md).

## 🚀 Quick start

**Requirements:** a machine that runs DeepSeek Harness (Windows is easiest) and at least one platform account to connect. QQ Personal needs a QQ gateway (SnowLuma on Windows; any OneBot v11 implementation on Linux/Docker); QQ Official Bot, Feishu, WeChat ClawBot, WeCom, and DingTalk can be connected directly from the setup wizard via QR or credentials.

### 1. Install the plugin

**Windows desktop:**

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:aureth-labs/dsh-aurabot-qq
```

**Linux / Docker** (replace `<profile>` with yours; run inside the container if applicable):

```bash
dsh plugin --profile <profile> add github:aureth-labs/dsh-aurabot-qq
```

Restart DSH; **Aurabot** appears in the sidebar under *Automation*.

### 2. Follow the setup wizard

1. Choose the platform(s) to connect in the wizard; scan the QR code or enter the bot credentials
2. If you choose **QQ Personal**, choose a gateway:
   - **SnowLuma (Windows)**: download & extract [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases) → start it → accept its EULA yourself in the panel (a console password is generated) → log in the bot account → click “attach bot account”
   - **Existing OneBot bot**: NapCat, LLOneBot, Lagrange or Dockerized SnowLuma all work; paste the forward WebSocket URL (and token). The plugin only connects — it never starts or injects into anything
3. Other platforms need no QQ gateway: choose QQ Official Bot, Feishu, WeChat ClawBot, WeCom, or DingTalk directly in the wizard, then scan the QR code or enter credentials
4. Start in dry run (replies only, nothing sent) or go live

> **Linux / Docker notes:** voice needs `python3-venv` or [uv](https://docs.astral.sh/uv/); RVC covers are Windows-only for now; when connecting to OneBot on the host or another container, use a reachable host/port instead of `127.0.0.1`.

### 3. Upgrade

Re-run the install command and restart DSH — settings, persona and memory are preserved. Enable *subscribe to unstable versions* in the panel for beta/rc update notices.

## 🧩 Module system

Apart from the core (config, platform gateway, chat hub, persona, permissions, panel), **every feature is a module**.

- Install/update/remove community modules from the panel’s **Module market** — registry: [dsh-aurabot-qq-mods](https://github.com/aureth-labs/dsh-aurabot-qq-mods)
- Your own modules live in the data directory `modules/` — never overwritten by upgrades, hot-reloaded on save (multi-file and npm deps supported)
- The panel has a sandboxed “simulate” test that captures outgoing messages instead of sending them
- Extension API: [API.md (Chinese)](src/modules/API.md) · types: [aurabot.d.ts](src/modules/aurabot.d.ts) · [module tutorial](docs/MODULE-TUTORIAL.md)
- Not a coder? Hand API.md to DSH and let it write the module for you

> ⚠️ Modules run in the same process as the plugin and can access account config. Capabilities shown at install time are declarations, **not a sandbox**. Only install modules you trust.

## 🛡️ Security & privacy

- **Off by default**: master switch off + dry run on — nothing goes to any platform until you enable it
- **Per-context permissions**: owner DMs get the full toolset; group chats and other people’s DMs get **no local tools**; sensitive actions (profiles, files, song covers, image gen, …) require the whole turn to be the owner
- **Execution-level guards**: dangerous shell commands need a “confirm” reply in chat (optional); DSH approvals can be confirmed from your owner DM (can be disabled); unload/reload clears pending confirmations and timers
- **Privacy boundaries**: what you say in an owner DM is never fed into groups or other DMs; memory is isolated by chat origin; social contexts only recall memories from that chat
- **Local data**: `%USERPROFILE%\.dsh\plugins-data\aurabot\`; use *System → Backup* to export everything as a zip and restore on a new machine

## 🖥️ Panel overview

| Group | Pages |
|---|---|
| Overview | status, logs, log level |
| Talk | connection, persona, permissions, group, model, voice, stickers, image gen, mood & memory |
| Life | Qzone, Bilibili, song covers, proactive chat, desktop pet, module market |
| System | workspace, backup, about, updates |

## 📚 Documentation

| Document | Contents |
|---|---|
| [User manual (Chinese)](docs/USER-MANUAL.md) | Every setting after installation, QQ commands, panel guide — **start here** |
| [Module tutorial (Chinese)](docs/MODULE-TUTORIAL.md) | Write your first module; hot reload; rewrite hooks |
| [Module API (Chinese)](src/modules/API.md) | Extension API, tools, context, commands, scheduled jobs |
| [Changelog](CHANGELOG.md) | What changed in each version |
| [Design notes (Chinese)](docs/DESIGN.md) | Implementation trade-offs: persona injection, group context, memory, mood, Bilibili, covers |

## ❓ FAQ

<details>
<summary><b>Does it require Windows?</b></summary>

No. The plugin runs on Linux/macOS/Windows; Windows is easiest because of the SnowLuma gateway and RVC cover support. On Linux/Docker, connect your own OneBot v11 bot; voice needs a Python venv.
</details>

<details>
<summary><b>Will my QQ account get banned?</b></summary>

It uses your own QQ account and your own gateway (SnowLuma/NapCat/…); the risk is the same as any QQ bot framework. Use a spare account, start in dry run, and don’t spam strangers.
</details>

<details>
<summary><b>Where does my data go?</b></summary>

Everything stays in the local data directory by default. Model calls go to the model service you configure; only features you explicitly enable (vector search, cloud TTS, Bilibili, Qzone, …) contact their services — each is explained in the panel before enabling.
</details>

<details>
<summary><b>Can I change the persona or add features?</b></summary>

Edit the persona section by section in the panel (effective next turn); features can be disabled, replaced, or written as your own hot-reloadable module, or installed from the module market.
</details>

<details>
<summary><b>How do I migrate to a new machine?</b></summary>

*System → Backup* exports config, memory, personas, stickers, your modules and QQ sessions as a zip; drop it in on the new machine and restart. Market modules are re-downloaded automatically.
</details>

<details>
<summary><b>Install fails / errors?</b></summary>

Bring the error and version from the panel’s *Logs* page to the QQ group (QR below), or open a [GitHub issue](https://github.com/aureth-labs/dsh-aurabot-qq/issues).
</details>

## 🧑‍💻 Development

```bash
git clone https://github.com/aureth-labs/dsh-aurabot-qq.git
cd dsh-aurabot-qq
npm test        # unit tests + end-to-end tests with a fake DSH host and a mock OneBot
```

```
src/host.js            plugin entry (host half): core + panel API /aurabot/api/*
src/core/modules.js    module kernel: load, toggle, replace, hot reload, error isolation
src/modules/           built-in modules + API.md + types + module template
src/chat/              message hub, group policy, reply parsing, allow-list & permissions
src/onebot/client.js   OneBot v11 client (HTTP + WS, auto reconnect)
src/snowluma/          SnowLuma management (detect, start/stop, inject only the bot account)
src/features/          stickers, Qzone, mood, memory, proactive chat, image gen
src/song/              cover pipeline (NetEase → separation → RVC → mixdown)
src/voice/             TTS, WAV handling
client/client.js       web half: sidebar entry + panel
personas/dafeiyu.md    default persona
cordis.patch.yml       plugin + preset mount declarations
test/                  unit + end-to-end tests
```

Requires Node.js ≥ 22.13.0.

## 🤝 Contributing

Issues and PRs are welcome!

- **Bug / feature request**: [open an issue](https://github.com/aureth-labs/dsh-aurabot-qq/issues) (please search first)
- **Code**: [fork → PR](https://github.com/aureth-labs/dsh-aurabot-qq/pulls); include regression tests for fixes; modules belong in the [module repo](https://github.com/aureth-labs/dsh-aurabot-qq-mods)
- **Modules**: start with the [tutorial](docs/MODULE-TUTORIAL.md)
- Contributors are credited in the changelog and PR history 💙

## 💬 Community

QQ group (install help, usage, ideas — please include the error from the panel logs and your version):

<div align="center">
<img src="assets/qq-group.jpg" alt="QQ group QR code" width="240" />
</div>

## 📈 Star history

<a href="https://www.star-history.com/?repos=aureth-labs%2Fdsh-aurabot-qq&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=aureth-labs/dsh-aurabot-qq&type=date&theme=dark&legend=top-left" />
    <img alt="Star history" src="https://api.star-history.com/svg?repos=aureth-labs/dsh-aurabot-qq&type=date&legend=top-left" />
  </picture>
</a>

## 📄 License & acknowledgements

[MIT](LICENSE)

Inspired by lessons from [Yuuyuko-uu](https://github.com/Yuuyuko-uu)’s dsh-qq-bridge, dsh-speak-up, dsh-feiyu-mood and dsh-fish-memory plugins (MIT) about the DSH plugin mechanism — no code was copied. Thanks to every contributor, module author, and everyone in the group who keeps tinkering with us.

<div align="center"><sub>Made with 🐟 by the Aurabot community</sub></div>
