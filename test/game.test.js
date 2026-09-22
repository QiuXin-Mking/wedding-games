import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Game, EV, CLOSE_REASON } from '../src/game.js';
import { QuizBank } from '../src/quizbank.js';
import { NicknamePool } from '../src/nicknames.js';
import { C2S, STAGE, OUTCOME, REJECT, RULES } from '../src/protocol.js';

const T0 = 1_000_000;

function makeGame({ spares = 3 } = {}) {
  const q = (i, spare) => ({
    text: `题目 ${i}`,
    options: ['A 选项', 'B 选项', 'C 选项', 'D 选项'],
    answer: 1, // 全部正确答案都是 B，便于写用例
    ...(spare ? { spare: true } : {}),
  });
  const bank = new QuizBank('test', [
    ...Array.from({ length: RULES.MAIN_QUESTIONS }, (_, i) => q(i, false)),
    ...Array.from({ length: spares }, (_, i) => q(100 + i, true)),
  ]);
  const pool = new NicknamePool(Array.from({ length: 400 }, (_, i) => `昵称${i}`));
  return new Game({ bank, nicknames: pool });
}

/** 开局 + n 位宾客入场 + 开第一题 */
function started(n = 3, at = T0) {
  const g = makeGame();
  const ids = Array.from({ length: n }, (_, i) => `c${i}`);
  for (const id of ids) g.join(id);
  g.hostAction(C2S.HOST_START, { expectedQIndex: -1 }, at);
  g.hostAction(C2S.HOST_NEXT, { expectedQIndex: -1 }, at);
  return { g, ids };
}

const CORRECT = 1;
const WRONG = 0;

describe('计分公式', () => {
  test('即答即对拿满分 300；13 题满分 3900', () => {
    const { g } = started(1);
    const r = g.answer('c0', 0, CORRECT, T0); // 剩 20000ms
    assert.equal(r.gained, 100 + 20 * 10);
    assert.equal(r.gained, 300);
    assert.equal(300 * RULES.MAIN_QUESTIONS, 3900);
  });

  test('答错 0 分，不扣分', () => {
    const { g } = started(1);
    assert.equal(g.answer('c0', 0, WRONG, T0 + 1000).gained, 0);
    assert.equal(g.tally('c0').total, 0);
  });

  test('剩 1 秒答对得 110', () => {
    const { g } = started(1);
    assert.equal(g.answer('c0', 0, CORRECT, T0 + 19_000).gained, 110);
  });
});

describe('AC-45 延长 10 秒后提交一律 0 分', () => {
  test('延长期间答对也是 0 分 —— 不存在「越慢分越高」', () => {
    const { g } = started(2);
    // c0 在原截止前 2 秒提交
    const early = g.answer('c0', 0, CORRECT, T0 + 18_000);
    assert.equal(early.gained, 120);

    g.hostAction(C2S.HOST_EXTEND, { expectedQIndex: 0 }, T0 + 19_000);

    // c1 在延长后第 1 秒提交 —— 比 c0 晚了整整 3 秒
    const late = g.answer('c1', 0, CORRECT, T0 + 21_000);
    assert.equal(late.gained, 0, '延长后提交必须 0 分，否则晚答者反而得分更高');
    assert.equal(late.outcome, OUTCOME.TIMEOUT,
      '延长期内提交记 timeout：延长只给看清题的机会、不补分，就不该算作一次有效作答');

    assert.ok(g.tally('c0').total > g.tally('c1').total, '早答者总分必须更高');
  });

  test('延长期内答对不得污染唱分与排行榜', () => {
    const { g } = started(2);
    g.answer('c0', 0, CORRECT, T0 + 1000);
    g.hostAction(C2S.HOST_EXTEND, { expectedQIndex: 0 }, T0 + 19_000);
    g.answer('c1', 0, CORRECT, T0 + 21_000);   // 延长期内答对

    assert.equal(g.correctCount(), 1,
      '主持人唱的「本题答对 N 人」不能把 0 分的人算进去');
    const t = g.tally('c1');
    assert.equal(t.correctCount, 0, '终局不能出现「答对 1 题、总分 0」这种自相矛盾');
    assert.equal(t.elapsedSum, 0, '不得把 >20 秒的耗时灌进排行榜第二排序键');
  });

  test('延长只推后结算时机，不改计分基准', () => {
    const { g } = started(1);
    const before = g.originalDeadlineAt;
    g.hostAction(C2S.HOST_EXTEND, { expectedQIndex: 0 }, T0 + 1000);
    assert.equal(g.originalDeadlineAt, before, 'originalDeadlineAt 不得被 extend 改动');
    assert.equal(g.deadlineAt, before + RULES.EXTEND_MS);
  });

  test('延长后仍可提交（不被 deadlinePassed 挡掉）', () => {
    const { g } = started(1);
    g.hostAction(C2S.HOST_EXTEND, { expectedQIndex: 0 }, T0 + 19_000);
    assert.equal(g.answer('c0', 0, CORRECT, T0 + 25_000).ok, true);
  });
});

