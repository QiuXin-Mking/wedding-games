/**
 * 事件日志与崩溃重放（docs/01 §6，design §3）。
 *
 * 全场唯一的持久化。每次状态变更**同步追加**一行 JSON，不做批量延迟写。
 *
 * 服务端的编排顺序是**先写盘、再广播** —— 反过来的话，崩溃恢复后大屏显示的题号
 * 会比日志新，重放出来的状态和宾客刚才看到的对不上。
 *
 * 关于 fsync：这里只做 writeSync，不做 fsyncSync。我们的故障模型是「进程挂掉、
 * systemd 两秒拉起」，而 writeSync 写完数据已在内核页缓存里，进程崩溃不会丢；
 * 只有整机断电才会丢。为了防断电而每行 fsync，会把 5200 次作答写成磁盘瓶颈，
 * 不划算。
 */

import { openSync, writeSync, closeSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EV } from './game.js';
import { STAGE, OUTCOME, RULES } from './protocol.js';
import { wallNow } from './clock.js';

export class EventLog {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    this.seq = 0;
    this.fd = openSync(file, 'a');
  }

  /**
   * 在 dir 下新建一个以启动时刻命名的日志。
   * @param {string} dir
   */
  static create(dir) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return new EventLog(join(dir, `${stamp}.jsonl`));
  }

  /**
   * 打开 dir 下最新的日志继续追加（崩溃重启后走这条）。
   * @param {string} dir
   * @returns {EventLog|null} 没有历史日志时返回 null
   */
  static openLatest(dir) {
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    if (files.length === 0) return null;
    const log = new EventLog(join(dir, files[files.length - 1]));
    log.seq = log.read().at(-1)?.seq ?? 0;
    return log;
  }

  /**
   * 追加一批事件。同步落盘。
   * @param {Array<object>} events
   * @returns {Array<object>} 补齐了 seq / ts 的事件
   */
  append(events) {
    if (!events || events.length === 0) return [];
    const stamped = events.map((e) => ({ seq: ++this.seq, ts: wallNow(), ...e }));
    writeSync(this.fd, stamped.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return stamped;
  }

  /** 读回全部事件。坏行跳过并记录 —— 崩溃可能截断最后一行 */
  read() {
    return EventLog.parse(readFileSync(this.file, 'utf8'));
  }

  close() {
    closeSync(this.fd);
  }

  /**
   * @param {string} text
   * @returns {Array<object>}
   */
  static parse(text) {
    const out = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // 崩溃可能把最后一行写了一半。丢掉半行，不要让整场恢复失败。
      }
    }
    return out;
  }
}

/**
 * 把事件重放进一个全新的 Game，恢复崩溃前的状态。
 *
 * **落点固定在「上一道已开启题目的结算态」**，即使崩溃时正处于答题中。
 * 理由：崩溃到拉起可能耗时数十秒，原截止时刻早已过去，自动续跑会让宾客
 * 莫名其妙地「还没看到题就超时了」。恢复后由主持人决定换备用题还是继续下一题 ——
 * 这两条路本来就在动作表里，不需要为崩溃恢复新增任何机制。
 *
 * @param {import('./game.js').Game} game 全新实例
 * @param {Array<object>} events
 * @returns {{applied: number, stage: string, qIndex: number, interrupted: boolean}}
 */
