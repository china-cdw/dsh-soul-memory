# 变更日志

## 0.4.13

- 新增两个按需工具 `code_explore`（查符号/文件/功能，返回源码片段 + 入口 + 调用关系）与 `code_impact`（影响半径、文件依赖）：把仓库的代码知识图谱（CodeGraph）接进记忆插件。只读、按需调用，代码上下文不进系统提示，避免每轮重发占预算。
- SDK 用候选绝对路径解析（`CODEGRAPH_SDK_PATH` → 逐层 `node_modules` → 全局安装位置，含 Windows 的 `%APPDATA%\npm\node_modules`），不新增 npm 依赖；只缓存「没装」5 分钟，装完不用重启。失败分几种报（没装 / 没索引 / 加载失败 / 索引打不开 / 超时），各带一条可复制的命令。
- 返回内容按路径过滤（`node_modules/`、`.git/`、`.env*`、私钥与凭据文件名、二进制），反斜杠、`..` 与仓库外绝对路径一律挡掉；凭据打码覆盖带引号的值、JWT、Bearer 与私钥块；代码围栏按内容动态加长，避免被代码里的反引号提前闭合；预算不够时说明还有几块没放进来。
- 评审后加固：索引句柄按仓库根缓存、并发打开共用一次、超时后回收；文件依赖与符号查询先归一化路径再查；影响半径的计数与清单都不含目标自己；`dispose` 先摘工具再关句柄；失败时带 `[err:...]` 让宿主与踩坑记录能识别。
- 新增自检 `scripts/dsh-codegraph-audit.mjs`（16 组断言：失败分支、正常路径、打码反例、路径穿越、对象返回值、预算截断、并发清理钩子、真 SDK 的 explore 与 impact），并加入 `npm test`。

## 0.4.12

- 新增工具 `review_brief`：把「只读评审」的规矩一次写死——只读边界（不改文件、不 commit、不部署、不派子 agent）、每条发现必须带 `文件:行号 + 严重度(blocker/should/nit) + 具体改法`、超时/报错不算通过、最多 4 轮，到线交人裁决。填 goal / repo / base / checks 就得到一段可直接派给评审员的 brief。
- `lessons` 新增 `action=route`：给一条坑标上「靠什么强制」（结构 > 类型 > 检查 > 测试 > 规则）和「怎么验证它会响」。列表里区分「已强制 / 还只是线索」，重复出现但没有任何强制手段的会直说「已重复 N 次，还没有会响的检查」。
- 注入的踩坑段落头部补上强制阶梯说明与 `lessons action=route` 的用法，避免「光记下来」被当成已修复。
- 新增自检 `scripts/dsh-review-brief-audit.mjs`（5 组断言：只读约束、必填字段、行号格式、轮次上限、占位提示），并加入 `npm test`。

## 0.4.11

- 新增：归档记忆自动带主题（工作 / 生活 / 健康 / 学习 / 家庭 / 其他）。
  写入时按标题与正文的词表估一个主题，设置页「记忆内容」可以按主题筛，
  每条前面有主题小标签。老笔记没有主题行时按同一套词表现算，不改文件。
- 新增：编码规范只在「像代码目录」的会话里注入。判据是当前目录下有没有
  package.json / go.mod / .git / AGENTS.md 这类标志物；纯聊天的会话不再被
  一屏编码约定占位。判断不了时仍按代码目录处理，不会悄悄吞掉规则。
- 自检新增 4 组断言（主题分类、多命中取舍、标签归一化、代码目录判定）。
## 0.4.10

- 设置页「记忆内容」的归档笔记改为按分量排序，与 `memory_list` 同一把尺子；每行显示「强/中/弱 分数 · 字数」，原来只按字数排。

## 0.4.9

- 记忆分量分档阈值抬高（strong 0.6→0.75、normal 0.4→0.5）：归档笔记天然`够长 + 有结论`，原阈值让九成落进「强」、分档没意义；实测 27 条从 22 强/2 中/3 弱变成 11 强/12 中/4 弱。

## 0.4.8

- 记忆按「文字样子」估一个分量（长度/结论/纠正/具体对象/口语），只用于排序与回收门槛，不删任何东西。
- `memory_list` 按分量排，输出里带「强/中/弱 + 分数 + 依据」。
- 分级回收多一道保守滤网：样子判为「强」的节点不进可回收列表。

## 0.4.7

- 会话级记忆开关：三档（正常 / 只读 / 关闭），只影响单个对话，换新会话自动恢复。
- 三种触发：设置页「跨会话记忆」卡、输入框下方的「记忆：正常」胶囊、对话里直接说「关闭跨会话记忆」。
- 关闭或只读时，系统提示只留一行说明，不再注入旧记忆卡片；`memory_write` / `memory_archive` 等写操作直接返回 E_DISABLED。
- 新增 `memory_mode` 工具与 `GET / POST /dsh-soul-memory/session` 接口。
## 0.4.6

- 归档笔记可以直接看正文、改正文、删除：新增 `POST /dsh-soul-memory/notes`（read / save / delete），删除写墓碑不物理删，保存前留 `.bak`。
- 记忆内容页每条笔记加「查看 / 编辑 / 删除」，编辑只改正文，标题与标签不动。

## 0.4.5

- 设置页补齐此前只在工具层的能力：新建规则、查重扫描、备份导出/导入（含预演）、回收门槛天数、手动整理一次。
- 新增路由 `POST /dsh-soul-memory/backup`、`GET` 同路径列表；`/rules` 支持 `add` 与 `dupes`；`/tier` 的 `collect` 支持 `minAgeDays`；`/dreaming` 支持 `action=run`。

## 0.4.4

按两份设计审查（信息架构 + 界面细节）改设置页：

- 新增「记忆内容」标签页：归档笔记列表（标题 + 字数）、踩坑条数、最近几天回合日志；只读，写入仍走模型工具
- 标签页改名：「规则」→「编码规范」，避免和「待批区」混淆
- 首屏读取失败时给出原因和「重试」，不再只有一个空态框
- 暂停写记忆改为两步确认；删除规则按钮改成危险色
- 「不提醒」与「静默」互斥：点静默会自动切回对话内条
- 复制全文给出「已复制 N 字」反馈；字数按字符显示，不再折算成 KB
- 浮层加 role="dialog"；侧栏没有待批时不再白占版面
- 样式收敛：字阶 5 档、圆角 3 档、按钮统一 28px 高；补 :focus-visible 与 :active；窄屏补 flex-wrap、媒体查询与 min-width:0；弹窗 z-index 提到 70，长列表时标题栏吸顶

## 0.4.3

- 检索结果标签拆成两轴：`match`（quote / literal / spread / graph）说明来源，`share`（Jaccard，满匹配时省略）说明命中量，取代原先的四档 `confidence`。
- `hits` 的 `share` 与排序同一把尺子（Jaccard），不再出现「排第一但 weak」。
- `spans` 现在带 `match: quote`；FTS 的 bm25 取负，所有 `score` 统一成「越大越相关」。
- 修 `recordLookup` 在 auto 模式下用外部转录的行号写锚点。
- `memory_backup` 的 `file` 只认备份目录里的文件名，传路径会直接报错说明。
- 补齐共享模块的注释：`due` 的倒置、low 层 `maxImportance` 的死条件、回合日志不 await 的原因。


## 0.4.2