describe('AC-04 倒计时内可改答案，按最后一次计分', () => {
  test('三次提交按最后一次算', () => {
    const { g } = started(1);
    g.answer('c0', 0, CORRECT, T0 + 1000); // 290
    g.answer('c0', 0, WRONG, T0 + 2000);
    const last = g.answer('c0', 0, CORRECT, T0 + 5000);
    assert.equal(last.gained, 100 + 15 * 10);
    assert.equal(g.tally('c0').total, 250, '总分只认最后一次，不得叠加');
  });

  test('从答对改成答错，总分与答对数都要跟着降', () => {
    const { g } = started(1);
    g.answer('c0', 0, CORRECT, T0 + 1000);
    assert.equal(g.tally('c0').correctCount, 1);
    g.answer('c0', 0, WRONG, T0 + 2000);
    const t = g.tally('c0');
    assert.equal(t.total, 0);
    assert.equal(t.correctCount, 0);
    assert.equal(t.elapsedSum, 0, '累计耗时也必须回退');
  });

  test('改答案会掉分（剩余时间变少）', () => {
    const { g } = started(1);
    g.answer('c0', 0, CORRECT, T0 + 1000);
    const a = g.tally('c0').total;
    g.answer('c0', 0, CORRECT, T0 + 9000);
    assert.ok(g.tally('c0').total < a);
  });
});

describe('AC-05 截止后提交不计分', () => {
  test('超过 deadlineAt 的提交被拒', () => {
    const { g } = started(1);
    const r = g.answer('c0', 0, CORRECT, T0 + RULES.QUESTION_MS + 1);
    assert.equal(r.ok, false);
    assert.equal(r.reason, REJECT.DEADLINE_PASSED);
  });

  test('从未提交者在结算时记 timeout、0 分', () => {
    const { g } = started(2);
    g.answer('c0', 0, CORRECT, T0 + 1000);
    g.tick(T0 + RULES.QUESTION_MS);
    assert.equal(g.stage, STAGE.REVEAL);
    assert.equal(g.myResultPayload('c1').outcome, OUTCOME.TIMEOUT);
    assert.equal(g.tally('c1').total, 0);
  });
});

