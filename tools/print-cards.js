#!/usr/bin/env node
/**
 * 生成主持人纸质题卡（含答案），浏览器打开后直接 Ctrl+P 打印成 A4。
 *
 *   node tools/print-cards.js                    写到 wip/题卡.html（wip/ 已被 .gitignore 忽略）
 *   node tools/print-cards.js out.html           写到指定文件
 *   node tools/print-cards.js -                  打到 stdout
 *   node tools/print-cards.js --bank test        用测试题库（默认 wedding）
 *
 * ## 为什么现生成、不存副本
 *
 * 和 print-names.js 同一个理由：仓库里存一份题卡，改题时迟早漏改副本，
 * 主持人拿着对不上的答案上台比没有题卡更糟。题库唯一真源是 questions/*.json。
 *
 * 走 loadBank 读题，和服务端同一套校验 —— 题库有问题时这里就会报错，
 * 不会印出一份服务端根本不认的题卡。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBank } from '../src/quizbank.js';

const args = process.argv.slice(2);
const bankFlag = args.indexOf('--bank');
const bankName = bankFlag >= 0 ? args.splice(bankFlag, 2)[1] : 'wedding';
// 不拦的话 undefined 会让 loadBank 落到 QUIZ_BANK / test，悄悄印出另一套题
if (!bankName) {
  console.error('--bank 后面要跟题库名：test 或 wedding');
  process.exit(1);
}
const out = args[0] ?? fileURLToPath(new URL('../wip/题卡.html', import.meta.url));

let bank;
try {
  bank = loadBank({ bank: bankName });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const LETTERS = 'ABCDEFGH';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function card(q, no) {
  const opts = q.options
    .map((o, i) => {
      const ok = i === q.answer;
      return `<li${ok ? ' class=ok' : ''}><b class=l>${LETTERS[i]}</b>${esc(o)}${ok ? '<span class=mark>✔ 正确答案</span>' : ''}</li>`;
    })
    .join('');
  return `<section class=card>
  <p class=q><span class=no>${no}</span>${esc(q.text)}</p>
  <ol>${opts}</ol>
  <p class=ans>答案：<b>${LETTERS[q.answer]}　${esc(q.options[q.answer])}</b></p>
</section>`;
}

const stamp = new Date().toLocaleString('zh-CN');
const html = `<!doctype html>
<html lang=zh-CN>
<meta charset=utf-8>
<title>主持人题卡 · ${esc(bank.label)}</title>
<style>
  @page { size: A4; margin: 14mm 15mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 13pt; color: #000; margin: 0 auto; max-width: 180mm; }
  h1 { font-size: 20pt; margin: 0 0 2pt; }
  .meta { font-size: 10pt; color: #555; margin: 0 0 10pt; }
  h2 { font-size: 16pt; margin: 14pt 0 6pt; padding: 3pt 8pt; border-left: 5pt solid #000; background: #eee; }
  h2.spare { break-before: page; }
  .card { break-inside: avoid; page-break-inside: avoid; border: 1pt solid #999; border-radius: 4pt; padding: 8pt 12pt; margin: 0 0 8pt; }
  .no { display: inline-block; margin-right: 8pt; padding: 0 5pt; border: 1.5pt solid #000; border-radius: 3pt; font-size: 14pt; }
  .q { font-size: 17pt; font-weight: 700; line-height: 1.4; margin: 0 0 6pt; }
  ol { list-style: none; margin: 0; padding: 0 0 0 12pt; }
  li { font-size: 15pt; line-height: 1.5; padding: 1pt 6pt; border: 1.5pt solid transparent; border-radius: 3pt; }
  li .l { display: inline-block; width: 22pt; }
  li.ok { font-weight: 700; border-color: #000; background: #ffe58a; }
  .mark { font-size: 11pt; margin-left: 10pt; padding: 0 5pt; background: #000; color: #fff; border-radius: 2pt; }
  .ans { font-size: 12pt; margin: 4pt 0 0; padding-left: 12pt; color: #333; }
  @media screen { body { padding: 16px; } }
</style>
<h1>主持人题卡 · ${esc(bank.label)}</h1>
<p class=meta>正题 ${bank.total} 道 · 备用 ${bank.spares.length} 道 · 由 tools/print-cards.js 从 questions/${esc(bank.name)}.json 生成于 ${esc(stamp)} · <b>含答案，勿给宾客看到</b></p>
<h2>正题（按出题顺序）</h2>
${bank.main.map((q, i) => card(q, `第${i + 1}题`)).join('\n')}
<h2 class=spare>备用题（换题时用）</h2>
<p class=meta>念错题或题目有歧义时，在控制台点「换一道备用题」，按下面顺序依次换上。</p>
${bank.spares.map((q, i) => card(q, `备${i + 1}`)).join('\n')}
</html>
`;

if (out === '-') {
  process.stdout.write(html);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`已写出 ${out}（${bank.label}：正题 ${bank.total} 道，备用 ${bank.spares.length} 道）`);
  console.log('浏览器打开后 Ctrl+P 打印（A4）。含答案，别提交进仓库。');
}
