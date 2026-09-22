/**
 * 编排层：把 Game、EventLog 和一堆连接接起来。
 *
 * 抽出来单独成文件是为了可测 —— server.js 只剩 HTTP/WS 的接线，
 * 而「先写盘再广播」「answerAck 何时发」「reveal 怎么分发」这些真正会出错的逻辑
 * 可以脱离网络直接单测。
 *
 * 两条铁律：
 *   1. **先写盘、再广播。** 反过来的话，崩溃后重放出的状态会比宾客刚才看到的旧。
 *   2. **不维护「在线人数」。** 连接数只用于知道往哪儿发消息，
 *      绝不参与任何游戏判定 —— 那是 X-1 的根源。
 */

import { Game } from './game.js';
import { EventLog, replayInto } from './eventlog.js';
import { loadBank, saveBankChoice } from './quizbank.js';
import { now } from './clock.js';
import { renameSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { C2S, S2C, ROLE, STAGE, REJECT, NOTICE, RULES, awardOf } from './protocol.js';

export class Hub {
  /**
   * @param {{bank, nicknames, log: EventLog, resume?: Array<object>}} deps
   */
  constructor({ bank, nicknames, log, resume, dataDir }) {
    this.game = new Game({ bank, nicknames });
    // 后台页要能就地换题库、重开一局，这几样是重建时用的
    this.bank = bank;
    this.nicknames = nicknames;
    this.dataDir = dataDir ?? null;
    this.log = log;
    /** ws -> {role, clientId} */
    this.conns = new Map();
    this.recovered = null;
    /**
     * progress / hostState 只标脏，由 tick 统一刷。
     *
     * 早先是每收到一个答案就向全场广播一次 progress —— 400 人同时提交就是
     * 400 × 400 = 16 万条消息（O(n²)），实测回执延迟从 70ms 涨到 2 秒；
     * 按每条 60 字节算是 9.6 MB，在 3 Mbps 的现场链路上要走 25 秒。
     * 进度计数器每 200ms 刷一次完全够用，没必要逐条广播。
     */
    this.dirty = { progress: false, host: false };

    if (resume && resume.length) {
      this.recovered = replayInto(this.game, resume);
    } else {
      this.log.append([{ type: 'boot', bank: bank.name, questionCount: bank.total }]);
    }
  }

  /**
   * 清空全部状态，重开一局；给了 bankName 就顺便换题库。
   *
   * **只归档不删除**：当前日志改名挪进 data/archive/，和 tools/reset-game.sh 一个口径。
   * 婚礼当天误点一次也不会丢掉已经打出来的成绩 —— 这是这个功能唯一重要的设计决定。
   *
   * 换题库会写 data/bank 持久化，否则服务一重启就退回环境变量指定的那个。
   */
  resetAll({ bankName } = {}) {
    if (!this.dataDir) throw new Error('未提供 dataDir，无法重置');

    this.log.close();
    try {
      const dir = join(this.dataDir, 'archive');
      mkdirSync(dir, { recursive: true });
      // 归档**所有**遗留日志，不只是当前这一份。
      // 服务重启时若旧日志不可续用（比如题库对不上），会新建一份而把旧的留在原地；
      // 按钮上写的是「清空全部状态」，只挪走当前那一份就名不副实了。
      for (const f of readdirSync(this.dataDir)) {
        if (!f.endsWith('.jsonl')) continue;
        renameSync(join(this.dataDir, f), join(dir, f));
      }
    } catch { /* 归档失败不该挡住重开，日志还在原处 */ }

    if (bankName && bankName !== this.bank.name) {
      this.bank = loadBank({ bank: bankName });   // 校验不过会抛，旧库继续用
      saveBankChoice(this.dataDir, bankName);
    }

    this.log = EventLog.create(this.dataDir);
    this.game = new Game({ bank: this.bank, nicknames: this.nicknames });
    this.recovered = null;
    this.recoveredNoticed = false;
    this.creditsOn = false;
    this.log.append([{ type: 'boot', bank: this.bank.name, questionCount: this.bank.total, reset: true }]);

    // 三端一律无条件重建：大屏收起鸣谢，所有人回到待机页
    this.broadcast({ type: S2C.CREDITS, on: false }, (m) => m.role === ROLE.SCREEN);
    for (const [ws, meta] of this.conns) {
      if (meta.role === ROLE.GUEST) meta.clientId = null;   // 旧身份已经不存在了
      this.#raw(ws, JSON.stringify(this.snapshotFor(null, meta.role)));
    }
    return { bank: this.bank.name, label: this.bank.label };
  }

  /** 后台页要看的：当前题库 + 这一局已经累积了多少东西 */
  adminState() {
    const g = this.game;
    let answers = 0;
    for (const gu of g.guests.values()) answers += gu.answers.size;
    return {
      type: S2C.ADMIN_STATE,
      bank: this.bank.name,
      bankLabel: this.bank.label,
      stage: g.stage,
      qIndex: g.qIndex,
      total: g.bank.total,
      joined: g.joined,
      answers,
    };
  }

  // ── 连接管理（只用于知道往哪儿发，不参与任何判定）────────────

  attach(ws, role, clientId = null) {
    this.conns.set(ws, { role, clientId });
  }

  detach(ws) {
    this.conns.delete(ws);
  }

  /** @param {(meta: {role: string, clientId: string|null}) => boolean} [filter] */
  broadcast(msg, filter) {
    const text = JSON.stringify(msg);
    for (const [ws, meta] of this.conns) {
      if (filter && !filter(meta)) continue;
      this.#raw(ws, text);
    }
  }

  send(ws, msg) {
    this.#raw(ws, JSON.stringify(msg));
  }

  /** 发给某位宾客的所有连接（同一人可能开了多个标签页） */
  sendToGuest(clientId, msg) {
    const text = JSON.stringify(msg);
    for (const [ws, meta] of this.conns) {
      if (meta.clientId === clientId) this.#raw(ws, text);
    }
  }

  #raw(ws, text) {
    // readyState 1 = OPEN。对刚断开的连接写入会抛，不能让它中断整轮广播。
    if (ws.readyState !== 1) return;
    try {
      ws.send(text);
    } catch {
      /* 连接正在关闭，忽略 */
    }
  }

  // ── 落盘 ────────────────────────────────────────────────

  /** 先写盘。返回是否真的写了东西 */
  #persist(result) {
    if (result?.events?.length) this.log.append(result.events);
    return Boolean(result?.events?.length);
  }

  // ── 宾客动作 ─────────────────────────────────────────────

  /**
   * 入场。
   * @returns {{ok: boolean, nickname?: string, reason?: string}}
   */
  handleJoin(ws, clientId) {
    const r = this.game.join(clientId);
    if (!r.ok) {
      this.send(ws, { type: S2C.REJECTED, reason: r.reason });
      return r;
    }
    this.#persist(r);

    const meta = this.conns.get(ws);
    if (meta) meta.clientId = clientId;

    this.send(ws, { type: S2C.IDENTITY, clientId, nickname: r.nickname });
    this.send(ws, this.snapshotFor(clientId, ROLE.GUEST));
    this.#pushProgress();
    this.#pushHostState();
    return r;
  }

  /**
   * 提交答案。
   *
   * **只有落盘成功后才发 answerAck**，前端也只有收到 ack 才显示「已提交」（X-2）。
   * 弱网下「页面写着已提交、结算却是 0 分」是最伤人的故障 —— 宾客会认定系统吞了
   * 他的答案，而主持人无法自证。
   */
  handleAnswer(ws, clientId, qIndex, optionIndex) {
    const r = this.game.answer(clientId, qIndex, optionIndex, now());
    if (!r.ok) {
      this.send(ws, {
        type: S2C.ANSWER_ACK, qIndex, optionIndex, accepted: false, reason: r.reason,
      });
      return r;
    }
    this.#persist(r);
    this.sendToGuest(clientId, {
      type: S2C.ANSWER_ACK, qIndex, optionIndex, accepted: true,
    });
    this.#pushProgress();
    this.#pushHostState();
    return r;
  }

  // ── 主持人动作 ───────────────────────────────────────────

  handleHostAction(ws, type, payload) {
    // 纯展示类动作，不碰游戏状态，也不写日志
    // 鸣谢是个纯展示开关，不碰游戏状态、不写日志，随便点多少次都无害
    if (type === C2S.HOST_CREDITS) {
      this.creditsOn = !this.creditsOn;
      this.broadcast({ type: S2C.CREDITS, on: this.creditsOn }, (m) => m.role === ROLE.SCREEN);
      return { ok: true, events: [], creditsOn: this.creditsOn };
    }

    if (type === C2S.HOST_SHOW_QR) {
      this.broadcast({ type: S2C.SHOW_QR, on: true }, (m) => m.role === ROLE.SCREEN);
      return { ok: true, events: [] };
    }
    if (type === C2S.HOST_CALL) {
      const g = this.game.guests.get(payload.clientId);
      if (!g) return { ok: false, reason: REJECT.UNKNOWN_GUEST, events: [] };
      this.sendToGuest(payload.clientId, { type: S2C.CALLED, nickname: g.nickname });
      return { ok: true, events: [], called: g.nickname };
    }
    if (type === C2S.HOST_GUESTS) {
      this.send(ws, {
        type: S2C.GUEST_LIST,
        // 按名次排，不按入场顺序 —— 发奖时主持人要找的是第一名，
        // 而不是最早扫码的那个人。复用 leaderboard 的三级排序，
        // 这样这里的名次和大屏上打出来的完全一致，不会出现「大屏说他第一、
        // 控制台里却排在第七」这种当众对不上的情况。
        guests: this.game.leaderboard().map(({ clientId, nickname, total, rank }) => ({
          clientId, nickname, total, rank, award: awardOf(rank),
        })),
      });
      return { ok: true, events: [] };
    }

    const before = this.game.stage;
    const r = this.game.hostAction(type, payload, now());
    if (!r.ok) {
      this.send(ws, { type: S2C.REJECTED, reason: r.reason, action: type, ...r });
      this.#pushHostState();
      return r;
    }
    this.#persist(r);

    if (r.notice) this.broadcast({ type: S2C.NOTICE, ...r.notice });

    switch (this.game.stage) {
      case STAGE.ASKING:
        this.#pushQuestion();
        break;
      case STAGE.PAUSED:
        this.broadcast({ type: S2C.PAUSED, remainMs: this.game.pausedRemainMs });
        break;
      case STAGE.REVEAL:
        this.pushReveal();
        break;
      case STAGE.FINAL:
        this.#pushFinal();
        break;
      default:
        this.#pushSnapshot();
    }
    if (before === STAGE.PAUSED && this.game.stage === STAGE.ASKING) {
      this.broadcast({ type: S2C.RESUMED, remainMs: this.game.deadlineAt - now() });
    }
    this.#pushProgress();
    this.#pushHostState();
    return r;
  }

  // ── 时间驱动 ─────────────────────────────────────────────

  /** 由 setInterval 调用。结算发生时自动推送 reveal */
  tick() {
    const r = this.game.tick(now());
    if (r.events?.length) {
      this.#persist(r);
      this.pushReveal();
      this.#pushHostState();
    }
    // 状态切换要立刻让宾客看到，所以结算的 reveal 是直发的；
    // 只有高频的计数器类推送走合并。
    this.flushDirty();
    return r;
  }

  // ── 推送 ────────────────────────────────────────────────

  /** 题目是逐人定制的 —— 必须带各自的 mySubmitted/myOption（X-3） */
  #pushQuestion() {
    for (const [ws, meta] of this.conns) {
      const payload = this.game.questionPayloadFor(meta.clientId);
      if (payload) this.#raw(ws, JSON.stringify(payload));
    }
  }

  /** 全局结算 + 逐人的个人结果。个人成绩不进广播，不泄露给全场 */
  pushReveal() {
    this.broadcast(this.game.revealPayload());
    // 崩溃恢复后第一次结算，必须给宾客一句解释。
    // 否则他刚才还在答题，一重连就看到结算画面，只会以为是自己的问题。
    if (this.recovered?.interrupted && !this.recoveredNoticed) {
      this.recoveredNoticed = true;
      this.broadcast({
        type: S2C.NOTICE, kind: NOTICE.RECOVERED,
        text: '刚才服务出了点小问题，这题不计分，大家的分数都还在',
      });
    }
    for (const [ws, meta] of this.conns) {
      if (meta.role !== ROLE.GUEST || !meta.clientId) continue;
      this.#raw(ws, JSON.stringify(this.game.myResultPayload(meta.clientId)));
    }
  }

  /** 终局榜单的唯一来源。长度与奖项都由 RULES 决定 */
  finalBoard() {
    return this.game.leaderboard().slice(0, RULES.FINAL_BOARD_SIZE)
      .map(({ nickname, total, rank }) => ({ nickname, total, rank, award: awardOf(rank) }));
  }

  #pushFinal() {
    const board = this.game.leaderboard();
    this.broadcast({
      type: S2C.FINAL,
      // 字段名保留 top10 不动，免得改坏三端
      top10: this.finalBoard(),
    });
    for (const [ws, meta] of this.conns) {
      if (meta.role !== ROLE.GUEST || !meta.clientId) continue;
      const t = this.game.tally(meta.clientId);
      const r = this.game.rankOf(meta.clientId);
      this.#raw(ws, JSON.stringify({
        type: S2C.MY_FINAL, rank: r?.rank ?? null, of: r?.of ?? 0,
        total: t.total, correctCount: t.correctCount,
      }));
    }
  }

  /** 标脏，不立即发。由 tick 合并刷出 */
  #pushProgress() {
    this.dirty.progress = true;
  }

  /** 标脏。hostStatePayload 内部要算一次排行榜，更不该逐条触发 */
  #pushHostState() {
    this.dirty.host = true;
  }

  /**
   * 主持人状态 + 本题剩余时间。
   *
   * 主持人端没做对时（只有宾客端和大屏做了），所以给绝对截止时刻没用，
   * 直接给剩余毫秒、由前端本地递减，误差只有一个网络延迟（实测 ~12ms）。
   *
   * 为什么非加不可：控制台上那个 MM:SS 是**整场累计耗时**，不是本题倒计时。
   * 演练中主持人说，想知道还剩几秒只能扭头看大屏 —— 那等于当众跟全场抢视线，
   * 而「还有十秒」是他最常喊的一句话。
   */
  #hostState() {
    const p = this.game.hostStatePayload();
    p.remainMs = this.game.stage === STAGE.ASKING
      ? Math.max(0, Math.round(this.game.deadlineAt - now()))
      : null;
    return p;
  }

  /** 立即刷出被标脏的推送。tick 每 200ms 调一次 */
  flushDirty() {
    if (this.dirty.progress) {
      this.dirty.progress = false;
      // 分母是已入场人数，不是连接数（X-1）
      this.broadcast({
        type: S2C.PROGRESS,
        answered: this.game.answeredCount(),
        joined: this.game.joined,
      });
    }
    if (this.dirty.host) {
      this.dirty.host = false;
      this.broadcast(this.#hostState(), (m) => m.role === ROLE.HOST);
    }
  }

  /**
   * 给每条连接推一份**完整**快照。
   *
   * 早先这里推的是只带 stage/qIndex 的残缺版，于是同一个 snapshot 类型有时全量、
   * 有时残缺 —— 大屏按 `m.bank||'—'` 取值，收到残缺版就把题库角标抹成了「—」，
   * 顺带还清掉了题面。消息类型的形状必须恒定。
   */
  #pushSnapshot() {
    for (const [ws, meta] of this.conns) {
      this.#raw(ws, JSON.stringify(this.snapshotFor(meta.clientId, meta.role)));
    }
  }

  /**
   * 重连后无条件全量重建的依据。
   * 前端收到它就整体重画，不做增量对账 —— 这是重连正确性最省心的做法。
   */
  snapshotFor(clientId, role) {
    const g = this.game;
    const base = {
      type: S2C.SNAPSHOT,
      stage: g.stage,
      qIndex: g.qIndex,
      total: g.totalQuestions,
      joined: g.joined,
      answered: g.answeredCount(),
      bank: g.bank.label,
      serverNow: now(),
      recovered: this.recovered?.interrupted ?? false,
    };

    if (role === ROLE.HOST) return { ...base, host: this.#hostState() };

    if (g.stage === STAGE.ASKING || g.stage === STAGE.PAUSED) {
      base.question = g.questionPayloadFor(clientId);
    }
    if (g.stage === STAGE.REVEAL) {
      base.reveal = g.revealPayload();
      // 结算态也要带题目内容：大屏要显示题干与高亮的正确答案。
      // 不带的话，大屏中途刷新就只剩一个排行榜，题面整个丢了。
      base.question = g.questionPayloadFor(clientId);
      if (clientId) base.myResult = g.myResultPayload(clientId);
    }
    if (g.stage === STAGE.FINAL) {
      // 必须和 #pushFinal 给出的完全一致 —— 同一份榜单有两条下发路径
      // （终局广播 / 刷新后的快照重建），口径分叉的话，刷新过的大屏就会
      // 少掉奖项标签。这个位置之前已经栽过一次：漏读 final 导致榜单整个空白。
      base.final = this.finalBoard();
    }
    if (clientId && g.guests.has(clientId)) {
      const guest = g.guests.get(clientId);
      const t = g.tally(clientId);
      // 重连后要明确告诉宾客「你的分还在」，不能只是静默恢复
      base.me = { clientId, nickname: guest.nickname, total: t.total, correctCount: t.correctCount };
    }
    return base;
  }
}

export { EventLog, REJECT, NOTICE };