describe('AC-46 自动结算的分母是已入场人数，不是在线人数', () => {
  test('game.js 不提供任何「在线」概念', () => {
    const { g } = started(3);
    assert.equal('online' in g, false);
    assert.equal(typeof g.joined, 'number');
    assert.equal(g.joined, 3, 'joined 只反映已入场，与连接状态无关');
  });

  test('只有部分人作答时不会提前结算 —— 掉线者不被当作不存在', () => {
    const { g } = started(10);
    // 模拟 7 人掉线（连 game.js 都不知道这件事），只有 3 人作答
    for (const id of ['c0', 'c1', 'c2']) g.answer(id, 0, CORRECT, T0 + 1000);
    g.tick(T0 + 2000);
    assert.equal(g.stage, STAGE.ASKING, '3/10 已答就结算的话，另外 7 人连题都看不到');
  });

  test('全部已入场者都作答后才自动结算', () => {
    const { g, ids } = started(4);
    for (const id of ids) g.answer(id, 0, CORRECT, T0 + 1000);
    const r = g.tick(T0 + 2000);
    assert.equal(g.stage, STAGE.REVEAL);
    assert.equal(r.reason, CLOSE_REASON.ALL_ANSWERED);
  });

  test('挂机不答由主持人 earlySettle 兜底，而不是缩小分母', () => {
    const { g } = started(5);
    g.answer('c0', 0, CORRECT, T0 + 1000);
    g.tick(T0 + 2000);
    assert.equal(g.stage, STAGE.ASKING);
    const r = g.hostAction(C2S.HOST_EARLY_SETTLE, { expectedQIndex: 0 }, T0 + 3000);
    assert.equal(r.ok, true);
    assert.equal(g.stage, STAGE.REVEAL);
    assert.equal(g.myResultPayload('c4').outcome, OUTCOME.TIMEOUT);
  });
});

describe('AC-13 / X-5 主持人动作幂等', () => {
  test('连续两次 host:next 带同一 expectedQIndex → 只前进一题', () => {
    const { g } = started(1);
    g.tick(T0 + RULES.QUESTION_MS); // → REVEAL，qIndex 仍为 0
    const first = g.hostAction(C2S.HOST_NEXT, { expectedQIndex: 0 }, T0 + 30_000);
    const second = g.hostAction(C2S.HOST_NEXT, { expectedQIndex: 0 }, T0 + 30_100);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.reason, REJECT.STALE_ACTION);
    assert.equal(g.qIndex, 1, '两台设备同时点也只能前进一题');
  });

  test('过期的 expectedQIndex 一律拒绝，并回报期望值便于排查', () => {
    const { g } = started(1);
    const r = g.hostAction(C2S.HOST_EXTEND, { expectedQIndex: 5 }, T0 + 1000);
    assert.equal(r.reason, REJECT.STALE_ACTION);
    assert.equal(r.expected, 0);
    assert.equal(r.got, 5);
  });

  test('迟到的旧题答案被丢弃', () => {
    const { g } = started(1);
    g.tick(T0 + RULES.QUESTION_MS);
    g.hostAction(C2S.HOST_NEXT, { expectedQIndex: 0 }, T0 + 30_000);
    const r = g.answer('c0', 0, CORRECT, T0 + 31_000); // 提交的是第 0 题
    assert.equal(r.reason, REJECT.STALE_ACTION);
  });
});

describe('republish 是纯读操作', () => {
  test('前后所有人的分数逐一相等', () => {
    const { g, ids } = started(3);
    g.answer('c0', 0, CORRECT, T0 + 1000);
    g.answer('c1', 0, WRONG, T0 + 2000);
    g.tick(T0 + RULES.QUESTION_MS);

    const before = ids.map((id) => g.tally(id));
    const r = g.hostAction(C2S.HOST_REPUBLISH, { expectedQIndex: 0 }, T0 + 25_000);
    const after = ids.map((id) => g.tally(id));

    assert.equal(r.ok, true);
    assert.deepEqual(after, before);
    assert.deepEqual(r.events, [], 'republish 不得产生任何事件');
  });
});

