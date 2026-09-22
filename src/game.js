/**
 * 游戏状态机、计分与排行榜（docs/01 §4）。
 *
 * 本模块是唯一的事实来源，且**完全不认识网络** —— 不 import ws、不知道连接、
 * 不知道谁在线。每个动作返回一串领域事件，由 server.js 负责先写盘、再广播。
 *
 * 「不认识连接」不只是分层洁癖，它直接实现了约束 X-1：
 * 自动结算的分母只能是 `joined`（已入场人数），因为这里根本拿不到「在线人数」。
 * 上一版设计正是栽在这里 —— 用在线人数做分母，合影三分钟后只剩 20 人在线，
 * 这 20 人答完题目就结算了，六十个刚解锁手机的宾客连题都没见到。
 */

import { C2S, S2C, STAGE, OUTCOME, REJECT, NOTICE, RULES, scoreOf } from './protocol.js';

/** 事件类型（写进 JSONL，也是崩溃重放的输入） */
export const EV = Object.freeze({
  BOOT: 'boot',
  GUEST_JOIN: 'guest_join',
  GUEST_REMOVE: 'guest_remove',
  GUEST_RENAME: 'guest_rename',
  GAME_START: 'game_start',
  QUESTION_OPEN: 'question_open',
  QUESTION_EXTEND: 'question_extend',
  QUESTION_PAUSE: 'question_pause',
  QUESTION_RESUME: 'question_resume',
  ANSWER: 'answer',
  QUESTION_CLOSE: 'question_close',
  QUESTION_SKIP: 'question_skip',
  QUESTION_SWAP: 'question_swap',
  GAME_FINISH: 'game_finish',
});

/** 本题关闭的原因，写进日志便于赛后复盘 */
export const CLOSE_REASON = Object.freeze({
  TIMEOUT: 'timeout',
  ALL_ANSWERED: 'allAnswered',
  EARLY_SETTLE: 'earlySettle',
});

const ok = (events = [], extra = {}) => ({ ok: true, events, ...extra });
const no = (reason, extra = {}) => ({ ok: false, reason, events: [], ...extra });

export class Game {
  /**
   * @param {{bank: import('./quizbank.js').QuizBank, nicknames: import('./nicknames.js').NicknamePool}} deps
   */
  constructor({ bank, nicknames }) {
    this.bank = bank;
    this.nicknames = nicknames;

    this.stage = STAGE.IDLE;
    /** 当前正题下标，未开始为 -1 */
    this.qIndex = -1;

    /**
     * 计分基准：本题**原始**截止时刻。host:extend 不动它。
     * 这是 AC-45「延长后不得越慢分越高」的要害 —— 两个字段必须分得清清楚楚。
     */
    this.originalDeadlineAt = 0;
    /** 结算时机：延长会推后它 */
    this.deadlineAt = 0;
    /** 暂停时冻结的剩余毫秒 */
    this.pausedRemainMs = 0;

    /** clientId -> guest */
    this.guests = new Map();
    /** 入场序号，用于排行榜最终兜底排序 */
    this.joinSeq = 0;

    /** qIndex -> 备用题（host:back 换题后覆盖原题） */
    this.overrides = new Map();
    /** 被跳过或被换掉的题 */
    this.voided = new Set();
  }

  // ── 查询 ────────────────────────────────────────────────

  /** 已入场人数。**自动结算的唯一合法分母**（X-1） */
  get joined() {
    return this.guests.size;
  }

  get totalQuestions() {
    return this.bank.total;
  }

  /** 当前题目内容（可能是换过的备用题） */
  currentQuestion() {
    if (this.qIndex < 0) return null;
    return this.overrides.get(this.qIndex) ?? this.bank.question(this.qIndex);
  }

  /** 本题已作答人数 */
  answeredCount() {
    if (this.qIndex < 0) return 0;
    let n = 0;
    for (const g of this.guests.values()) if (g.answers.has(this.qIndex)) n++;
    return n;
  }

  /** 本题答对人数（供主持人唱分，D14） */
  correctCount() {
    if (this.qIndex < 0) return 0;
    let n = 0;
    for (const g of this.guests.values()) {
      if (g.answers.get(this.qIndex)?.outcome === OUTCOME.CORRECT) n++;
    }
    return n;
  }

  /** 本题各选项的作答分布 */
  distribution() {
    const q = this.currentQuestion();
    if (!q) return [];
    const d = new Array(q.options.length).fill(0);
    for (const g of this.guests.values()) {
      const a = g.answers.get(this.qIndex);
      if (a && a.optionIndex >= 0 && a.optionIndex < d.length) d[a.optionIndex]++;
    }
    return d;
  }

