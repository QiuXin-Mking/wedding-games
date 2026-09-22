import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { createApp } from '../server.js';
import { C2S, S2C, ROLE, REJECT, STAGE, RULES } from '../src/protocol.js';

const SCREEN_KEY = 'scr-key';
const HOST_KEY = 'host-key';

let app;
let port;
let dataDir;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'srv-'));
  app = createApp({ dataDir, screenKey: SCREEN_KEY, hostKey: HOST_KEY, tickMs: 30 });
  port = await app.listen(0);
});

after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** 一个会把收到的消息排队、可按类型等待的客户端 */
function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  const api = {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    /** 等一条指定类型的消息 */
    next(type, ms = 2000) {
      const i = queue.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { type, resolve };
        waiters.push(w);
        setTimeout(() => {
          const j = waiters.indexOf(w);
          if (j >= 0) {
            waiters.splice(j, 1);
            reject(new Error(`等待 ${type} 超时；已收到：${queue.map((m) => m.type).join(',')}`));
          }
        }, ms);
      });
    },
    /** 断言在一段时间内**没有**收到某类型消息 */
    async never(type, ms = 250) {
      await new Promise((r) => setTimeout(r, ms));
      assert.equal(queue.some((m) => m.type === type), false, `不应收到 ${type}`);
    },
    seen: () => queue.map((m) => m.type),
    close: () => ws.close(),
  };
  return new Promise((r) => ws.on('open', () => r(api)));
}

async function hello(c, role, key, clientId) {
  c.send({ type: C2S.HELLO, role, key, clientId });
  return c.next(S2C.SNAPSHOT);
}