describe('skip：作废本题且不公布答案', () => {
  test('全员 skipped、0 分、不计入累计耗时', () => {
    const { g, ids } = started(3);
    g.answer('c0', 0, CORRECT, T0 + 1000);
    const r = g.hostAction(C2S.HOST_SKIP, { expectedQIndex: 0 }, T0 + 5000);
    assert.equal(r.ok, true);
    for (const id of ids) {
      assert.equal(g.myResultPayload(id).outcome, OUTCOME.SKIPPED);
      assert.equal(g.tally(id).total, 0);
      assert.equal(g.tally(id).elapsedSum, 0);
    }
  });

  test('结算画面不公布答案，也不给作答分布', () => {
    const { g } = started(2);
    g.hostAction(C2S.HOST_SKIP, { expectedQIndex: 0 }, T0 + 5000);
    const p = g.revealPayload();
    assert.equal(p.voided, true);
    assert.equal(p.correctIndex, -1, '主持人说作废、屏幕却公布答案会让全场困惑');
    assert.deepEqual(p.distribution, []);
  });

  test('宾客侧带一句解释（X-4）', () => {
    const { g } = started(1);
    const r = g.hostAction(C2S.HOST_SKIP, { expectedQIndex: 0 }, T0 + 5000);
    assert.ok(r.notice.text.includes('不是你的问题'));
  });
});

describe('back：换备用题，不重答已公布答案的原题', () => {
  test('换题后回到答题态，题目内容变了', () => {
    const { g } = started(2);
    const oldText = g.currentQuestion().text;
    g.tick(T0 + RULES.QUESTION_MS);
    const r = g.hostAction(C2S.HOST_BACK, { expectedQIndex: 0 }, T0 + 30_000);
    assert.equal(r.ok, true);
    assert.equal(g.stage, STAGE.ASKING);
    assert.equal(g.qIndex, 0, '仍是第 0 题的槽位');
    assert.notEqual(g.currentQuestion().text, oldText, '必须换成备用题');
  });

  test('原题的作答与得分被抹掉，新题重新计分', () => {
    const { g } = started(2);
    g.answer('c0', 0, CORRECT, T0 + 1000);
    assert.ok(g.tally('c0').total > 0);
    g.tick(T0 + RULES.QUESTION_MS);
    g.hostAction(C2S.HOST_BACK, { expectedQIndex: 0 }, T0 + 30_000);
    assert.equal(g.tally('c0').total, 0, '原题对任何人贡献 0 分');
    g.answer('c0', 0, CORRECT, T0 + 31_000);
    assert.ok(g.tally('c0').total > 0);
  });

  test('写入 QUESTION_SWAP 事件，作废可审计', () => {
    const { g } = started(1);
    g.tick(T0 + RULES.QUESTION_MS);
    const r = g.hostAction(C2S.HOST_BACK, { expectedQIndex: 0 }, T0 + 30_000);
    assert.equal(r.events[0].type, EV.QUESTION_SWAP);
    assert.equal(r.events[1].type, EV.QUESTION_OPEN);
  });

  test('备用题用尽后拒绝换题，而不是崩溃', () => {
    const g = makeGame({ spares: 1 });
    g.join('c0');
    g.hostAction(C2S.HOST_START, { expectedQIndex: -1 }, T0);
    g.hostAction(C2S.HOST_NEXT, { expectedQIndex: -1 }, T0);
    g.tick(T0 + RULES.QUESTION_MS);
    assert.equal(g.hostAction(C2S.HOST_BACK, { expectedQIndex: 0 }, T0 + 30_000).ok, true);
    g.tick(T0 + 60_000);
    const r = g.hostAction(C2S.HOST_BACK, { expectedQIndex: 0 }, T0 + 70_000);
    assert.equal(r.ok, false);
    assert.equal(r.detail, '备用题已用尽');
  });
});

