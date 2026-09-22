#!/usr/bin/env node
/**
 * 打印昵称池，供人工过目（FR-N 的长辈独立审核用）。
 *
 *   node tools/print-names.js                 打到终端，四列排版
 *   node tools/print-names.js --md out.md     生成一份 Markdown 表格，方便发给人看
 *
 * ## 为什么不在仓库里存一份现成的名单
 *
 * 原先有个 `昵称池-待审核.md`，手工维护。2026-09-22 发现它已经和
 * `nicknames.json` 对不上了：第 213 号表里写「沉稳的海龟」，实际发的是
 * 「香甜的八宝饭」—— 改数据时漏改了副本。
 *
 * 审核一份不是真正会发出去的名单，比不审核更糟：审完会以为放心了。
 * 所以副本删掉，要看就从唯一真源现生成。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const raw = JSON.parse(readFileSync(new URL('nicknames.json', ROOT), 'utf8'));
const names = Array.isArray(raw) ? raw : (raw.nicknames ?? raw.pool);

if (!Array.isArray(names) || names.length === 0) {
  console.error('nicknames.json 里没读到昵称数组');
  process.exit(1);
}

const mdFlag = process.argv.indexOf('--md');
const COLS = 4;

if (mdFlag >= 0) {
  const out = process.argv[mdFlag + 1];
  if (!out) {
    console.error('用法：node tools/print-names.js --md <输出文件>');
    process.exit(1);
  }
  const lines = [
    `# 昵称池 ${names.length} 条`,
    '',
    `> 由 \`node tools/print-names.js --md\` 从 \`nicknames.json\` 生成于 ${new Date().toLocaleString('zh-CN')}。`,
    '> **这是一份快照，不要提交进仓库** —— 仓库里存副本迟早会和真源对不上。',
    '',
    '**发放顺序即本表顺序**，运行时零随机：第 N 位入场的宾客拿第 N 号。',
    '',
    '看到不妥的直接报编号。',
    '',
    `|${' 昵称 |'.repeat(COLS)}`,
    `|${'---|'.repeat(COLS)}`,
  ];
  for (let i = 0; i < names.length; i += COLS) {
    const row = [];
    for (let j = 0; j < COLS; j++) {
      const n = names[i + j];
      row.push(n ? `${i + j + 1}. ${n}` : '');
    }
    lines.push(`| ${row.join(' | ')} |`);
  }
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`已写出 ${out}（${names.length} 条）`);
  console.log('⚠️  这是快照，给人看完就删，别提交进仓库。');
} else {
  const w = Math.max(...names.map((n) => [...n].length)) * 2 + 2;
  for (let i = 0; i < names.length; i += COLS) {
    const row = [];
    for (let j = 0; j < COLS && i + j < names.length; j++) {
      const label = `${String(i + j + 1).padStart(3)}. ${names[i + j]}`;
      row.push(label.padEnd(w));
    }
    console.log(row.join(''));
  }
  console.log(`\n共 ${names.length} 条。发放顺序即此顺序，第 N 位入场拿第 N 号。`);
  console.log('要发给人过目：node tools/print-names.js --md /tmp/昵称池.md');
}