function logEvents() {
  const f = readdirSync(dataDir).filter((x) => x.endsWith('.jsonl')).sort().at(-1);
  return readFileSync(join(dataDir, f), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('AC-11 口令校验', () => {
  test('大屏不需要口令 —— 纯展示端，少一道会坏的环节', async () => {
    const c = await connect();
    c.send({ type: C2S.HELLO, role: ROLE.SCREEN });
    const snap = await c.next(S2C.SNAPSHOT);
    assert.equal(snap.type, S2C.SNAPSHOT, '大屏应当无口令直接进入');
    c.close();
  });

  test('大屏带个乱口令也照样进 —— 服务端根本不看它', async () => {
    const c = await connect();
    c.send({ type: C2S.HELLO, role: ROLE.SCREEN, key: '随便乱打的' });
    assert.equal((await c.next(S2C.SNAPSHOT)).type, S2C.SNAPSHOT);
    c.close();
  });

  test('主持人口令错误被拒', async () => {
    const c = await connect();
    c.send({ type: C2S.HELLO, role: ROLE.HOST, key: '' });
    assert.equal((await c.next(S2C.REJECTED)).reason, REJECT.BAD_KEY);
    c.close();
  });

  test('宾客无需口令', async () => {
    const c = await connect();
    const snap = await hello(c, ROLE.GUEST, undefined, 'g-anon');
    assert.equal(snap.type, S2C.SNAPSHOT);
    c.close();
  });

  test('未 hello 就发指令一律拒绝', async () => {
    const c = await connect();
    c.send({ type: C2S.JOIN, clientId: 'x' });
    assert.equal((await c.next(S2C.REJECTED)).reason, REJECT.BAD_KEY);
    c.close();
  });

  test('非主持人发 host:* 被拒', async () => {
    const c = await connect();
    await hello(c, ROLE.GUEST, undefined, 'g-fake');
    c.send({ type: C2S.HOST_NEXT, expectedQIndex: -1 });
    assert.equal((await c.next(S2C.REJECTED)).reason, REJECT.BAD_KEY);
    c.close();
  });

  test('垃圾数据不回应也不断开', async () => {
    const c = await connect();
    await hello(c, ROLE.GUEST, undefined, 'g-junk');
    c.ws.send('这不是 JSON');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(c.ws.readyState, WebSocket.OPEN, '不能因为一条垃圾数据就踢掉宾客');
    c.close();
  });
});

describe('对时', () => {
  test('sync 原样回传 t0 并给出服务端时刻', async () => {
    const c = await connect();
    await hello(c, ROLE.GUEST, undefined, 'g-sync');
    c.send({ type: C2S.SYNC, t0: 12345 });
    const pong = await c.next(S2C.PONG);
    assert.equal(pong.t0, 12345, 't0 必须原样回传，客户端靠它算 rtt');
    assert.ok(pong.t1 > 0);
    c.close();
  });
});

describe('入场与快照', () => {
  test('join 后拿到 identity 与昵称', async () => {
    const c = await connect();
    await hello(c, ROLE.GUEST, undefined, 'g1');
    c.send({ type: C2S.JOIN, clientId: 'g1' });
    const id = await c.next(S2C.IDENTITY);
    assert.equal(id.clientId, 'g1');
    assert.ok(id.nickname.length >= 4);
    c.close();
  });

  test('重连后首条是 snapshot，且明确带回自己的分数', async () => {
    const c = await connect();
    await hello(c, ROLE.GUEST, undefined, 'g1');
    c.send({ type: C2S.JOIN, clientId: 'g1' });
    await c.next(S2C.IDENTITY);
    c.close();

    const again = await connect();
    const snap = await hello(again, ROLE.GUEST, undefined, 'g1');
    assert.ok(snap.me, '重连必须带回 me —— 宾客要知道「你的分还在」');
    assert.equal(snap.me.clientId, 'g1');
    assert.equal(typeof snap.me.total, 'number');
    again.close();
  });
});

describe('X-2 answerAck：只有落盘了才说「已提交」', () => {
  let host, guest;

  before(async () => {
    host = await connect();
    await hello(host, ROLE.HOST, HOST_KEY);
    guest = await connect();
    await hello(guest, ROLE.GUEST, undefined, 'ga');
    guest.send({ type: C2S.JOIN, clientId: 'ga' });
    await guest.next(S2C.IDENTITY);
    host.send({ type: C2S.HOST_START, expectedQIndex: -1 });
    await host.next(S2C.HOST_STATE);
    host.send({ type: C2S.HOST_NEXT, expectedQIndex: -1 });
    await guest.next(S2C.QUESTION);
  });

  after(() => { host.close(); guest.close(); });

  test('提交被接受后回 ack，且日志里已经有这条作答', async () => {
    guest.send({ type: C2S.ANSWER, qIndex: 0, optionIndex: 1 });
    const ack = await guest.next(S2C.ANSWER_ACK);
    assert.equal(ack.accepted, true);
    assert.equal(ack.qIndex, 0);

    // 先写盘、再广播：收到 ack 的这一刻，磁盘上必须已经有了
    const answers = logEvents().filter((e) => e.type === 'answer' && e.clientId === 'ga');
    assert.equal(answers.length, 1, 'ack 已发出，日志却没有这条作答 —— 崩溃就会丢');
  });

  test('过期题号的提交被拒，ack 里说明原因', async () => {
    guest.send({ type: C2S.ANSWER, qIndex: 99, optionIndex: 1 });
    const ack = await guest.next(S2C.ANSWER_ACK);
    assert.equal(ack.accepted, false);
    assert.equal(ack.reason, REJECT.STALE_ACTION);
  });
});

describe('X-4 救场动作都带一句给宾客的解释', () => {
  test('extend / skip 都广播 notice', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'srv2-'));
    const app2 = createApp({ dataDir: dir2, hostKey: HOST_KEY, tickMs: 30 });
    const p2 = await app2.listen(0);
    const mk = async (role, key, clientId) => {
      const ws = new WebSocket(`ws://127.0.0.1:${p2}`);
      const q = [];
      ws.on('message', (r) => q.push(JSON.parse(r.toString())));
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify({ type: C2S.HELLO, role, key, clientId }));
      return { ws, q };
    };
    const h = await mk(ROLE.HOST, HOST_KEY);
    const g = await mk(ROLE.GUEST, undefined, 'gz');
    g.ws.send(JSON.stringify({ type: C2S.JOIN, clientId: 'gz' }));
    await new Promise((r) => setTimeout(r, 80));
    h.ws.send(JSON.stringify({ type: C2S.HOST_START, expectedQIndex: -1 }));
    await new Promise((r) => setTimeout(r, 60));
    h.ws.send(JSON.stringify({ type: C2S.HOST_NEXT, expectedQIndex: -1 }));
    await new Promise((r) => setTimeout(r, 60));

    h.ws.send(JSON.stringify({ type: C2S.HOST_EXTEND, expectedQIndex: 0 }));
    await new Promise((r) => setTimeout(r, 80));
    const n1 = g.q.filter((m) => m.type === S2C.NOTICE);
    assert.equal(n1.length, 1, 'extend 必须给宾客一句话，否则手机上就是无解释突变');
    assert.ok(n1[0].text.includes('加时'));

    h.ws.send(JSON.stringify({ type: C2S.HOST_SKIP, expectedQIndex: 0 }));
    await new Promise((r) => setTimeout(r, 80));
    const n2 = g.q.filter((m) => m.type === S2C.NOTICE);
    assert.equal(n2.length, 2);
    assert.ok(n2[1].text.includes('不是你的问题'));

    h.ws.close(); g.ws.close();
    await app2.close();
    rmSync(dir2, { recursive: true, force: true });
  });
});