  /**
   * 某位宾客的累计成绩。
   *
   * **全部由作答记录现算，不做增量维护。**
   * 倒计时内允许改答案（AC-04），增量维护就必须在改答案时正确地「减掉上一次」——
   * 那是个典型的会算错的地方。13 道题现算的开销可以忽略，换来的是不可能算错。
   */
  tally(clientId) {
    const g = this.guests.get(clientId);
    if (!g) return { total: 0, correctCount: 0, elapsedSum: 0 };
    let total = 0;
    let correctCount = 0;
    let elapsedSum = 0;
    for (const a of g.answers.values()) {
      total += a.gained;
      if (a.outcome === OUTCOME.CORRECT) {
        correctCount++;
        // 只有答对的题计入累计耗时；skipped 的题不计（docs/01 §4.2）
        elapsedSum += a.elapsedMs;
      }
    }
    return { total, correctCount, elapsedSum };
  }

  /**
   * 排行榜：总分降序 → 答对题累计耗时升序 → 入场序号升序。
   * 三级排序保证名次唯一，不出现并列。
   */
  leaderboard() {
    return [...this.guests.values()]
      .map((g) => ({ clientId: g.clientId, nickname: g.nickname, joinSeq: g.joinSeq, ...this.tally(g.clientId) }))
      .sort((a, b) => b.total - a.total || a.elapsedSum - b.elapsedSum || a.joinSeq - b.joinSeq)
      .map((row, i) => ({ ...row, rank: i + 1 }));
  }

  rankOf(clientId) {
    const board = this.leaderboard();
    const i = board.findIndex((r) => r.clientId === clientId);
    return i < 0 ? null : { rank: i + 1, of: board.length };
  }

  // ── 宾客动作 ─────────────────────────────────────────────

  /**
   * 入场并领取昵称。
   * @param {string} clientId
   */
  join(clientId) {
    if (this.stage === STAGE.FINAL) return no(REJECT.GAME_FINISHED);
    const existing = this.guests.get(clientId);
    if (existing) return ok([], { nickname: existing.nickname, rejoined: true });

    const { nickname, cursor, fallback } = this.nicknames.issue();
    const g = {
      clientId,
      nickname,
      cursor,
      joinSeq: this.joinSeq++,
      answers: new Map(),
    };
    this.guests.set(clientId, g);
    return ok([{ type: EV.GUEST_JOIN, clientId, nickname, cursor }], { nickname, fallback });
  }

  /**
   * 提交答案。
   *
   * 倒计时内可重复提交，**每次都覆盖前一次**，计分用最后一次到达服务端的时刻
   * （AC-04）。改答案会因剩余时间变少而掉分，属预期行为。
   *
   * @param {string} clientId
   * @param {number} qIndex 客户端声明的题号，用于丢弃迟到的旧题答案
   * @param {number} optionIndex
   * @param {number} nowMs 服务端单调时钟
   */
  answer(clientId, qIndex, optionIndex, nowMs) {
    if (this.stage === STAGE.PAUSED) return no(REJECT.PAUSED);
    if (this.stage !== STAGE.ASKING) return no(REJECT.NOT_ASKING);
    if (qIndex !== this.qIndex) return no(REJECT.STALE_ACTION);
    if (nowMs > this.deadlineAt) return no(REJECT.DEADLINE_PASSED);

    const g = this.guests.get(clientId);
    if (!g) return no(REJECT.UNKNOWN_GUEST);

    const q = this.currentQuestion();
    if (!q || optionIndex < 0 || optionIndex >= q.options.length) return no(REJECT.STALE_ACTION);

    // 计分基准是**原始**截止时刻。延长期间提交 remainMs <= 0，一律 0 分。
    const remainMs = this.originalDeadlineAt - nowMs;
    const correct = optionIndex === q.answer;
    const gained = scoreOf(correct, remainMs);
    // 耗时用于排行榜兜底排序；延长期间提交会 > 一题的时长，属实
    const elapsedMs = Math.max(0, RULES.QUESTION_MS - remainMs);
    const outcome = correct ? OUTCOME.CORRECT : OUTCOME.WRONG;

    g.answers.set(this.qIndex, { optionIndex, outcome, gained, elapsedMs });

    return ok(
      [{ type: EV.ANSWER, clientId, qIndex: this.qIndex, optionIndex, outcome, gained, elapsedMs }],
      { outcome, gained, allAnswered: this.answeredCount() >= this.joined },
    );
  }