- 修复备份导入的路径穿越：`files` 的 key 只允许 7 个已知文件名与 `notes/<安全名>.md`。
- 修复 `current` 标记：跨会话与外部转录的命中不再被标成「本会话原话」。
- 修复 `source=graph` 仍会写库（ingest / recordLookup）。
- `source` 加 enum，拼错不再静默降级成 auto。
- 修复外部来源检索：`session LIKE '%:%'` 下推到 SQL，本地行不再把外部命中挤出窗口。
- 修复 `capture` 的两次写入：被取代的节点与新节点在同一事务里关闭与写入。
- `/mem sleep` 只退役低层（不再收掉 progress），与 `memory_tier` 的「中层不回收」一致。
- 路由注册失败会回滚已注册的路径，不再让下次热重载连锁失败。
- `importExternal` 的 `budgetMs` 现在真的生效。
- `memory_backup` / `memory_journal` 的错误带 `[err:CODE]`；`apply` 只认布尔真值；`memory_journal` 校验 action。
- 测试 249 → 254。

## 0.4.1

- **跨工具会话索引**：`soul_recall` 新增 `source=external`，把本机其他 AI 工具的对话转录读进已有的 span 索引，和本插件的原文一起检索。当前识别 QClaw / OpenClaw（`~/.qclaw/agents/**/sessions/*.jsonl`）与 Claude Code（`~/.claude/projects/**/*.jsonl`），存在才读、不存在不报错。
  - 增量靠 span 水位（`spanWatermark`），同一文件重复调用只补新行；单文件上限 8MB、单次最多 4000 行，默认给 400ms 预算，超时留到下次。
  - 结果带 `session`（形如 `qclaw:<id>`）与 `current: false`，`external.agents` 给出各来源命中数。
  - 这对应 deja-vu 的「跨 47 个 AI 工具共享历史」能力，但不依赖 Go 二进制：只在 Node 里解析 JSONL。
- 新增自检 `scripts/dsh-memory-external-test.mjs`（5 项：发现转录、导入、外部独检、水位去重、追加只补新增），断言总数 249 → 254。

## 0.4.0

- **衰减默认开**：`memory.dynamics` 从默认 `false` 改为 `true`，检索按 ACT-R 激活值排序，久不命中的旧节点自然靠后（不删除）；关掉恢复固定权重。
- **置信度四档**：`soul_recall` 的 `hits` / `neighbours` 增加 `confidence` —— `exact`（查询词全中）、`partial`（过半）、`related`（字面没撞上但靠图谱关联/激活捞回）、`weak`（仅擦边）。图谱召回本来按关联算，不补 `related` 会把结果全判弱。
- **只翻原文**：`soul_recall` 新增 `source` 参数（`auto` / `quote` / `graph`），`quote` 跳过图谱直接跨会话搜原始对话。
- **回合日志**：新增 `memory_journal` 工具与 `memory.turnLog` 开关（默认开），每轮有记忆写入时在 `$DSH_HOME/memory/turns/YYYYMMDD.md` 记一行「要了什么、写了什么、产物在哪」，闲聊不记。
- **备份/搬家**：新增 `memory_backup` 工具 —— `export` 把核心记忆、编码规范与待批、风格、踩坑、设置、归档笔记打包成 JSON；`import` 默认只预演，`apply` 前自动快照到 `backups/pre-import-<时间>/`。不备份 SQLite 图谱库（派生数据）。
- 新增自检 `scripts/dsh-memory-backup-test.mjs`（4 项），断言总数 245 → 249。

## 0.3.51

- 协议从 MIT 改为 **AGPL-3.0-or-later + 商业授权** 双轨：修改后分发、或以网络服务形式提供给别人使用，都必须同样以 AGPL-3.0 开源；闭源商用需先取得商业授权（申请方式写进 README）。0.3.51 之前以 MIT 发布的版本不可撤回，不受影响。
- 新增 `NOTICE`：保留上游 dsh-soul 2.0.1、dsh-core-memory 1.0.1、dsh-x-memory 的 MIT 版权与许可原文 —— MIT 要求保留，换协议后这些声明继续约束上游代码。
- `package.json` 的 `license` 改为 `AGPL-3.0-or-later`，`files` 补 `NOTICE`；中英 README 的「致谢与许可」整节重写。

## 0.3.50

- 编码规范注入上限可由用户在设置页自填：灵魂记忆 → 规则顶部新增「注入上限」输入框（400–8000 字，步进 100），留空 = 跟随宿主 `coding.budget`；写入 `memory/SOUL-UI.json` 的 `rulesBudget`，改动下一轮组装生效。
- host 侧新增 `effectiveBudget()`：UI 设置优先、其次宿主配置、最后默认 3500；`collectRules()` 与用量提示统一走该值；`/state` 的 `limits` 暴露 `minRulesBudget` / `maxRulesBudget`。
- 修 `sync-install.mjs` 漏复制 `client.js` 的问题（此前页面一直加载旧客户端脚本，表现为「点刷新没反应」）；顺带把 README 双语里过时的 2000 字预算、工具数量与断言计数改对，并补上「灵魂记忆设置页」六条路由的说明。
- 测试：界面断言 19 条、编码规范 14 条；全套 245 断言全绿。

## 0.3.49

- 规则可编辑：设置页「灵魂记忆 → 规则」每条后面加「编辑」，弹窗改正文、为什么、陷阱，保存后下一轮组装生效；写入走 `readGlobalRuleBlocks()` / `editRule()`，找不到原规则回 `E_NOT_FOUND`，改完撞上别的规则回 `E_DUPLICATE`；`POST /dsh-soul-memory/rules` 新增 `action=edit`（原来只有 `forget`）。
- 补九项界面能力：形态加「不提醒」第四档、临时静默（1 小时 / 今天 / 恢复）、页头记忆体检卡（核心记忆大小 / 归档 / 待批 / 规则用量 / 可回收 + 一句建议）、分级回收按钮（预演 → 回收 → 撤销）、暂停写记忆、规则逐条删、待批规则行内编辑、闲时整理开关、写接口令牌（页面加载时下发，缺令牌 403）。
- 编码规范预算默认 2000 → 3500（真实值由 `cordis.patch.yml` 的 `coding.budget` 决定，改代码默认值不够）；`coding_rules` 的 add/approve/show 输出用量，用到 85% 带截断警告，设置页规则 tab 有进度条。
- 新增规则时自动查重：add / propose / approve 都跟已有规则比对，提示「可能与已有规则重复或可合并」；新增 `action=dupes` 单独扫一遍。
- 测试：编码规范 14 条、界面 18 条断言；全套 205 断言全绿。

## 0.3.48

- 新增「灵魂记忆」设置页（`client.js`）：注册 4 个 slot（设置页 + 图标 + 输入框下方提示条 + 浮层），四个 tab——待批区、规则、称呼与风格、记忆分级。
- 待批提醒支持三种形态：输入框下方提示条（默认）、右侧面板、居中浮层；形态与称呼存 `memory/SOUL-UI.json`。
- host 侧新增 `src/ui-settings.js`、`src/ui-routes.js`，注册 `GET /dsh-soul-memory/state`、`POST /dsh-soul-memory/ui`、`POST /dsh-soul-memory/pending`；安全模型：回环 Host + Origin 同源 + 头 `x-dsh-soul-memory: 1` + JSON + 64KB。
- 称呼写进注入节 `## 称呼`，缓存键含 SOUL-UI.json，改称呼下一轮组装生效，不用重启。
- 客户端插件改 `package.json` 的 `dsh.client` / `exports['./client']` / `files` 后必须重启 DSH（热重载只换已加载模块，不换包清单）。

## 0.3.47