describe('暂停与继续', () => {
  test('暂停期间提交一律拒绝', () => {
    const { g } = started(1);
    g.hostAction(C2S.HOST_PAUSE, { expectedQIndex: 0 }, T0 + 5000);
    assert.equal(g.answer('c0', 0, CORRECT, T0 + 6000).reason, REJECT.PAUSED);
  });

  test('暂停时长不算进宾客的思考时间', () => {
    const { g } = started(1);
    g.hostAction(C2S.HOST_PAUSE, { expectedQIndex: 0 }, T0 + 5000);   // 剩 15s
    g.hostAction(C2S.HOST_RESUME, { expectedQIndex: 0 }, T0 + 65_000); // 暂停了 60s
    // 恢复后立刻答对，应当仍视作「用了 5 秒」，即剩 15 秒
    const r = g.answer('c0', 0, CORRECT, T0 + 65_000);
    assert.equal(r.gained, 100 + 15 * 10, '暂停的 60 秒不得被算成宾客在思考');
  });
});

describe('排行榜（AC-25 名次唯一）', () => {
  test('总分降序 → 答对题累计耗时升序 → 入场序号升序', () => {
    const { g } = started(3);
    g.answer('c0', 0, CORRECT, T0 + 5000); // 250
    g.answer('c1', 0, CORRECT, T0 + 1000); // 290
    g.answer('c2', 0, WRONG, T0 + 1000);   // 0
    g.tick(T0 + RULES.QUESTION_MS);
    const board = g.leaderboard();
    assert.deepEqual(board.map((r) => r.clientId), ['c1', 'c0', 'c2']);
    assert.deepEqual(board.map((r) => r.rank), [1, 2, 3]);
  });

  test('总分相同时按累计耗时排序', () => {
    const { g } = started(2);
    // 两人都答对第 0 题、同样得分？构造成总分相同但耗时不同：
    // c0 第 0 题答对(290)，c1 第 0 题答对(290) —— 同分同耗时，再让 c1 第 1 题慢一点答对
    g.answer('c0', 0, CORRECT, T0 + 1000);
    g.answer('c1', 0, CORRECT, T0 + 1000);
    g.tick(T0 + RULES.QUESTION_MS);
    const t1 = T0 + 30_000;
    g.hostAction(C2S.HOST_NEXT, { expectedQIndex: 0 }, t1);
    g.answer('c0', 1, WRONG, t1 + 1000);
    g.answer('c1', 1, WRONG, t1 + 9000);
    g.tick(t1 + RULES.QUESTION_MS);
    const board = g.leaderboard();
    assert.equal(board[0].total, board[1].total, '前置条件：两人总分相同');
    assert.equal(board[0].clientId, 'c0', '答对题累计耗时短的在前');
  });

  test('名次唯一，不出现并列', () => {
    const { g } = started(5);
    g.tick(T0 + RULES.QUESTION_MS); // 全员 timeout，总分都是 0
    const ranks = g.leaderboard().map((r) => r.rank);
    assert.deepEqual(ranks, [1, 2, 3, 4, 5]);
  });
});

describe('X-3 question 载荷携带本人提交状态', () => {
  test('未提交时 mySubmitted=false', () => {
    const { g } = started(1);
    const p = g.questionPayloadFor('c0');
    assert.equal(p.mySubmitted, false);
    assert.equal(p.myOption, -1);
  });

  test('提交后重播 question，已提交态不丢失', () => {
    const { g } = started(1);
    g.answer('c0', 0, 2, T0 + 1000);
    g.hostAction(C2S.HOST_EXTEND, { expectedQIndex: 0 }, T0 + 19_000);
    const p = g.questionPayloadFor('c0');
    assert.equal(p.mySubmitted, true, 'extend 重播后前端要能还原选中态');
    assert.equal(p.myOption, 2);
  });
});

describe('主持人唱分数据（D14 / AC-38）', () => {
  test('结算态提供已答人数、答对人数、正确答案、当前第一名', () => {
    const { g } = started(4);
    g.answer('c0', 0, CORRECT, T0 + 1000);
    g.answer('c1', 0, CORRECT, T0 + 2000);
    g.answer('c2', 0, WRONG, T0 + 3000);
    g.tick(T0 + RULES.QUESTION_MS);
    const s = g.hostStatePayload();
    assert.equal(s.joined, 4);
    assert.equal(s.answered, 4, '结算后未提交者也记为已处理');
    assert.equal(s.correctCount, 2);
    assert.equal(s.correctIndex, CORRECT);
    assert.equal(s.leader.nickname, '昵称0');
  });
});

