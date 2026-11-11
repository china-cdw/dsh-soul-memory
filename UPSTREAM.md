# 上游与同步

dsh-x-memory 是 **dsh-soul 2.0.1** 的 fork，并移植了 **dsh-core-memory 1.0.1**（MIT）的核心记忆层。
升级上游时不要整目录覆盖：`src/` 里大部分文件是上游逐字节镜像，但有几个文件是我们自己写的。

## 哪些是我们的

| 路径 | 说明 |
| --- | --- |
| `src/memory/util.js` | 四层共用的路径 / 原子写 / 写队列 / 敏感信息过滤 |
| `src/core-memory.js` | 移植自 dsh-core-memory，另加 3 处增强（查重、时间衰减、体检） |
| `src/persona.js` | 移植自 dsh-core-memory，自定义正文持久化修复 |
| `src/coding.js` | 新增：编码规范固定记忆层（全局 CODING.md + 项目规则文件） |
| `src/lessons.js` | 新增：踩坑自动记录层（工具报错→恢复配对） |
| `src/memory/guard.js` | 新增：写入守卫（私钥拒收、凭据标记敏感） |
| `src/memory/bili.js` | 新增：billion-context 会话摘要只读桥接 |
| `index.js` | 上游文件 + 4 处接线（见下） |
| `cordis.patch.yml` | 上游文件 + `coding` / `lessons` / `bridge` 三段配置 |

其余 `src/*.js`、`compaction.js`、`harness/`、`locale/` 都是上游镜像，升级时随上游走。

## index.js 需要重放的接线点

上游改了 `index.js` 时，把下面几处按新文件重新加回去（都在 `apply()` 里）：

1. `import { registerCoreMemory } from './src/core-memory.js'` —— 文件头 import 区。
2. `settings()` 里在 `budget: budgetSettings(input),` 之后加：
   `coding: { enabled: boolean(input.coding?.enabled, true, 'coding.enabled'), budget: integer(input.coding?.budget, 2000, 400, 8000, 'coding.budget') }`，
   `lessons: { enabled: boolean(input.lessons?.enabled, true, 'lessons.enabled'), budget: integer(input.lessons?.budget, 600, 200, 4000, 'lessons.budget') }`，
   `bridge: { enabled: boolean(input.bridge?.enabled, true, 'bridge.enabled'), sessionsDir: ..., maxSessions: ..., maxChars: ... }`。
3. 创建 Store 之后：`process.env.DSH_SOUL_DATABASE = config.database`。
4. 在合适位置调用：
   `registerCoreMemory(ctx, { graphSearch, graphStats, coding: config.coding, lessons: config.lessons, bridge: config.bridge })`，
   其中 `graphSearch(scope, query)` 用 `recall(store, scope, query, { limit: 6 }).hits`，
   `graphStats(scope)` 用 `memoryStats(store, scope)` 的 byKind 求和 + `graphStats(store, scope).edges`。

## 同步步骤

```bash
# 1. 先看镜像有没有被本地误改（正常应为「未被本地修改」）
node scripts/sync-upstream.mjs --check

# 2. 拿到新版 dsh-soul 源码目录后同步（会覆盖镜像、删掉上游已删的镜像、更新清单）
node scripts/sync-upstream.mjs --from /path/to/dsh-soul

# 3. 按上面「接线点」重放 index.js（脚本不会自动合并）
# 4. 语法与回归
node --check index.js
node dsh-memory-audit.mjs && node dsh-memory-coding-audit.mjs && node dsh-memory-lessons-audit.mjs && node lessons-replay-test.mjs && node dsh-memory-bridge-audit.mjs

# 5. 更新 package.json 的 dshMemory.upstream.version，安装副本重新同步
```

镜像文件的 sha256 记录在 `upstream-manifest.json`；`--check` 会报「本地被改过」或「缺失」。
确实需要改某个镜像文件时，别直接改：把它变成我们自己的文件（移进 `src/memory/` 或新文件），
再把路径加进 `scripts/sync-upstream.mjs` 的 `OUR_FILES`。
