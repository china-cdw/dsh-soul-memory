// dsh-soul-memory — 灵魂记忆界面设置
//
// 只存「界面偏好」这一小类：待批提醒的形态、对用户的称呼。
// 风格（persona）仍是独立文件 PERSONA.md，走自己的路由与校验，不在这里重复。
//
// 文件：<dshHome>/memory/SOUL-UI.json
// 设计：读失败按默认值返回（界面不能因为一个坏文件打不开）；
//       写失败必须抛出（设置页要能告诉用户"没存进去"，而不是静默 200）。
import { readFileSync } from 'node:fs';
import { atomicWrite, createQueue, memoryPath, safeJson, withFileLock } from './memory/util.js';

/**
 * 待批提醒形态。inline 是默认：不占空间，出现在对话里。
 * off 表示完全不弹，只在设置页里把待批攒着——开会或被看屏时用。
 */
export const DISPLAY_MODES = ['inline', 'sidebar', 'overlay', 'off'];

export const UI_DEFAULTS = Object.freeze({
  displayMode: 'inline',
  nickname: '',
  // 0 = 不静默；否则是静默到期的毫秒时间戳。静默期间待批照常累积，只是不弹。
  mutedUntil: 0,
  // 暂停写入记忆（所有会话）。聊私事时用；不影响读取与工具调用。
  memoryPaused: false,
  // 编码规范注入预算（字）。0 = 跟随宿主配置（cordis.patch.yml 的 coding.budget）。
  rulesBudget: 0,
});

/** 规则预算可填范围：与宿主配置一致，避免页面写进一个必然被钳回的值。 */
export const MIN_RULES_BUDGET = 400;
export const MAX_RULES_BUDGET = 8000;

/** 静默最多 30 天，防止一次手滑写进一个离谱的时间戳。 */
const MAX_MUTE_MS = 30 * 24 * 60 * 60 * 1000;

/** 称呼上限：够用，又不会把系统提示撑开。 */
export const MAX_NICKNAME = 40;

export const uiSettingsPath = () => memoryPath('SOUL-UI.json');

// 与 persona 写盘共用同一把逻辑锁（同一进程内串行），避免两次保存交错。
const queue = createQueue();

export function normalizeUiSettings(input) {
  const out = { ...UI_DEFAULTS };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  if (DISPLAY_MODES.includes(input.displayMode)) out.displayMode = input.displayMode;
  if (typeof input.nickname === 'string') out.nickname = input.nickname.trim().slice(0, MAX_NICKNAME);
  const muted = Number(input.mutedUntil);
  if (Number.isFinite(muted) && muted > 0) {
    const now = Date.now();
    // 过期值归零：静默到期后界面不该还显示「静默中」。
    out.mutedUntil = muted <= now ? 0 : Math.min(muted, now + MAX_MUTE_MS);
  }
  if (typeof input.memoryPaused === 'boolean') out.memoryPaused = input.memoryPaused;
  const rulesBudget = Number(input.rulesBudget);
  if (Number.isFinite(rulesBudget) && rulesBudget >= MIN_RULES_BUDGET) {
    out.rulesBudget = Math.min(MAX_RULES_BUDGET, Math.round(rulesBudget));
  } else if (rulesBudget === 0) {
    // 0 显式表示「回到宿主配置」。
    out.rulesBudget = 0;
  }
  return out;
}

/** 读界面设置。文件缺失/损坏都回默认值；不会抛。 */
export function readUiSettings() {
  let raw;
  try {
    raw = readFileSync(uiSettingsPath(), 'utf8');
  } catch {
    return { ...UI_DEFAULTS };
  }
  return normalizeUiSettings(safeJson(raw, null));
}

/**
 * 校验一次局部更新。
 * 拼错的字段名不能静默成功——那会让调用方以为生效了。
 * @returns {{ ok: true, patch: object } | { ok: false, error: string }}
 */
export function validateUiPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  const patch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'displayMode') {
      if (typeof value !== 'string' || !DISPLAY_MODES.includes(value)) {
        return { ok: false, error: 'displayMode 只能是 ' + DISPLAY_MODES.join(' / ') };
      }
      patch.displayMode = value;
    } else if (key === 'nickname') {
      if (typeof value !== 'string') return { ok: false, error: 'nickname 必须是字符串' };
      if (value.trim().length > MAX_NICKNAME) {
        return { ok: false, error: '称呼最多 ' + MAX_NICKNAME + ' 个字符' };
      }
      patch.nickname = value.trim();
    } else if (key === 'mutedUntil') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return { ok: false, error: 'mutedUntil 必须是非负时间戳（0 表示取消静默）' };
      }
      patch.mutedUntil = value;
    } else if (key === 'memoryPaused') {
      if (typeof value !== 'boolean') return { ok: false, error: 'memoryPaused 必须是布尔值' };
      patch.memoryPaused = value;
    } else if (key === 'rulesBudget') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: 'rulesBudget 必须是数字（0 表示跟随宿主配置）' };
      }
      if (value !== 0 && (value < MIN_RULES_BUDGET || value > MAX_RULES_BUDGET)) {
        return { ok: false, error: `rulesBudget 只能是 0 或 ${MIN_RULES_BUDGET}–${MAX_RULES_BUDGET} 之间的整数` };
      }
      patch.rulesBudget = value === 0 ? 0 : Math.round(value);
    } else {
      return { ok: false, error: '不支持的字段：' + key };
    }
  }
  return { ok: true, patch };
}

/**
 * 合并写回。空 patch 不写盘（调用方会返回 204）。
 * @returns {Promise<object>} 写完后的完整设置
 */
export async function writeUiSettings(patch) {
  return queue(() => withFileLock(uiSettingsPath(), async () => {
    const current = readUiSettings();
    const next = normalizeUiSettings({ ...current, ...patch });
    await atomicWrite(uiSettingsPath(), JSON.stringify(next, null, 2) + '\n');
    return next;
  }));
}