describe('入场与宾客管理', () => {
  test('重复 join 不重复发昵称', () => {
    const g = makeGame();
    const a = g.join('c0');
    const b = g.join('c0');
    assert.equal(b.rejoined, true);
    assert.equal(a.nickname, b.nickname);
    assert.equal(g.joined, 1);
  });

  test('公布排行后拒绝新入场', () => {
    const { g } = started(1);
    g.hostAction(C2S.HOST_FINISH, {}, T0 + 1000);
    assert.equal(g.join('newbie').reason, REJECT.GAME_FINISHED);
  });

  test('中途入场者从当前题开始，此前各题不计分但进排行榜', () => {
    const { g } = started(2);
    g.tick(T0 + RULES.QUESTION_MS);
    const t1 = T0 + 30_000;
    g.hostAction(C2S.HOST_NEXT, { expectedQIndex: 0 }, t1);
    g.join('late');
    assert.equal(g.joined, 3);
    g.answer('late', 1, CORRECT, t1 + 1000);
    assert.ok(g.leaderboard().some((r) => r.clientId === 'late'));
    assert.equal(g.tally('late').correctCount, 1);
  });

  test('主持人只能重新发放昵称，不能自定义', () => {
    const { g } = started(1);
    const before = g.guests.get('c0').nickname;
    const r = g.hostAction(C2S.HOST_NEXT_NICKNAME, { clientId: 'c0' }, T0);
    assert.equal(r.ok, true);
    assert.notEqual(r.nickname, before);
    assert.equal(g.guests.get('c0').nickname, r.nickname);
  });

  test('移除宾客后其成绩不再出现在排行榜', () => {
    const { g } = started(3);
    g.hostAction(C2S.HOST_REMOVE, { clientId: 'c1' }, T0);
    assert.equal(g.joined, 2);
    assert.equal(g.leaderboard().some((r) => r.clientId === 'c1'), false);
  });
});

describe('非法状态迁移被拒', () => {
  let g;
  beforeEach(() => { g = makeGame(); });

  test('IDLE 态不能直接开题', () => {
    assert.equal(g.hostAction(C2S.HOST_NEXT, { expectedQIndex: -1 }, T0).reason, REJECT.ILLEGAL_TRANSITION);
  });

  test('ASKING 态不能 republish', () => {
    const s = started(1);
    assert.equal(
      s.g.hostAction(C2S.HOST_REPUBLISH, { expectedQIndex: 0 }, T0).reason,
      REJECT.ILLEGAL_TRANSITION,
    );
  });

  test('REVEAL 态不能 extend', () => {
    const s = started(1);
    s.g.tick(T0 + RULES.QUESTION_MS);
    assert.equal(
      s.g.hostAction(C2S.HOST_EXTEND, { expectedQIndex: 0 }, T0).reason,
      REJECT.ILLEGAL_TRANSITION,
    );
  });

  test('非法动作返回 rejected 而不是抛异常', () => {
    assert.doesNotThrow(() => g.hostAction('host:nonsense', { expectedQIndex: -1 }, T0));
  });

  test('最后一题之后 next 直接进入终局', () => {
    const { g: gg } = started(1);
    for (let i = 0; i < RULES.MAIN_QUESTIONS; i++) {
      gg.tick(T0 + (i + 1) * 100_000);
      gg.hostAction(C2S.HOST_NEXT, { expectedQIndex: i }, T0 + (i + 1) * 100_000 + 1);
    }
    assert.equal(gg.stage, STAGE.FINAL);
  });
});