- 规则晋升分流：用户当场明确要求的用 `coding_rules add` 直接写；模型自己归纳的用 `propose` 进待批（`memory/CODING.pending.json`，上限 20 条），`approve` 后才注入、`reject` 丢弃。
- 晋升门槛成文并注入：跨项目适用、至少复现过两次、说得出必须遵守的场景；只出现一次的不进全局。
- 修 `collectRules` 的空短路：没有任何正式规则时，刚 propose 完的待批提示显示不出来。

## 0.3.46

- 记忆分级 + GC：`src/tiering.js`（tierOf / tierCounts / collectionCandidates / tierSummary）；新工具 `memory_tier`（status 看分布与候选、collect 预演回收、apply=true 执行、restore 恢复）。
- 分级：约束与钉住 → 🔴；决策与进度 → 🟡；产物、索引与其他 → 🟢。回收只动 🟢 且从没被命中、存在 ≥90 天；写 `state=retired`，可逆。
- `memory_brief` 多一行分级分布；GC 与 dreaming 共用运行锁。

## 0.3.45

- 修「记住」提醒的计数：宿主每个 model step 会把 systemPrompt 上下文组装两次（`assemble()` 与请求前的 `refreshContext()`），原来在 `text()` 里扣额度，一个 step 被扣两次，声明的「最多 3 轮」实际只显示 2 次，多步回合还会在同一轮里烧完。计数改到 `agent/pre-step`（每步一次），`text()` 纯读；新增 `src/memory/cue.js` 承载状态，默认显示 2 个 model step。
- 收紧意图识别：问句（「还记得…吗」）、否定（「我不记得」）、`don't remember` / `Do you remember`、代码标识符 `rememberMe` 不再命中；补上「以后用 / 以后默认 / 每次 / 下次别 / keep in mind / always use / note that」等说法。
- 原话不再从第 0 字截：按命中位置取前后窗口（200 字），去掉 400 字节预截；长消息末尾那句「记住」不会再被切掉。
- 写入守卫补中文敏感词（密码 / 口令 / 验证码 / 密钥 / 身份证 / 银行卡 / 手机号 / 住址），这类内容标记为 sensitive，不进系统提示与检索正文。
- 提醒文案改为「如果确实是长期要求」，并要求同一句只写一次、已存过不重复存。
- 测试 12 → 30 条断言（意图命中/不命中、窗口截断、计数推进与读两次不扣额度），总数 173 → 191。

## 0.3.44

- 新增「长期记忆要求」兑底：人类消息命中「记住 / 以后都 / 别再 / 今后 / remember / from now on …」时，`agent/pre-step` 记下原话，随后最多 3 轮在该会话的 systemPrompt 末尾注入提醒，要求先用 `memory_write`（必须长期稳定再用 `memory_core`）落盘再回答；未命中不注入、不改历史、不额外调用模型。
- 新增 `src/memory/remember.js`（中英文正则、`rememberExcerpt` 截断 200 字符、`rememberReminder` 提醒文案）与 `scripts/dsh-memory-remember-test.mjs`（12 条断言）。
- 自检 161 → 173 断言全绿。

## 0.3.43

- 彻底改名：包名、patch id、源码目录、安装副本目录、profile 依赖与 pnpm 锁文件全部改为 `dsh-soul-memory`；旧名只保留在历史记录里。
- 显示名与 GitHub 仓库已在 0.3.42 改为 `dsh-soul-memory`，本次补齐包与安装标识。
- 161 断言全绿。

## 0.3.42

- 显示名改为 `dsh-soul-memory`（`locale/zh.json`、`locale/en.json` 的 `meta.title`），描述同步改成实际能力，不再沿用旧的「独立 Evolve」文案；
- 仓库改名为 `china-cdw/dsh-soul-memory`，`package.json` 的 homepage / repository / bugs 与两份 README 的克隆地址同步更新；包名与安装名当时仍为 `dsh-x-memory`（0.3.43 起已全部改名）；
- 自检 161 断言全过（只改显示文案与链接）。

## 0.3.41

- 所有记忆类工具的描述末尾补一行「备注：」：说明数据落在 `<DSH home>/memory/` 的哪个文件、有没有副作用、是否调用模型/花钱；
- 备注以工具定义里的 `notes` 字段维护，注册时由 `src/tool-notes.js` 的 `withNotes()` 统一拼接，备注留空的工具保持原描述；
- 覆盖 `memory_write` / `memory_core` / `memory_search` / `memory_read` / `memory_list` / `memory_delete` / `memory_brief` / `persona` / `memory_dreaming` / `coding_rules` / `lessons` / `soul_recall` / `soul_expand` 与 `evolve_*`；
- 自检 161 断言全过（描述改动不涉及执行逻辑）。

## 0.3.40

- AI 裁决的 `reason` 也按「离该 id 最近」归属，同一对象里两个 id 不再互相借理由；
- 截断恢复补上末尾未闭合对象：回复在最后一条中途被 token 上限切断时，该条完整裁决也能捞回；
- 移除 dry-run 虚报的 `wouldRetire`（它只是 planned 的副本、没过护栏）；dry-run 看 `planned`，真实退役看 apply 的 `retired`/`rejected`；
- `DREAMING.json` 读不出或损坏时 `run` 返回 `skipped:"corrupt"`、`status` 顶部提示，且不再用默认值覆盖原文件；损坏副本按时间戳保留最近 3 份；
- 锁占用错误改用 `E_LOCK` 区分，内层 DREAMING.json 写盘失败不再被误报成 `skipped:"running"`；
- `graph-memory.js` 的 retire SQL 补 `scope` 与 `state='active'`，避免跨作用域或把 superseded 节点改成 retired；
- `restore` 补 `valid_to IS NULL`；整理运行中 restore 返回 `[err:E_BUSY]`；
- 边统计（`byRel`/`edges`/`hubs` 的 degree）只算两端都 active 的边；
- README 同步：cleanup 字段表、`pin=0` 护栏、`E_BUSY`、损坏保护说明；计数 85/161；
- 自检 161 断言全过。
## 0.3.39

- **裁决配对**：`recoverItems` 改成按对象边界前向扫描，verdict 归「离该 id 最近」的对象——同一对象出现两个 id、或 `reason` 里带 `{` 时，不再把裁决判给相邻节点。
- **dry-run 不虚报**：`cleanup.rejected` 只在 apply 时计算，新增 `wouldRetire` 用来预览「如果 apply 会退役几条」。
- **恢复可跨项目**：`restore(store, scope, ids)` 现在带 scope 与 `state='retired'` 守卫，并刷新 `seen`，恢复后的节点不会立刻被裁掉。
- **不再推迟清理**：`recordNodes` 只对 active 节点刷新 `seen`，重放同一批抽取不会再让 retired 节点的 30 天计时重新开始。
- **跨进程互斥**：`memory_dreaming run` 用 `DREAMING.json.run` 文件锁串行化，抢不到返回 `skipped: 'running'`，冷却判断在锁内。
- **配置损坏可见**：`DREAMING.json` 读取失败或 JSON 损坏都会备份成 `.bad-<时间戳>` 并返回 `corrupt: true`，不再静默回落默认值覆盖开关。
- **退役守卫与统计**：retire 的 UPDATE 加 `state='active'` 守卫；边统计只计入 active 端点。
- **文档**：README 中英补 `cleanup` 全部字段（含 `wouldRetire`/`details`）、`rejected` 的 apply/dry-run 语义、`retiredAt` 即 `seen`；自检数改为 158 项断言（核心 82）。

## 0.3.38

