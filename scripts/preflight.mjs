#!/usr/bin/env node
// dsh-x-memory — 发布前扫描
//
// 目标：在 npm publish / GitHub 发布前，把不该离开本机的东西拦下来。
// 四类：私钥块、凭据形状、绝对家目录、超长高熵块。
//
// 只报「文件:行号 + 类别」，绝不回显命中的文本——否则扫描报告本身就成了泄露源。
// 任何一类命中都以非零退出码结束（fail closed）；读不了的文件同样算失败。
// 确认是误报时，在 .preflight-ignore.json 里加豁免（数组，元素为
// "相对路径"、"相对路径:行号" 或 "相对路径:行号 类别"）。

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IGNORE_FILE = '.preflight-ignore.json';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.snapshots', '.github']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.ts', '.txt', '.sh']);
const MAX_BYTES = 2 * 1024 * 1024;

const DRIVE = /[A-Za-z]:[\\/]/;
// 用字符串拼，避免这个正则的源码本身被 ABS_POSIX 命中。
const HOME_NAMES = ['Users', 'home'];
const POSIX_HOME = new RegExp('(?:^|[\\s"\'(=])/(?:' + HOME_NAMES.join('|') + ')/[^/\\s\'"]+');

// 顺序即优先级：一行命中第一类就记一条，避免同一行重复报。
const CLASSES = [
  ['PRIVATE_KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['CREDENTIAL', /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,})\b/],
  ['ABS_WIN', /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"]+/i],
  ['ABS_POSIX', POSIX_HOME],
  ['HIGH_ENTROPY', /[A-Za-z0-9+/]{200,}={0,2}/],
];

function classify(line) {
  for (const [cls, re] of CLASSES) {
    // Windows 盘符路径里的家目录段属于盘符路径，不算 POSIX 家目录。
    if (cls === 'ABS_POSIX' && DRIVE.test(line)) continue;
    if (re.test(line)) return cls;
  }
  return null;
}

async function walk(dir, out) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    out.push({ path: dir, error: e });
    return;
  }
  for (const ent of entries) {
    if (ent.name === IGNORE_FILE) continue;
    if (ent.name.startsWith('.bak') || ent.name.includes('.tmp-')) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      await walk(full, out);
    } else if (ent.isFile()) {
      const dot = ent.name.lastIndexOf('.');
      if (dot < 0 || !TEXT_EXT.has(ent.name.slice(dot).toLowerCase())) continue;
      out.push({ path: full });
    }
  }
}

async function loadIgnore() {
  let raw;
  try {
    raw = await readFile(join(ROOT, IGNORE_FILE), 'utf8');
  } catch {
    return new Set();
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    console.error('[preflight] ' + IGNORE_FILE + ' 不是合法 JSON：' + e.message);
    process.exit(1);
  }
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) {
    console.error('[preflight] ' + IGNORE_FILE + ' 必须是字符串数组');
    process.exit(1);
  }
  return new Set(list.map((s) => s.trim()).filter(Boolean));
}

function ignored(ignore, rel, line, cls) {
  return ignore.has(rel) || ignore.has(rel + ':' + line) || ignore.has(rel + ':' + line + ' ' + cls);
}

async function scan() {
  const files = [];
  await walk(ROOT, files);
  const ignore = await loadIgnore();
  const findings = [];
  for (const f of files) {
    const rel = relative(ROOT, f.path).split('\\').join('/');
    if (f.error) {
      findings.push({ rel, line: 0, cls: 'UNREADABLE' });
      continue;
    }
    let buf;
    try {
      const st = await stat(f.path);
      if (st.size > MAX_BYTES) continue;
      buf = await readFile(f.path, 'utf8');
    } catch {
      findings.push({ rel, line: 0, cls: 'UNREADABLE' });
      continue;
    }
    if (buf.includes('\u0000')) continue;
    const lines = buf.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const cls = classify(lines[i]);
      if (!cls) continue;
      if (ignored(ignore, rel, i + 1, cls)) continue;
      findings.push({ rel, line: i + 1, cls });
    }
  }
  return findings;
}

const findings = await scan();
if (findings.length) {
  console.error('preflight 失败：发现 ' + findings.length + ' 处不宜发布的内容（只报位置与类别，不回显内容）');
  for (const f of findings) {
    console.error('  ' + f.rel + ':' + f.line + '  ' + f.cls);
  }
  console.error('处理：删除/替换该处内容；确认是误报时在 ' + IGNORE_FILE + ' 里加豁免（数组：相对路径 / 相对路径:行号 / 相对路径:行号 类别）。');
  process.exit(1);
}
console.log('preflight 通过：未发现私钥、凭据、绝对家目录或高熵块。');
