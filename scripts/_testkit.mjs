// 自检脚本共用的小工具：临时 DSH_HOME、断言计数、插件 ctx 桩件。
//
// 约定：每个 audit 脚本自成一个可执行文件，失败退出码 1；测试只看行为，不 mock 内部函数。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 建一个临时 DSH_HOME 并切过去；返回 { dir, cleanup }。 */
export async function makeHome(prefix = 'dsh-x-memory-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  process.env.DSH_HOME = dir;
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** 极简测试台：顺序执行、逐条打印、结束时汇总并以退出码表达结果。 */
export function suite(name) {
  const state = { pass: 0, fail: 0, failures: [] };
  return {
    async test(label, fn) {
      try {
        await fn();
        state.pass += 1;
        console.log('  ok   ' + label);
      } catch (e) {
        state.fail += 1;
        state.failures.push({ label, error: e });
        console.log('  FAIL ' + label + ' — ' + (e && e.message ? e.message : String(e)));
      }
    },
    finish() {
      const total = state.pass + state.fail;
      console.log(`\n${name}: ${state.pass}/${total} 通过，${state.fail} 失败`);
      if (state.fail) {
        const first = state.failures[0];
        console.error('\n首个失败：' + first.label);
        console.error(first.error && first.error.stack ? first.error.stack : String(first.error));
        process.exitCode = 1;
      }
      return state;
    },
    state,
  };
}

/**
 * 插件 ctx 桩件：捕获工具、section、事件 handler 与 web 路由。
 * 不模拟宿主调度；测试直接调用捕获到的函数。
 */
export function makeCtx() {
  const tools = new Map();
  const sections = [];
  const handlers = new Map();
  const routes = [];
  const disposers = [];
  const ctx = {
    tools: {
      register(def) {
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
    },
    systemPrompt: {
      section(opts) {
        sections.push(opts);
        return { dispose() { /* noop */ } };
      },
    },
    on(name, fn) {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    inject(_deps, fn) {
      fn({
        // 宿主语义：effect(run) 立即执行并保存返回的清理函数。
        effect: (run) => {
          const dispose = typeof run === 'function' ? run() : run;
          disposers.push(dispose);
          return dispose;
        },
        webServer: {
          register(route) {
            routes.push(route);
            return () => { /* noop */ };
          },
        },
      });
      return () => { for (const d of disposers.splice(0)) { try { if (typeof d === 'function') d(); } catch { /* 忽略 */ } } };
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, tools, sections, handlers, routes };
}

/** 轮询等待条件成立（宿主里 bootstrap 是异步的）。 */
export async function waitFor(fn, { timeout = 3000, interval = 25, label = '条件' } = {}) {
  const started = Date.now();
  for (;;) {
    let value;
    try { value = await fn(); } catch (e) { value = false; }
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('等待超时：' + label);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** 取工具执行结果（插件工具返回字符串或 {type:'text',text}）。 */
export async function callTool(tools, name, args = {}, exec = undefined) {
  const def = tools.get(name);
  assert.ok(def, '工具未注册：' + name);
  const value = await def.execute(args, exec);
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export { assert };