- 修复：`recoverItems` 改为按 `id` 做花括号配对，模型把 `verdict` 写在 `id` 之前时不再把裁决串到下一条（此前可能退役 keep 的节点、放过 noise 节点）；
- 修复：retire / restore 的 UPDATE 补 `AND scope=?`，跨 project 的同 id 节点不会被误改；
- 修复：`recordNodes` 的 `ON CONFLICT` 不再自动把 retired 节点改回 active，恢复只走显式 `action=restore`（重放同一批抽取不会静默撤销退役）；
- 修复：`action=restore` 与 `run` 共用 `dreamingInFlight` 互斥，整理进行中返回 `[err:E_BUSY]`；
- 修复：无模型路由归因为 `no_llm`（`E_NO_ROUTE`），不再混进 `llm_failed`；`action=retired` 列取失败时返回原因 + `[err:E_INTERNAL]`，不再伪装成空列表；
- 修复：`DREAMING.json` 的锁名不再重复拼 `.lock`（此前是 `DREAMING.json.lock.lock`）；解析失败先把损坏文件备份成 `.bad` 再回落默认值，不会静默覆盖用户开关；
- 修复：`neighbourhood()` 与图谱统计的 hubs 过滤 retired 节点；
- 改进：`cleanup` 统一字段并新增 `reason`/`keep`/`invalid`/`rejected`，README 补字段表；`autoApply` 默认 false 的措辞与首句矛盾已修正；
- 自检：核心 79 项、编码 10、踩坑 15、重放 11、桥接 14、回归 26，共 **155 项断言**（新增 3 条：verdict 在 id 前的截断恢复、E_NO_ROUTE 归因、retired 列取失败文案）。

## 0.3.37

- `memory_dreaming action=retired` 改为查库里的实时状态：只列 `state='retired'` 的节点（最多 100 条），restore 之后不再出现在列表里；没有 retired 节点时返回「当前没有 retired 节点。」
- 新增 `setDreamRetiredListProvider` 接线；宿主未提供 provider 时才回落到最近一次整理的 `cleanup.details`（仅作历史参考）。
- 新增 1 条回归（retired 以库为准），共 152 项断言。

## 0.3.36

- 修复：AI 裁决的截断恢复真正可达——生成器返回 `{text, finishKind}`，由 `parseCleanupVerdicts` 统一解析；`max-tokens`/`length` 时强制从残缺 JSON 里捞完整裁决（`recoverItems` 改为按 id 切窗、不依赖字段顺序）。
- 修复：retire 加护栏（与 periphery 同口径：`hits=0`、未被取代、创建 ≥7 天、`pin=0`）并包进事务；`recordNodes` 冲突时把 retired 节点复活；`latestNode`/`neighbours` 只认 active，retired 不再从 handoff 与联想扩散漏回上下文。
- 新增：`memory_dreaming action=retired` 列出最近 retire 的节点，`action=restore ids=[...]` 恢复；`retired` 30 天后才可能被清理。
- 修复：全批失败或无 llm 时降级为「不清理」而不是中止——digest 照写、冷却照推进，`cleanup.available=false` 并带 `reason: llm_failed|no_llm`。
- 新增：`dreaming.autoApply`（默认 false）。空闲到期不再自动改库，只允许手动 `run`；显式开启后才自动 apply。
- 修复：`runDreaming` 增加 in-flight 互斥；`DREAMING.json` 的读改写走文件锁 + 原子写，`configured` 不再落盘；加入快照文件清单；`planned` 去重。
- 文档：写清「可逆」的含义（投影/联想消失、30 天后才清理）、`cleanup` 字段、`autoApply` 与 `ai` 默认值；中英 README 同步；151 项断言。

## 0.3.35

- 闲时整理的 AI 清理改为分批调用（每批 12 条），避免单次裁决 60 条被 token 上限截断；
- 模型输出被 max-tokens 截断时，用正则从残缺 JSON 里捞出完整裁决，不再整次失败；
- 某批调用失败不影响其他批：成功批的裁决照常生效，结果里带部分失败信息；
- 模型路由兜底：插件设置 → 顶层 → agent → 宿主 `agent-default-model`（读 `cordis.patch.yml`），都没有才报错并给指引；
- 新增 3 条回归（分批切块、截断容错、部分失败仍生效），共 148 断言；
## 0.3.34

- dreaming 加 AI 清理：把用户废话、断网重发的重复对话、明显错乱内容判为 noise/duplicate，只 retire（可逆、从投影消失，soul_recall 仍可找回），不删原始会话日志、不删笔记；
- AI 只做裁决：严格 JSON 白名单 id，keep 与编造 id 不动；模型不可用/超时/返回不合法 JSON 时跳过清理、照常整理，绝不静默删除；
- 配置 `dreaming.ai`（默认开）、`provider`/`model`（留空用全局默认）、`maxScanNodes`（默认 60）、`maxRetirePerRun`（默认 20）；
- 新增 3 条回归（只 retire 判定项、AI 不可用不 retire、模型报错中止且不 retire），共 145 项断言。

## 0.3.33

### 可选：闲时整理（dreaming）
- 新增 `memory_dreaming` 工具：`status` 查看开关与上次结果，`on`/`off` 写入 `DREAMING.json` 立即生效，`run` 默认 dry-run（`apply: true` 才写、`force: true` 忽略冷却）。
- 默认关闭；开启后每次 turn 结束按 `dreaming.idleDelaySeconds`（默认 120 秒）起 unref 定时器，把近期会话图谱里的决策、约束和重复进度聚成 digest 笔记——只新增，不改不删既有记忆。
- 边界：单次最多 `maxNotes`（默认 3）条；自动整理有 `minIntervalMinutes`（默认 180）冷却；digest 带 `dream` 标签与来源 seq，走同一套查重。
- 配置项：`dreaming.enabled`、`dreaming.idleDelaySeconds`、`dreaming.minIntervalMinutes`、`dreaming.maxNotes`；数据目录新增 `DREAMING.json`。
- README 中英双语补充 dreaming 小节、工具表、配置与数据目录；断言数更新为 66 核心 / 10 编码 / 15 踩坑 / 11 重放 / 14 桥接 / 26 回归，共 142 项。

## 0.3.32

- **归档记忆记录来源会话与事件序号**：`memory_write` 未显式传 `session`/`seq` 时，自动取 `exec.agent.session.id` 与当前会话最新事件序号，写入 front-matter；`memory_read` 显示「来源会话：<sid> #<seq>（可 soul_expand 回看原文）」，让记忆能回捞到原始对话。
- **宿主注入文本不再进入记忆**：新增 `injected()` 特征识别（runtime-context 快照、`[骨架]`、技能清单、系统提醒、核心记忆/编码规范/踩坑注入段落），入缓冲与纠正判断前跳过；`skeleton.normalize` 把这类消息标为 `sourceKind: "host"`，`extract` 直接跳过，避免把「宿主告诉我什么」误当成「用户约束」。
- 回归：新增 2 条用例（自动来源会话、注入上下文不进图谱），共 139 断言。

## 0.3.31

### 借鉴三份参考实现后的三项增强

- **检索准入**：`memory_search` 在查询含两个以上词时，只命中一个词的条目折叠为「低相关已折叠」，不再挤占前 8 条；标题/标签强命中仍直接保留。
- **规则三要素**：`coding_rules action=add` 支持可选 `why`/`pitfall`，写为缩进子项（规则 + 为什么为真 + 陷阱）；`forget` 连子项一起删，不留孤儿。
- **来源指纹**：`memory_write` 支持可选 `paths`（最多 10 个文件），front-matter 记录 sha256；`memory_read` 时比对，文件改过标「已变更（记忆可能过时）」，缺失标「已缺失」。

