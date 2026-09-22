#!/usr/bin/env node
/**
 * 昵称池校验 CLI。
 *
 *   node tools/check-nicknames.js [文件路径]
 *
 * 规则实现在 src/nicknameRules.js，服务端启动时走同一套 —— 不存在两份规则。
 * **不通过禁止入库**。
 */

import { readFileSync } from 'node:fs';
import { validatePool } from '../src/nicknameRules.js';

const file = process.argv[2] ?? new URL('../nicknames.json', import.meta.url);
const shown = typeof file === 'string' ? file : decodeURIComponent(file.pathname);

let pool;
try {
  pool = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`读取失败：${shown}\n  ${e.message}`);
  process.exit(2);
}

const report = validatePool(pool);

console.log(`昵称池校验：${shown}\n`);
for (const c of report.checks) {
  const mark = c.ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${c.id.padEnd(4)} ${c.desc}`);
  if (!c.ok && c.detail) console.log(`         → ${c.detail}`);
}

console.log('\n以下两条无法机器判定（不引拼音库/词库是 C6 的要求），由人工承接：');
for (const m of report.manual) console.log(`  - ${m}`);

if (report.ok) {
  console.log('\n机器校验全部通过。注意：这不等于七条全过，U6/U7 仍需人工。');
  process.exit(0);
}
console.error('\n机器校验未通过，禁止入库。');
process.exit(1);
