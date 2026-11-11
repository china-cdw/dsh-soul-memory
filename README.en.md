# dsh-x-memory

[简体中文](README.md) | English

> A layered memory plugin for DSH: keep what should always be remembered, what happened before, mistakes already made, and your coding rules in separate layers — injected on demand instead of dumped into the context window.

One plugin gives you: a resident core memory, searchable archived notes, a session knowledge graph, automatic mistake notes, project coding conventions, and the ability to recover old session details from billion-context summaries. Every layer has its own budget and its own switch, so they never crowd each other out.

- Requirements: Node.js ≥ 24, DSH ≥ 0.2.1-rc.2
- License: MIT
- Built on [dsh-soul](https://github.com/icyaaaww/dsh-soul) 2.0.1, with the core-memory layer ported from dsh-core-memory 1.0.1 (both MIT). See "Credits" below.

---

## What it solves

| Problem | How this plugin solves it |
| --- | --- |
| A new session starts from scratch and forgets your preferences | Core memory `MEMORY.md` is injected into every session |
| You remember the conclusion but not the constraints or decisions behind it | The session graph records constraints, decisions and artifacts; `soul_recall` fetches them on demand |
| The same mistake is made over and over | After a tool error, the error and the fix that worked are recorded automatically and surfaced next session |
| Coding conventions have to be restated every time | Global `CODING.md` and project rule files such as `AGENTS.md` are read automatically |
| Long sessions get compressed and the old details vanish | The read-only bridge searches billion-context's compressed session summaries |

## Why one plugin instead of three

When three memory plugins each own a slice, the model has to decide "which one should this go into", and separate plugins duplicate injections and compete for budget. Merged into one:

- **One write routes by content**: long-lived facts to core memory, experiences to archived notes, process to the session graph, failures to mistake notes, rules to coding conventions;
- **One search covers three sources**: `memory_search` queries archived notes, the graph and billion-context summaries together, and returns ids and source labels for drilling down;
- **One set of switches and injections**: all layers share the same data directory, redaction and guard rules.

## The five layers

| Layer | What it stores | Location | Injection | Budget | Tools |
| --- | --- | --- | --- | --- | --- |
| Core memory | Long-lived facts, preferences, environment | `$DSH_HOME/memory/MEMORY.md` | Every turn, `order 60` | 3000 chars | `memory_core` |
| Archived notes | Experiences and conclusions looked up later | `$DSH_HOME/memory/notes/*.md` | Only the 12 most recent titles | — | `memory_write` / `memory_read` / `memory_list` / `memory_search` / `memory_delete` |
| Session graph | Constraints, decisions, artifacts, raw history | `$DSH_HOME/dsh-soul/<profile>/evolve.sqlite` | 600-byte projection, `order 940` | 600 bytes | `soul_recall` / `soul_expand` |
| Mistake notes | Tool error → how it was fixed | `$DSH_HOME/memory/LESSONS.jsonl` | Every turn, `order 62` | 600 chars | `lessons` |
| Coding conventions | Global rules + project rule files | `$DSH_HOME/memory/CODING.md` + project dir | Every turn, `order 61` | 2000 chars | `coding_rules` |

### Which coding-rule files are read

In the current session's working directory, in this order:

```
CODING.md
AGENTS.md
CLAUDE.md
.cursorrules
.github/copilot-instructions.md
.dsh/rules.md
.cursor/rules/*.mdc, *.md
```

The global `CODING.md` takes priority; project files are appended in the order above. Anything beyond the 2000-character budget is truncated and marked as such.

---

## Four mechanisms added in this version

### 1. Supersede markers

When a memory is corrected, don't silently stack a second entry:

```text
memory_write(title: "Deployment", content: "Now deployed with Docker Compose", supersedes: "20261110-153000")
```

The old note stays on disk but is marked "superseded by [new id]" and shown that way in search, listing and injection. Use `memory_delete` if you want it gone.

### 2. Write guard (GUARD.json)

`$DSH_HOME/memory/GUARD.json` defines your own rules:

- `reject`: private-key blocks and common token shapes (`sk-`, `ghp_`, `AKIA`, `glpat-`, …) — rejected, never written to disk;
- `sensitive`: values that look like passwords or credential assignments — accepted but flagged `sensitive: true`; the title is not listed in the system prompt and the body is hidden in search results (read explicitly with `memory_read` when needed);
- the private-key rule is a hard floor baked into code — `GUARD.json` cannot disable it.

Core memory (injected into every session) rejects both categories outright.

### 3. Daily snapshots

On the first load each day the whole memory directory is copied to `$DSH_HOME/memory/.snapshots/<timestamp>/`, keeping the last 7. Rotation orders snapshots by directory mtime, not by name, and an empty memory directory never leaves an empty snapshot behind. If something gets corrupted, copy a snapshot back; `memory_brief` shows "snapshot: N".

### 4. billion-context bridge (read-only)

If [billion-context](https://github.com/ranxianglei/billion-context) is installed, `memory_search` appends a "historical session summaries" section after archived notes and the session graph, keyword-searching the compressed session blocks it wrote to disk.

- Reads its `sessions/*.json` only; never modifies or recompresses anything;
- Corrupt files, files over 32MB and missing directories are skipped silently — the main search is never affected;
- Reads at most the 4 most recent sessions × 5 blocks by default; `maxChars` limits the output length;
- Turn it off with `bridge.enabled = false`.

---

## Quick start

```bash
# 1. Clone
git clone https://github.com/china-cdw/dsh-x-memory
cd dsh-x-memory

# 2. Install into a DSH profile
dsh plugin --profile desktop add "$PWD"
```

Restart DSH (or toggle the bundle off and on to hot-reload). The system prompt should then contain:

```
# 跨会话记忆（dsh-x-memory）
# 编码规范（dsh-x-memory）
# 踩过的坑（dsh-x-memory 自动记录）   ← only when there are notes
```

To verify, call `memory_brief`: it reports core-memory size, archived note count, persona, snapshots, graph size and billion-context status. To write your first memory immediately, use `memory_core` with `append`.

> If you only changed plugin source and don't want to reinstall: toggling the bundle (`plugin_manager set_bundle enabled=false` → `enabled=true`) reloads the module from disk without restarting the whole app.

---

## Tools

| Tool | Purpose | Main arguments |
| --- | --- | --- |
| `memory_write` | Write an archived note | `title`, `content`, `tags?`, `force?`, `supersedes?` |
| `memory_read` | Read a note by id | `id` (unique prefix accepted) |
| `memory_list` | List notes (optionally by tag) | `limit?`, `tag?` |
| `memory_search` | Three-way search: notes + graph + billion-context | `query` |
| `memory_delete` | Delete (tombstoned, never resurrected) | `id` |
| `memory_core` | Edit a core-memory section | `action` (append/replace/remove), `section`, `text?` |
| `memory_brief` | Memory health report | — |
| `persona` | Reply style | `action` (get/set/custom/disable), `preset?`, `text?` |
| `coding_rules` | Coding conventions | `action` (show/list/add/forget), `text?` |
| `lessons` | Mistake notes | `action` (list/forget/clear), `text?` |
| `soul_recall` | Recall from the session graph / raw history | `query`, `k?` |
| `soul_expand` | Expand raw text by seq range | `from`, `to` |

Write rules: `memory_write` runs a near-duplicate check (similarity ≥ 0.55 is rejected; pass `force: true` to write anyway).

Mistake notes are captured automatically: within one session, if a tool errors and the same tool later succeeds, a note "error + fix that worked" is recorded, and repeats of the same error are merged into a count. Structured signals come first: `isError` and exit codes (parsed from the result line; exit code 0 counts as success, and benign 1 from tools like `grep` is ignored). Only when no structured signal exists is the response text checked as a fallback. File-reader tools and the memory/coding tools themselves are never captured.

---

## Configuration

Defaults in `cordis.patch.yml`:

```yaml
config:
  enabled: false            # upstream "evolution" feature, off by default
  profile: desktop
  memory:
    enabled: true           # core memory + archived notes + graph
    projectionBytes: 600    # graph projection per turn, in bytes
    maintenance: true       # dedupe and edge decay every 20 turns
  coding:
    enabled: true
    budget: 2000            # coding-convention injection budget (400–8000)
  lessons:
    enabled: true
    budget: 600             # mistake-note injection budget (200–4000)
  bridge:
    enabled: true
    sessionsDir: ''         # empty = auto-detect billion-context default dir
    maxSessions: 4
    maxChars: 1200          # bridge section output limit (200–4000)
```

When `bridge.sessionsDir` is empty, it looks at `BILI_SESSIONS_DIR` first, then `%USERPROFILE%\.local\share\billion-context\sessions` (`~/.local/share/billion-context/sessions` on Linux/macOS).

---

## Data directory

```
$DSH_HOME/memory/
├── MEMORY.md            # core memory (injected every turn, 3000 chars max)
├── PERSONA.md           # reply style
├── CODING.md            # global coding conventions
├── GUARD.json           # optional, custom guard rules
├── LESSONS.jsonl        # mistake notes (max 400)
├── index.json           # note index (atomic writes + file lock); rebuilt from notes/ if corrupt, reconciled by id at startup (missing entries added, lost files marked missing)
├── notes/               # archived notes, one .md per note
└── .snapshots/          # daily snapshots, last 7 kept
```

The graph database lives at `$DSH_HOME/dsh-soul/<profile>/evolve.sqlite` (reusing dsh-soul's location; existing data from dsh-soul keeps working).

---

## Security

- Private-key blocks and common token shapes: rejected at write time;
- Credential-like assignments: saved but flagged sensitive — never injected into the system prompt, body hidden in search results;
- Mistake notes are redacted before writing; lines containing `password` / `token` / `secret` / `bearer` are dropped;
- Pre-publish scan:

```bash
npm run preflight
```

Scans for private keys, credential shapes, absolute home paths and high-entropy blobs. Any hit fails the run and prints only `relative/path:line  CLASS` — never the matched text. Files that cannot be scanned (`.env*`, oversized files, binaries, unknown extensions) are not skipped silently: they produce a `SKIPPED` line and also fail the run until you add them to the ignore list.

For confirmed false positives, create `.preflight-ignore.json` in the repository root:

```json
["docs/example.md:12", "README.md:96 ABS_WIN"]
```

Three granularities are supported: `relative/path`, `relative/path:line`, `relative/path:line CLASS`.

---

## Relationship with billion-context

They are not the same kind of tool and don't compete:

- **billion-context** handles "one session doesn't fit" — it compresses consumed conversation and lets the model decompress when needed;
- **dsh-x-memory** handles "you can't remember across sessions" — it keeps what should survive in the system prompt and on local disk.

The bridge does exactly one thing: it folds billion-context's compressed session summaries **read-only** into `memory_search`. It keeps managing compression; the memory layer never writes to it or depends on its internal format (unknown formats are skipped).

Running both does not hurt prefix caching: memory travels in the system prompt, compression only touches message history.

---

## Upstream and syncing

This plugin is a fork of dsh-soul 2.0.1; most files under `src/` are byte-identical mirrors of upstream. Which files are ours, the wiring points that must be replayed in `index.js`, and the sync procedure are all documented in [UPSTREAM.md](./UPSTREAM.md).

```bash
node scripts/sync-upstream.mjs --check                  # verify mirrors are unmodified
node scripts/sync-upstream.mjs --from <dsh-soul dir>    # sync a new upstream version
```

The `dshMemory` field in `package.json` records the upstream version and ported source; `upstream-manifest.json` stores a sha256 for every mirrored file.

---

## Limitations

- Search is keyword + CJK-bigram matching, not semantic search; cross-session semantic recall currently relies on the graph and billion-context summaries;
- The billion-context bridge only covers blocks that were actually compressed (default: the 4 most recent sessions × 5 blocks), and those summaries are second-hand;
- Coding rules are discovered from the session's working directory only — `AGENTS.md` files in subdirectories are not merged upward;
- Upstream's "evolution" (self-modifying harness) is off by default, and this plugin does not recommend enabling it.

---

## Development and self-checks

```bash
node --check index.js
node scripts/sync-upstream.mjs --check
npm run preflight
```

```bash
npm test          # every self-check script; any failure exits non-zero
```

The checks ship in `scripts/`: 21 core assertions, 8 coding, 12 mistake notes, 11 event-replay, 14 billion-context bridge and 9 regression assertions — 75 in total — covering edge cases in writes, search, supersede, guard, snapshots, index locking, concurrency, cache invalidation and the bridge. Run one alone with `node scripts/dsh-memory-audit.mjs`.

---

## Credits and license

MIT License.

- Base: [icyaaaww/dsh-soul](https://github.com/icyaaaww/dsh-soul) 2.0.1 (MIT) — session graph, projection, compaction backend;
- Core-memory layer ported from dsh-core-memory 1.0.1 (MIT) — `MEMORY.md`, archived notes, persona;
- Design inspiration from two open-source projects (no code copied):
  - [NattoCB/dsh-plugin-memory](https://github.com/NattoCB/dsh-plugin-memory): layering, index/detail separation, truncation budgets;
  - [dearbld/dsh-living-memory](https://github.com/dearbld/dsh-living-memory): conflict supersede markers, data-driven guard rules, pre-publish scanning, snapshot rotation;
- billion-context is a separate MIT plugin; this plugin only reads its session archive and contains none of its code.
