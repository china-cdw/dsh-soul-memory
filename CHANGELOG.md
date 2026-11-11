# 变更日志

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