  // ── 主持人动作 ───────────────────────────────────────────

  /**
   * 统一入口。所有动作**必须携带 expectedQIndex**，与服务端当前题号不符即丢弃（X-5）。
   *
   * 这一条同时解决两种连跳：主持人点了没反应本能再点一次；
   * 以及允许多设备同开后，伴郎在台下替他点了一下。
   *
   * @param {string} type C2S.HOST_*
   * @param {{expectedQIndex?: number, clientId?: string}} payload
   * @param {number} nowMs
   */
  hostAction(type, payload = {}, nowMs = 0) {
    const needsQIndex = [
      C2S.HOST_START, C2S.HOST_NEXT, C2S.HOST_EXTEND, C2S.HOST_EARLY_SETTLE,
      C2S.HOST_SKIP, C2S.HOST_BACK, C2S.HOST_REPUBLISH, C2S.HOST_PAUSE, C2S.HOST_RESUME,
    ].includes(type);
    if (needsQIndex && payload.expectedQIndex !== this.qIndex) {
      return no(REJECT.STALE_ACTION, { expected: this.qIndex, got: payload.expectedQIndex });
    }

    switch (type) {
      case C2S.HOST_START: return this.#start();
      case C2S.HOST_NEXT: return this.#next(nowMs);
      case C2S.HOST_EXTEND: return this.#extend(nowMs);
      case C2S.HOST_EARLY_SETTLE: return this.#settle(CLOSE_REASON.EARLY_SETTLE);
      case C2S.HOST_SKIP: return this.#skip();
      case C2S.HOST_BACK: return this.#back(nowMs);
      case C2S.HOST_REPUBLISH: return this.#republish();
      case C2S.HOST_PAUSE: return this.#pause(nowMs);
      case C2S.HOST_RESUME: return this.#resume(nowMs);
      case C2S.HOST_FINISH: return this.#finish();
      case C2S.HOST_NEXT_NICKNAME: return this.#nextNickname(payload.clientId);
      case C2S.HOST_REMOVE: return this.#remove(payload.clientId);
      default: return no(REJECT.ILLEGAL_TRANSITION);
    }
  }

