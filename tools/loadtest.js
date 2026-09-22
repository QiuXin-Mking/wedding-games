#!/usr/bin/env node
/**
 * 并发压测（AC-10）。
 *
 *   node tools/loadtest.js --clients 400 --url ws://127.0.0.1:8888 --host-key host
 *
 * 模拟 N 位宾客同时连接、入场，然后在同一道题内集中提交 —— 这正是现场
 * 主持人喊完「开始」之后的那一刻。
 *
 * 三件事必须同时成立，缺一不可：
 *   1. **不丢答案**：每一次提交都要收到 accepted 的回执
 *   2. **不错分**：结算后每个人的分数要和本地按公式算出来的一致
 *   3. **广播延迟 < 1 秒**：从主持人点「下一题」到最后一位宾客收到题目
 *
 * 只测「没报错」是不够的 —— 丢答案和错分都不会报错，只会让某位宾客
 * 在婚礼现场发现自己明明答了却是 0 分。
 */

import WebSocket from 'ws';
import { C2S, S2C, ROLE, OUTCOME, RULES, scoreOf } from '../src/protocol.js';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const CLIENTS = Number(arg('clients', 100));
const URL = arg('url', 'ws://127.0.0.1:8888');
const HOST_KEY = arg('host-key', process.env.HOST_KEY ?? 'host');
const QUESTIONS = Number(arg('questions', 3));

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
const ms = (n) => `${n.toFixed(0)}ms`;

/** 一个极简的 WS 客户端封装 */
function client(role, key, clientId) {
  const ws = new WebSocket(URL);
  const state = { ws, clientId, role, nickname: null, acks: [], results: [], qSeenAt: new Map() };
  const handlers = new Map();
  state.on = (type, fn) => handlers.set(type, fn);
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === S2C.QUESTION) state.qSeenAt.set(m.qIndex, Date.now());
    if (m.type === S2C.ANSWER_ACK) state.acks.push(m);
    if (m.type === S2C.MY_RESULT) state.results.push(m);
    handlers.get(m.type)?.(m);
  });
  state.send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  state.ready = new Promise((res) => ws.on('open', () => {
    state.send({ type: C2S.HELLO, role, key, clientId });
    res(state);
  }));
  return state;
}

const waitFor = (c, type, timeout = 15000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`${c.clientId ?? c.role} 等 ${type} 超时`)), timeout);
  c.on(type, (m) => { clearTimeout(t); res(m); });
});