describe('个人成绩不进广播', () => {
  test('大屏收得到 reveal，收不到任何 myResult', async () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'srv3-'));
    const app3 = createApp({ dataDir: dir3, screenKey: SCREEN_KEY, hostKey: HOST_KEY, tickMs: 30 });
    const p3 = await app3.listen(0);
    const mk = async (role, key, clientId) => {
      const ws = new WebSocket(`ws://127.0.0.1:${p3}`);
      const q = [];
      ws.on('message', (r) => q.push(JSON.parse(r.toString())));
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify({ type: C2S.HELLO, role, key, clientId }));
      return { ws, q };
    };
    const h = await mk(ROLE.HOST, HOST_KEY);
    const s = await mk(ROLE.SCREEN, SCREEN_KEY);
    const g = await mk(ROLE.GUEST, undefined, 'gm');
    g.ws.send(JSON.stringify({ type: C2S.JOIN, clientId: 'gm' }));
    await new Promise((r) => setTimeout(r, 80));
    h.ws.send(JSON.stringify({ type: C2S.HOST_START, expectedQIndex: -1 }));
    await new Promise((r) => setTimeout(r, 60));
    h.ws.send(JSON.stringify({ type: C2S.HOST_NEXT, expectedQIndex: -1 }));
    await new Promise((r) => setTimeout(r, 60));
    g.ws.send(JSON.stringify({ type: C2S.ANSWER, qIndex: 0, optionIndex: 1 }));
    await new Promise((r) => setTimeout(r, 200)); // 全员已答 → 自动结算

    assert.ok(s.q.some((m) => m.type === S2C.REVEAL), '大屏要收到结算');
    assert.equal(s.q.some((m) => m.type === S2C.MY_RESULT), false,
      '个人成绩单发给本人，不能让大屏和别人看到');
    assert.ok(g.q.some((m) => m.type === S2C.MY_RESULT), '本人要收到自己的结果');

    h.ws.close(); s.ws.close(); g.ws.close();
    await app3.close();
    rmSync(dir3, { recursive: true, force: true });
  });
});

