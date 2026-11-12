# dsh-x-memory

简体中文 | [English](README.en.md)

> DSH 的分层记忆插件：把「该一直记得的」「以前发生过的」「踩过的坑」「你的编码规矩」分开放、按需注入，而不是一股脑塞进上下文。

只装这一个插件，就能同时得到：常驻核心记忆、可检索的归档笔记、会话过程图谱、自动踩坑记录、项目编码规范，以及从 billion-context 会话摘要里找回旧过程的能力。每一层都有独立预算和独立开关，互不挤占。

- 运行要求：Node.js ≥ 24，DSH ≥ 0.2.1-rc.2
- 许可证：MIT
- 来源：以 [dsh-soul](https://github.com/icyaaaww/dsh-soul) 2.0.1 为底座，移植 dsh-core-memory 1.0.1 的核心记忆层（两者均 MIT），详见文末「致谢」

---

## 它解决什么

| 问题 | 这一层怎么解决 |
| --- | --- |
| 新会话从零开始，之前说过的偏好全忘了 | 核心记忆 `MEMORY.md` 每个会话自动注入 |
| 只记得结论，找不到当时的约束和决策 | 会话图谱记录约束/决策/产物，`soul_recall` 按需回捞 |
| 同一个错反复犯 | 工具报错后自动记一条「错 + 当时怎么改对的」，下个会话提醒 |
| 每次都要重新交代代码规范 | 自动读全局 `CODING.md` 和项目里的 `AGENTS.md` 等规则文件 |
| 长会话被压缩后，旧过程细节消失 | 桥接 billion-context 的会话压缩摘要，只读检索 |

## 为什么合成一个插件

三个记忆插件各管一摊时，模型要同时判断「这条该写哪」；拆开装还会重复注入、预算互相挤占。合成一个之后：

- **一次写入按内容分流**：长期事实进核心记忆，经历进归档笔记，过程进图谱，错误进踩坑记录，规矩进编码规范；
- **一次检索查三处**：`memory_search` 同时查归档、图谱和 billion-context 摘要，结果带来源和 id，需要时再下钻；
- **一套开关注入**：五层共用同一份数据目录、同一套脱敏与守卫规则。

## 五层记忆

| 层 | 存什么 | 位置 | 注入 | 预算 | 工具 |
| --- | --- | --- | --- | --- | --- |
| 核心记忆 | 长期稳定的事实、偏好、环境 | `$DSH_HOME/memory/MEMORY.md` | 每轮，`order 60` | 3000 字 | `memory_core` |
| 归档笔记 | 需要时才查的经历、结论 | `$DSH_HOME/memory/notes/*.md` | 只注入最近 12 条标题 | — | `memory_write` / `memory_read` / `memory_list` / `memory_search` / `memory_delete` |
| 会话图谱 | 约束、决策、产物、历史原文 | `$DSH_HOME/dsh-soul/<profile>/evolve.sqlite` | 投影 600 字节，`order 940` | 600 字节 | `soul_recall` / `soul_expand` |
| 踩坑记录 | 工具报错 → 后来怎么改对 | `$DSH_HOME/memory/LESSONS.jsonl` | 每轮，`order 62` | 600 字 | `lessons` |
| 编码规范 | 全局规矩 + 项目规则文件 | `$DSH_HOME/memory/CODING.md` + 项目目录 | 每轮，`order 61` | 2000 字 | `coding_rules` |

### 编码规范会自动读哪些文件

在当前会话的工作目录下，按顺序查找：

```
CODING.md
AGENTS.md
CLAUDE.md
.cursorrules
.github/copilot-instructions.md
.dsh/rules.md
.cursor/rules/*.mdc, *.md
```

全局 `CODING.md` 优先，项目文件按上面的顺序追加；超出 2000 字预算时截断并注明。

---

## 这一版新增的四个机制

### 1. 取代标记

同一条记忆被修正时，不要静默叠加两条：

```text
memory_write(title: "部署方式", content: "现在用 Docker Compose 部署", supersedes: "20261110-153000")
```

旧笔记保留但标记「已被 [新 id] 取代」，检索、列表、注入里都会显示。不想要旧内容直接 `memory_delete`。

### 2. 写入守卫（GUARD.json）

`$DSH_HOME/memory/GUARD.json` 可自定义规则：

- `reject`：私钥块、常见 token 形状（`sk-`、`ghp_`、`AKIA`、`glpat-` 等）——直接拒收，不落盘；
- `sensitive`：疑似密码/凭据赋值形状——允许保存但标 `sensitive: true`，系统提示不列它，检索时正文显示「已隐藏」，需要时用 `memory_read` 显式读取；
- 私钥块规则是硬底线，写在代码里，`GUARD.json` 关不掉。

核心记忆（会注入每个会话）对两类都直接拒写。

### 3. 每日快照

每天第一次加载时把记忆库整体复制到 `$DSH_HOME/memory/.snapshots/<时间戳>/`，保留最近 7 份。轮转按快照目录的修改时间（而不是目录名）判断新旧；记忆库还是空的时候不会留下空目录。改坏了可以整份拷回去；`memory_brief` 里能看到「快照：N 份」。

### 4. billion-context 桥接（只读）

如果装了 [billion-context](https://github.com/ranxianglei/billion-context)，`memory_search` 会在归档笔记、会话图谱之后，追加一段【历史会话摘要】——从它落盘的会话压缩块里做关键词检索。

- 只读它写好的 `sessions/*.json`，不改、不压缩它；
- 坏文件、超过 32MB、目录不存在都静默跳过，不影响主检索；
- 默认最多读最近 4 个会话、每个 5 块，`maxChars` 控制输出长度；
- 不想要就把 `bridge.enabled` 设为 `false`。

---

## 闲时整理（dreaming，可选）

默认关闭。开启后，插件会把最近会话图谱里的决策、约束和重复进度聚成 digest 笔记写进 `notes/`（只新增，不删改既有记忆）；开了 `dreaming.ai` 时还会先让模型判一遍垃圾（寒暄、断网重发的重复对话、明显错乱的内容），判定为 noise/duplicate 的节点只 retire——从投影与联想扩散里消失、原始会话日志不删；默认只动 pin=0、hits=0、未被取代、创建 ≥7 天的节点（比 periphery 启发式更窄：不看重要性分数），可用 `action=retired` 查看、`action=restore` 恢复；retired 超过 30 天后才可能被清理。`dreaming.autoApply` 默认 false：空闲不会自动整理，必须手动 `run`；设为 true 后才在空闲时自动 run。

- 开关：`memory_dreaming` 的 `action=status/on/off`（运行态写入 `$DSH_HOME/memory/DREAMING.json`，立即生效），或在设置里给 `dreaming.enabled: true`；开启后是否允许空闲自动改库由 `dreaming.autoApply`（默认 false）决定；
- 手动跑：`action=run` 默认 dry-run 只列候选，`apply: true` 才写盘，`force: true` 忽略冷却；
- 边界：每次最多 `dreaming.maxNotes` 条（默认 3）；两次自动整理至少间隔 `dreaming.minIntervalMinutes`（默认 180 分钟）；digest 带 `dream` 标签和来源 seq，走与 `memory_write` 相同的查重；
- 空闲触发延迟由 `dreaming.idleDelaySeconds` 控制（默认 120 秒，最小 10）；
- AI 清理（默认开）：模型只做裁决，必须返回严格 JSON；判 `noise`/`duplicate` 的节点 retire，`keep` 与编造 id 一律不动；某一批失败不影响其他批；全部失败或无 llm 时降级为「不清理」，digest 照写、冷却照常推进（`cleanup.available=false` 并在 `reason` 里说明 `llm_failed`/`no_llm`）；
- 分批与容错：候选每 12 条一批调用；输出被 token 上限截断时，从残缺 JSON 里捞出完整裁决（含末尾被截断的未闭合对象）；某批失败不影响其他批的结果；
- 损坏保护：`DREAMING.json` 读不出或损坏时 `run` 返回 `skipped:"corrupt"`、`status` 顶部会提示，且不会用默认值覆盖原文件（损坏副本留在 `DREAMING.json.bad-<时间戳>`，只保留最近 3 份）；修复或重建用 `action=on`；
- 路由兜底：`dreaming.provider/model` → 插件顶层 provider/model → 当前 agent → 宿主 `cordis.patch.yml` 的 `agent-default-model`，都没有才报错并给出配置指引；
- AI 路由：`dreaming.provider` / `dreaming.model`，留空用全局默认模型；扫描上限 `dreaming.maxScanNodes`（默认 60，范围 10–300），单次最多 retire `dreaming.maxRetirePerRun`（默认 20，范围 1–100）；`action=retired` 列出库里当前仍为 retired 的节点（restore 后即消失），`action=restore` 配 `ids` 恢复；整理正在运行时 restore 返回 `[err:E_BUSY]`。

- `cleanup` 字段：`available`（模型是否可用）、`reason`（`disabled` / `no_candidates` / `no_generator` / `no_llm` / `llm_failed` / null）、`scanned`、`planned`（模型判为 noise/duplicate、去重并按单次上限截断后的条数；真正退役还受护栏影响，看 apply 的 `retired`/`rejected`）、`retired`（真正退役的条数，受护栏与单次上限限制；dry-run 恒为 0）、`keep`、`invalid`、`rejected`（apply 时 planned 与 retired 的差额，被护栏挡下；dry-run 恒为 0）、`details`（每条裁决的 id/verdict/reason）、`error`（部分批失败时的首个错误）。`action=retired` 的 `retiredAt` 取节点的 `seen`（最近一次被抽取或退役的时间）。

---

## 快速开始

```bash
# 1. 克隆到本地
git clone https://github.com/china-cdw/dsh-x-memory
cd dsh-x-memory

# 2. 装进 DSH 的 profile
dsh plugin --profile desktop add "$PWD"
```

装完后重启 DSH（或把 bundle 关掉再打开，会热重载），系统提示里应出现：

```
# 跨会话记忆（dsh-x-memory）
# 编码规范（dsh-x-memory）
# 踩过的坑（dsh-x-memory 自动记录）   ← 有记录时才出现
```

验证：在会话里调用 `memory_brief`，应看到核心记忆大小、归档条数、风格、快照、图谱规模、billion-context 状态。想立刻写第一条记忆，用 `memory_core` 的 `append`。

> 只改插件源码、不重装时：`plugin_manager set_bundle enabled=false` → `enabled=true` 会重新加载磁盘模块，不必重启整个 App。

---

## 工具

下表是默认注册的 12 个工具；开启演化（`config.enabled: true` 并配置 provider/model）后还会注册 `evolve_status`、`evolve_diagnose`、`evolve_request`、`evolve_tree` 等 `evolve_*` 工具，总数最多 19 个。

| 工具 | 用途 | 主要参数 |
| --- | --- | --- |
| `memory_write` | 写一条归档笔记 | `title`、`content`、`tags?`、`force?`、`supersedes?` |
| `memory_read` | 按 id 读全文 | `id`（支持唯一前缀） |
| `memory_list` | 列归档（可按标签过滤） | `limit?`、`tag?` |
| `memory_search` | 三路检索：归档 + 图谱 + billion-context | `query` |
| `memory_delete` | 删除（写墓碑，不复活） | `id` |
| `memory_core` | 改核心记忆分节 | `action`（append/replace/remove）、`section`、`text?` |
| `memory_brief` | 记忆库体检 | — |
| `memory_dreaming` | 闲时整理开关、手动执行与误删恢复（含 AI 垃圾清理） | `action`（status/on/off/run/retired/restore）、`apply?`、`force?`、`ids?` |
| `persona` | 回复风格 | `action`（get/set/custom/disable）、`preset?`、`text?` |
| `coding_rules` | 编码规范 | `action`（show/list/add/forget）、`text?` |
| `lessons` | 踩坑记录 | `action`（list/forget/clear）、`text?`、`limit?`（默认 50，上限 200） |
| `soul_recall` | 从会话图谱/历史原文回捞 | `query`、`k?` |
| `soul_expand` | 按 seq 区间展开原文（默认 2000 字节 / 200 条，上限 20000 / 1000）；首条事件被裁剪时用 `from=resume.seq` + `offset=resume.offset` 续读，其他截断用 `from=to+1`；零预算返回的 `next` 即续读起点 | `from`、`to`（必填，0–1000000）；`limit?`、`maxEvents?`、`offset?`（默认 2000 / 200 / 0） |

写入规则：`memory_write` 会做近重复检查（相似度 ≥0.55 拒写，加 `force: true` 可强写）。

踩坑是自动记录的：同一会话里某工具报错、之后同工具成功，就记一条「错误 + 生效做法」；同类错误合并计数。判定优先看结构化信号：`isError`、退出码（正则取值，退出码 0 视为成功，`grep` 这类 1 也放过）；只有拿不到结构化信号时，才用正文里的失败字样兜底。读文件类工具和记忆/编码工具自身不记。

### 设置页接口

风格设置页通过同源 `fetch` 调用本机路由 `/dsh-x-memory/persona`（只在宿主提供 `webServer` 时注册）：

- `GET` 返回 `{ persona, presets, maxCustom }`；
- 所有请求（含 GET）必须带自定义请求头 `X-DSH-X-Memory: 1`：跨站表单/链接伪造不了这个头，浏览器还会先发 CORS 预检，挡住了未经允许的跨源读取；
- `POST` 要求 `Content-Type: application/json`、请求体 ≤16KB；方法只接受 `GET`/`POST`，其他方法返回 405 且带 `Allow: GET, POST`；空的 `{}` 返回 204 且不写盘；其余返回 200，参数/方法/权限错误返回 400/403/405/413/415，写盘或内部故障返回 500；
- 只接受本机回环 Host（`localhost` / `127.0.0.1` / `[::1]`），且带 Origin 时必须与 Host 一致——防止 DNS rebinding 与跨站提示注入；未携带 Host 头（HTTP/1.0）时跳过 Host 白名单；
- 响应带 `Cache-Control: no-store`，风格属于个人数据，不缓存。

工具失败时，返回文本末尾带机器可读后缀 `[err:CODE]`（例如 `[err:E_NOT_FOUND]`、`[err:E_GUARD]`）；注意宿主层仍把这类结果当作成功（`isError` 为 false），调用方需要识别后缀来完成分支。

---

## 配置

`cordis.patch.yml` 默认值：

```yaml
config:
  enabled: false            # 上游的「演化」功能，默认关
  # profile 默认按安装路径推断；也可设环境变量 DSH_PROFILE 或显式 database
  memory:
    enabled: true           # 核心记忆 + 归档 + 图谱
    projectionBytes: 600    # 图谱每轮投影字节数
    maintenance: true       # 每 20 轮去重与边衰减
  coding:
    enabled: true
    budget: 2000            # 编码规范注入预算（400–8000）
  lessons:
    enabled: true
    budget: 600             # 踩坑注入预算（200–4000）
  bridge:
    enabled: true
    sessionsDir: ''         # 留空 = 自动找 billion-context 默认目录
    maxSessions: 4
    maxChars: 1200          # 桥接段输出上限（200–4000）
  dreaming:
    enabled: false          # 闲时整理：默认关；开启后只新增 digest 笔记
    autoApply: false        # 空闲到期是否自动改库；默认 false，只能手动 run
    idleDelaySeconds: 120   # turn 结束后等多少秒再跑（10–3600）
    minIntervalMinutes: 180 # 两次自动整理的最小间隔（0–10080）
    maxNotes: 3             # 单次最多写几条（1–10）
    ai: true                # 让模型判垃圾（noise/duplicate → retire，可逆）
    provider: ''            # 留空用全局默认模型
    model: ''
    maxScanNodes: 60        # 单次送模型判定的节点上限（10–300）
    maxRetirePerRun: 20     # 单次最多 retire 多少节点（1–100）
```

`bridge.sessionsDir` 留空时依次找：环境变量 `BILI_SESSIONS_DIR` → `%USERPROFILE%\.local\share\billion-context\sessions`（Linux/macOS 为 `~/.local/share/billion-context/sessions`）。

---

## 数据目录

```
$DSH_HOME/memory/
├── MEMORY.md            # 核心记忆（每轮注入，3000 字内）
├── PERSONA.md           # 回复风格
├── DREAMING.json        # 闲时整理运行态（开关、上次执行时间与结果）
├── CODING.md            # 全局编码规范
├── GUARD.json           # 可选，自定义守卫规则
├── LESSONS.jsonl        # 踩坑记录（最多 400 条）
├── index.json           # 归档索引（原子写 + 文件锁）；坏了会从 notes/ 重建，启动时按 id 对账（缺的补录、文件丢的标 missing）
├── notes/               # 归档笔记，一条一个 .md
└── .snapshots/          # 每日快照，保留 7 份
```

图谱库在 `$DSH_HOME/dsh-soul/<profile>/evolve.sqlite`（沿用 dsh-soul 的位置，装过 soul 的话旧数据直接可用）。

---

## 安全

- 私钥块、常见 token 形状：写入即拒收；
- 凭据赋值形状：可保存但标记敏感，不进系统提示、检索时隐藏正文；
- 踩坑记录写入前过一遍脱敏，含 `password` / `token` / `secret` / `bearer` 等字样的行直接丢弃；
- 发布前自检：

```bash
npm run preflight
```

扫描私钥块、凭据形状、绝对家目录路径、高熵串；命中就失败退出，只打印 `相对路径:行号  类别`，不回显命中内容。读不了的文件（`.env*`、超大文件、二进制、未识别扩展名）不会被静默跳过：输出 `SKIPPED` 行并同样计为失败，确认无害后加进忽略清单。

确认是误报时，在仓库根目录建 `.preflight-ignore.json`：

```json
["docs/example.md:12", "README.md:96 ABS_WIN"]
```

支持「相对路径」「相对路径:行号」「相对路径:行号 类别」三种粒度。

---

## 与 billion-context 的关系

两者不是同类，也不抢活：

- **billion-context** 管「一次会话装不下」——压缩已消耗的对话，模型需要时可解压；
- **dsh-x-memory** 管「跨会话记不住」——把该长期保留的东西放在系统提示和本地库里。

桥接只做一件事：把它的会话压缩摘要**只读**并入 `memory_search`。它继续管它的压缩，记忆层不介入、不改写、不依赖它的内部格式（格式不认识就跳过）。

两者同时开着时前缀缓存不受影响：记忆走系统提示，压缩只动消息历史。

---

## 升级

1. 在插件目录更新源码（`git pull` 或安装新版本）；
2. 改完源码后同步安装副本：先 `plugin_manager set_bundle dsh-x-memory=false`，再跑 `node <workspace>/sync-install.mjs`，最后 `set_bundle ... =true` 热重载；
3. 数据不会动：`$DSH_HOME/memory` 与图谱库保持原样，升级前一天的快照在 `.snapshots/` 里可回退。

## 上游与同步

本插件是 dsh-soul 2.0.1 的 fork，`src/` 下大部分文件是上游逐字节镜像；我们自己写的文件、`index.js` 需要重放的接线点、同步步骤都写在 [UPSTREAM.md](./UPSTREAM.md)。

```bash
node scripts/sync-upstream.mjs --check                 # 检查镜像是否被本地改过
node scripts/sync-upstream.mjs --from <dsh-soul 目录>  # 同步上游新版本
```

`package.json` 的 `dshMemory` 字段记录了上游版本与移植来源；`upstream-manifest.json` 存每个镜像文件的 sha256。

---

## 限制

- 检索是关键词 + 中文二元组匹配，不是语义检索；跨会话语义回忆目前靠图谱和 billion-context 摘要；
- billion-context 桥只覆盖已被压缩的会话块（默认最近 4 个会话、每个 5 块），且摘要是二次转写；
- 编码规范按当前会话工作目录找项目文件，子目录里的 `AGENTS.md` 不会逐层向上合并；
- 上游「演化」（自改 harness）默认关闭，本插件也不建议开启。

---

## 开发与自检

```bash
node --check index.js
node scripts/sync-upstream.mjs --check
npm run preflight
```

```bash
npm test          # 全部自检脚本；任何一项失败即非零退出
```

自检脚本随包发布在 `scripts/` 下：核心层 85 项、编码层 10 项、踩坑层 15 项、事件重放 11 项、billion-context 桥接 14 项、修复项回归 26 项，共 161 项断言，覆盖写入/检索/取代/守卫/快照/索引锁/并发/缓存失效/桥接的边界情况。单跑某一个：`node scripts/dsh-memory-audit.mjs`。

---

## 致谢与许可

MIT License。

- 底座来自 [icyaaaww/dsh-soul](https://github.com/icyaaaww/dsh-soul) 2.0.1（MIT）：会话图谱、投影、压缩后端；
- 核心记忆层移植自 dsh-core-memory 1.0.1（MIT）：`MEMORY.md`、归档笔记、persona；
- 设计上借鉴了两个开源项目（未复制代码）：
  - [NattoCB/dsh-plugin-memory](https://github.com/NattoCB/dsh-plugin-memory)：分层、索引与详情分离、截断预算；
  - [dearbld/dsh-living-memory](https://github.com/dearbld/dsh-living-memory)：冲突取代标记、守卫规则数据化、发布前扫描、快照轮转；
- billion-context 是独立插件（MIT），本插件只读取它的会话存档，不包含它的代码。
