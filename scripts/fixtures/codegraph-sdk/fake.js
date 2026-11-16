// CodeGraph SDK 的假实现：只在自检里用，覆盖「找根 → 打开 → 查询 → 关闭」这条接口面。
// 真 SDK 的行为由两轮实测确定（见 src/codegraph.js 头部），这里只复刻用到的形状。
export const state = {
  root: null, // findNearestCodeGraphRoot 的返回值
  openError: '', // 打开索引时抛的错
  contextError: '', // buildContext 时抛的错
  context: '', // buildContext 返回的 JSON 字符串
  search: [], // searchNodes 的返回
  impact: { nodes: new Map(), edges: [], roots: [] },
  dependents: [],
  calls: [], // 记录调用参数，供断言
  closed: 0,
};

export function findNearestCodeGraphRoot(cwd) {
  state.calls.push({ kind: 'root', cwd });
  return state.root;
}

export class CodeGraph {
  static async open(root, options) {
    state.calls.push({ kind: 'open', root, options });
    if (state.openError) throw new Error(state.openError);
    return {
      async buildContext(input, buildOptions) {
        state.calls.push({ kind: 'buildContext', input, options: buildOptions });
        if (state.contextError) throw new Error(state.contextError);
        return state.context;
      },
      searchNodes(query, searchOptions) {
        state.calls.push({ kind: 'searchNodes', query, options: searchOptions });
        return state.search;
      },
      getImpactRadius(id, depth) {
        state.calls.push({ kind: 'getImpactRadius', id, depth });
        return state.impact;
      },
      getFileDependents(file) {
        state.calls.push({ kind: 'getFileDependents', file });
        return state.dependents;
      },
      close() { state.closed += 1; },
    };
  }
}

export function isInitialized() { return true; }
