// dsh-soul-memory — 写入守卫
//
// 规则分两层：
//   reject    —— 直接拒收（私钥块、常见凭据前缀），永不落盘。
//   sensitive —— 疑似凭据赋值，允许落盘但不进系统提示、检索结果里隐藏正文。
//
// 机器级规则可以放在 <DSH_HOME>/memory/GUARD.json（{"reject": [...], "sensitive": [...]}），
// 按类替换默认值：只写 reject 时 sensitive 仍用内置默认，反之同理；两类都空则整份回落默认。
// 代码里保留一条私钥块兜底规则，数据文件关不掉它（living-memory 的做法）。
//
// 「这类规则到底给没给」按编译后的结果算，不看原始数组：
// 早先只要数组里有非空字符串就算给了，于是一条写错的正则（比如带 PCRE 内联标志）
// 编译失败后留下空数组，整类 token 规则静默失效——文件看着有规则，实际全放行。
import { readFileSync, statSync } from 'node:fs';
import { memoryPath, safeJson } from './util.js';
import { PRIVATE_KEY_SOURCE } from './secrets.js';

const FLOOR = [PRIVATE_KEY_SOURCE];

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
    '(?:密码|口令|验证码|密钥|身份证|银行卡|手机号|住址)\\s*(?:是|为|[:：=])\\s*\\S{4,}',
  ],
};

export function guardRulesPath() {
  return memoryPath('GUARD.json');
}

/** 编译一类规则；同时记下被跳过的原始规则，方便点名告警。 */
function compile(list) {
  const out = [];
  const skipped = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string' || !item) continue;
    try { out.push(new RegExp(item, 'i')); } catch { skipped.push(item); }
  }
  return { out, skipped };
}

let cache = { key: '', rules: null, source: '' };

function warnSkipped(label, compiled) {
  if (!compiled.skipped.length) return;
  console.warn(
    'dsh-soul-memory: GUARD.json 有 ' + compiled.skipped.length + ' 条 ' + label +
    ' 规则正则非法，已跳过：' + compiled.skipped.slice(0, 3).map(s => JSON.stringify(s)).join('、')
  );
}

function readRulesFile() {
  const path = guardRulesPath();
  let key = '';
  try { key = String(statSync(path).mtimeMs); } catch { return null; }
  if (cache.key === key && cache.rules) return cache.rules;
  const parsed = safeJson(readFileSync(path, 'utf8'), null);
  if (!parsed || typeof parsed !== 'object') return null;
  const reject = compile(parsed.reject);
  const sensitive = compile(parsed.sensitive);
  warnSkipped('reject', reject);
  warnSkipped('sensitive', sensitive);
  // 原始数组非空、但一条都编译不出来：等于这一类被写坏了。必须点名，
  // 否则表现和「用户主动清空」一模一样，没人会发现审计规则已经不在生效。
  if (Array.isArray(parsed.reject) && parsed.reject.length > 0 && reject.out.length === 0) {
    console.warn('dsh-soul-memory: GUARD.json 的 reject 规则全部无法编译，已回落到内置默认规则（token 仍会被拒收）。');
  }
  if (Array.isArray(parsed.sensitive) && parsed.sensitive.length > 0 && sensitive.out.length === 0) {
    console.warn('dsh-soul-memory: GUARD.json 的 sensitive 规则全部无法编译，已回落到内置默认规则。');
  }
  // 先记「数据文件自己给了几条可用规则」，再把兜底私钥规则并进去。
  // 顺序不能反：兜底规则永远存在，先并就会让「全是坏正则」也看着像给了规则，
  // 于是 token 规则被跳过 —— 文件里有规则，实际全放行。
  const ownReject = reject.out.length > 0;
  const ownSensitive = sensitive.out.length > 0;
  // 兜底：私钥块永远拦，数据文件不能把它关掉。
  reject.out.push(...compile(FLOOR).out);
  const rules = {
    reject: reject.out,
    sensitive: sensitive.out,
    // 记住数据文件里每一类是否真的给了（可编译的）规则：空数组或全是坏正则都应回落默认值。
    hasReject: ownReject,
    hasSensitive: ownSensitive,
    source: path,
  };
  cache = { key, rules, source: path };
  return rules;
}

export function loadGuardRules() {
  const custom = readRulesFile();
  if (!custom) {
    return { reject: compile(DEFAULTS.reject).out, sensitive: compile(DEFAULTS.sensitive).out, source: 'builtin' };
  }
  // 逐类判定：GUARD.json 只写了 reject 时，sensitive 仍用内置默认，反之同理。
  // 两类都没给（或都给坏）时整份回落默认值。
  const reject = custom.hasReject ? custom.reject : compile(DEFAULTS.reject).out;
  const sensitive = custom.hasSensitive ? custom.sensitive : compile(DEFAULTS.sensitive).out;
  if (!custom.hasReject && !custom.hasSensitive) {
    return { reject: compile(DEFAULTS.reject).out, sensitive: compile(DEFAULTS.sensitive).out, source: 'builtin' };
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
