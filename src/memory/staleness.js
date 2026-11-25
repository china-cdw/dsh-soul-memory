// 过期约束提示：只加一句日期，不改排序、不改正文。
//
// 为什么不在写入时判断：一个约束是否仍然有效，只有人知道；这里能给的是「它什么时候写的」，
// 让读的人自己决定要不要复核。0 表示关闭，默认值在 index.js 的 readConfig 里。
const DAY = 86400000;

export function staleSuffix(recordedAt, { days = 0, now = Date.now() } = {}) {
  if (!days || days <= 0) return '';
  const at = Number(recordedAt) || 0;
  if (!at) return '';
  if (!(Number(now) - at > days * DAY)) return '';
  const date = new Date(at).toISOString().slice(0, 10);
  return '（记录于 ' + date + '，可能已过期）';
}