describe('HTTP 静态层', () => {
  const get = async (path, headers) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: res.status, headers: res.headers, body: await res.text() };
  };

  test('三端路由可达', async () => {
    for (const p of ['/', '/screen', '/host']) {
      assert.equal((await get(p)).status, 200, p);
    }
  });

  test('浏览器可以拉到协议常量', async () => {
    const r = await get('/src/protocol.js');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('export const S2C'));
  });

  test('X-6 昵称池与题库不可通过 HTTP 拿到', async () => {
    for (const p of ['/nicknames.json', '/questions/test.json', '/src/game.js']) {
      assert.equal((await get(p)).status, 404, `${p} 不该可达`);
    }
  });

  test('路径穿越被挡', async () => {
    for (const p of ['/../package.json', '/..%2Fpackage.json', '/public/../../package.json']) {
      assert.equal((await get(p)).status, 404, p);
    }
  });

  test('静态资源走 ETag 协商缓存，改版后不会吃到旧页面', async () => {
    const r = await get('/');
    assert.match(r.headers.get('cache-control'), /no-cache/);
    const etag = r.headers.get('etag');
    assert.ok(etag, '必须带 ETag，否则每次都要重传整页');

    // 内容没变：回 304，不重传正文
    const r304 = await get('/', { 'if-none-match': etag });
    assert.equal(r304.status, 304);
    assert.equal(r304.body, '');

    // 拿着过期的 ETag：必须回 200 带新正文，而不是 304。
    // 这条正是强缓存踩过的坑 —— 部署完手机还在白屏，因为它压根不来问。
    const rStale = await get('/', { 'if-none-match': 'W/"deadbeef-0"' });
    assert.equal(rStale.status, 200);
    assert.ok(rStale.body.includes('婚礼答题'));
  });
});

