// dsh-soul-memory — 浏览器写接口的共用守卫
//
// 为什么单独一个模块：同一套「回环 Host + 同源 Origin + 自定义头 + 写令牌」
// 原先在 ui-routes.js 和 core-memory.js 的 persona 路由里各写了一份，然后漂移了——
// persona 那份漏掉了令牌校验。两份实现迟早会再次分叉，所以只留这一份。
//
// 注意依赖方向：ui-routes.js 已经 import core-memory.js 的 runDreaming，
// 所以 core-memory.js 不能反过来 import ui-routes.js。这里不引用任何业务模块，
// 两边都可以 import，不会形成循环依赖。
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { memoryPath } from './util.js';

export const GUARD_HEADER = 'x-dsh-soul-memory';
export const TOKEN_HEADER = 'x-dsh-soul-memory-token';

/**
 * 写操作令牌：写接口要求带上它。
 * GET /state 会返回它，所以它挡不住「先读再写」的本机脚本，只挡不知道要两步的顺手调用；
 * 真正的边界仍是回环 Host + 同源 Origin + 自定义头这三道。
 *
 * It is persisted rather than generated per module load: a hot reload used to mint a new
 * token while the open page still held the old one, and every write the user then made was
 * rejected with 403 until a manual refresh. Reading it back from the memory dir keeps the
 * page working across reloads.
 */
export function loadWriteToken() {
  const dir = memoryPath();
  const file = join(dir, '.ui-token');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(existing)) {
      // 老版本用默认权限写过这个文件（常见 0666）：读到就顺手收紧。
      try { chmodSync(file, 0o600); } catch { /* Windows/NTFS 上 mode 语义有限，忽略 */ }
      return existing;
    }
  } catch { /* first run: mint one below */ }
  const token = randomBytes(16).toString('hex');
  try {
    mkdirSync(dir, { recursive: true });
    // 0600：只有当前用户可读写。多用户机器上别的账号不该能拿这个令牌去改 CODING.md。
    writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* 见上 */ }
  } catch { /* read-only home: the in-memory token still works for this process */ }
  return token;
}

export const WRITE_TOKEN = loadWriteToken();

export function sendJson(res, code, payload) {
  try {
    const body = JSON.stringify(payload);
    res.statusCode = code;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    // 记忆与设置都是个人数据，禁止任何缓存。
    res.setHeader('cache-control', 'no-store');
    res.end(body);
  } catch {
    /* 响应已发出时忽略 */
  }
}

/** 只允许本机回环 Host：DNS rebinding 下 Origin 与 Host 都是攻击者域名，必须单独挡。 */
export function isLoopbackHost(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) return true;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(name);
}

/**
 * 统一入口守卫。通过返回 true；否则已写响应并返回 false。
 * 方法 → 回环 Host → 同源 Origin → 自定义头 →（POST）JSON Content-Type，顺序固定。
 * @param {boolean} needsJson POST 时要求 application/json。
 */
export function guard(req, res, needsJson) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, { error: '仅支持 GET / POST' });
    return false;
  }
  if (!isLoopbackHost(req)) {
    sendJson(res, 403, { error: '仅允许本机页面访问' });
    return false;
  }
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      sendJson(res, 403, { error: '跨源请求被拒绝' });
      return false;
    }
  }
  // 跨站表单/链接无法带自定义头，且会触发 CORS 预检。
  if (String(req.headers[GUARD_HEADER] || '') !== '1') {
    sendJson(res, 403, { error: '缺少 ' + GUARD_HEADER + ': 1 请求头' });
    return false;
  }
  if (needsJson) {
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.startsWith('application/json')) {
      sendJson(res, 415, { error: 'Content-Type 必须是 application/json' });
      return false;
    }
  }
  return true;
}

/** 写接口额外要求令牌；失败时已写响应并返回 false。 */
export function requireToken(req, res) {
  if (String(req.headers[TOKEN_HEADER] || '') !== WRITE_TOKEN) {
    sendJson(res, 403, { error: '缺少或错误的写操作令牌，先刷新一次页面' });
    return false;
  }
  return true;
}
