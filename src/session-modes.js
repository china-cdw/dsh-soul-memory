import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, createQueue, memoryPath, withFileLock } from './memory/util.js';

/**
 * 会话级记忆模式，三个档位：
 * - normal   读写都照旧（默认）
 * - readonly 不写新记忆，仍然能读到旧记忆
 * - off      不写，也不再自动注入旧记忆
 *
 * 存在 <memory>/SESSION-MODES.json，只保留最近 N 个会话；换新会话自动回到 normal。
 */
export const SESSION_MODES = ['normal', 'readonly', 'off'];
export const MODE_LABELS = {
  normal: '正常',
  readonly: '只读',
  off: '关闭',
};
const MAX_SESSIONS = 200;
const queue = createQueue();

function file() {
  return join(memoryPath(), 'SESSION-MODES.json');
}

function readAll() {
  try {
    const raw = readFileSync(file(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function modeOf(sessionId) {
  if (!sessionId) return 'normal';
  const all = readAll();
  const entry = all[String(sessionId)];
  const mode = entry && typeof entry === 'object' ? entry.mode : entry;
  return SESSION_MODES.includes(mode) ? mode : 'normal';
}

export function listModes() {
  const all = readAll();
  const out = [];
  for (const [id, entry] of Object.entries(all)) {
    const mode = entry && typeof entry === 'object' ? entry.mode : entry;
    if (!SESSION_MODES.includes(mode) || mode === 'normal') continue;
    out.push({ session: id, mode, at: entry && entry.at ? entry.at : null });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function setMode(sessionId, mode) {
  if (!sessionId) throw new Error('缺少会话 id');
  if (!SESSION_MODES.includes(mode)) throw new Error('mode 只能是 normal / readonly / off');
  return queue(() => withFileLock(file() + '.lock', async () => {
    const all = readAll();
    const at = new Date().toISOString();
    if (mode === 'normal') delete all[String(sessionId)];
    else all[String(sessionId)] = { mode, at };
    // 只留最近的 MAX_SESSIONS 条，避免文件无界增长。
    const entries = Object.entries(all).filter(([, v]) => v && typeof v === 'object' && v.at);
    if (entries.length > MAX_SESSIONS) {
      entries.sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)));
      for (const [id] of entries.slice(0, entries.length - MAX_SESSIONS)) delete all[id];
    }
    if (!existsSync(memoryPath())) throw new Error('记忆目录不存在');
    await atomicWrite(file(), JSON.stringify(all, null, 2) + '\n');
    return { session: String(sessionId), mode };
  }));
}
