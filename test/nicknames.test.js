import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NicknamePool, loadDefaultPool } from '../src/nicknames.js';
import { validatePool, MAX_SAME_FIRST_CHAR, MAX_SAME_LAST_CHAR } from '../src/nicknameRules.js';
import { RULES } from '../src/protocol.js';

const POOL_FILE = new URL('../nicknames.json', import.meta.url);
const REAL_POOL = JSON.parse(readFileSync(POOL_FILE, 'utf8'));

/** 用真实池做基底，改其中一条来构造违规样本 —— 保证只有被改的那条会报错 */
function poolWith(index, value) {
  const p = [...REAL_POOL];
  p[index] = value;
  return p;
}

describe('昵称池机器校验（AC-19 / AC-20）', () => {
  test('定稿池 U1~U5 全部通过', () => {
    const r = validatePool(REAL_POOL);
    const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
    assert.deepEqual(failed, [], failed.join('\n'));
    assert.equal(r.ok, true);
  });

  test('U6 / U7 明确标为需人工，不得被「机器全绿」掩盖', () => {
    const r = validatePool(REAL_POOL);
    assert.ok(r.manual.some((m) => m.startsWith('U6')));
    assert.ok(r.manual.some((m) => m.startsWith('U7')));
  });

  test('U1 整条重复被抓出', () => {
    const r = validatePool(poolWith(1, REAL_POOL[0]));
    assert.equal(r.checks.find((c) => c.id === 'U1').ok, false);
  });

  test('U2 末二字重复被抓出 —— 这是「8 条都以柯基结尾」的防线', () => {
    const tail = REAL_POOL[0].slice(-2);
    const r = validatePool(poolWith(1, `崭新的${tail}`));
    const u2 = r.checks.find((c) => c.id === 'U2');
    assert.equal(u2.ok, false);
    assert.ok(u2.detail.includes(tail));
  });

  test('U4 超长被抓出', () => {
    const r = validatePool(poolWith(5, '今天特别开心的小柯基'));
    assert.equal(r.checks.find((c) => c.id === 'U4').ok, false);
  });

  test('U4b 含非汉字被抓出', () => {
    const r = validatePool(poolWith(5, 'happy的柯基'));
    assert.equal(r.checks.find((c) => c.id === 'U4b').ok, false);
  });

  test('U5 禁用词被抓出，并指出类别与命中字', () => {
    const r = validatePool(poolWith(5, '贪吃的鹌鹑'));
    const u5 = r.checks.find((c) => c.id === 'U5');
    assert.equal(u5.ok, false);
    assert.ok(u5.detail.includes('食量身材'), u5.detail);
  });

  test('U5 婚礼忌讳字被抓出（这条真的漏网过：「沉稳的海龟」含「龟」）', () => {
    const r = validatePool(poolWith(5, '沉稳的海龟'));
    const u5 = r.checks.find((c) => c.id === 'U5');
    assert.equal(u5.ok, false);
    assert.ok(u5.detail.includes('龟'), u5.detail);
  });

  test('白名单豁免生效：「老虎」不因含「老」被误杀', () => {
    const r = validatePool(poolWith(5, '威风的老虎'));
    assert.equal(r.checks.find((c) => c.id === 'U5').ok, true);
  });

  test('白名单只豁免该词本身，不豁免同字的其他词', () => {
    const r = validatePool(poolWith(5, '很老的绵羊'));
    assert.equal(r.checks.find((c) => c.id === 'U5').ok, false);
  });

  test('池容量不为 400 被抓出', () => {
    assert.equal(validatePool(REAL_POOL.slice(0, 399)).checks.find((c) => c.id === 'U0').ok, false);
  });

  test('首字与末字的集中度实测留有余量', () => {
    const count = (f) => {
      const m = new Map();
      for (const n of REAL_POOL) m.set(f(n), (m.get(f(n)) ?? 0) + 1);
      return Math.max(...m.values());
    };
    assert.ok(count((n) => n[0]) <= MAX_SAME_FIRST_CHAR);
    assert.ok(count((n) => n[n.length - 1]) <= MAX_SAME_LAST_CHAR);
  });
});

describe('昵称发放（AC-24 / AC-25 / AC-26）', () => {
  test('加载定稿池不抛错', () => {
    const p = loadDefaultPool();
    assert.equal(p.pool.length, RULES.NICKNAME_POOL_SIZE);
    assert.equal(p.issued, 0);
  });

  test('400 位宾客依次入场，与池文件逐一对应且互不重复', () => {
    const p = loadDefaultPool();
    const got = Array.from({ length: 400 }, () => p.issue().nickname);
    assert.deepEqual(got, REAL_POOL);
    assert.equal(new Set(got).size, 400);
  });

  test('相同入场顺序重跑两次，结果完全一致（运行时零随机）', () => {
    const a = Array.from({ length: 50 }, (_, i) => loadDefaultPool()).map((p) => p.issue().nickname);
    assert.equal(new Set(a).size, 1, '每个新池的第一个都应相同');

    const run = () => {
      const p = loadDefaultPool();
      return Array.from({ length: 120 }, () => p.issue().nickname);
    };
    assert.deepEqual(run(), run());
  });

  test('第 401 位触发兜底命名且不崩溃', () => {
    const p = loadDefaultPool();
    for (let i = 0; i < 400; i++) p.issue();
    assert.equal(p.exhausted, true);
    const r = p.issue();
    assert.equal(r.fallback, true);
    assert.equal(r.nickname, `${REAL_POOL[0]} 401`);
  });

  test('兜底命名仍然互不重复', () => {
    const p = loadDefaultPool();
    const got = Array.from({ length: 405 }, () => p.issue().nickname);
    assert.equal(new Set(got).size, 405);
  });

  test('重放恢复游标后，下一位拿到第 N+1 条而非重复条目（AC-09）', () => {
    const p = loadDefaultPool();
    p.restore(37);
    assert.equal(p.issue().nickname, REAL_POOL[37]);
    assert.throws(() => p.restore(-1), /非法的昵称游标/);
    assert.throws(() => p.restore(1.5), /非法的昵称游标/);
  });

  test('坏池子拒绝加载 —— 不带着违规数据启动', () => {
    assert.throws(
      () => new NicknamePool([]) && NicknamePool.load(new URL('./nonexistent.json', import.meta.url)),
      /昵称池读取失败/,
    );
  });
});