describe('snapshot 的形状必须恒定', () => {
  test('每一条 snapshot 都带 bank 与 total，不存在残缺版', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv4-'));
    const app4 = createApp({ dataDir: dir, screenKey: SCREEN_KEY, hostKey: HOST_KEY, tickMs: 30 });
    const p4 = await app4.listen(0);
    const mk = async (role, key) => {
      const ws = new WebSocket(`ws://127.0.0.1:${p4}`);
      const q = [];
      ws.on('message', (r) => q.push(JSON.parse(r.toString())));
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify({ type: C2S.HELLO, role, key }));
      return { ws, q };
    };
    const h = await mk(ROLE.HOST, HOST_KEY);
    const s = await mk(ROLE.SCREEN, SCREEN_KEY);
    await new Promise((r) => setTimeout(r, 80));
    // host:start 进 READY —— 早先这一步会广播只带 stage/qIndex 的残缺 snapshot
    h.ws.send(JSON.stringify({ type: C2S.HOST_START, expectedQIndex: -1 }));
    await new Promise((r) => setTimeout(r, 120));

    const snaps = s.q.filter((m) => m.type === S2C.SNAPSHOT);
    assert.ok(snaps.length >= 2, '连接时与进入 READY 时各一条');
    for (const [i, m] of snaps.entries()) {
      assert.ok(m.bank, `第 ${i + 1} 条 snapshot 缺 bank —— 大屏角标会被抹成「—」`);
      assert.equal(typeof m.total, 'number', `第 ${i + 1} 条 snapshot 缺 total`);
    }
    h.ws.close(); s.ws.close();
    await app4.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('发奖点名（Q-N1 / 演练 X-3）', () => {
  test('只有被叫到的那位收到 called，其他人收不到', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv5-'));
    const app5 = createApp({ dataDir: dir, hostKey: HOST_KEY, tickMs: 30 });
    const p5 = await app5.listen(0);
    const mk = async (role, key, clientId) => {
      const ws = new WebSocket(`ws://127.0.0.1:${p5}`);
      const q = [];
      ws.on('message', (r) => q.push(JSON.parse(r.toString())));
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify({ type: C2S.HELLO, role, key, clientId }));
      return { ws, q };
    };
    const h = await mk(ROLE.HOST, HOST_KEY);
    const a = await mk(ROLE.GUEST, undefined, 'win');
    const b = await mk(ROLE.GUEST, undefined, 'other');
    a.ws.send(JSON.stringify({ type: C2S.JOIN, clientId: 'win' }));
    b.ws.send(JSON.stringify({ type: C2S.JOIN, clientId: 'other' }));
    await new Promise((r) => setTimeout(r, 100));

    h.ws.send(JSON.stringify({ type: C2S.HOST_CALL, clientId: 'win' }));
    await new Promise((r) => setTimeout(r, 120));

    const called = a.q.filter((m) => m.type === S2C.CALLED);
    assert.equal(called.length, 1, '被叫到的人必须收到');
    assert.ok(called[0].nickname, '要带上昵称，好让当事人确认没认错');
    assert.equal(b.q.some((m) => m.type === S2C.CALLED), false, '没被叫到的人不该亮起');

    h.ws.close(); a.ws.close(); b.ws.close();
    await app5.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('入场失败必须有回执', () => {
  // 宾客端点完「进入」按钮立刻变灰，等的就是这条回执。
  // 服务端原先在 join 缺 clientId 时直接 return，那台手机会永远卡在灰按钮上，
  // 连「失败了」都不知道 —— 不回话比拒绝更糟。
  test('join 缺 clientId 时回 badJoin，而不是静默丢弃', async () => {
    const c = await connect();
    await hello(c, ROLE.GUEST, undefined, 'g-noid');
    c.send({ type: C2S.JOIN });
    const r = await c.next(S2C.REJECTED);
    assert.equal(r.reason, REJECT.BAD_JOIN);
    c.close();
  });

  test('非宾客角色发 join 也有回执', async () => {
    const c = await connect();
    c.send({ type: C2S.HELLO, role: ROLE.HOST, key: HOST_KEY });
    await c.next(S2C.SNAPSHOT);
    c.send({ type: C2S.JOIN, clientId: 'x' });
    assert.equal((await c.next(S2C.REJECTED)).reason, REJECT.BAD_JOIN);
    c.close();
  });
});

describe('主持人端要能自己看到本题倒计时', () => {
  // 控制台上的 MM:SS 是整场累计耗时，不是本题倒计时。演练中主持人说，
  // 想知道还剩几秒只能扭头看大屏 —— 那等于当众跟全场抢视线，
  // 而「还有十秒」恰恰是他最常喊的一句。
  test('hostState 在答题中带 remainMs，其他阶段为 null', async () => {
    // 用独立实例，不蹭共享 app —— 它的 stage 取决于前面跑了哪些用例
    const dir = mkdtempSync(join(tmpdir(), 'qtick-'));
    const app = createApp({ dataDir: dir, screenKey: SCREEN_KEY, hostKey: HOST_KEY, tickMs: 30 });
    const port = await app.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const q = [];
    ws.on('message', (r) => q.push(JSON.parse(r.toString())));
    await new Promise((r) => ws.on('open', r));
    const wait = (pred, ms = 3000) => new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const hit = [...q].reverse().find(pred);
        if (hit) { clearInterval(iv); res(hit); }
        else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('等超时')); }
      }, 20);
    });

    ws.send(JSON.stringify({ type: C2S.HELLO, role: ROLE.HOST, key: HOST_KEY }));
    const snap = await wait((m) => m.type === S2C.SNAPSHOT);
    assert.equal(snap.host.remainMs, null, 'IDLE 态不该有本题剩余时间');

    ws.send(JSON.stringify({ type: C2S.HOST_START, expectedQIndex: -1 }));
    await wait((m) => m.type === S2C.HOST_STATE && m.stage === STAGE.READY);
    ws.send(JSON.stringify({ type: C2S.HOST_NEXT, expectedQIndex: -1 }));

    const asking = await wait((m) => m.type === S2C.HOST_STATE && m.stage === STAGE.ASKING);
    assert.equal(typeof asking.remainMs, 'number', '答题中必须给出剩余毫秒');
    assert.ok(asking.remainMs > 0 && asking.remainMs <= RULES.QUESTION_MS,
      `剩余时间要落在 0~${RULES.QUESTION_MS} 之间，实际 ${asking.remainMs}`);

    ws.send(JSON.stringify({ type: C2S.HOST_EARLY_SETTLE, expectedQIndex: 0 }));
    const reveal = await wait((m) => m.type === S2C.HOST_STATE && m.stage === STAGE.REVEAL);
    assert.equal(reveal.remainMs, null, '结算后不该再显示倒计时');
    ws.close();
    await app.close();
  });
});

