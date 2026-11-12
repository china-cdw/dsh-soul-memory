# 变更日志

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