export function replayInto(game, events) {
  let maxNickCursor = -1;
  let maxSpareIndex = -1;
  let started = false;
  let finished = false;
  let lastOpened = -1;
  /** 最后一题是否被正常关闭（没关闭说明崩在答题中） */
  let lastClosed = true;

  for (const e of events) {
    switch (e.type) {
      case EV.GUEST_JOIN: {
        game.guests.set(e.clientId, {
          clientId: e.clientId,
          nickname: e.nickname,
          cursor: e.cursor,
          joinSeq: game.joinSeq++,
          answers: new Map(),
        });
        maxNickCursor = Math.max(maxNickCursor, e.cursor);
        break;
      }
      case EV.GUEST_RENAME: {
        const g = game.guests.get(e.clientId);
        if (g) {
          g.nickname = e.nickname;
          g.cursor = e.cursor;
        }
        maxNickCursor = Math.max(maxNickCursor, e.cursor);
        break;
      }
      case EV.GUEST_REMOVE:
        game.guests.delete(e.clientId);
        break;

      case EV.GAME_START:
        started = true;
        break;

      case EV.QUESTION_OPEN:
        lastOpened = e.qIndex;
        lastClosed = false;
        game.originalDeadlineAt = e.originalDeadlineAt;
        game.deadlineAt = e.deadlineAt;
        break;

      case EV.QUESTION_EXTEND:
        game.deadlineAt = e.deadlineAt;
        break;

      case EV.QUESTION_RESUME:
        game.deadlineAt = e.deadlineAt;
        break;

      case EV.ANSWER: {
        // 同一 (clientId, qIndex) 可能有多条 —— 倒计时内允许改答案。
        // Map 按键覆盖，天然「以最后一条为准」。
        const g = game.guests.get(e.clientId);
        if (g) {
          g.answers.set(e.qIndex, {
            optionIndex: e.optionIndex,
            outcome: e.outcome,
            gained: e.gained,
            elapsedMs: e.elapsedMs,
          });
        }
        break;
      }

      case EV.QUESTION_CLOSE:
        lastClosed = true;
        // 结算时未提交者记 timeout。这里的字段必须与 Game.#settle **逐字段一致** ——
        // 只要有一个字段不同，重放出来的记录就和崩溃前不一样，
        // 而分数相同会让测试全绿、直到 CSV 导出时才露馅。
        for (const g of game.guests.values()) {
          if (!g.answers.has(e.qIndex)) {
            g.answers.set(e.qIndex, {
              optionIndex: -1,
              outcome: OUTCOME.TIMEOUT,
              gained: 0,
              elapsedMs: RULES.QUESTION_MS,
            });
          }
        }
        break;

      case EV.QUESTION_SKIP:
        lastClosed = true;
        game.voided.add(e.qIndex);
        for (const g of game.guests.values()) {
          g.answers.set(e.qIndex, {
            optionIndex: -1,
            outcome: OUTCOME.SKIPPED,
            gained: 0,
            elapsedMs: 0,
          });
        }
        break;

      case EV.QUESTION_SWAP: {
        // 原题作废：作答记录整体抹掉；槽位换成备用题
        for (const g of game.guests.values()) g.answers.delete(e.qIndex);
        const spare = game.bank.spares[e.spareIndex];
        if (spare) game.overrides.set(e.qIndex, spare);
        game.voided.delete(e.qIndex);
        maxSpareIndex = Math.max(maxSpareIndex, e.spareIndex);
        break;
      }

      case EV.GAME_FINISH:
        finished = true;
        break;

      default:
        break; // boot / question_pause 等对状态无影响
    }
  }

  // 游标从事件推导，不单独持久化 —— 保证重启后下一位拿到第 N+1 条，
  // 绝不把同一昵称分给第二个人
  game.nicknames.restore(maxNickCursor + 1);
  game.bank.restoreSpareCursor(maxSpareIndex + 1);

  game.qIndex = lastOpened;
  if (finished) {
    game.stage = STAGE.FINAL;
  } else if (lastOpened >= 0) {
    game.stage = STAGE.REVEAL;
  } else if (started) {
    game.stage = STAGE.READY;
  } else {
    game.stage = STAGE.IDLE;
  }

  return {
    applied: events.length,
    stage: game.stage,
    qIndex: game.qIndex,
    // 崩在答题中：该题没有 close/skip 事件。主持人需要决定换备用题还是继续。
    interrupted: lastOpened >= 0 && !lastClosed && !finished,
  };
}