async function main() {
  console.log(`压测 ${URL}  客户端 ${CLIENTS}  题数 ${QUESTIONS}\n`);

  const host = client(ROLE.HOST, HOST_KEY);
  await host.ready;
  await waitFor(host, S2C.SNAPSHOT);

  // ── 阶段一：集中连接与入场 ──────────────────────────────
  const t0 = Date.now();
  const guests = Array.from({ length: CLIENTS }, (_, i) => client(ROLE.GUEST, undefined, `lt-${i}`));
  await Promise.all(guests.map((g) => g.ready));
  const connectMs = Date.now() - t0;

  const t1 = Date.now();
  const joined = guests.map((g) => {
    const p = waitFor(g, S2C.IDENTITY);
    g.send({ type: C2S.JOIN, clientId: g.clientId });
    return p.then((m) => { g.nickname = m.nickname; });
  });
  await Promise.all(joined);
  const joinMs = Date.now() - t1;

  console.log(`  ${CLIENTS} 路连接  ${ms(connectMs)}`);
  console.log(`  ${CLIENTS} 人入场  ${ms(joinMs)}`);
  const names = new Set(guests.map((g) => g.nickname));
  console.log(`  昵称唯一  ${names.size === CLIENTS ? '是' : `否（${names.size}/${CLIENTS}）`}\n`);

  host.send({ type: C2S.HOST_START, expectedQIndex: -1 });
  await new Promise((r) => setTimeout(r, 200));

  const broadcastLat = [];
  const ackLat = [];
  let lostAcks = 0;
  let wrongScores = 0;

  for (let q = 0; q < QUESTIONS; q++) {
    // ── 阶段二：出题，量广播延迟 ─────────────────────────
    const seen = guests.map((g) => waitFor(g, S2C.QUESTION));
    const sentAt = Date.now();
    host.send({ type: C2S.HOST_NEXT, expectedQIndex: q - 1 });
    const qs = await Promise.all(seen);
    const lat = guests.map((g) => g.qSeenAt.get(q) - sentAt).filter(Number.isFinite);
    broadcastLat.push(...lat);

    // ── 阶段三：全员在同一瞬间提交 ───────────────────────
    // 把人均分到各个选项上。压测客户端**不知道正确答案**（X-2/X-6 规定题库不下发），
    // 所以判据不能依赖「哪个是对的」，只能用不变量：
    // 选了同一个选项的人，结果必须完全一致；且有且只有一组是对的。
    const nOpt = qs[0].options.length;
    const picked = guests.map((_, i) => i % nOpt);
    const ackWait = guests.map((g) => waitFor(g, S2C.ANSWER_ACK));
    const submitAt = Date.now();
    guests.forEach((g, i) => g.send({ type: C2S.ANSWER, qIndex: q, optionIndex: picked[i] }));
    const acks = await Promise.all(ackWait.map((p) => p.catch(() => null)));
    ackLat.push(Date.now() - submitAt);
    lostAcks += acks.filter((a) => !a || !a.accepted).length;

    // ── 阶段四：等结算，用不变量核对 ─────────────────────
    const settled = guests.map((g) => waitFor(g, S2C.MY_RESULT));
    host.send({ type: C2S.HOST_EARLY_SETTLE, expectedQIndex: q });
    const results = await Promise.all(settled.map((p) => p.catch(() => null)));

    const byOption = new Map();
    results.forEach((r, i) => {
      if (!r) return void wrongScores++;
      // 不变量一：答对才有分，答错必须是 0 分
      const isCorrect = r.outcome === OUTCOME.CORRECT;
      if (isCorrect && r.gained <= 0) wrongScores++;
      if (!isCorrect && r.gained !== 0) wrongScores++;
      (byOption.get(picked[i]) ?? byOption.set(picked[i], []).get(picked[i])).push(r.outcome);
    });
    // 不变量二：选了同一个选项的人，结果必须一模一样
    for (const [opt, outs] of byOption) {
      if (new Set(outs).size !== 1) {
        wrongScores += outs.length;
        console.error(`  ! 第 ${q + 1} 题选项 ${opt}：同一选项出现了不同结果 ${[...new Set(outs)].join('/')}`);
      }
    }
    // 不变量三：有且只有一个选项是正确的
    const correctGroups = [...byOption].filter(([, outs]) => outs[0] === OUTCOME.CORRECT).length;
    if (correctGroups !== 1) {
      wrongScores += guests.length;
      console.error(`  ! 第 ${q + 1} 题有 ${correctGroups} 个选项被判为正确`);
    }
  }

  // ── 报告 ──────────────────────────────────────────────
  console.log('广播延迟（主持人点「下一题」→ 宾客收到题目）');
  console.log(`  中位 ${ms(pct(broadcastLat, 0.5))}   p95 ${ms(pct(broadcastLat, 0.95))}   最大 ${ms(Math.max(...broadcastLat))}`);
  console.log('回执延迟（提交 → 收到 answerAck）');
  console.log(`  中位 ${ms(pct(ackLat, 0.5))}   最大 ${ms(Math.max(...ackLat))}\n`);

  const maxBroadcast = Math.max(...broadcastLat);
  const checks = [
    ['昵称全场唯一', names.size === CLIENTS],
    ['不丢答案（回执全部 accepted）', lostAcks === 0, `${lostAcks} 条丢失或被拒`],
    ['不错分', wrongScores === 0, `${wrongScores} 人分数不符`],
    ['广播延迟 < 1 秒', maxBroadcast < 1000, `最大 ${ms(maxBroadcast)}`],
  ];
  let ok = true;
  for (const [name, pass, detail] of checks) {
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${pass ? '' : ` —— ${detail}`}`);
    ok &&= pass;
  }

  host.send({ type: C2S.HOST_FINISH });
  await new Promise((r) => setTimeout(r, 150));
  for (const g of guests) g.ws.close();
  host.ws.close();

  console.log(ok ? '\n压测通过（AC-10）' : '\n压测未通过');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('压测出错：', e.message); process.exit(2); });
