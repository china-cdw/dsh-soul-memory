// dsh-x-memory — 写入守卫
//
// 规则分两层：
//   reject    —— 直接拒收（私钥块、常见凭据前缀），永不落盘。
//   sensitive —— 疑似凭据赋值，允许落盘但不进系统提示、检索结果里隐藏正文。
//
// 机器级规则可以放在 <DSH_HOME>/memory/GUARD.json（{"reject": [...], "sensitive": [...]}），
// 按类替换默认值：只写 reject 时 sensitive 仍用内置默认，反之同理；两类都空则整份回落默认。
// 代码里保留一条私钥块兜底规则，数据文件关不掉它（living-memory 的做法）。
// 正则非法、文件坏掉都静默退回默认值，守卫本身不能把记忆写崩。

import { readFileSync, statSync } from 'node:fs';
import { memoryPath, safeJson } from './util.js';

const FLOOR = ['-----BEGIN [A-Z ]*PRIVATE KEY-----'];

const DEFAULTS = {
  reject: [
    ...FLOOR,
    '\\bsk-[A-Za-z0-9_-]{20,}\\b',
    '\\bghp_[A-Za-z0-9]{20,}\\b',
    '\\bgithub_pat_[A-Za-z0-9_]{20,}\\b',
    '\\bAKIA[0-9A-Z]{16}\\b',
    '\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b',
    '\\bglpat-[A-Za-z0-9_-]{20,}\\b',
  ],
  sensitive: [
    '(?:password|passwd|secret|token|api[-_ ]?key|access[-_ ]?key)\\s*[:=]\\s*\\S{6,}',
    'bearer\\s+[A-Za-z0-9._-]{20,}',
    'authorization\\s*:\\s*\\S{8,}',
  ],
};

export function guardRulesPath() {
  return memoryPath('GUARD.json');
}

function compile(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string' || !item) continue;
    try { out.push(new RegExp(item, 'i')); } catch { /* 单条坏正则只跳过这一条 */ }
  }
  return out;
}

let cache = { key: '', rules: null, source: '' };

function readRulesFile() {
  const path = guardRulesPath();
  let key = '';
  try { key = String(statSync(path).mtimeMs); } catch { return null; }
  if (cache.key === key && cache.rules) return cache.rules;
  const parsed = safeJson(readFileSync(path, 'utf8'), null);
  if (!parsed || typeof parsed !== 'object') return null;
  const rules = {
    reject: compile(parsed.reject),
    sensitive: compile(parsed.sensitive),
    // 记住数据文件里每一类是否真的给了规则：空数组（或写字时误留的 []）应回落默认值，
    // 而不是变成「用户把这一类清空了」。
    hasReject: Array.isArray(parsed.reject) && parsed.reject.some((x) => typeof x === 'string' && x),
    hasSensitive: Array.isArray(parsed.sensitive) && parsed.sensitive.some((x) => typeof x === 'string' && x),
    source: path,
  };
  // 兜底：私钥块永远拦，数据文件不能把它关掉。
  rules.reject.push(...compile(FLOOR));
  cache = { key, rules, source: path };
  return rules;
}

export function loadGuardRules() {
  const custom = readRulesFile();
  if (!custom) {
    return { reject: compile(DEFAULTS.reject), sensitive: compile(DEFAULTS.sensitive), source: 'builtin' };
  }
  // 逐类判定：GUARD.json 只写了 reject 时，sensitive 仍用内置默认，反之同理。
  // 两类都为空/非法时整份回落默认值。
  const reject = custom.hasReject ? custom.reject : compile(DEFAULTS.reject);
  const sensitive = custom.hasSensitive ? custom.sensitive : compile(DEFAULTS.sensitive);
  if (!custom.hasReject && !custom.hasSensitive) {
    return { reject: compile(DEFAULTS.reject), sensitive: compile(DEFAULTS.sensitive), source: 'builtin' };
  }
  return { reject, sensitive, source: custom.source };
}

/** 命中返回 { kind: 'reject'|'sensitive', rule }，未命中返回 { kind: null }。 */
export function checkGuard(text) {
  const s = String(text ?? '');
  if (!s) return { kind: null };
  const rules = loadGuardRules();
  for (const re of rules.reject) if (re.test(s)) return { kind: 'reject', rule: String(re) };
  for (const re of rules.sensitive) if (re.test(s)) return { kind: 'sensitive', rule: String(re) };
  return { kind: null };
}

export function isSensitive(text) {
  return checkGuard(text).kind === 'sensitive';
}

/** 供测试清缓存。 */
export function _resetGuardCache() {
  cache = { key: '', rules: null, source: '' };
}
