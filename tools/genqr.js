#!/usr/bin/env node
/**
 * 离线生成入口二维码（FR-9.3）。
 *
 *   node tools/genqr.js http://119.29.186.63:8888/
 *
 * 产物 public/qr.png 与 public/qr.svg 直接入库。
 *
 * ## 为什么用 npx 而不是自己实现
 *
 * C6 禁止运行时依赖，但它管的是**运行时**；这里生成的是一张静态图片，
 * 跑完就不再需要任何东西，`package.json` 与 `node_modules` 都不受影响
 * （AC-30 仍然成立：顶层只有 ws）。
 *
 * 一开始确实自己写了一版 QR 编码器（GF(256)、RS 纠错、掩码、手写 PNG，约 200 行）。
 * 图画出来结构完全正确 —— 三个定位角、校正图案、定时图案一应俱全 ——
 * **但用独立解码器一验，根本扫不出来**。修了一处格式信息位的放置错误后仍然扫不出。
 *
 * 于是停手。理由：这是个一次性产物，正确性是二元的，而现场扫不出来是灾难性的；
 * 继续盲调一个自研编码器，是拿婚礼当天去赌我对 ISO/IEC 18004 的记忆。
 * C6.4 写的是「新增依赖前必须先确认无法用标准库在 100 行内解决」——
 * 试过了，两百行还是错的，这条规则自己的豁免口径正好适用。
 *
 * ## 生成后必须验证
 *
 * 光看图像「像个二维码」没有意义。必须用一个**独立的解码器**验证它解出来
 * 确实是目标 URL（本项目用浏览器 + jsQR 验的）。自研那版就是栽在这一步。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = process.argv[2];
if (!url) {
  console.error('用法：node tools/genqr.js <url>');
  console.error('例：  node tools/genqr.js http://119.29.186.63:8888/');
  process.exit(1);
}

const out = fileURLToPath(new URL('../public/', import.meta.url));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

for (const [ext, type, extra] of [['png', 'png', ['-w', '480']], ['svg', 'svg', []]]) {
  execFileSync(npx, ['--yes', 'qrcode@1.5.4', '-o', `${out}qr.${ext}`, '-t', type, '-m', '4', ...extra, url], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const f = `${out}qr.${ext}`;
  if (!existsSync(f) || statSync(f).size === 0) {
    console.error(`生成失败：qr.${ext}`);
    process.exit(2);
  }
  console.log(`  public/qr.${ext}  ${statSync(f).size} 字节`);
}

console.log(`\n内容：${url}`);
console.log('⚠️  请用独立解码器验证它能扫出上面这个地址，不要只看图像像不像二维码。');
console.log('    打印成桌卡尺寸后，还要再用真手机实扫一次（FR-9.3）。');
