// 私钥块的唯一定义：guard 的硬底线、redact 的打码、memory/util 的清洗都引用这里。
// 早先三处各写一份（[A-Z ]* / [^-]* / [A-Z0-9 ]*），结果 PGP BLOCK 与 SSH2 ENCRYPTED
// 两种标准格式只在其中一处被认出来——同一段文本「有没有私钥」会因调用路径不同而异。
//
// 覆盖四类标准头：RSA、OPENSSH、PGP 的私钥块（BLOCK 结尾），以及 SSH2 加密私钥。
// 头一律以「五个连字符 + BEGIN + 空格」开头、以「五个连字符」结尾，中间允许空格与大写词。

/** 正则源码（guard.js 需要字符串形式塞进 GUARD.json 的规则里）。 */
export const PRIVATE_KEY_SOURCE = '-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----';

/** 单行判断：文本里是否出现私钥块的开头。 */
export const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;

/** 整块删除（BEGIN 到 END）。 */
export const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[sS]*?-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/g;