### 验证

- 新增 3 条回归（来源指纹变更/缺失、检索折叠、why/pitfall 连删）；六套共 **137 断言**全过。
- `preflight` 通过；`sync-upstream --check` 仍通过。

## 0.3.30

- 删除两处真实死代码：`src/memory/util.js` 的 `SECRET_PATTERN`（从未被引用，真正生效的是 `SECRET_VALUE`）、`src/persona.js` 的 `presetById`（从未被引用，调用方直接用 `PRESET_BY_ID`）。
- `UPSTREAM.md` 注明 `src/memory-dynamics.js` 是上游预留、无调用方的参考实现：不接线、不删除（删除会被同步装回）。
- 审计结论：镜像文件里的未用导出保持上游原样；`src/component-worker.js` 由 `components.js` 以子进程路径启动，不是孤儿。
- 134 断言全过；无运行时行为变化。
## 0.3.29

- README 双语计数校正真正进入提交（0.3.28 因 git stat 缓存未重新哈希而漏提交）：提交树与工作区均为 26 项回归、共 134 项断言。
- 快照拷贝循环遇到「源存在但非普通文件」（目录/设备/链接）时不再静默跳过：删除目标旧副本并记 `name:notfile`，当天不写 `.complete`。
- `src/session-search.js` 归为自有文件（`OUR_FILES`）并从上游清单移除，`node scripts/sync-upstream.mjs --check` 恢复通过。
- 更正 0.3.28 变更日志第一条的触发条件描述。

六套自检 134 断言全过。

## 0.3.28

- 快照补写时，探测阶段属性读取失败（非 ENOENT，状态未知）的文件，若拷贝前确认已不存在，也删旧副本并记 `name:stale`，不会在 `.complete` 后面复活已删记忆。
- 探测阶段就确认不存在的文件（如未设置 PERSONA.md）仍按常态跳过，不会把整天备份误判为不完整。
- README 中英双语的断言计数校正为 59/9/15/11/14/26 = 134。
- 更正 `validateExpandArgs` 旁过时的「审计不再靠源码正则」注释。

六套自检 134 断言全过。
## 0.3.27

- 快照：源文件属性读取遇到 EPERM/EBUSY/ELOOP 等非 ENOENT 错误时，不再当作「源里不存在」——旧副本不会被保留并盖上 `.complete`，而是记入 `failed` 让当天不算完成。
- 快照：探测时存在、拷贝前消失（ENOENT）的源文件，会删除目标里的旧副本并标记不完整；顶层陈旧文件只清理「确认不存在」的那些。
- expandRange：两端都越界返回空区间且不标 `truncated`（越界不是「还有内容没读完」），单端越界读到区间末尾；越界不再污染 `truncated`，零预算 + 越界优先回答越界，不再误导「提高 limit」。
- 审计：新增工具层接线断言（`index.js` 是否真的调用 `validateExpandArgs`），越界用例改为测导出的校验函数。
- 6 套自检共 134 项断言全部通过。

## 0.3.26

- 快照完整性改为「源存在才要求拷贝成功」：探测阶段 stat 源文件，源里没有的不算失败；copyFile 阶段 ENOENT 视为探测后源被删，删掉目标旧副本并记 `name:stale`。
- 当天已有残目录（无 `.complete`）且源记忆全空时，不再清理残目录，保留 `MEMORY.md`/`index.json`/`evolve.sqlite` 并返回 `copied: 0` + error。
- `notes/` 与顶层文件的删除失败（EBUSY/EPERM）现在进入 `incomplete`，不再被静默吞掉；`.complete` 只在无失败时写入。
- `soul_expand` 的 `from`/`to` 共用导出常量 `MAX_SEQ`（schema、校验、`expandRange` 夹紧单一来源），补回 `from` 上界。
- 越界语义：两端越界返回空区间并标 `truncated`；单端越界按上界读取并在 note 说明；越界零事件不再提示「提高 limit」。
- 修复 `README.md` / `README.en.md` / `CHANGELOG.md` 的测试计数（59/9/15/11/14/25，共 133）。
- 回归用例：源记忆全空保留残目录（含 `MEMORY.md`）、两端/单端越界语义、`validateExpandArgs` 上界。
## 0.3.25

- 同日快照补写不再误判「整天不完整」：源里仍存在的顶层文件不再先删（copyFile 会整份替换），只删源里已消失的；删除失败按 EBUSY/EPERM 重试 3 次，其余记入 failed。
- 源记忆全空时不再清空当天残目录：保留 .started 与图谱快照，返回 { copied: 0, error }；自己刚建的空壳仍会删除。
- expandRange 请求区间越界不再静默换成别的事件：两端越界返回空区间并标 truncated，单端越界在 note 里说明按上界读取；越界也计入 truncated。
- MAX_SEQ 收敛为单一来源：session-search.js 导出，index.js 的 schema 与校验共用。
- README 计数改为 59/9/15/11/14/25，共 133 项断言；CHANGELOG 恢复 H1。
- 新增回归：源全空保留残目录、两端越界空区间、单端越界 note（共 133 项断言）。


## 0.3.24 — 同日快照的陈旧文件与删除失败
- 复用当天快照目录时，除了 notes 还会先清掉 `PERSONA.md`/`GUARD.json` 等顶层文件：`copyFile` 只覆盖不删除，旧备份会被 `.complete` 盖章，恢复时旧风格/旧规则盖回当前值。
- 清理 notes/顶层文件失败不再被静默吞掉：非 ENOENT 记入 `failed`，不写 `.complete`，下次快照重试。
- 快照回归用例现在预置 `dest/notes/b.md` 与 `dest/PERSONA.md`，在 0.3.23 实现上会失败、在 0.3.24 上通过（不再空转）。
- `expandRange` 的 `start` 也夹到 `MAX_SEQ`，直接调用时不再出现 `to < from`。
- 断言计数更正为 130（此前 CHANGELOG/MEMORY 写 129）。


## 0.3.23

- **soul_expand 的 from 补回上界**：0.3.22 删除 from>to 校验时漏了 `from > 1000000`，巨大 from + 小 to 会把区间终点抬到 from，同步空转（1e9 约 2.4 秒）；工具层重新拒绝，expandRange 内再用 MAX_SEQ 兜底夹紧终点。
- **同日补写快照先清空 notes**：复用当天目录时 `cp` 是合并复制，已删除的笔记会留在备份里并被 `.complete` 盖章，恢复后对账会把删掉的记忆复活；现在补写前先删 `dest/notes`。
- 新增 2 条回归：from 上界与终点夹紧（快速返回）、同日补写不保留已删笔记；共 130 断言。


## 0.3.22

- 死锁回收串行化：pid 已死的锁通过 `<lock>.reclaim` 二级锁串行回收，删除前复核内容与 mtime，避免多个写者同时进临界区（实测重叠 3/3 → 0/3）。
- `soul_expand` 的 `from` 指向不存在的 seq 时同步清空 `pendingSkip`，offset 不再顺延吃掉下一条事件的开头。
- 零预算返回可回填的 `next`，并修正 note 中 `to` 的说明（from=0 时 to=-1 表示一条都没读）。
- 预算不足一个字符时 note 明确提示「提高 limit（≥4）」，不再让调用方原地打转。
- `soul_recall` 的 `k` 允许 0（等同默认 3），避免收紧校验造成的破坏性变更；`from > to` 交给区间归一化，不再报错。
- `sliceAround` 注释与「严格不超预算」的实现对齐；README 中英文修正续读协议（首条被裁剪用 resume.seq+offset，其他截断用 from=to+1）。
- 自检 126 断言全过（含缺失事件 offset、零预算 next、死锁回收并发三条新回归）。

