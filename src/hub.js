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
import { exportDetailCsv } from './csv.js';
import { now } from './clock.js';
import { C2S, S2C, ROLE, STAGE, REJECT, NOTICE } from './protocol.js';

export class Hub {
  /**
   * @param {{bank, nicknames, log: EventLog, resume?: Array<object>}} deps
   */
  constructor({ bank, nicknames, log, resume }) {
    this.game = new Game({ bank, nicknames });
    this.log = log;
    /** ws -> {role, clientId} */
    this.conns = new Map();
    this.recovered = null;

    if (resume && resume.length) {
      this.recovered = replayInto(this.game, resume);
    } else {
      this.log.append([{ type: 'boot', bank: bank.name, questionCount: bank.total }]);
    }
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
    if (type === C2S.HOST_EXPORT) {
      return { ok: true, csv: exportDetailCsv(this.game) };
    }

    // 纯展示类动作，不碰游戏状态，也不写日志
    if (type === C2S.HOST_SHOW_QR) {
      this.broadcast({ type: S2C.SHOW_QR, on: true }, (m) => m.role === ROLE.SCREEN);
      return { ok: true, events: [] };
    }
    if (type === C2S.HOST_GUESTS) {
      this.send(ws, {
        type: S2C.GUEST_LIST,
        guests: [...this.game.guests.values()].map((g) => ({
          clientId: g.clientId, nickname: g.nickname, total: this.game.tally(g.clientId).total,
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
        this.broadcast(this.#stageOnly());
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
    if (!r.events?.length) return r;
    this.#persist(r);
    this.pushReveal();
    this.#pushHostState();
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
    for (const [ws, meta] of this.conns) {
      if (meta.role !== ROLE.GUEST || !meta.clientId) continue;
      this.#raw(ws, JSON.stringify(this.game.myResultPayload(meta.clientId)));
    }
  }

  #pushFinal() {
    const board = this.game.leaderboard();
    this.broadcast({
      type: S2C.FINAL,
      top10: board.slice(0, 10).map(({ nickname, total, rank }) => ({ nickname, total, rank })),
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

  #pushProgress() {
    // 分母是已入场人数，不是连接数（X-1）
    this.broadcast({
      type: S2C.PROGRESS,
      answered: this.game.answeredCount(),
      joined: this.game.joined,
    });
  }

  #pushHostState() {
    const payload = this.game.hostStatePayload();
    this.broadcast(payload, (m) => m.role === ROLE.HOST);
  }

  #stageOnly() {
    return { type: S2C.SNAPSHOT, stage: this.game.stage, qIndex: this.game.qIndex };
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

    if (role === ROLE.HOST) return { ...base, host: g.hostStatePayload() };

    if (g.stage === STAGE.ASKING || g.stage === STAGE.PAUSED) {
      base.question = g.questionPayloadFor(clientId);
    }
    if (g.stage === STAGE.REVEAL) {
      base.reveal = g.revealPayload();
      if (clientId) base.myResult = g.myResultPayload(clientId);
    }
    if (g.stage === STAGE.FINAL) {
      base.final = g.leaderboard().slice(0, 10)
        .map(({ nickname, total, rank }) => ({ nickname, total, rank }));
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
