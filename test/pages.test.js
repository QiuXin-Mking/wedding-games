import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const PAGES = ['index', 'screen', 'host'];
const read = (n) => readFileSync(new URL(`../public/${n}.html`, import.meta.url), 'utf8');

describe('三端页面', () => {
  for (const name of PAGES) {
    test(`${name}.html 每一段脚本语法都正确`, () => {
      const src = read(name);
      // 必须覆盖**所有** <script>，不能只查 type=module。
      // 真实事故：index.html 的 boot 兜底脚本（普通 script）里写了
      // b.innerHTML='<div style="font:19px/1.6 'Songti SC',serif">'，
      // 单引号把 JS 字符串提前闭合 → 整块 SyntaxError → 进度函数 p 从未定义 →
      // 手机永远停在「正在进入」。当时 142 个测试全绿，因为只查了 module 块。
      const blocks = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
      // 宾客端有 boot 兜底 + 主模块两段；大屏与主持人端只有主模块一段
      assert.ok(blocks.length >= (name === 'index' ? 2 : 1), '脚本块数量不对');
      blocks.forEach(([, body], i) => {
        assert.doesNotThrow(
          () => new Function(body.replace(/^import .*$/gm, '')),
          `${name}.html 第 ${i + 1} 段脚本语法错误 —— 这一整块都不会执行`,
        );
      });
    });

    test(`${name}.html 不引任何外部资源`, () => {
      const ext = read(name).match(/(?:src|href)=["']?(https?:)?\/\/[^"' >]+/g);
      assert.deepEqual(ext, null, '外部资源会带来额外请求，违反单请求约束');
    });
  }

  test('手机端首屏 gzip < 10 KB（AC-31）', () => {
    const size = gzipSync(Buffer.from(read('index'), 'utf8'), { level: 9 }).length;
    assert.ok(size < 10 * 1024, `实际 ${(size / 1024).toFixed(1)} KB`);
  });

  test('手机端前 600 字节内出现可见文字（P-3 流式渲染）', () => {
    const src = read('index');
    const at = Buffer.byteLength(src.slice(0, src.indexOf('正在进入')), 'utf8');
    assert.ok(at < 600, `首个可见文字在第 ${at} 字节，400 人并发时出字会变慢`);
  });

  test('内容的可见性不得依赖动画跑起来', () => {
    // 标签页隐藏时浏览器会把动画冻在起始帧。用 opacity:0 作为起始帧的话，
    // 宾客锁屏再回来就可能看到一片空白。装饰可以动，正文不能。
    const css = read('index').match(/@keyframes rise\{[^}]*\}/)?.[0] ?? '';
    assert.equal(/opacity\s*:\s*0/.test(css), false, '昵称揭晓不得从 opacity:0 起步');
  });
});
