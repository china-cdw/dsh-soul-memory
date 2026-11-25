// 医疗/个人信息识别：只回答「这段文字像不像个人信息」，不改写、不删除正文。
//
// 设计边界：
//   - 默认只用于「标记敏感」，不用于拒写。医疗投标/病历整理场景里，删掉一句就可能毁掉材料，
//     所以这里宁可多标一条，也不做不可逆的清洗。
//   - 病历号、患者姓名必须带标签（病历号：/患者：）才算命中；裸数字串只认身份证与手机号，
//     避免把版本号、金额、检查结果当成 PII。
//   - 返回值里不带命中的原文：调用方只拿得到类别，日志和错误信息不会二次泄露。

const CN_ID_18 = /(?<![0-9A-Za-z])(?:[1-9]\d{5})(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9A-Za-z])/;
const CN_ID_15 = /(?<!\d)[1-9]\d{5}(?:\d{2})(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}(?!\d)/;
const CN_MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const MRN = /(?:病历号|病案号|住院号|就诊号|门诊号|医保号|医保卡号|社保号)\s*[:：=]?\s*[A-Za-z0-9-]{4,}/i;
const PATIENT = /(?:患者姓名|病人姓名|患者|病人|姓名)\s*[:：=]\s*[\u4e00-\u9fa5·]{2,6}/;

const KINDS = [
  { kind: 'idcard', label: '身份证号', re: CN_ID_18 },
  { kind: 'idcard', label: '身份证号', re: CN_ID_15 },
  { kind: 'phone', label: '手机号', re: CN_MOBILE },
  { kind: 'mrn', label: '病历号/就诊号', re: MRN },
  { kind: 'patient', label: '患者姓名', re: PATIENT },
];

/** 命中返回第一个类别，未命中返回 null。只给类别，不回显命中的原文。 */
export function detectPii(text) {
  const s = String(text ?? '');
  if (!s) return null;
  for (const item of KINDS) {
    item.re.lastIndex = 0;
    if (item.re.test(s)) return { kind: item.kind, label: item.label };
  }
  return null;
}

/** 供测试与「这条为什么被标敏感」使用：返回所有命中的类别（去重）。 */
export function piiKinds(text) {
  const s = String(text ?? '');
  const found = [];
  for (const item of KINDS) {
    item.re.lastIndex = 0;
    if (item.re.test(s) && !found.includes(item.kind)) found.push(item.kind);
  }
  return found;
}
