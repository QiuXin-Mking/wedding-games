import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { createApp } from '../server.js';
import { C2S, S2C, ROLE, REJECT, STAGE } from '../src/protocol.js';

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
  test('大屏口令错误被拒', async () => {
    const c = await connect();
    c.send({ type: C2S.HELLO, role: ROLE.SCREEN, key: '猜的' });
    assert.equal((await c.next(S2C.REJECTED)).reason, REJECT.BAD_KEY);
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
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
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

  test('静态资源带强缓存', async () => {
    const r = await get('/');
    assert.match(r.headers.get('cache-control'), /max-age=3600/);
  });
});
