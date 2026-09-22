import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { exportDetailCsv } from '../src/csv.js';
import { Game } from '../src/game.js';
import { QuizBank } from '../src/quizbank.js';
import { NicknamePool } from '../src/nicknames.js';
import { C2S, RULES } from '../src/protocol.js';

const T0 = 1_000_000;
const CORRECT = 1;

function playedGame({ guests = 3, questions = 2 } = {}) {
  const q = (i, spare) => ({
    text: i === 0 ? '带,逗号 和"引号"的题干' : `题目 ${i}`,
    options: ['甲', '乙', '丙', '丁'],
    answer: 1,
    ...(spare ? { spare: true } : {}),
  });
  const bank = new QuizBank('test', [
    ...Array.from({ length: RULES.MAIN_QUESTIONS }, (_, i) => q(i, false)),
    q(100, true),
  ]);
  const pool = new NicknamePool(Array.from({ length: 400 }, (_, i) => `昵称${i}`));
  const g = new Game({ bank, nicknames: pool });

  for (let i = 0; i < guests; i++) g.join(`c${i}`);
  g.hostAction(C2S.HOST_START, { expectedQIndex: -1 }, T0);
  let t = T0;
  for (let qi = 0; qi < questions; qi++) {
    g.hostAction(C2S.HOST_NEXT, { expectedQIndex: qi - 1 }, t);
    // 第 0 位答对，第 1 位答错，其余不答
    g.answer('c0', qi, CORRECT, t + 1000);
    if (guests > 1) g.answer('c1', qi, 0, t + 2000);
    t += 100_000;
    g.tick(t);
  }
  return g;
}

describe('AC-32 CSV 导出', () => {
  test('带 UTF-8 BOM —— 否则 Excel 会按 GBK 解释，整张表中文全乱', () => {
    const csv = exportDetailCsv(playedGame());
    assert.equal(csv.charCodeAt(0), 0xfeff);
  });

  test('行数 = 宾客数 × 题数（加一行表头）', () => {
    const g = playedGame({ guests: 4 });
    const lines = exportDetailCsv(g).trim().split('\r\n');
    assert.equal(lines.length, 1 + 4 * RULES.MAIN_QUESTIONS);
  });

  test('含逗号与引号的题干被正确转义', () => {
    const csv = exportDetailCsv(playedGame());
    assert.ok(csv.includes('"带,逗号 和""引号""的题干"'),
      '转义错了的话，Excel 会把一行拆成好几列，整张表错位');
  });

  test('表头覆盖赛后发奖需要的全部字段', () => {
    const header = exportDetailCsv(playedGame()).split('\r\n')[0].replace('﻿', '');
    for (const col of ['昵称', '题号', '所选选项', '正确选项', '结果', '本题得分', '总分', '最终名次']) {
      assert.ok(header.includes(col), `缺列：${col}`);
    }
  });

  test('四种结果都翻成中文，不把 outcome 枚举值直接甩给人看', () => {
    const g = playedGame({ guests: 3 });
    g.hostAction(C2S.HOST_NEXT, { expectedQIndex: 1 }, T0 + 500_000);
    g.hostAction(C2S.HOST_SKIP, { expectedQIndex: 2 }, T0 + 501_000);
    const csv = exportDetailCsv(g);
    for (const w of ['答对', '答错', '未作答', '本题作废']) {
      assert.ok(csv.includes(w), `缺结果文案：${w}`);
    }
    assert.equal(csv.includes('timeout'), false, '不能把枚举值直接写进给人看的表');
  });

  test('作废的题不在「正确选项」列公布答案', () => {
    const g = playedGame({ guests: 2 });
    g.hostAction(C2S.HOST_NEXT, { expectedQIndex: 1 }, T0 + 500_000);
    g.hostAction(C2S.HOST_SKIP, { expectedQIndex: 2 }, T0 + 501_000);
    assert.ok(exportDetailCsv(g).includes('（本题作废）'));
  });

  test('按最终名次排序，第一行是第一名', () => {
    const g = playedGame({ guests: 3 });
    const rows = exportDetailCsv(g).trim().split('\r\n').slice(1);
    const firstNick = rows[0].split(',')[0];
    assert.equal(firstNick, g.leaderboard()[0].nickname);
    assert.equal(rows[0].split(',').at(-1), '1');
  });

  test('导出是纯读，不改动任何分数', () => {
    const g = playedGame({ guests: 3 });
    const before = ['c0', 'c1', 'c2'].map((id) => g.tally(id));
    exportDetailCsv(g);
    assert.deepEqual(['c0', 'c1', 'c2'].map((id) => g.tally(id)), before);
  });
});
