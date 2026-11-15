// 灵魂记忆设置页与本地接口的自检。
//
// 两层：
// 1. ui-settings.js 的纯函数与文件往返（默认值、非法输入、原子写）；
// 2. registerSoulUiRoutes 注册的三条路由——真实调 handler，喂假 req/res，
//    覆盖安全守卫（缺请求头、跨源、方法、Content-Type）与正常读写。
// 浏览器端 client.js 不进 Node 加载（依赖 window），只做语法解析。
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeHome, makeCtx, suite, assert } from './_testkit.mjs';
import {
  DISPLAY_MODES, UI_DEFAULTS, MAX_NICKNAME,
  normalizeUiSettings, validateUiPatch, readUiSettings, writeUiSettings, uiSettingsPath,
} from '../src/ui-settings.js';
import { registerSoulUiRoutes } from '../src/ui-routes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = await makeHome();
const s = suite('dsh-memory-ui');

/** 最小 res 桩件：记录状态码、头与响应体。 */
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value },
    end(chunk) { this.body = chunk == null ? '' : String(chunk) },
  };
}

/** 写接口的进程内令牌：从 GET /state 拿到后，后续写请求自动带上。 */
let writeToken = '';

/** 最小 req 桩件：headers 可覆写，body 在微任务里推给 handler。 */
function fakeReq({ method = 'GET', headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  const auth = writeToken ? { 'x-dsh-soul-memory-token': writeToken } : {};
  req.headers = { host: '127.0.0.1:10036', 'x-dsh-soul-memory': '1', ...auth, ...headers };
  req.url = '/dsh-soul-memory/state';
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

async function hit(route, req) {
  const res = fakeRes();
  await route.handler(req, res);
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null } catch { /* 非 JSON 响应 */ }
  return { res, json };
}

try {
  await s.test('默认界面设置', () => {
    assert.deepEqual(readUiSettings(), UI_DEFAULTS);
    assert.deepEqual(DISPLAY_MODES, ['inline', 'sidebar', 'overlay', 'off']);
    assert.equal(UI_DEFAULTS.displayMode, 'inline');
  });

  await s.test('normalizeUiSettings 收敛非法值', () => {
    assert.equal(normalizeUiSettings({ displayMode: 'overlay' }).displayMode, 'overlay');
    assert.equal(normalizeUiSettings({ displayMode: 'nope' }).displayMode, 'inline');
    assert.equal(normalizeUiSettings({ nickname: '  山大王  ' }).nickname, '山大王');
    assert.equal(normalizeUiSettings({ nickname: 'x'.repeat(MAX_NICKNAME + 20) }).nickname.length, MAX_NICKNAME);
    assert.deepEqual(normalizeUiSettings(null), UI_DEFAULTS);
  });

  await s.test('validateUiPatch 只收已知字段且类型正确', () => {
    assert.deepEqual(validateUiPatch({ nickname: '大王' }), { ok: true, patch: { nickname: '大王' } });
    assert.equal(validateUiPatch({ displayMode: 'sidebar' }).ok, true);
    assert.equal(validateUiPatch({ displaymode: 'sidebar' }).ok, false);
    assert.equal(validateUiPatch({ displayMode: 1 }).ok, false);
    assert.equal(validateUiPatch({ nickname: {} }).ok, false);
    assert.equal(validateUiPatch([]).ok, false);
    assert.equal(validateUiPatch(null).ok, false);
  });

  await s.test('rulesBudget 只能是 0 或 400–8000', async () => {
    assert.equal(validateUiPatch({ rulesBudget: 0 }).ok, true);
    assert.equal(validateUiPatch({ rulesBudget: 5000 }).patch.rulesBudget, 5000);
    assert.equal(validateUiPatch({ rulesBudget: 399 }).ok, false);
    assert.equal(validateUiPatch({ rulesBudget: 8001 }).ok, false);
    assert.equal(validateUiPatch({ rulesBudget: '2000' }).ok, false);
    assert.equal(validateUiPatch({ rulesBudget: 2500.4 }).patch.rulesBudget, 2500);
  });

  await s.test('写入后读回一致，文件落在 memory/SOUL-UI.json', async () => {
    const saved = await writeUiSettings({ displayMode: 'sidebar', nickname: '山大王' });
    assert.equal(saved.displayMode, 'sidebar');
    assert.equal(saved.nickname, '山大王');
    assert.deepEqual(readUiSettings(), { displayMode: 'sidebar', nickname: '山大王', mutedUntil: 0, memoryPaused: false, rulesBudget: 0 });
    assert.ok(uiSettingsPath().replace(/\\/g, '/').endsWith('/memory/SOUL-UI.json'));
  });

  await s.test('损坏的文件回落到默认值而不是抛错', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(uiSettingsPath(), '{ 不是 json', 'utf8');
    assert.deepEqual(readUiSettings(), UI_DEFAULTS);
    // 恢复一份可用的设置供后面的路由测试用。
    await writeUiSettings({ displayMode: 'inline', nickname: '' });
  });

  const { ctx, routes } = makeCtx();
  // 与 index.js 接线方式一致：webServer 是可选的注入服务，回调参数才是带它的 ctx。
  ctx.inject(['webServer'], (c) => { registerSoulUiRoutes(c, { store: null }) });

  await s.test('注册六条 exact 路由', () => {
    const paths = routes.map((r) => r.path).sort();
    assert.deepEqual(paths, [
      '/dsh-soul-memory/dreaming',
      '/dsh-soul-memory/pending',
      '/dsh-soul-memory/rules',
      '/dsh-soul-memory/state',
      '/dsh-soul-memory/tier',
      '/dsh-soul-memory/ui',
    ]);
    assert.ok(routes.every((r) => r.kind === 'exact'));
  });

  const stateRoute = routes.find((r) => r.path.endsWith('/state'));
  const uiRoute = routes.find((r) => r.path.endsWith('/ui'));
  const pendingRoute = routes.find((r) => r.path.endsWith('/pending'));

  await s.test('缺自定义请求头一律 403', async () => {
    const { res } = await hit(stateRoute, fakeReq({ headers: { 'x-dsh-soul-memory': '' } }));
    assert.equal(res.statusCode, 403);
  });

  await s.test('跨源 Origin 被拒绝', async () => {
    const { res } = await hit(stateRoute, fakeReq({ headers: { origin: 'https://evil.example' } }));
    assert.equal(res.statusCode, 403);
  });

  await s.test('非回环 Host 被拒绝（DNS rebinding）', async () => {
    const { res } = await hit(stateRoute, fakeReq({ headers: { host: 'evil.example' } }));
    assert.equal(res.statusCode, 403);
  });

  await s.test('GET state 返回完整结构', async () => {
    const { res, json } = await hit(stateRoute, fakeReq());
    assert.equal(res.statusCode, 200);
    for (const key of ['ui', 'limits', 'pending', 'rules', 'persona', 'presets', 'tiers', 'health', 'dreaming', 'rulesList']) {
      assert.ok(key in json, '缺少字段：' + key);
    }
    assert.equal(json.ui.displayMode, 'inline');
    assert.ok(Array.isArray(json.pending));
    assert.ok(Array.isArray(json.presets) && json.presets.length > 0);
    assert.equal(json.tiers.minAgeDays, 90);
    assert.equal(res.headers['cache-control'], 'no-store');
    // 页面用它签写操作；本机其他脚本拿不到。
    assert.equal(typeof json.token, 'string');
    assert.ok(json.token.length >= 16);
    writeToken = json.token;
  });

  await s.test('写接口缺令牌一律 403', async () => {
    const saved = writeToken;
    writeToken = '';
    try {
      const { res } = await hit(uiRoute, fakeReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: '没令牌' }),
      }));
      assert.equal(res.statusCode, 403);
    } finally {
      writeToken = saved;
    }
  });

  await s.test('POST ui 改形态并落盘', async () => {
    const { res, json } = await hit(uiRoute, fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayMode: 'overlay', nickname: '大王' }),
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(json.ui.displayMode, 'overlay');
    assert.equal(json.ui.nickname, '大王');
    assert.equal(readUiSettings().displayMode, 'overlay');
  });

  await s.test('POST ui 拒收未知字段', async () => {
    const { res } = await hit(uiRoute, fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dispalyMode: 'sidebar' }),
    }));
    assert.equal(res.statusCode, 400);
  });

  await s.test('POST ui 要求 application/json', async () => {
    const { res } = await hit(uiRoute, fakeReq({
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ nickname: 'x' }),
    }));
    assert.equal(res.statusCode, 415);
  });

  await s.test('POST pending 校验 action 与 ids', async () => {
    const bad = await hit(pendingRoute, fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    }));
    assert.equal(bad.res.statusCode, 400);
    const bad2 = await hit(pendingRoute, fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'merge', ids: ['a'] }),
    }));
    assert.equal(bad2.res.statusCode, 400);
  });

  await s.test('POST pending 批准不存在的 id 返回 400', async () => {
    const { res, json } = await hit(pendingRoute, fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', ids: ['nope1234'] }),
    }));
    assert.equal(res.statusCode, 400);
    assert.ok(json && typeof json.error === 'string');
  });

  await s.test('GET 只读接口拒绝 POST', async () => {
    const { res } = await hit(stateRoute, fakeReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    assert.equal(res.statusCode, 405);
  });

  await s.test('client.js 语法可解析', () => {
    const code = readFileSync(join(root, 'client.js'), 'utf8');
    // 浏览器模块，不执行；只要能过解析就说明没有语法错误。
    new Function(code);
    assert.ok(code.includes("__ModuleLoader__.load"));
    assert.ok(code.includes("'settings.section'"));
    assert.ok(code.includes("'conversation.composer.dock'"));
    assert.ok(code.includes("'shell.overlay'"));
  });
} finally {
  s.finish();
  await home.cleanup();
}
