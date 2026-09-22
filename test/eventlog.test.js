import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLog, replayInto, RESUME_WINDOW_MS } from '../src/eventlog.js';
import { Game, EV } from '../src/game.js';
import { QuizBank } from '../src/quizbank.js';
import { NicknamePool } from '../src/nicknames.js';
import { C2S, STAGE, OUTCOME, RULES } from '../src/protocol.js';

const T0 = 1_000_000;
const CORRECT = 1;
const WRONG = 0;

function freshGame() {
  const q = (i, spare) => ({
    text: `题目 ${i}`,
    options: ['A', 'B', 'C', 'D'],
    answer: 1,
    ...(spare ? { spare: true } : {}),
  });
  const bank = new QuizBank('test', [
    ...Array.from({ length: RULES.MAIN_QUESTIONS }, (_, i) => q(i, false)),
    ...Array.from({ length: 3 }, (_, i) => q(100 + i, true)),
  ]);
  const pool = new NicknamePool(Array.from({ length: 400 }, (_, i) => `昵称${i}`));
  return new Game({ bank, nicknames: pool });
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'evlog-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 跑一场，把所有事件写进日志。返回 {game, log, dir}
 * 这是「崩溃前」的现场。
 */
function playSession(dir, script) {
  const game = freshGame();
  const log = EventLog.create(dir);
  const rec = (r) => log.append(r.events ?? []);
  script({ game, rec, log });
  return { game, log };
}

describe('追加写', () => {
  test('每条事件一行 JSON，seq 自增', () => {
    withDir((dir) => {
      const log = EventLog.create(dir);
      log.append([{ type: 'a' }, { type: 'b' }]);
      log.append([{ type: 'c' }]);
      log.close();
      const lines = readFileSync(log.file, 'utf8').trim().split('\n');
      assert.equal(lines.length, 3);
      assert.deepEqual(lines.map((l) => JSON.parse(l).seq), [1, 2, 3]);
      assert.ok(JSON.parse(lines[0]).ts > 0, '每条都要带墙钟时间供人阅读');
    });
  });

  test('空事件数组不写盘', () => {
    withDir((dir) => {
      const log = EventLog.create(dir);
      assert.deepEqual(log.append([]), []);
      log.close();
      assert.equal(readFileSync(log.file, 'utf8'), '');
    });
  });

  test('崩溃截断的半行被跳过，不拖垮整场恢复', () => {
    withDir((dir) => {
      const log = EventLog.create(dir);
      log.append([{ type: 'a' }, { type: 'b' }]);
      log.close();
      appendFileSync(log.file, '{"seq":3,"type":"hal', 'utf8'); // 写了一半就断电
      const events = EventLog.parse(readFileSync(log.file, 'utf8'));
      assert.equal(events.length, 2);
    });
  });

  test('openResumable 接着上次的 seq 继续写', () => {
    withDir((dir) => {
      const a = EventLog.create(dir);
      a.append([{ type: 'x' }, { type: 'y' }]);
      a.close();
      const found = EventLog.openResumable(dir);
      assert.equal(found.stale, false);
      assert.equal(found.log.seq, 2);
      const [ev] = found.log.append([{ type: 'z' }]);
      assert.equal(ev.seq, 3);
      found.log.close();
    });
  });

  test('目录为空时 openResumable 返回 null', () => {
    withDir((dir) => assert.equal(EventLog.openResumable(dir), null));
  });
});

describe('H1 彩排日志不得污染当天（只续用还热着的日志）', () => {
  test('几天前的日志被判为 stale，不续用', () => {
    withDir((dir) => {
      const log = EventLog.create(dir);
      log.append([{ type: 'boot' }, { type: 'game_finish' }]);
      log.close();
      // 假装现在是 5 天之后 —— 彩排 9/28，婚礼 10/6
      const found = EventLog.openResumable(dir, { now: Date.now() + 5 * 86400000 });
      assert.equal(found.stale, true, '五天前的彩排日志绝不能被当成本场继续');
      assert.equal(found.log, null, 'stale 时不得返回可写句柄');
      assert.ok(found.ageMs > RESUME_WINDOW_MS);
    });
  });

  test('刚刚的日志仍然续用 —— 崩溃两秒后被拉起不能丢掉这一场', () => {
    withDir((dir) => {
      const log = EventLog.create(dir);
      log.append([{ type: 'boot' }, { type: 'guest_join', clientId: 'a', nickname: 'n', cursor: 0 }]);
      log.close();
      const found = EventLog.openResumable(dir);
      assert.equal(found.stale, false);
      assert.ok(found.log, '崩溃恢复必须能接上');
      found.log.close();
    });
  });

  test('跨零点重启仍在窗口内', () => {
    withDir((dir) => {
      const log = EventLog.create(dir);
      log.append([{ type: 'boot' }]);
      log.close();
      const found = EventLog.openResumable(dir, { now: Date.now() + 2 * 60 * 1000 });
      assert.equal(found.stale, false, '两分钟前的日志必须续用');
      found.log.close();
    });
  });
});

describe('AC-09 崩溃重放', () => {
  test('人数、昵称、各人总分、昵称游标全部一致', () => {
    withDir((dir) => {
      const { game, log } = playSession(dir, ({ game, rec }) => {
        for (const id of ['c0', 'c1', 'c2']) rec(game.join(id));
        rec(game.hostAction(C2S.HOST_START, { expectedQIndex: -1 }, T0));
        rec(game.hostAction(C2S.HOST_NEXT, { expectedQIndex: -1 }, T0));
        rec(game.answer('c0', 0, CORRECT, T0 + 1000));
        rec(game.answer('c1', 0, WRONG, T0 + 2000));
        rec(game.tick(T0 + RULES.QUESTION_MS));
      });
      log.close();

      const before = {
        joined: game.joined,
        names: [...game.guests.values()].map((g) => g.nickname),
        tallies: ['c0', 'c1', 'c2'].map((id) => game.tally(id)),
        cursor: game.nicknames.cursor,
      };

      const revived = freshGame();
      const r = replayInto(revived, EventLog.parse(readFileSync(log.file, 'utf8')));

      assert.equal(revived.joined, before.joined);
      assert.deepEqual([...revived.guests.values()].map((g) => g.nickname), before.names);
      assert.deepEqual(['c0', 'c1', 'c2'].map((id) => revived.tally(id)), before.tallies);
      assert.equal(revived.nicknames.cursor, before.cursor);
      assert.equal(r.stage, STAGE.REVEAL);
      assert.equal(r.qIndex, 0);
    });
  });

  test('重启后下一位新宾客拿到第 N+1 条，不与已有宾客重名', () => {
    withDir((dir) => {
      const { log } = playSession(dir, ({ game, rec }) => {
        for (let i = 0; i < 37; i++) rec(game.join(`c${i}`));
      });
      log.close();

      const revived = freshGame();
      replayInto(revived, EventLog.parse(readFileSync(log.file, 'utf8')));
      const r = revived.join('newbie');
      assert.equal(r.nickname, '昵称37');
      const all = [...revived.guests.values()].map((g) => g.nickname);
      assert.equal(new Set(all).size, all.length, '绝不把同一昵称分给第二个人');
    });
  });

  test('同一题多条 answer，重放后以最后一条为准', () => {
    withDir((dir) => {
      const { game, log } = playSession(dir, ({ game, rec }) => {
        rec(game.join('c0'));
        rec(game.hostAction(C2S.HOST_START, { expectedQIndex: -1 }, T0));
        rec(game.hostAction(C2S.HOST_NEXT, { expectedQIndex: -1 }, T0));
        rec(game.answer('c0', 0, CORRECT, T0 + 1000)); // 290
        rec(game.answer('c0', 0, WRONG, T0 + 2000));   // 0 —— 最后一次
        rec(game.tick(T0 + RULES.QUESTION_MS));
      });
      log.close();

      const raw = EventLog.parse(readFileSync(log.file, 'utf8'));
      assert.equal(raw.filter((e) => e.type === EV.ANSWER).length, 2, '两次提交都要留痕');

      const revived = freshGame();
      replayInto(revived, raw);
      assert.equal(revived.tally('c0').total, 0);
      assert.equal(game.tally('c0').total, 0);
    });
  });

  test('question_swap 重放：原题作废、槽位换成备用题、备用游标不回退', () => {
    withDir((dir) => {
      const { log } = playSession(dir, ({ game, rec }) => {
        rec(game.join('c0'));
        rec(game.hostAction(C2S.HOST_START, { expectedQIndex: -1 }, T0));
        rec(game.hostAction(C2S.HOST_NEXT, { expectedQIndex: -1 }, T0));
        rec(game.answer('c0', 0, CORRECT, T0 + 1000));
        rec(game.tick(T0 + RULES.QUESTION_MS));
        rec(game.hostAction(C2S.HOST_BACK, { expectedQIndex: 0 }, T0 + 30_000));
      });
      log.close();

      const revived = freshGame();
      replayInto(revived, EventLog.parse(readFileSync(log.file, 'utf8')));
      assert.equal(revived.tally('c0').total, 0, '原题不再贡献分数');
      assert.equal(revived.currentQuestion().text, '题目 100', '槽位已换成第一道备用题');
      assert.equal(revived.bank.spareCursor, 1, '备用游标不得回退，否则会重复取同一道');
    });
  });

  test('question_skip 重放：全员 skipped 且不计入累计耗时', () => {
    withDir((dir) => {
      const { log } = playSession(dir, ({ game, rec }) => {
        for (const id of ['c0', 'c1']) rec(game.join(id));
        rec(game.hostAction(C2S.HOST_START, { expectedQIndex: -1 }, T0));
        rec(game.hostAction(C2S.HOST_NEXT, { expectedQIndex: -1 }, T0));
        rec(game.answer('c0', 0, CORRECT, T0 + 1000));
        rec(game.hostAction(C2S.HOST_SKIP, { expectedQIndex: 0 }, T0 + 5000));
      });
      log.close();

      const revived = freshGame();
      replayInto(revived, EventLog.parse(readFileSync(log.file, 'utf8')));
      assert.equal(revived.voided.has(0), true);
      for (const id of ['c0', 'c1']) {
        assert.equal(revived.tally(id).total, 0);
        assert.equal(revived.tally(id).elapsedSum, 0);
      }
    });
  });

  test('被移除的宾客不会在重放后复活', () => {
    withDir((dir) => {
      const { log } = playSession(dir, ({ game, rec }) => {
        for (const id of ['c0', 'c1']) rec(game.join(id));
        rec(game.hostAction(C2S.HOST_REMOVE, { clientId: 'c1' }, T0));
      });
      log.close();

      const revived = freshGame();
      replayInto(revived, EventLog.parse(readFileSync(log.file, 'utf8')));
      assert.equal(revived.joined, 1);
      assert.equal(revived.guests.has('c1'), false);
    });
  });

  test('重发昵称后重放，取最后那个昵称', () => {
    withDir((dir) => {
      const { log } = playSession(dir, ({ game, rec }) => {
        rec(game.join('c0'));
        rec(game.hostAction(C2S.HOST_NEXT_NICKNAME, { clientId: 'c0' }, T0));
      });
      log.close();
      const revived = freshGame();
      replayInto(revived, EventLog.parse(readFileSync(log.file, 'utf8')));
      assert.equal(revived.guests.get('c0').nickname, '昵称1');
      assert.equal(revived.nicknames.cursor, 2, '两次发放都要消耗池容量');
    });
  });
});

describe('恢复落点', () => {
  test('崩在答题中也落在结算态，并标记 interrupted', () => {
    withDir((dir) => {
      const { log } = playSession(dir, ({ game, rec }) => {
        rec(game.join('c0'));
        rec(game.hostAction(C2S.HOST_START, { expectedQIndex: -1 }, T0));
        rec(game.hostAction(C2S.HOST_NEXT, { expectedQIndex: -1 }, T0));
        rec(game.answer('c0', 0, CORRECT, T0 + 1000));
        // 这里崩溃：没有 question_close
      });
      log.close();

      const revived = freshGame();
      const r = replayInto(revived, EventLog.parse(readFileSync(log.file, 'utf8')));
      assert.equal(r.stage, STAGE.REVEAL, '不自动续跑 —— 原截止早已过去');
      assert.equal(r.interrupted, true, '主持人需要知道这题是被打断的');
    });
  });

  test('正常结算后崩溃，不标记 interrupted', () => {
    withDir((dir) => {
      const { log } = playSession(dir, ({ game, rec }) => {
        rec(game.join('c0'));
        rec(game.hostAction(C2S.HOST_START, { expectedQIndex: -1 }, T0));
        rec(game.hostAction(C2S.HOST_NEXT, { expectedQIndex: -1 }, T0));
        rec(game.tick(T0 + RULES.QUESTION_MS));
      });
      log.close();
      const revived = freshGame();
      assert.equal(replayInto(revived, EventLog.parse(readFileSync(log.file, 'utf8'))).interrupted, false);
    });
  });

  test('开局前崩溃 → IDLE；已开局未出题 → READY；已结束 → FINAL', () => {
    withDir((dir) => {
      const a = freshGame();
      assert.equal(replayInto(a, []).stage, STAGE.IDLE);

      const b = freshGame();
      assert.equal(replayInto(b, [{ type: EV.GAME_START }]).stage, STAGE.READY);

      const c = freshGame();
      const r = replayInto(c, [
        { type: EV.GAME_START },
        { type: EV.QUESTION_OPEN, qIndex: 0, originalDeadlineAt: T0, deadlineAt: T0 },
        { type: EV.QUESTION_CLOSE, qIndex: 0 },
        { type: EV.GAME_FINISH },
      ]);
      assert.equal(r.stage, STAGE.FINAL);
      assert.equal(r.interrupted, false);
    });
  });

  test('恢复后主持人可直接换备用题继续 —— 不需要为崩溃新增任何机制', () => {
    withDir((dir) => {
      const { log } = playSession(dir, ({ game, rec }) => {
        rec(game.join('c0'));
        rec(game.hostAction(C2S.HOST_START, { expectedQIndex: -1 }, T0));
        rec(game.hostAction(C2S.HOST_NEXT, { expectedQIndex: -1 }, T0));
      });
      log.close();

      const revived = freshGame();
      replayInto(revived, EventLog.parse(readFileSync(log.file, 'utf8')));
      assert.equal(revived.hostAction(C2S.HOST_BACK, { expectedQIndex: 0 }, T0 + 60_000).ok, true);
      assert.equal(revived.stage, STAGE.ASKING);
    });
  });
});

describe('timeout 记录的重放一致性', () => {
  test('未作答者的记录逐字段一致 —— 只比分数会漏掉这个 bug', () => {
    withDir((dir) => {
      const { game, log } = playSession(dir, ({ game, rec }) => {
        for (const id of ['c0', 'c1']) rec(game.join(id));
        rec(game.hostAction(C2S.HOST_START, { expectedQIndex: -1 }, T0));
        rec(game.hostAction(C2S.HOST_NEXT, { expectedQIndex: -1 }, T0));
        rec(game.answer('c0', 0, CORRECT, T0 + 1000));
        // c1 全程不答 —— 结算时会被记 timeout
        rec(game.tick(T0 + RULES.QUESTION_MS));
      });
      log.close();

      const revived = freshGame();
      replayInto(revived, EventLog.parse(readFileSync(log.file, 'utf8')));

      const rec1 = game.guests.get('c1').answers.get(0);
      const rec2 = revived.guests.get('c1').answers.get(0);
      assert.equal(rec1.outcome, OUTCOME.TIMEOUT);
      assert.deepEqual(rec2, rec1,
        'timeout 记录的 elapsedMs 曾经现场写 20000、重放写 0；' +
        '分数都是 0 所以测试全绿，直到 CSV 导出才会露馅');
      // 分数确实相同 —— 正是这一点让 bug 藏了下来
      assert.deepEqual(revived.tally('c1'), game.tally('c1'));
    });
  });
});

describe('一场完整 13 题的重放等价性', () => {
  test('重放出来的排行榜与崩溃前逐行相同', () => {
    withDir((dir) => {
      const { game, log } = playSession(dir, ({ game, rec }) => {
        for (let i = 0; i < 8; i++) rec(game.join(`c${i}`));
        rec(game.hostAction(C2S.HOST_START, { expectedQIndex: -1 }, T0));
        let t = T0;
        for (let q = 0; q < RULES.MAIN_QUESTIONS; q++) {
          rec(game.hostAction(C2S.HOST_NEXT, { expectedQIndex: q - 1 }, t));
          for (let i = 0; i < 8; i++) {
            // 制造分数差异：有人快有人慢，有人答错
            const correct = (i + q) % 3 !== 0 ? CORRECT : WRONG;
            rec(game.answer(`c${i}`, q, correct, t + 500 + i * 900));
          }
          t += 100_000;
          rec(game.tick(t));
        }
        rec(game.hostAction(C2S.HOST_FINISH, {}, t));
      });
      log.close();

      const revived = freshGame();
      replayInto(revived, EventLog.parse(readFileSync(log.file, 'utf8')));

      const strip = (b) => b.map(({ clientId, nickname, total, correctCount, elapsedSum, rank }) =>
        ({ clientId, nickname, total, correctCount, elapsedSum, rank }));
      assert.deepEqual(strip(revived.leaderboard()), strip(game.leaderboard()));

      // 不能只比分数。分数相同但原始记录不同的话，CSV 导出会与现场对不上。
      const records = (gm) => [...gm.guests.values()].map((g) => [g.clientId, [...g.answers.entries()]]);
      assert.deepEqual(records(revived), records(game), '每题的原始作答记录必须逐字段一致');
      assert.equal(revived.stage, STAGE.FINAL);
      assert.ok(revived.leaderboard()[0].total > 0, '前置条件：确实有人得分');
    });
  });
});
