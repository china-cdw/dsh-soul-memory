/**
 * 工具备注（description 末尾的「备注：」）。
 *
 * 备注只回答读描述的人最常问的三件事：数据落在哪、有没有副作用、花不花钱。
 * 它不参与执行逻辑，因此统一在这里拼接，避免每个工具各写一种格式。
 * 备注留空的工具保持原描述不变（空字符串与 undefined 等价）。
 */
export function withNotes(description, notes) {
  const extra = typeof notes === 'string' ? notes.trim() : ''
  return extra ? `${description}\n\n备注：${extra}` : description
}