## 0.3.21

- 修复 `soul_expand` 的 offset 在空事件上顺延、吞掉下一条开头（空事件也先消费 offset；`from=0` 零预算返回 `to=-1` 且标 `truncated`）。
- `limit` 极小预算不再超预算返回字符：放不下就返回空并标 `truncated`，调用方不会拿到超过承诺的字节数。
- 崩溃遗留的锁按 pid 立即回收（无需等 10 分钟 stale）；`index.json` 快照拷贝遇 EBUSY/EPERM 重试 3 次。
- 图谱快照失败写日志；rotate 的 keep 注释与实际一致。
- `soul_expand` / `soul_recall` 参数边界进 schema（from/to ≤ 1000000、limit ≤ 20000、maxEvents ≤ 1000、k 1–5）。
- README 中英双语补续读协议（`from=resume.seq` + `offset=resume.offset`）与默认值/上限。
- 125 断言全绿。
## 0.3.20

- 续读游标不再多算：只有「被裁剪的那条事件」的 skip 才计入 `resume.offset`，跳过整条事件不贡献字节；skip+clip 组合续读不再永久丢字节。
- 参数错误返回对象而非裸字符串：`soul_*` 的 `[err:E_ARG]` 分支统一返回 `{ text }`，符合注册时的 output schema，宿主校验不再报硬错误。
- 快照锁阈值统一：新增并导出 `SNAPSHOT_LOCK_STALE_MS = 10 分钟`，文件快照与图谱快照共用；心跳间隔上限 5 秒，VACUUM 阻塞事件循环时活锁不会被当死锁删掉。
- 快照等待显式化：文件快照 30 秒、图谱快照 60 秒；跳过与失败都写日志，不再静默。
- 零预算 `to` 钳制：`from=0` 时返回 `to=0` 而不是 `-1`，不再越出调用方的 `to>=0` 校验；去掉只在该分支出现的 `processed`。
- `int()` 参数补 `minimum: 0`。
- 回归测试 124 条：新增 skip+clip 游标、`from=0` 零预算、快照锁常量与 E_ARG 返回对象检查。

## 0.3.19

- 续读游标真正前进：`resume.offset` 累加 `skipBytes`，offset 只用一次，越界不再吞掉后续事件。
- `limit`/连续续读的硬上限：单次最多 20000 字节、1000 事件；参数错误一律 `[err:E_ARG]` 文本。
- 零预算返回 `to = from - 1`，不再把「没处理」谎报成「区间读完」。
- `snapshotGraph` 与文件快照共用锁文件，stale 放宽到 10 分钟，避免 VACUUM 阻塞心跳被抢锁。
- persona preset 统一 trim：工具与 HTTP 路由对 `' warm '` 行为一致。
- README 的 `soul_expand` 补 `limit`/`maxEvents`/`offset` 与 resume 协议。

## 0.3.18

- 修复 `soul_expand` 的 `limit` 没有上限：硬钳制 20KB / 1000 事件，避免一次拉回整个大事件。
- 新增 `offset` 参数：`resume.offset` 现在真的能续读，不再同 seq 重读同一段。
- 快照：`snapshotGraph` 进入 `.snapshot.lock`，临时文件改 `<pid>-<rand>`，避免并发分裂与 pid 复用撞名。
- 快照轮转：`count` 过滤点文件；`latestSnapshot` 也认只有图谱的目录，不再把有图无文的备份当「尚未生成」。
- persona：`preset` 显式空白现在返回 `E_ARG`，不再静默成功。
- 测试增至 118 断言。


## 0.3.17

- 快照图谱完成改用独立 `.graph` 标记 + SQLite magic 校验：半截文件、纯文本 `evolve.sqlite` 不再被当成完成，也不会占 keep 名额。
- 快照整段加跨进程锁；先拷 `notes/` 再拷 `index.json`；`.started` 写失败即中止；超过 10 分钟的 `evolve.sqlite.tmp-*` 自动清理。
- `expandRange`：左右边界都不切断代理对；极小预算至少返回一个完整 code point（不再零进展）；首条被裁剪时返回 `resume: { seq, offset }`；`limit`/`maxEvents` 只有 null/undefined 才取默认，显式 0 返回空且不谎报截断。
- persona：`action=set` 可以只传 `enabled`（预设继承）；`disable` 与 `enabled=true` 冲突时报 `E_ARG`；去掉无效的 `enabled: true` 死字段。
- soul_*：参数错误带 `[err:E_ARG]`，检索预算耗尽带 `[err:E_BUDGET]`；`soul_expand` 暴露并转发 `limit`/`maxEvents`。
- 自检 115 断言全过。

## 0.3.16

- 图谱快照目录不再被自己的 `.started` 误判为在途残片：`inFlight` 要求「无 .complete 且无 evolve.sqlite」。
- `snapshotGraph` 先写 `.started` 再 VACUUM，大库写入期间不会被另一进程当空壳删掉。
- `sliceAround` 不再切断代理对；预算放不下一个字符时至少返回首个完整 code point，保证调用方有进展。
- `expandRange` 逐端归一 from/to、end clamp 到 ≥0；`limit=0`/`maxEvents=0` 显式返回空结果并说明。
- persona 工具新增 `enabled` 参数；停用状态下切预设不再谎报「已切换」，提示需要显式启用。
- README.en 同步状态码（405/500）与「无 Host 头（HTTP/1.0）跳过白名单」说明。
- 自检：核心 52 + 编码 9 + 踩坑 15 + 重放 11 + 桥接 14 + 回归 10 = 111 断言全过。
## 0.3.15 — 快照在途状态与 API 边界

- 快照在途标记 `.started`：写失败的残片不再占用 keep 名额、不再被 `latestSnapshot` 报成「最近可用快照」；空壳目录清理加 10 分钟年龄门槛，避免删掉并发写者刚建的当天目录。
- 图谱快照先写临时文件、校验非空后 rename；半截 `evolve.sqlite` 会被删除重做，不再永久粘住。
- `rotateSnapshots` 支持 `protect`：本轮正在写的目录永不淘汰；keep 按总量计算，避免 protected 导致多留一份。
- `latestSnapshot` 按 `.complete` 内容时间排序，只认完成或 0.3.11 之前的老快照。
- `GUARD.json` 纳入快照。
- `soul_expand` 预算严格按字节；预算放不下首字符时不再假装前进；区间读完没有可读事件时 `to` 落到 end，避免客户端反复重试。
- `persona` 工具 `set` 不再把停用状态悄悄改回启用；`disable` 不再要求自定义正文非空（与 HTTP 路由一致）。
- bootstrap 模板写入改用文件锁（去掉内层 enqueue，避免自己等自己）。
- README：补 405/500 状态码与「无 Host 头（HTTP/1.0）跳过 Host 白名单」的说明。
- 自检 108 断言全过（核心 49 / 编码 9 / 踩坑 15 / 重放 11 / 桥接 14 / 回归 10）。

## 0.3.14

- 快照轮转同时保护「本轮正在写的目录」与「0.3.11 之前的无标记旧快照」：失败不再自删、图谱目录不再被误删、keep 把受保护目录计入总量。
- persona 工具切预设不再把继承的超长正文当新写入校验（6000 字正文可正常切预设）。
- expandRange：尾部无事件不再误报截断；首条超预算按字节严格裁剪；提示只在真正裁剪时出现。
- README 自检数字更新为 106 项断言。

