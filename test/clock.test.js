import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { now, wallNow } from '../src/clock.js';

describe('AC-14 单调时钟不受系统时间跳变影响', () => {
  test('把 Date.now 向前跳 30 秒，now() 纹丝不动', () => {
    const real = Date.now;
    const before = now();
    try {
      Date.now = () => real() + 30_000;   // 模拟 NTP 向前校时
      const after = now();
      const drift = after - before;
      assert.ok(drift < 100, `now() 跟着跳了 ${drift.toFixed(0)}ms —— 倒计时会瞬间归零`);
    } finally {
      Date.now = real;
    }
  });

  test('把 Date.now 向后跳 30 秒，now() 仍单调递增', () => {
    const real = Date.now;
    const before = now();
    try {
      Date.now = () => real() - 30_000;   // 模拟 NTP 向后校时
      const after = now();
      assert.ok(after >= before, 'now() 倒流了 —— 已作答的人会被重新判成超时');
    } finally {
      Date.now = real;
    }
  });

  test('now() 严格单调递增', () => {
    let prev = now();
    for (let i = 0; i < 2000; i++) {
      const cur = now();
      assert.ok(cur >= prev, '单调时钟出现倒退');
      prev = cur;
    }
  });

  test('wallNow() 是真实墙钟，只给人看，不参与计时判定', () => {
    const real = Date.now;
    try {
      Date.now = () => 1234567890;
      assert.equal(wallNow(), 1234567890, '事件日志的 ts 需要真实绝对时间');
    } finally {
      Date.now = real;
    }
  });
});
