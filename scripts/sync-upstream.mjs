#!/usr/bin/env node
// dsh-x-memory 上游同步工具
//
// 背景：dsh-x-memory 是 dsh-soul 的 fork。src/ 下大部分文件是上游逐字节镜像，
// 只有少数几个是我们自己的（见 OUR_FILES）。升级上游时不能整目录覆盖，否则会
// 把我们的四个模块和 index.js 的接线冲掉。
//
// 用法：
//   node scripts/sync-upstream.mjs --init --from <dsh-soul 目录>   建立/重建镜像清单（不覆盖文件）
//   node scripts/sync-upstream.mjs --check                         只检查：镜像文件是否被本地改过、清单是否缺文件
//   node scripts/sync-upstream.mjs --from <dsh-soul 目录>          实际同步：覆盖镜像文件、删除上游已删的镜像、更新清单
//   （同步默认目标就是本插件目录，可用 --to <dir> 指定）
//
// 同步完 index.js 不会自动合并——它是我们改过的接线文件。脚本会打印与上游的差异摘要，
// 按 UPSTREAM.md 的「index.js 接线点」逐条重放即可。

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MANIFEST = join(ROOT, 'upstream-manifest.json');

/** 我们自己的文件（相对本插件根目录）：同步时永远不覆盖。 */
const OUR_FILES = new Set([
  'index.js',
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'UPSTREAM.md',
  'upstream-manifest.json',
  'src/core-memory.js',
  'src/persona.js',
  'src/coding.js',
  'src/lessons.js',
  'src/memory/util.js',
  'src/memory/guard.js',
  'src/memory/bili.js',
]);

/** 不参与镜像的目录/文件（上游仓库自带，插件运行不需要）。 */
const SKIP = [/^node_modules(\/|$)/, /^\.git(\/|$)/, /^scripts(\/|$)/, /^test(\/|$)/, /^docs(\/|$)/, /\.bak/, /\.tmp-/];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(base, abs).split(sep).join('/');
    if (SKIP.some((re) => re.test(rel))) continue;
    if (entry.isDirectory()) await walk(abs, base, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function upstreamInfo(from) {
  const pkg = await readJson(join(from, 'package.json'));
  if (!pkg || pkg.name !== 'dsh-soul') {
    throw new Error(`--from 指向的不是 dsh-soul 包：${from}`);
  }
  const files = (await walk(from)).filter((rel) => !OUR_FILES.has(rel));
  const hashes = {};
  for (const rel of files) hashes[rel] = sha(await readFile(join(from, rel)));
  return { pkg, files, hashes };
}

async function loadManifest() {
  const m = await readJson(MANIFEST);
  if (!m || !m.files) throw new Error('upstream-manifest.json 缺失或损坏，先跑 --init --from <dsh-soul 目录>');
  return m;
}

async function localHashes(files) {
  const out = {};
  for (const rel of files) {
    try { out[rel] = sha(await readFile(join(ROOT, rel))); } catch { out[rel] = null; }
  }
  return out;
}

function reportDrift(manifest, local) {
  const bad = [];
  for (const [rel, expected] of Object.entries(manifest.files)) {
    if (!local[rel]) bad.push(`缺失        ${rel}`);
    else if (local[rel] !== expected) bad.push(`本地被改过  ${rel}`);
  }
  return bad;
}

async function initWith(from) {
  const { pkg, hashes } = await upstreamInfo(from);
  const local = await localHashes(Object.keys(hashes));
  const bad = reportDrift({ files: hashes }, local);
  const manifest = {
    upstream: { name: pkg.name, version: pkg.version },
    note: '由 scripts/sync-upstream.mjs --init 生成：记录镜像文件的 sha256，用于检测本地误改与上游漂移。',
    files: hashes,
  };
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`已写入清单：上游 ${pkg.name}@${pkg.version}，镜像 ${Object.keys(hashes).length} 个文件`);
  if (bad.length) {
    console.log('注意：当前目录与清单不一致（同步前先解决）：');
    for (const line of bad) console.log('  ' + line);
  } else {
    console.log('当前镜像与上游逐字节一致。');
  }
}

async function check() {
  const manifest = await loadManifest();
  const local = await localHashes(Object.keys(manifest.files));
  const bad = reportDrift(manifest, local);
  console.log(`清单：上游 ${manifest.upstream.name}@${manifest.upstream.version}，${Object.keys(manifest.files).length} 个镜像文件`);
  if (!bad.length) {
    console.log('镜像未被本地修改，清单完整。');
    return 0;
  }
  console.log(`发现 ${bad.length} 处不一致：`);
  for (const line of bad) console.log('  ' + line);
  console.log('这些文件应属于上游；若确实需要本地改动，请改成我们自己的文件（见 UPSTREAM.md）。');
  return 1;
}

async function sync(from) {
  const { pkg, hashes } = await upstreamInfo(from);
  const old = await loadManifest().catch(() => ({ files: {} }));
  let copied = 0;
  let removed = 0;
  for (const [rel, hash] of Object.entries(hashes)) {
    if (old.files[rel] === hash) continue;
    const dest = join(ROOT, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(join(from, rel)));
    copied += 1;
  }
  for (const rel of Object.keys(old.files)) {
    if (hashes[rel]) continue;
    await rm(join(ROOT, rel), { force: true });
    removed += 1;
  }
  const manifest = {
    upstream: { name: pkg.name, version: pkg.version },
    note: old.note || '由 scripts/sync-upstream.mjs 生成：记录镜像文件的 sha256。',
    files: hashes,
  };
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`同步完成：${pkg.name}@${pkg.version}，覆盖 ${copied}、删除 ${removed}、镜像 ${Object.keys(hashes).length}`);
  console.log('下一步：');
  console.log('  1) 按 UPSTREAM.md 的「index.js 接线点」重放我们的改动（上游改过 index.js 时）');
  console.log('  2) node --check index.js src/core-memory.js src/coding.js src/lessons.js src/memory/util.js');
  console.log('  3) node dsh-x-memory-audit.mjs && node dsh-x-memory-coding-audit.mjs && node dsh-x-memory-lessons-audit.mjs && node lessons-replay-test.mjs');
  console.log('  4) 更新 package.json 的 dshMemory.upstream.version 与 files 通配符');
}

if (flag('--check')) {
  process.exitCode = await check();
} else if (flag('--init')) {
  const from = opt('--from');
  if (!from) throw new Error('--init 需要 --from <dsh-soul 目录>');
  await initWith(resolve(from));
} else {
  const from = opt('--from');
  if (!from) {
    console.error('用法见文件头注释：--init/--check/--from <dsh-soul 目录>');
    process.exit(2);
  }
  await sync(resolve(from));
}
