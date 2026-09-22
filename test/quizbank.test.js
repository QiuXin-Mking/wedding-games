import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadBank, validateBank, BANK_TEST, BANK_WEDDING } from '../src/quizbank.js';
import { RULES } from '../src/protocol.js';

/** 造一套合法题库：13 正题 + n 备用 */
function makeBank(spares = 3) {
  const q = (i, spare) => ({
    text: `题目 ${i}`,
    options: ['甲', '乙', '丙', '丁'],
    answer: i % 4,
    ...(spare ? { spare: true } : {}),
  });
  return [
    ...Array.from({ length: RULES.MAIN_QUESTIONS }, (_, i) => q(i, false)),
    ...Array.from({ length: spares }, (_, i) => q(i, true)),
  ];
}

function withTempBank(name, data, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'quizbank-'));
  try {
    if (data !== null) {
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(data), 'utf8');
    }
    return fn(pathToFileURL(join(dir, '/')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('题库校验（AC-17）', () => {
  test('合法题库通过', () => {
    assert.deepEqual(validateBank(makeBank()), []);
  });

  test('正题数 ≠ 13 被拒', () => {
    const bad = makeBank().filter((_, i) => i !== 0);
    const errs = validateBank(bad);
    assert.ok(errs.some((e) => e.includes('正题必须恰好 13 道')), errs.join('\n'));
  });

  test('备用题为 0 被拒 —— host:back 换题会无题可换', () => {
    const errs = validateBank(makeBank(0));
    assert.ok(errs.some((e) => e.includes('备用题至少')), errs.join('\n'));
  });

  test('正确选项下标越界被拒，且指出是第几条', () => {
    const bad = makeBank();
    bad[4].answer = 9;
    const errs = validateBank(bad);
    assert.ok(errs.some((e) => e.includes('第 5 条') && e.includes('越界')), errs.join('\n'));
  });

  test('题干为空被拒', () => {
    const bad = makeBank();
    bad[2].text = '   ';
    assert.ok(validateBank(bad).some((e) => e.includes('题干为空')));
  });

  test('选项少于 2 个被拒', () => {
    const bad = makeBank();
    bad[1].options = ['只有一个'];
    assert.ok(validateBank(bad).some((e) => e.includes('选项至少 2 个')));
  });

  test('空选项被拒', () => {
    const bad = makeBank();
    bad[3].options[2] = '';
    assert.ok(validateBank(bad).some((e) => e.includes('选项为空')));
  });
});

describe('题库切换（AC-15 / AC-16）', () => {
  test('不设环境变量时默认加载 test', () => {
    withTempBank(BANK_TEST, makeBank(), (dir) => {
      const b = loadBank({ dir });
      assert.equal(b.name, BANK_TEST);
      assert.equal(b.label, '测试题库');
    });
  });

  test('QUIZ_BANK=wedding 且文件存在时加载正式题库', () => {
    withTempBank(BANK_WEDDING, makeBank(), (dir) => {
      const b = loadBank({ bank: BANK_WEDDING, dir });
      assert.equal(b.name, BANK_WEDDING);
      assert.equal(b.label, '正式题库');
    });
  });

  test('指定 wedding 但文件缺失 → 抛错退出，绝不回退到 test', () => {
    // 同一目录下故意只放 test.json，确认它不会被拿来顶替
    withTempBank(BANK_TEST, makeBank(), (dir) => {
      assert.throws(
        () => loadBank({ bank: BANK_WEDDING, dir }),
        (e) => e.message.includes('拒绝回退') && e.message.includes('wedding.json'),
        '缺文件时必须失败，且错误里要说清拒绝回退',
      );
    });
  });

  test('QUIZ_BANK 取非法值被拒', () => {
    assert.throws(() => loadBank({ bank: 'production' }), /QUIZ_BANK 非法/);
  });

  test('题库内容非法时启动失败，且错误信息指出具体问题', () => {
    const bad = makeBank();
    bad[0].answer = 99;
    withTempBank(BANK_TEST, bad, (dir) => {
      assert.throws(
        () => loadBank({ dir }),
        (e) => e.message.includes('校验未通过') && e.message.includes('越界'),
      );
    });
  });
});

describe('备用题池（host:back 换题）', () => {
  test('按序取出，取完即无', () => {
    const b = loadBankFrom(makeBank(2));
    assert.equal(b.hasSpare, true);
    assert.equal(b.takeSpare().spareIndex, 0);
    assert.equal(b.takeSpare().spareIndex, 1);
    assert.equal(b.hasSpare, false);
    assert.equal(b.takeSpare(), null);
  });

  test('备用题不混进正题序列', () => {
    const b = loadBankFrom(makeBank(3));
    assert.equal(b.total, RULES.MAIN_QUESTIONS);
    assert.equal(b.main.every((q) => !q.spare), true);
  });

  test('重放可恢复备用题游标', () => {
    const b = loadBankFrom(makeBank(3));
    b.restoreSpareCursor(2);
    assert.equal(b.takeSpare().spareIndex, 2);
    assert.throws(() => b.restoreSpareCursor(-1), /非法的备用题游标/);
  });
});

function loadBankFrom(data) {
  return withTempBank(BANK_TEST, data, (dir) => loadBank({ dir }));
}

describe('真实测试题库', () => {
  test('仓库里的 questions/test.json 合法且可加载', () => {
    const b = loadBank({ bank: BANK_TEST });
    assert.equal(b.total, RULES.MAIN_QUESTIONS);
    assert.ok(b.spares.length >= RULES.MIN_SPARE_QUESTIONS);
  });
});