## 0.3.13

- persona：读取侧不再截断超长自定义正文；停用/切换预设不会把截断后的正文写回（显式入参仍限 4000 字）。
- soul_expand：单条事件超过字节预算时返回其前若干字节并让 `to` 前进，不再返回空内容或丢掉后续小事件；截断说明区分「首条被裁剪」。
- 快照：`.complete` 写失败按不完整处理；轮转优先淘汰残缺目录，完整目录按 mtime 保留最新 keep 份；`latestSnapshot` 兼容 0.3.11 以前无标记的快照。
- 索引：`rebuildIndex` 整体进索引锁，锁内直接写盘（不再重入 `persistIndex`）；bootstrap 的空索引创建也在锁内，避免覆盖并发写。
- coding：`addRule` / `forgetRule` 捕获锁超时并返回 `E_IO`，不再抛裸异常。
- persona 路由：方法判定前移，跨源预检也能拿到 405 + `Allow`；README 补 `lessons.limit`，并说明 `expandRange` 按字节预算。
- 自检：核心 44 项，六套合计 103 断言。
## 0.3.12

- 锁序统一：lessons 的整份改写（forget/clear）也走「先队列后文件锁」，消除与自动记录交错时的 12 秒卡死和记录丢失。
- persona 路由坏 JSON 返回 400（不再抛异常落 500 并回显内部错误）。
- 快照完整性：notes/ 拷贝失败也计入 failed，只有全部成功才写 `.complete`；latestSnapshot / rotateSnapshots 只认带完成标记的目录。
- 索引锁陈旧清理加 mtime 复核（与 withFileLock 一致），避免误删刚被心跳续期的活锁。
- reconcileIndex 整体在索引锁内执行，锁内直接写盘（不再调用会二次加锁的 persistIndex）。
- coding_rules 的 add/forget 返回机器可读 code（E_ARG / E_DUPLICATE / E_NOT_FOUND / E_IO），工具输出用 [err:CODE] 透传。
- expandRange 按字节预算收口（对齐对外承诺的 ≤2KB），truncated 只看是否因条数或字节上限提前退出，不再假阳性。
- 自检 101 断言（核心 42 / 编码 9 / 踩坑 15 / 重放 11 / 桥接 14 / 回归 10）。

## 0.3.11

- 踩坑层 `rewriteRows`（forget/clear）加跨进程文件锁，避免与 append 互相覆盖。
- `withFileLock` 支持显式短等待优先；陈旧锁删除前二次校验 token；心跳下限随 stale 自适应。
- persona 的三处读-改-写（disable / set / HTTP 路由）改用文件锁；路由对未知字段、空 preset 返回 400，内部错误返回 500，响应带 maxCustom。
- 快照逐文件校验，任一文件失败不写 `.complete` 并打印原因（不再谎报完成）。
- `normalizeRef` 先去掉 `.md` 再去方括号，`[abc].md` 不再归一成 `abc]`。
- `expandRange` 返回真实 `to`、`truncated` 与提示，不再静默截断却回显请求值。
- 自检 99 断言。
## 0.3.10

- 修复：`memory_delete` / `memory_read` 收到空引用（如 `[]`、`[`、`.md`）时不再做空前缀匹配，返回 `E_ARG`，避免误删整库。
- 修复：当天快照目录已存在（图谱先建）且没有文件可拷时，不再删除该目录，避免连带删掉刚生成的 `evolve.sqlite`。
- 修复：索引锁的等待时间与心跳间隔改为跟随可配置的 stale 值（`DSH_X_MEMORY_LOCK_STALE_MS`），等待默认不短于 stale×1.2；心跳只给自己持有的锁续命。
- 修复：`LESSONS.jsonl` 追加改为跨进程文件锁；读失败不再是空清单，不会整份重写清空历史。
- 修复：persona 设置页拒绝未知字段与错误类型（返回 400），不再静默 200。
- 修复：`settings()` 的 profile 非法时回落到 `desktop` 并记录错误，不再让整个插件不加载；soul 参数加边界（k 1–5、from/to 0–1000000 且 from ≤ to）。
- 自检：新增 2 条回归（空引用不删库、copied=0 不误删图谱快照），六套共 96 断言全过。
## 0.3.9

- 数据安全：CODING.md 读取失败不再回落到模板（只有 ENOENT 才用模板，其余错误放弃写入）；踩坑追加读失败不再整份重写。
- 并发：文件锁加 token 归属校验与 utimes 心跳，释放前确认仍持有；索引锁等待/过期阈值提到 15s/30s 并支持环境变量覆盖；锁内重建索引不再重复抢锁。
- 快照：以 `.complete` 标记判断当天是否已备份，图谱快照先建目录不再导致文件记忆整天被跳过。
- 显示：`memory_read` 等工具输出的 `[id]` 与 `.md` 后缀可被 read/delete/supersedes 识别；未知参数不再让相关成功误配为「纠正」。
- 错误码：`memory_core` 找不到分节、persona 缺 preset 等补齐 `[err:CODE]`。
- 平台：profile 支持 `input.profile` / `DSH_PROFILE` / 路径推断三级回落；`soul_recall`/`soul_expand` 的 seq 参数改 integer。
- 文档：README 补 405/204、`[err:CODE]` 语义与「升级」小节，去掉过时的 `profile: desktop` 示例。
- 自检 94 断言全过（核心 36 / 编码 8 / 踩坑 15 / 重放 11 / 桥接 14 / 回归 10）。

## 0.3.8

- 截断改用围栏状态机：识别 ``` 与 ~~~、缩进 ≤3、四反引号；截断处若有未闭合围栏则补一个同字符同长度的关闭围栏，不再删正文（避免标题前缀被误判后丢掉 8KB）。
- 失败结果补齐机器可读错误码：E_ARG / E_NOT_FOUND / E_AMBIGUOUS / E_DUPLICATE / E_GUARD / E_INTERNAL。
- persona 设置页：非 GET/POST 返回 405 + Allow；空 patch 返回 204 且不写盘；所有响应 Cache-Control: no-store。

## 0.3.7

- 截断感知代码围栏：`memory_read` 超长截断不再留下半个 ``` 围栏（奇数个围栏时回退到最后一个围栏起点）。
- 失败结果带机器可读后缀：`[err:E_ARG]` / `[err:E_NOT_FOUND]` / `[err:E_READ]` / `[err:E_GUARD]`，调用方可按 code 分支，不必匹配中文。
- persona 设置接口要求自定义请求头 `X-DSH-X-Memory: 1`（GET 也一样）：跨站页面无法伪造，且触发 CORS 预检，堵住未经允许的跨源读取。
- persona 响应加 `Cache-Control: no-store`，个人风格不落缓存。
- 自检新增 3 项：缺少请求头 403、围栏不被切半、失败结果带 err 后缀；共 86 断言。

## 0.3.6

- 修掉 4 处会在 emoji / 代理对上切半的裸 slice：memory_read 的 8000 字截断、踩坑指纹归一化、persona 读取旧超长文件、persona 写入校验。
- 截断统一走 `sliceSafe`，不再产生半个字符或 U+FFFD。
- 六套自检仍全绿（82 断言），preflight 通过。

## 0.3.5

