# dsh-soul-memory

简体中文 | [English](README.en.md)

[![release](https://img.shields.io/github/v/release/china-cdw/dsh-soul-memory?style=flat-square&color=EFB23A)](https://github.com/china-cdw/dsh-soul-memory/releases) [![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-C0392B?style=flat-square)](LICENSE) [![node](https://img.shields.io/badge/node-%E2%89%A5%2024-33271D?style=flat-square)](package.json)

> **给 DeepSeek Harness 装一套会分层、会遗忘、会回捞的长期记忆。**
> 新会话不再从零开始；上下文被压缩之后，还知道该回哪儿找原文。
> 想先看它长什么样、解决什么问题：[ambervouch.com/soul-memory](https://ambervouch.com/soul-memory)（介绍页，不装也能读）。

只装这一个插件，就能同时得到：常驻核心记忆、可检索的归档笔记、会话过程图谱、自动踩坑记录、项目编码规范，以及从 billion-context 会话摘要里找回旧过程的能力。几层各有自己的预算和开关，互不挤占（归档笔记只注入标题，不占字数预算）。

**它盯的是三件最容易悄悄坏掉的事**：

- 换个会话就忘了你定过的规矩 —— 核心记忆每轮注入；
- 上下文压缩后只剩「摘要的摘要」 —— 检索结果带原文指针和证据等级；
- 记忆越存越多，没人知道哪份才是真的 —— 同一件事只在一个地方算数（见 [AUTHORITY.md](AUTHORITY.md)）。

### 30 秒装上

```bash
git clone https://github.com/china-cdw/dsh-soul-memory
dsh plugin --profile desktop add "$PWD"
```

然后**完全退出 DSH 再重新打开**（装在宿主进程里的那部分只在启动时加载，刷新页面不算重启）。会话里能调用 `memory_brief`、`memory_doctor` 就是装好了。没有数据库要装、没有 API Key、不联网。

更细的步骤和验证方式见 [快速开始](#快速开始)；它是怎么设计的、为什么这么分，见 [五层记忆](#五层记忆) 与 [每个位置谁是权威](#每个位置谁是权威)。

- 运行要求：Node.js ≥ 24，DSH ≥ 0.2.1-rc.2
- 许可证：AGPL-3.0-or-later（闭源商用需商业授权，见文末「致谢与许可」）
- 来源：以 [dsh-soul](https://github.com/icyaaaww/dsh-soul) 2.0.1 为底座，移植 dsh-core-memory 1.0.1 的核心记忆层（上游均为 MIT，声明保留在 [NOTICE](NOTICE)）

---

## 它解决什么

| 问题 | 这一层怎么解决 |
| --- | --- |
| 新会话从零开始，之前说过的偏好全忘了 | 核心记忆 `MEMORY.md` 每个会话自动注入 |
| 只记得结论，找不到当时的约束和决策 | 会话图谱记录约束/决策/产物，`soul_recall` 按需回捞 |
| 同一个错反复犯 | 工具报错后自动记一条「错 + 当时怎么改对的」，下个会话提醒 |
| 每次都要重新交代代码规范 | 自动读全局 `CODING.md` 和项目里的 `AGENTS.md` 等规则文件 |
| 长会话被压缩后，旧过程细节消失 | 桥接 billion-context 的会话压缩摘要，只读检索 |
| 不知道前几天到底在做什么 | 回合日志按天记一行「要了什么、写了什么、产物在哪」，`memory_journal` 直接读 |
| 想换电脑或怕误删 | `memory_backup` 一键导出 JSON，导入默认只预演、写前自动快照 |
| 在别的 AI 工具里干过的活找不回来 | `soul_recall source=external` 读 QClaw/OpenClaw 与 Claude Code 的对话转录，和本插件原文一起检索 |

## 0.4.0 的记忆行为

- **「衰减」默认开启**（`memory.dynamics`）：检索排序会算一个 ACT-R 激活值——越久没被命中的旧节点分数越低、自然排到后面，但不会被删除；关掉就按固定权重排序。
- **每条命中带两个标签**（`soul_recall`）：`match` 说明来源（quote 原话 / literal 字面命中 / spread 关键词散落命中 / graph 从图谱找到），`share` 说明命中了多少；每条另带 `evidence`（原文 / 图谱摘要 / 关联推断），引用原话只认「原文」。
- **只翻原文**（`soul_recall source=quote`）：跳过知识图谱，直接跨会话搜原始对话。
- **回合日志**（`memory.turnLog`）：每轮只要有记忆写入，就在 `$DSH_HOME/memory/turns/YYYYMMDD.md` 记一行；闲聊不记。
- **个人信息默认只标记**：身份证号、手机号、带标签的病历号/患者姓名在归档与图谱里标为敏感，正文照常保存，注入与检索只露标题；确需查看用 `memory_read`。不做全量打码，避免毁掉医疗材料。
- **过期约束会提醒**：超过 `memory.staleConstraintDays`（默认 90 天）的约束，注入时多一句「记录于 YYYY-MM-DD，可能已过期」；设 0 关闭。
- **项目名看得见**：`memory_brief` 会显示当前项目的目录名和内部哈希，换目录后能一眼看出自己在哪里。

## 为什么合成一个插件

三个记忆插件各管一摊时，模型要同时判断「这条该写哪」；拆开装还会重复注入、预算互相挤占。合成一个之后：

- **一次写入按内容分流**：长期事实进核心记忆，经历进归档笔记，过程进图谱，错误进踩坑记录，规矩进编码规范；
- **一次检索查三处**：`memory_search` 同时查归档、图谱和 billion-context 摘要，结果带来源和 id，需要时再下钻；
- **一套开关和一套注入规则**：五层共用同一份数据目录、同一套脱敏与守卫规则。

## 五层记忆

| 层 | 存什么 | 位置 | 注入 | 预算 | 工具 |
| --- | --- | --- | --- | --- | --- |
| 核心记忆 | 长期稳定的事实、偏好、环境 | `$DSH_HOME/memory/MEMORY.md` | 每轮，`order 60` | 3000 字 | `memory_core` |
| 归档笔记 | 需要时才查的经历、结论 | `$DSH_HOME/memory/notes/*.md` | 只注入最近 12 条标题 | — | `memory_write` / `memory_read` / `memory_list` / `memory_search` / `memory_delete` |
| 会话图谱 | 约束、决策、产物、历史原文 | `$DSH_HOME/dsh-soul/<profile>/evolve.sqlite` | 每轮注入一段图谱摘要（600 字节）。`order` 是排序权重键：图谱用上游的 `systemPrompt.context`（900–960 权重段），其余三层用 `systemPrompt.section`，两套 API 的权重互不相干 | 600 字节 | `soul_recall` / `soul_expand` |
| 踩坑记录 | 工具报错 → 后来怎么改对 | `$DSH_HOME/memory/LESSONS.jsonl` | 每轮，`order 62` | 600 字 | `lessons` |
| 编码规范 | 全局规矩 + 项目规则文件 | `$DSH_HOME/memory/CODING.md` + 项目目录 | 每轮，`order 61` | 3500 字（设置页可调） | `coding_rules` |

> 不想被记住的内容包在 `<private>…</private>` 里：所有写入、会话缓冲、被动抽取、原文索引与回合日志都会在落盘前整段摘掉；整条都是私密段时直接拒写。
>
> 一处代价要知道：孤立的 `</private>`（没有对应的开标签）按「上一个分片开了口」处理，从该处一直摘到本条消息末尾——**它后面的公开内容也一起丢**。同一条消息里请成对写；未闭合状态只在同一回合内延续；回合结束时无论当时是正常读写、只读还是关闭，都会复位，不会让你下一句也消失。

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

全局 `CODING.md` 优先，项目文件按上面的顺序追加在后面。内容超出预算时会截断并注明；预算默认 3500 字，可在「灵魂记忆 → 规则」里改成 400–8000。

---

## 四个关键机制

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

如果装了 [billion-context](https://github.com/ranxianglei/billion-context)，`memory_search` 会先查归档笔记和会话图谱，再追加一段【历史会话摘要】——在它写到本地的会话压缩块里做关键词检索。

- 只读它写好的 `sessions/*.json`，不改、不压缩它；
- 坏文件、超过 32MB、目录不存在都静默跳过，不影响主检索；
- 默认最多读最近 4 个会话、每个 5 块，`maxChars` 控制输出长度；
- 不想要就把 `bridge.enabled` 设为 `false`。

---

## 闲时整理（dreaming，可选）

默认关闭。开启后，插件会把最近会话图谱里的决策、约束和重复进度，聚成一份 digest 笔记写进 `notes/`：只新增，不改也不删已有记忆。

开了 `dreaming.ai` 时，模型还会先判一遍垃圾（寒暄、断网重发的重复对话、明显错乱的内容）。判为 noise 或 duplicate 的节点只会「退休」（retire）：不再出现在每轮注入的图谱摘要和关联检索里，原始会话日志不删。默认只动 `pin=0`、`hits=0`（没被钉住、也从没被命中过）、没被取代、创建满 7 天的节点；`action=retired` 能看，`action=restore` 能恢复；retired 满 30 天后才可能被清理。

`dreaming.autoApply` 默认 false：空闲时不会自己整理，必须手动 `run`；设成 true 才会在空闲时自动跑。

- 开关：`memory_dreaming` 的 `action=status/on/off`（运行态写入 `$DSH_HOME/memory/DREAMING.json`，立即生效），或在设置里给 `dreaming.enabled: true`；开启后是否允许空闲自动改库由 `dreaming.autoApply`（默认 false）决定；
- 手动跑：`action=run` 默认 dry-run 只列候选，`apply: true` 才写盘，`force: true` 忽略冷却；
- 边界：每次最多 `dreaming.maxNotes` 条（默认 3）；两次自动整理至少间隔 `dreaming.minIntervalMinutes`（默认 180 分钟）；digest 带 `dream` 标签和来源 seq，走与 `memory_write` 相同的查重；
- 空闲触发延迟由 `dreaming.idleDelaySeconds` 控制（默认 120 秒，最小 10）；
- AI 清理（默认开）：模型只做裁决，必须返回严格 JSON；判 `noise`/`duplicate` 的节点 retire，`keep` 与编造 id 一律不动；某一批失败不影响其他批；全部失败或无 llm 时降级为「不清理」，digest 照写、冷却照常推进（`cleanup.available=false` 并在 `reason` 里说明 `llm_failed`/`no_llm`）；
- 分批与容错：候选每 12 条一批调用；输出被 token 上限截断时，从残缺 JSON 里捞出完整裁决（含末尾被截断的未闭合对象）；某批失败不影响其他批的结果；
- 损坏保护：`DREAMING.json` 读不出或损坏时 `run` 返回 `skipped:"corrupt"`、`status` 顶部会提示，且不会用默认值覆盖原文件（损坏副本留在 `DREAMING.json.bad-<时间戳>`，只保留最近 3 份）；修复或重建用 `action=on`；
- 路由兜底：`dreaming.provider/model` → 插件顶层 provider/model → 当前 agent → 宿主 `cordis.patch.yml` 的 `agent-default-model`，都没有才报错并给出配置指引；
- AI 路由：`dreaming.provider` / `dreaming.model`，留空用全局默认模型；扫描上限 `dreaming.maxScanNodes`（默认 60，范围 10–300），单次最多 retire `dreaming.maxRetirePerRun`（默认 20，范围 1–100）；`action=retired` 列出库里当前仍为 retired 的节点（restore 后即消失），`action=restore` 配 `ids` 恢复；整理正在运行时 restore 返回 `[err:E_BUSY]`。

`action=run` 的返回里有 `cleanup` 一节，字段含义：

- `available`：模型能不能用；
- `reason`：为什么没清理，取值 `disabled` / `no_candidates` / `no_generator` / `no_llm` / `llm_failed`，正常时为 null；
- `scanned`：这一轮扫了多少节点；
- `planned`：模型判为 noise/duplicate、去重并按单次上限截断后的条数；真正退役多少还受护栏影响，看 `retired` 与 `rejected`；
- `retired`：真正退役的条数（受护栏和单次上限限制；dry-run 恒为 0）；
- `keep` / `invalid`：判为保留的条数、以及模型返回了不存在 id 的条数；
- `rejected`：apply 时 `planned` 与 `retired` 的差额，即被护栏挡下的条数（dry-run 恒为 0）；
- `details`：每条裁决的 id / verdict / reason；
- `error`：某几批失败时的首个错误。

`action=retired` 里的 `retiredAt` 取节点的 `seen`，也就是最近一次被抽取或退役的时间。

---

## 快速开始

```bash
# 1. 克隆到本地
git clone https://github.com/china-cdw/dsh-soul-memory
cd dsh-soul-memory

# 2. 装进 DSH 的 profile
dsh plugin --profile desktop add "$PWD"
```

装完后重启 DSH（或把 bundle 关掉再打开，会热重载），系统提示里应出现：

```
# 跨会话记忆（dsh-soul-memory）
# 编码规范（dsh-soul-memory）
# 踩过的坑（dsh-soul-memory 自动记录）   ← 有记录时才出现
```

验证：在会话里调用 `memory_brief`，应看到记忆索引（核心大小、最近 8 条目录、风格、快照、图谱规模、billion-context 状态）；目录里只有标题，正文用 `memory_read` 取。想立刻写第一条记忆，用 `memory_core` 的 `append`。

> 只改插件源码、不重装时：`plugin_manager set_bundle enabled=false` → `enabled=true` 会重新加载磁盘模块，不必重启整个 App。

---

## 工具

下表是默认注册的 21 个工具，总开关是 `config.memory.enabled`（设成 false，`memory_*` 与 `soul_*` 一起不注册）。`evolve_status`、`evolve_diagnose`、`evolve_request`、`evolve_tree` 等 `evolve_*` 是另一组，由顶层 `config.enabled` 控制；打开它会同时要求配好 provider/model，否则加载时报错。两组都开时最多 25 个。

代码图谱两个工具（`code_explore` / `code_impact`）是可选的：需要额外装一次 [CodeGraph](https://github.com/colbymchenry/codegraph)（`npm i -g @colbymchenry/codegraph`），并在目标仓库跑一次 `codegraph init`。没装或没建索引时它们只回复「怎么装 / 怎么建」，不影响其余记忆功能；`config.codegraph.enabled: false` 可以整个关掉。

| 工具 | 用途 | 主要参数 |
| --- | --- | --- |
| `memory_write` | 写一条归档笔记 | `title`、`content`、`tags?`、`force?`、`supersedes?` |
| `memory_read` | 按 id 读全文 | `id`（支持唯一前缀） |
| `memory_list` | 列归档（可按标签过滤） | `limit?`、`tag?` |
| `memory_search` | 三路检索：归档 + 图谱 + billion-context | `query` |
| `memory_delete` | 删除（写墓碑，不复活） | `id` |
| `memory_core` | 改核心记忆分节 | `action`（append/replace/remove）、`section`、`text?` |
| `memory_brief` | 记忆索引与体检（列目录，不返回正文） | — |
| `memory_doctor` | 记忆体检：预算、索引对账、日志可解析、备份可打开、图谱与回收、桥接、三种私钥头的打码自检；并列出「这台机器测不到什么」 | — |
| `memory_mode` | 本会话的记忆开关（正常读写 / 只读 / 关闭），换会话自动恢复 | `action`（get/set）、`mode?`（normal/readonly/off）、`session?` |
| `memory_dreaming` | 闲时整理开关、手动执行与误删恢复（含 AI 垃圾清理） | `action`（status/on/off/run/retired/restore）、`apply?`、`force?`、`ids?` |
| `persona` | 回复风格 | `action`（get/set/custom/disable）、`preset?`、`text?` |
| `coding_rules` | 编码规范（可弹窗编辑、新增时自动查重） | `action`（show/list/add/propose/pending/approve/reject/forget/dupes）、`text?`、`ids?` |
| `memory_tier` | 记忆分级与回收（🔴🟡🟢，30 天内可恢复） | `action`（status/collect/restore）、`apply?`、`minAgeDays?`、`ids?` |
| `memory_backup` | 备份/搬家：导出 JSON、列备份、从备份恢复 | `action`（export/list/import）、`file?`、`apply?` |
| `memory_journal` | 回合日志：按天看「这一轮做了什么」 | `action`（read/list）、`days?` |
| `lessons` | 踩坑记录（可给每条标「靠什么强制」，并区分已强制/还只是线索） | `action`（list/route/forget/clear）、`text?`、`limit?`（默认 50，上限 200）、`fp?`、`level?`（structure/type/check/test/rule）、`enforce?`、`prove?` |
| `review_brief` | 生成只读评审的 brief：写死只读边界、`文件:行号 + 严重度 + 改法` 格式、超时不算通过、最多 4 轮 | `goal?`、`repo?`、`base?`、`diff?`、`outOfScope?`、`checks?`、`focus?`、`round?` |
| `soul_recall` | 从会话图谱/历史原文/其他 AI 工具的转录里回捞（每条带 `evidence`：原文副本 / 图谱摘要 / 关联推断） | `query`、`k?`、`source?`（auto/quote/graph/external） |
| `soul_expand` | 按 seq 区间展开原文（默认 2000 字节 / 200 条，上限 20000 / 1000）；首条事件被裁剪时用 `from=resume.seq` + `offset=resume.offset` 续读，其他截断用 `from=to+1`；零预算返回的 `next` 即续读起点 | `from`、`to`（必填，0–1000000）；`limit?`、`maxEvents?`、`offset?`（默认 2000 / 200 / 0） |
| `code_explore` | 在仓库的代码索引里查符号/文件/功能：返回源码片段、入口与调用关系，替代「先 grep 再逐个翻文件」 | `query`、`repo?`、`maxBlocks?`（默认 3、上限 6）、`maxChars?` |
| `code_impact` | 查符号或文件的影响半径：谁依赖它、调用关系，改动前判断波及面 | `symbol?`、`file?`（二选一）、`repo?`、`depth?`（默认 3）、`maxChars?` |

写入规则：`memory_write` 会做近重复检查（相似度 ≥0.55 拒写，加 `force: true` 可强写）。

踩坑是自动记录的：同一会话里某工具报错、之后同工具成功，就记一条「错误 + 生效做法」；同类错误合并计数。

判定时先看机器能读的信号：`isError` 字段、退出码（从结果里取出数字，0 算成功，`grep` 这类返回 1 也算放过）。只有拿不到这类信号时，才退一步看正文里有没有失败字样。读文件类工具、记忆与编码工具自身不记。

### 设置页接口

风格设置页通过同源 `fetch` 调用本机路由 `/dsh-soul-memory/persona`（只在宿主提供 `webServer` 时注册）：

- `GET` 返回 `{ persona, presets, maxCustom }`；
- 所有请求（含 GET）必须带自定义请求头 `x-dsh-soul-memory: 1`：跨站表单/链接伪造不了这个头，浏览器还会先发 CORS 预检，挡住了未经允许的跨源读取；
- `POST` 要求 `Content-Type: application/json`、请求体 ≤16KB；方法只接受 `GET`/`POST`，其他方法返回 405 且带 `Allow: GET, POST`；空的 `{}` 返回 204 且不写盘；其余返回 200，参数/方法/权限错误返回 400/403/405/413/415，写盘或内部故障返回 500；
- 只接受本机回环 Host（`localhost` / `127.0.0.1` / `[::1]`），且带 Origin 时必须与 Host 一致——防止 DNS rebinding 与跨站提示注入；未携带 Host 头（HTTP/1.0）时跳过 Host 白名单；
- 响应带 `Cache-Control: no-store`，风格属于个人数据，不缓存。
### 灵魂记忆设置页

设置页里的「灵魂记忆」由 `client.js` 注册到宿主设置页的插槽（slot），一共六个页签：待批区、记忆内容、记忆流、规则、称呼与风格、记忆分级（「记忆内容」和「记忆流」共用 `/memories` 与 `/notes` 两条路由：一个按主题筛，一个按天倒序看）。数据来自同源 `fetch` 的六条路由（同样只在宿主提供 `webServer` 时注册，基础安全模型与 `/persona` 一致：回环 Host、Origin 同源、`x-dsh-soul-memory: 1` 头）：

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/dsh-soul-memory/state` | GET | 一次取全：UI 设置、待批、规则列表、分级、体检、闲时整理状态，并下发写令牌 |
| `/dsh-soul-memory/ui` | POST | 改形态（输入框下方 / 右侧面板 / 居中浮层 / 不提醒）、称呼、临时静默、暂停写记忆、规则注入上限 |
| `/dsh-soul-memory/pending` | POST | `approve` / `reject` / `edit` 待批规则 |
| `/dsh-soul-memory/rules` | POST | `forget` 删规则、`edit` 改规则（正文 / 为什么 / 陷阱） |
| `/dsh-soul-memory/tier` | POST | `preview` / `collect` / `restore` 分级回收 |
| `/dsh-soul-memory/dreaming` | POST | 开 / 关闲时整理 |

写操作额外要求 `x-dsh-soul-memory-token` 请求头：令牌由 `/state` 随机生成下发、只存在进程内存里（重启即换），缺失或错误返回 403。

工具失败时，返回文本末尾带机器可读后缀 `[err:CODE]`（例如 `[err:E_NOT_FOUND]`、`[err:E_GUARD]`）；注意宿主层仍把这类结果当作成功（`isError` 为 false），调用方要自己认出这个后缀，才能走失败分支。

有两处例外：`evolve_*` 出错时返回 JSON 形式的 error 对象，不走文本后缀；`code_explore` / `code_impact` 在「没装 CodeGraph」或「还没建索引」时有意返回普通说明文字——那是使用指引，不是失败。

---

## 配置

仓库里的 `cordis.patch.yml` 是随插件分发的示例，**里面只写了下面这些键**（没写的走代码默认值）：

```yaml
config:
  enabled: false            # 上游的「演化」功能，默认关
  # profile 默认按安装路径推断；也可设环境变量 DSH_PROFILE 或显式 database
  memory:
    enabled: true           # 核心记忆 + 归档 + 图谱
    projectionBytes: 600    # 图谱每轮投影字节数
    staleConstraintDays: 90 # 约束超过多少天在注入时提醒可能过期；0 关闭
    maintenance: true       # 每 20 轮去重与边衰减
  coding:
    enabled: true
    budget: 3500            # 编码规范注入预算（400–8000；设置页可覆盖）
  lessons:
    enabled: true
    budget: 600             # 踩坑注入预算（200–4000）
  codegraph:
    enabled: true           # CodeGraph 两个工具；没装包时只回复怎么装
    maxChars: 8000          # 单个结果最多返回多少字符（1000–40000）
  bridge:
    enabled: true
    sessionsDir: ''         # 留空 = 自动找 billion-context 默认目录
    maxSessions: 4
    maxChars: 1200          # 桥接段输出上限（200–4000）
```

示例里**没写**的键用代码默认值（`index.js` 的 `readConfig`），这也给出各自的可调范围：

- `dreaming.*`：`enabled: false`、`autoApply: false`、`idleDelaySeconds: 120`、`minIntervalMinutes: 180`、`maxNotes: 3`、`ai: true`、`provider: ''`、`model: ''`、`maxScanNodes: 60`、`maxRetirePerRun: 20`；
- `memory.maxNodes: 500`（50–5000）、`verifyArtifacts: true`、`dynamics: true`、`turnLog: true`、`promote: false`、`staleConstraintDays: 90`（0–3650）、`maintenanceTurns: 20`（5–500）；
- `codegraph.maxChars: 8000`（1000–40000）、`coding.budget: 3500`（400–8000）、`lessons.budget: 600`（200–4000）。

所以想开 dreaming、改 `maxNodes` 或调预算，直接写进自己的 `cordis.patch.yml` 即可——它们本来就不在示例里，不是不能配。

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
- 个人信息（身份证号、手机号、带标签的病历号/患者姓名）：只标记、不删正文；不进系统提示、检索只露标题，显式 `memory_read` 才看正文；图谱节点同样按敏感过滤；
- 私钥整块打码：`redact` 把整块替换成 `[REDACTED KEY]`，发布闸门与 `memory_doctor` 都用合成样例验一遍（这一层 0.4.17 曾因正则少一个反斜杠静默失效）；
- 踩坑记录写入前过一遍脱敏，含 `password` / `token` / `secret` / `bearer` 等字样的行直接丢弃；
- 发布前自检：

```bash
npm run preflight
```

扫描私钥块、凭据特征、绝对家目录路径、明显随机的长字符串；命中就失败退出，只打印 `相对路径:行号  类别`，不回显命中内容。读不了的文件（`.env*`、超大文件、二进制、未识别扩展名）也不会被悄悄放过：会打印一行 `SKIPPED`，并同样算作失败；确认无害后加进忽略清单。

确认是误报时，在仓库根目录建 `.preflight-ignore.json`：

```json
["docs/example.md:12", "README.md:96 ABS_WIN"]
```

支持「相对路径」「相对路径:行号」「相对路径:行号 类别」三种粒度。

---

## 与 billion-context 的关系

两者不是同类，也不抢活：

- **billion-context** 管「一次会话装不下」——压缩已消耗的对话，模型需要时可解压；
- **dsh-soul-memory** 管「跨会话记不住」——把该长期保留的东西放在系统提示和本地库里。

桥接只做一件事：把它的会话压缩摘要**只读**并入 `memory_search`。它继续管它的压缩，记忆层不介入、不改写、不依赖它的内部格式（格式不认识就跳过）。

两者同时开着时前缀缓存不受影响：记忆走系统提示，压缩只动消息历史。

---

## 升级

1. 在插件目录更新源码（`git pull` 或安装新版本）；
2. 改完源码后同步安装副本：先把 `dsh-soul-memory` 这个 bundle 关掉（`plugin_manager set_bundle`，`enabled=false`），再跑 `node <workspace>/sync-install.mjs`，最后重新打开（`enabled=true`）完成热重载；
3. 数据不会动：`$DSH_HOME/memory` 与图谱库保持原样，升级前一天的快照在 `.snapshots/` 里可回退。

## 上游与同步

本插件是 dsh-soul 2.0.1 的 fork，`src/` 下大部分文件是上游逐字节镜像；我们自己写的文件、`index.js` 需要重放的接线点、同步步骤都写在 [UPSTREAM.md](./UPSTREAM.md)。

```bash
node scripts/sync-upstream.mjs --check                 # 检查镜像是否被本地改过
node scripts/sync-upstream.mjs --from <dsh-soul 目录>  # 同步上游新版本
```

`package.json` 的 `dshMemory` 字段记录了上游版本与移植来源；`upstream-manifest.json` 存每个镜像文件的 sha256。

`src/core-memory.js` 与 persona 相关实现是按 dsh-core-memory 1.0.1 的行为重写的，不是逐字节镜像（上游改动要人工判断怎么合），所以**不在 sha256 可核验范围内**——`sync-upstream.mjs --check` 不拿它们做对比，改过也不会报漂移。

---

## 每个位置谁是权威

记忆散在十几个地方：核心记忆、归档笔记、索引、会话图谱、踩坑日志、编码规范、风格、设置、快照、备份。

**同一件事只在一个地方算数**。其余两种：能重建的（丢了可以从原文再算一遍）和只追加的（历史记录，只往后写、不覆盖）。

完整对照表在 [AUTHORITY.md](./AUTHORITY.md)，几条最容易踩的：

- 系统提示里的核心记忆是衍生视图：超 3000 字会被截断，**文件才是权威**；截断说明里会写「尾部多少字没注入、全文在哪」。
- `index.json` 只是目录缓存：唯一认的是 `notes/*.md`；只改索引，下次自动核对时会被改回去。
- 图谱节点是摘要，不是原话：`soul_recall` 的每条结果都标 `evidence`（原文副本 / 图谱摘要 / 关联推断）。原文副本是会话日志的脱敏索引，用来定位，不保证逐字；要逐字原话用 `soul_expand` 展开。
- 备份只是历史存档，不参与读取；`memory_backup import` 默认只预演（dry-run），写之前自动快照。

还有一条分界：**身份半**（记忆、规则、风格、设置）只属于这台机器和这个人，可以带走但不可移植；**能力半**（代码、工具、判据）可复制。升级插件只动能力半，永远不用新代码去重建别人的身份文件。

---

## 刻意不做的事

这些不是没做完，是决定不做（用了最弱的够用机制）：

- **不写任何会话事件**：宿主格式一变就会让会话打不开，收益远小于风险。
- **不注册改变 agent 行为的钩子**（restrict / guard / waterfall 那类）：记忆只提供事实与指针，采不采用由当前会话判断。
- **不自动安装、不自动改宿主配置**：装插件是人的动作；升级只动自己的文件。
- **不复制 billion-context 的摘要**：它是外部权威，只读；复制一份就成了两个真相。
- **不在写入时「顺手提炼」**：`memory_write` 存用户/模型明确给出的原文；提炼是 dreaming 的事，而且默认 dry-run。
- **不做语义向量检索**：当前是关键词 + 中文二元组 + 图谱扩散，够用且可解释；换向量是另一个工程，不是补丁。

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

自检脚本随包发布在 `scripts/` 下：核心层 104 项、编码层 14 项、踩坑层 16 项、记住意图 30 项、事件重放 11 项、billion-context 桥接 14 项、修复项回归 26 项、记忆分级 16 项、规则晋升 15 项、设置页 23 项、备份/回合日志 5 项、记忆体检 5 项、外部转录 6 项、记忆主题 4 项、评审 brief 5 项、代码图谱 17 项，共 311 项断言，覆盖写入/检索/取代/守卫/快照/索引锁/并发/缓存失效/桥接的边界情况。单跑某一个：`node scripts/dsh-memory-audit.mjs`。

---

## 致谢与许可

本项目采用 **AGPL-3.0-or-later + 商业授权** 双轨：

- **免费用**：遵守 [GNU AGPL-3.0](LICENSE) 即可使用、修改、分发。修改后的版本必须以同样的 AGPL-3.0 开源，并保留本项目的版权声明。这里也包括「不发布二进制、只把服务放在网上给别人用」的情况——你改过的代码只要对外提供了服务，就要按 AGPL 把源码提供给使用者。
- **闭源商用**：不想承担 AGPL 开源义务的商用场景（闭源集成、闭源分发、闭源 SaaS），需先取得商业授权。申请方式：在 [Issues](https://github.com/china-cdw/dsh-soul-memory/issues) 开一条，写明公司 / 产品 / 使用方式。商业授权只改许可条款，代码与开源版完全相同，取得后无需开源你的修改。
- **历史版本**：0.3.51 之前以 MIT 发布的版本不可撤回，仍按 MIT 授权；AGPL-3.0 自 0.3.51 起生效。

上游与第三方：

- 底座来自 [icyaaaww/dsh-soul](https://github.com/icyaaaww/dsh-soul) 2.0.1（MIT）：会话图谱、投影、压缩后端；
- 核心记忆层移植自 dsh-core-memory 1.0.1（MIT）：`MEMORY.md`、归档笔记、persona；
- 上述上游仍为 MIT，其版权与许可原文保留在 [NOTICE](NOTICE)；
- 设计上借鉴了两个开源项目（未复制代码）：
  - [NattoCB/dsh-plugin-memory](https://github.com/NattoCB/dsh-plugin-memory)：分层、索引与详情分离、截断预算；
  - [dearbld/dsh-living-memory](https://github.com/dearbld/dsh-living-memory)：冲突取代标记、守卫规则数据化、发布前扫描、快照轮转；
- billion-context 是独立插件（MIT），本插件只读取它的会话存档，不包含它的代码。