describe('后台运维页', () => {
  // 这个页面能一键清空全场成绩，所以口令必须独立于主持人，
  // 且重置只归档不删除 —— 婚礼当天误点一次也不该丢掉已经打出来的成绩。
  const mk = async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const q = [];
    ws.on('message', (r) => q.push(JSON.parse(r.toString())));
    await new Promise((r) => ws.on('open', r));
    const wait = (pred, ms = 3000) => new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const hit = [...q].reverse().find(pred);
        if (hit) { clearInterval(iv); res(hit); }
        else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('等超时')); }
      }, 20);
    });
    return { ws, q, wait, send: (o) => ws.send(JSON.stringify(o)) };
  };

  test('主持人口令进不了后台', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'admin1-'));
    const app = createApp({ dataDir: dir, screenKey: SCREEN_KEY, hostKey: HOST_KEY, adminKey: 'adm', tickMs: 30 });
    const port = await app.listen(0);
    const c = await mk(port);
    c.send({ type: C2S.HELLO, role: ROLE.ADMIN, key: HOST_KEY });
    const r = await c.wait((m) => m.type === S2C.REJECTED);
    assert.equal(r.reason, REJECT.BAD_KEY, '后台口令必须独立于主持人');
    c.ws.close(); await app.close();
  });

  test('重置清空对局，但把日志归档保留', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'admin2-'));
    const app = createApp({ dataDir: dir, screenKey: SCREEN_KEY, hostKey: HOST_KEY, adminKey: 'adm', tickMs: 30 });
    const port = await app.listen(0);

    // 先造出一局有数据的游戏
    const g = await mk(port);
    g.send({ type: C2S.HELLO, role: ROLE.GUEST });
    await g.wait((m) => m.type === S2C.SNAPSHOT);
    g.send({ type: C2S.JOIN, clientId: 'g1' });
    await g.wait((m) => m.type === S2C.IDENTITY);

    const a = await mk(port);
    a.send({ type: C2S.HELLO, role: ROLE.ADMIN, key: 'adm' });
    const before = await a.wait((m) => m.type === S2C.ADMIN_STATE);
    assert.equal(before.joined, 1, '重置前应有 1 人入场');

    const oldLogs = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(oldLogs.length, 1);

    a.q.length = 0;
    a.send({ type: C2S.ADMIN_RESET });
    const after = await a.wait((m) => m.type === S2C.ADMIN_STATE);
    assert.equal(after.joined, 0, '重置后宾客清零');
    assert.equal(after.stage, STAGE.IDLE, '重置后回到待机');

    // 旧日志必须还在，只是挪进了 archive/
    const archived = readdirSync(join(dir, 'archive'));
    assert.ok(archived.includes(oldLogs[0]),
      `旧日志必须归档保留而不是删除，archive/ 里有：${archived.join(', ')}`);

    g.ws.close(); a.ws.close(); await app.close();
  });

  test('切换题库会被记住，重启后依然生效', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'admin3-'));
    const app = createApp({ dataDir: dir, screenKey: SCREEN_KEY, hostKey: HOST_KEY, adminKey: 'adm', tickMs: 30 });
    const port = await app.listen(0);
    const a = await mk(port);
    a.send({ type: C2S.HELLO, role: ROLE.ADMIN, key: 'adm' });
    const s0 = await a.wait((m) => m.type === S2C.ADMIN_STATE);
    assert.equal(s0.bank, 'test');

    a.q.length = 0;
    a.send({ type: C2S.ADMIN_RESET, bank: 'wedding' });
    const s1 = await a.wait((m) => m.type === S2C.ADMIN_STATE);
    assert.equal(s1.bank, 'wedding', '应已切到正式题库');
    a.ws.close(); await app.close();

    // 重启：不带任何环境变量，也必须还是 wedding
    const app2 = createApp({ dataDir: dir, screenKey: SCREEN_KEY, hostKey: HOST_KEY, adminKey: 'adm', tickMs: 30 });
    const port2 = await app2.listen(0);
    const b = await mk(port2);
    b.send({ type: C2S.HELLO, role: ROLE.ADMIN, key: 'adm' });
    const s2 = await b.wait((m) => m.type === S2C.ADMIN_STATE);
    assert.equal(s2.bank, 'wedding',
      '题库选择没持久化 —— 服务一重启就会悄悄退回测试题库，而那一刻没人在看大屏角标');
    b.ws.close(); await app2.close();
  });
});