- 快照补上图谱库：启动时用 VACUUM INTO 把 evolve.sqlite 复制进当天快照目录（7 天轮转），图谱不再零备份。
- persona 设置接口补 DNS rebinding 防护：只接受 localhost / 127.0.0.1 / ::1 的 Host，其余 403。
- markSuperseded 改为按行改写 front-matter，保留未知字段，不再整体重序列化。
- 写入查重扫描范围从 200 条放宽到 500 条。
- guard.js 头注释与实现对齐（按类替换默认值，FLOOR 私钥规则永远生效）。
- README 中英双语：工具数说明改为默认 12 个 / 开演化最多 19 个；新增设置页接口文档。
- 自检新增 3 项（Host 白名单、superseded 保留未知字段、snapshotGraph），总计 82 断言。

## 0.3.4

- 修复（数据安全）：`MEMORY.md` 读取失败不再被当成「文件不存在」——只有 ENOENT 才写模板，权限/占用类错误直接报错，避免常驻记忆被模板整体覆盖
- 修复（数据安全）：`memory_core` 只把「用户 / 环境 / 项目 / 偏好 / 背景 / 约定 / 决策 / 待办 / 其他」当分节；分节正文里的 `## 标题` 不再切出新节，写入时降级为 `###`，`replace/remove` 不再只改到前半段
- 修复（并发）：`MEMORY.md` 与 `CODING.md` 的读-改-写增加跨进程文件锁（`<file>.lock`），两个 DSH 实例并发编辑不再互相覆盖
- 修复（可用性）：图谱库 `new Store()` 失败时降级为纯文件记忆（MEMORY.md / notes / 编码规范 / 踩坑记录仍可用），不再让整个插件不加载
- 修复（安全）：自定义风格长度校验与当前预设无关，超长正文不再在非 custom 预设下绕过校验后被静默截断
- 修复（可移植）：`cordis.patch.yml` 去掉硬编码 `profile: desktop`，改由安装路径推断，避免所有 profile 共用同一个图谱库
- 修复（噪声）：退出码失败但报错正文只剩 `===` 之类的分隔符时不记踩坑
- 修复（文档）：README 中桥接单文件上限从 8MB 更正为 32MB
- 新增自检：分节结构不切坏、非法分节名拒绝（核心套件 23 项）

## 0.3.3

- 修复：cmd / 第三方 CLI 的 GBK 输出被宿主按 UTF-8 解码成乱码（U+FFFD）时，踩坑记录不再把乱码串写进系统提示——折叠成「（命令输出编码无法识别，退出码 N）」标注
- 改进：乱码失败的指纹改为 `工具:<garbled-output> exit N`，同类失败按退出码归并，不再因乱码无法合并
- 改进：`SHELL_TOOL` 增加 `mcp__localexec__run`、`mcp__windows-mcp__PowerShell`，MCP 执行器的非零退出码也能被识别为失败
- 新增自检：「乱码输出折叠成标注，指纹按退出码归并」（踩坑套件 14 项）

## 0.3.1

- 修复（安全）：三个注入节全部 `interpolate: false`，最近笔记的标题/tags 也过 `sanitize`——记忆里的 `{{...}}` 不再被当成模板变量展开
- 修复：快照在记忆目录为空时不再留下空目录（返回 error）；轮转改按目录 mtime 排序，`latestSnapshot` 同口径
- 修复：编码规范 `add` / `forget` 写回基底改为完整读取——超过 6000 字的规则文件不再被截断后覆盖（预算只约束注入与展示）
- 修复：索引写回原子化 + `index.json.lock`（`wx` 创建、10 秒过期回收、2 秒等待上限）；启动时按 id 对账（文件有索引无→补录，索引有文件无→标 `missing`，墓碑→移除）
- 修复：删除笔记先写墓碑再改索引——中途失败不会出现「索引没了、笔记还在」的复活
- 修复：踩坑层 `forget` / `clear` 与自动记录共用同一写队列，消除读改写竞态；临时文件名加随机后缀，失败清理
- 修复：笔记 id 加 6 位随机后缀，同一秒写入同名标题不再碰撞
- 修复：踩坑判定改为退出码正则取值、`EXIT_CODE 0` 视为成功；结构化信号优先，无信号时才看正文兜底
- 修复：无 front-matter 的 `PERSONA.md` 视为 `custom`（此前正文永远不注入）
- 修复：插件卸载/启动失败时还原 `DSH_SOUL_DATABASE`
- 修复：persona HTTP 路由校验同源 Origin 与 `application/json`，跨源/错类型直接拒绝
- 修复：快照清理按目录 mtime；`preflight` 对 `.env*`、超大文件、二进制、未知扩展名输出 `SKIPPED` 并计失败
- 修复：`sync-upstream --check` 额外报告 `src/` 下未登记文件；同步先写临时目录再替换
- 改进：记忆检索正文缓存校验 mtime/size；注入节文本按文件 mtime+size 缓存；JSON 解析统一走 `safeJson`
- 改进：billion-context 缓存键改毫秒 mtime + 32 条 LRU；踩坑会话表 LRU 上限 64，`list` 默认 50 类
- 改进：`/mem graph` 的 `nodeRow` 结果校验 `scope`，避免跨项目误命中
- 改进：`guard` 空数组回落默认规则（此前显式 `[]` 会关掉整类默认规则）；删除未使用的 `maskSecrets`
- 改进：编码预算过小时在注入节提示可调 `coding.budget`；`CORE_BUDGET`、模板与 README 统一为 3000 字
- 新增：自检脚本随包发布（`scripts/` 下核心 21、编码 8、踩坑 12、重放 11、桥接 14、回归 9，共 75 项断言），`npm test` 一键跑

## 0.3.0

- 新增：取代标记——`memory_write` 支持 `supersedes`，旧笔记保留但标「已被取代」，检索/列表/注入都可见
- 新增：写入守卫 `GUARD.json`——私钥块直接拒收，凭据形状标敏感（不进系统提示、检索时隐藏正文）
- 新增：每日快照，保留最近 7 份，`memory_brief` 可见
- 新增：billion-context 会话摘要只读桥接——`memory_search` 增加第三段，`memory_brief` 增加状态行
- 新增：发布前扫描 `scripts/preflight.mjs`（私钥/凭据/绝对家目录/高熵串，fail closed）
- 改名：`dsh-memory` → `dsh-x-memory`；新增 `src/memory/{util,guard,bili}.js`
- 修复：踩坑层误把退出码、正文里的 `[exit code]` 文字当失败
- 修复：中文近重复检测失效；短文本重复误判（改 Jaccard）
- 修复：自定义回复风格丢 `#` 标题、切预设后自定义正文丢失
- 修复：核心记忆 3000 字截断、6000 字才告警的不一致

## 0.2.0

- 新增：编码规范层——自动读取全局 `CODING.md` 与项目 `AGENTS.md` / `CLAUDE.md` / `.cursorrules` / `.github/copilot-instructions.md` / `.dsh/rules.md` / `.cursor/rules/*.mdc`
- 新增：踩坑记录层——同会话工具报错后恢复，自动记一条「错误 + 生效做法」
- 新增：上游同步脚本 `scripts/sync-upstream.mjs`、镜像清单与 `UPSTREAM.md`
- 改进：`memory_search` 改为归档 + 会话图谱两路；笔记正文加内存缓存，不再每次读盘
- 改进：路径 / 原子写 / 写队列 / 脱敏四处重复实现收进 `src/memory/util.js`

## 0.1.0

- 首个版本：以 dsh-soul 2.0.1 为底座，移植 dsh-core-memory 1.0.1 的核心记忆层，合并为单个插件
- 三层记忆：核心记忆（常驻）、归档笔记（按需）、会话图谱（可回捞）