  #start() {
    if (this.stage !== STAGE.IDLE) return no(REJECT.ILLEGAL_TRANSITION);
    this.stage = STAGE.READY;
    return ok([{ type: EV.GAME_START }]);
  }

  #next(nowMs) {
    if (this.stage !== STAGE.READY && this.stage !== STAGE.REVEAL) {
      return no(REJECT.ILLEGAL_TRANSITION);
    }
    const next = this.qIndex + 1;
    if (next >= this.bank.total) return this.#finish();

    this.qIndex = next;
    this.originalDeadlineAt = nowMs + RULES.QUESTION_MS;
    this.deadlineAt = this.originalDeadlineAt;
    this.stage = STAGE.ASKING;
    return ok([
      {
        type: EV.QUESTION_OPEN,
        qIndex: this.qIndex,
        originalDeadlineAt: this.originalDeadlineAt,
        deadlineAt: this.deadlineAt,
      },
    ]);
  }

  /** 延长只推后 deadlineAt（何时结算），绝不动 originalDeadlineAt（如何计分） */
  #extend() {
    if (this.stage !== STAGE.ASKING) return no(REJECT.ILLEGAL_TRANSITION);
    this.deadlineAt += RULES.EXTEND_MS;
    return ok([{ type: EV.QUESTION_EXTEND, qIndex: this.qIndex, deadlineAt: this.deadlineAt }], {
      notice: { kind: NOTICE.EXTENDED, text: '主持人加时 10 秒，还没作答的可以继续答' },
    });
  }

  #pause(nowMs) {
    if (this.stage !== STAGE.ASKING) return no(REJECT.ILLEGAL_TRANSITION);
    this.pausedRemainMs = Math.max(0, this.deadlineAt - nowMs);
    this.stage = STAGE.PAUSED;
    return ok([{ type: EV.QUESTION_PAUSE, qIndex: this.qIndex, remainMs: this.pausedRemainMs }], {
      notice: { kind: NOTICE.PAUSED, text: '暂停一下，稍等片刻' },
    });
  }

  #resume(nowMs) {
    if (this.stage !== STAGE.PAUSED) return no(REJECT.ILLEGAL_TRANSITION);
    const delta = this.pausedRemainMs - (this.deadlineAt - nowMs);
    this.deadlineAt = nowMs + this.pausedRemainMs;
    // 计分基准同步平移，否则暂停时长会被算成宾客的思考时间
    this.originalDeadlineAt += delta;
    this.stage = STAGE.ASKING;
    return ok([{ type: EV.QUESTION_RESUME, qIndex: this.qIndex, deadlineAt: this.deadlineAt }], {
      notice: { kind: NOTICE.RESUMED, text: '继续答题' },
    });
  }

  /** 结算本题：未提交者记 timeout、0 分 */
  #settle(reason) {
    if (this.stage !== STAGE.ASKING && this.stage !== STAGE.PAUSED) {
      return no(REJECT.ILLEGAL_TRANSITION);
    }
    const events = [];
    for (const g of this.guests.values()) {
      if (!g.answers.has(this.qIndex)) {
        g.answers.set(this.qIndex, {
          optionIndex: -1,
          outcome: OUTCOME.TIMEOUT,
          gained: 0,
          elapsedMs: RULES.QUESTION_MS,
        });
      }
    }
    events.push({ type: EV.QUESTION_CLOSE, qIndex: this.qIndex, reason });
    this.stage = STAGE.REVEAL;
    return ok(events, { reason });
  }

  /**
   * 跳过本题：全员 skipped、0 分、**不计入累计耗时**。
   * 大屏显示「本题作废」且不公布答案 —— 主持人嘴上说作废、屏幕却在公布答案会让全场困惑。
   */
  #skip() {
    if (this.stage !== STAGE.ASKING && this.stage !== STAGE.PAUSED && this.stage !== STAGE.REVEAL) {
      return no(REJECT.ILLEGAL_TRANSITION);
    }
    this.#voidCurrent();
    this.stage = STAGE.REVEAL;
    return ok([{ type: EV.QUESTION_SKIP, qIndex: this.qIndex }], {
      notice: { kind: NOTICE.SKIPPED, text: '这题作废了，所有人都不计分，不是你的问题' },
      voided: true,
    });
  }

  /**
   * 换一道备用题重开。
   *
   * 不是「重答原题」—— 原题的正确答案刚在大屏上用最大字号公布过，
   * 重答只会变成一次集体送分，把排行榜彻底搅乱。所以只能换题。
   */
  #back(nowMs) {
    if (this.stage !== STAGE.REVEAL) return no(REJECT.ILLEGAL_TRANSITION);
    const spare = this.bank.takeSpare();
    if (!spare) return no(REJECT.ILLEGAL_TRANSITION, { detail: '备用题已用尽' });

    // 原题的作答记录整体抹掉 —— 该题槽位现在换成了新题，原题对任何人贡献 0 分。
    // 不用 #voidCurrent()：那会写入 skipped 记录，而紧接着新题的作答又要覆盖同一个
    // qIndex，白写一遍。作废这件事由日志里的 QUESTION_SWAP 事件承载。
    for (const g of this.guests.values()) g.answers.delete(this.qIndex);
    this.overrides.set(this.qIndex, spare.question);
    this.voided.delete(this.qIndex); // 换上的新题是有效题

    this.originalDeadlineAt = nowMs + RULES.QUESTION_MS;
    this.deadlineAt = this.originalDeadlineAt;
    this.stage = STAGE.ASKING;
    return ok(
      [
        { type: EV.QUESTION_SWAP, qIndex: this.qIndex, spareIndex: spare.spareIndex },
        {
          type: EV.QUESTION_OPEN,
          qIndex: this.qIndex,
          originalDeadlineAt: this.originalDeadlineAt,
          deadlineAt: this.deadlineAt,
        },
      ],
      { notice: { kind: NOTICE.SWAPPED, text: '这题换一道，刚才那题不计分，大家重新答' } },
    );
  }

  /** 纯读操作，重播结算画面用。**绝不触碰任何分数** */
  #republish() {
    if (this.stage !== STAGE.REVEAL) return no(REJECT.ILLEGAL_TRANSITION);
    return ok([], { republish: true });
  }

  #finish() {
    if (this.stage === STAGE.FINAL) return no(REJECT.ILLEGAL_TRANSITION);
    this.stage = STAGE.FINAL;
    return ok([{ type: EV.GAME_FINISH }]);
  }

  #nextNickname(clientId) {
    const g = this.guests.get(clientId);
    if (!g) return no(REJECT.UNKNOWN_GUEST);
    const { nickname, cursor } = this.nicknames.issue();
    g.nickname = nickname;
    g.cursor = cursor;
    return ok([{ type: EV.GUEST_RENAME, clientId, nickname, cursor }], { nickname });
  }

  #remove(clientId) {
    if (!this.guests.has(clientId)) return no(REJECT.UNKNOWN_GUEST);
    this.guests.delete(clientId);
    return ok([{ type: EV.GUEST_REMOVE, clientId }]);
  }

  /** 把当前题标记为作废：全员 skipped、0 分、不计入累计耗时 */
  #voidCurrent() {
    this.voided.add(this.qIndex);
    for (const g of this.guests.values()) {
      g.answers.set(this.qIndex, {
        optionIndex: -1,
        outcome: OUTCOME.SKIPPED,
        gained: 0,
        elapsedMs: 0,
      });
    }
  }

  // ── 时间驱动 ─────────────────────────────────────────────

  /**
   * 由服务端定时调用。
   *
   * 自动结算的两个触发条件：
   *   1. 到达 deadlineAt
   *   2. **全部已入场宾客**都已提交
   *
   * 条件 2 的分母是 joined，不是「在线人数」—— 本模块根本不知道谁在线（X-1）。
   * 挂机不答的情况由主持人 host:earlySettle 兜底，不靠缩小分母来绕过。
   *
   * @param {number} nowMs
   */
  tick(nowMs) {
    if (this.stage !== STAGE.ASKING) return ok();
    if (this.joined > 0 && this.answeredCount() >= this.joined) {
      return this.#settle(CLOSE_REASON.ALL_ANSWERED);
    }
    if (nowMs >= this.deadlineAt) {
      return this.#settle(CLOSE_REASON.TIMEOUT);
    }
    return ok();
  }

  // ── 对外快照 ─────────────────────────────────────────────

  /** 发给某位宾客的题目载荷。**必须带 mySubmitted/myOption**（X-3） */
  questionPayloadFor(clientId) {
    const q = this.currentQuestion();
    if (!q) return null;
    const a = this.guests.get(clientId)?.answers.get(this.qIndex);
    return {
      type: S2C.QUESTION,
      qIndex: this.qIndex,
      total: this.bank.total,
      text: q.text,
      options: q.options,
      deadlineAt: this.deadlineAt,
      bank: this.bank.label,
      // host:extend 会重播 question，前端整体重渲染；不带这两个字段，
      // 已提交宾客的选中态会被冲掉，「已提交者不受影响」就成了空话
      mySubmitted: Boolean(a),
      myOption: a?.optionIndex ?? -1,
    };
  }

  /** 发给主持人的状态：题干答案 + 唱分四项 + 时间预算 */
  hostStatePayload() {
    const q = this.currentQuestion();
    const board = this.leaderboard();
    return {
      type: S2C.HOST_STATE,
      stage: this.stage,
      qIndex: this.qIndex,
      total: this.bank.total,
      joined: this.joined,
      answered: this.answeredCount(),
      correctCount: this.correctCount(),
      text: q?.text ?? null,
      options: q?.options ?? [],
      correctIndex: q?.answer ?? -1,
      leader: board[0] ? { nickname: board[0].nickname, total: board[0].total } : null,
      hasSpare: this.bank.hasSpare,
      voided: this.voided.has(this.qIndex),
      bank: this.bank.label,
    };
  }

  /** 每题结算的全局载荷。作废的题不公布答案 */
  revealPayload() {
    const voided = this.voided.has(this.qIndex);
    return {
      type: S2C.REVEAL,
      qIndex: this.qIndex,
      voided,
      correctIndex: voided ? -1 : (this.currentQuestion()?.answer ?? -1),
      distribution: voided ? [] : this.distribution(),
      top5: this.leaderboard().slice(0, 5).map(({ nickname, total, rank }) => ({ nickname, total, rank })),
    };
  }

  /** 某位宾客的本题结果 */
  myResultPayload(clientId) {
    const a = this.guests.get(clientId)?.answers.get(this.qIndex);
    const t = this.tally(clientId);
    const r = this.rankOf(clientId);
    return {
      type: S2C.MY_RESULT,
      qIndex: this.qIndex,
      outcome: a?.outcome ?? OUTCOME.TIMEOUT,
      gained: a?.gained ?? 0,
      total: t.total,
      rank: r?.rank ?? null,
      of: r?.of ?? 0,
    };
  }
}
