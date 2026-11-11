# 变更日志

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
