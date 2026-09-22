/**
 * snapshot 的每个字段都必须真的被前端读走。
 *
 * 真实事故：服务端在 FINAL 态的 snapshot 带了 final（排行榜），
 * 而 screen.html 的 SNAPSHOT 分支只读了 question 与 reveal，漏了 final。
 * 结果大屏在终局刷新后，标题「最终排名」还在，榜单一片空白 ——
 * 而「大屏黑屏就刷新恢复」正是应急预案的一级处置。
 *
 * 服务端测试看不到这个 bug（它只管发出去），页面语法测试也看不到
 * （语法完全正确）。这里把两侧接起来：跑一局真游戏，把每个 stage 下
 * snapshot 的真实字段名抓出来，逐个断言前端源码确实读了它。
 *
 * 以后服务端往 snapshot 里加字段而前端忘了接，这条会红。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../server.js';
import { C2S, S2C, ROLE, STAGE } from '../src/protocol.js';

const SCREEN_KEY = 'sk';
const HOST_KEY = 'hk';

/** 三端都不必读的纯元信息，以及只对宾客有意义的字段 */
const ALWAYS_SKIP = new Set(['type']);
const GUEST_ONLY = new Set(['me', 'myResult', 'myFinal']);

const page = (n) => readFileSync(new URL(`../public/${n}.html`, import.meta.url), 'utf8');

/** 前端是否读了这个字段：出现 m.<key> 或 m[<key>] 即算 */
function reads(src, key) {
  return new RegExp(`m\\.${key}\\b|m\\[['"]${key}['"]\\]`).test(src);
}

describe('snapshot 的字段必须被前端读走', () => {
  test('跑完整一局，逐个 stage 核对三端有没有漏读', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snapfield-'));
    const app = createApp({ dataDir: dir, screenKey: SCREEN_KEY, hostKey: HOST_KEY, tickMs: 30 });
    const port = await app.listen(0);

    const mk = async (role, key) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const q = [];
      ws.on('message', (r) => q.push(JSON.parse(r.toString())));
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify({ type: C2S.HELLO, role, key }));
      return { ws, q, send: (o) => ws.send(JSON.stringify(o)) };
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    const host = await mk(ROLE.HOST, HOST_KEY);
    const guest = await mk(ROLE.GUEST);
    await wait(60);
    guest.send({ type: C2S.JOIN, clientId: 'g1' });
    await wait(60);

    // 每个 stage 都新接一个大屏，拿到该 stage 下最完整的一条 snapshot
    const seen = new Map();   // stage -> Set(字段名)
    const capture = async (stage) => {
      const s = await mk(ROLE.SCREEN, SCREEN_KEY);
      await wait(80);
      const snap = s.q.find((m) => m.type === S2C.SNAPSHOT);
      assert.ok(snap, `${stage} 态下大屏没收到 snapshot`);
      assert.equal(snap.stage, stage, `期望 ${stage}，实际 ${snap.stage}`);
      seen.set(stage, new Set(Object.keys(snap)));
      s.ws.close();
    };

    await capture(STAGE.IDLE);

    host.send({ type: C2S.HOST_START, expectedQIndex: -1 });
    await wait(80);
    await capture(STAGE.READY);

    host.send({ type: C2S.HOST_NEXT, expectedQIndex: -1 });
    await wait(80);
    await capture(STAGE.ASKING);

    guest.send({ type: C2S.ANSWER, qIndex: 0, optionIndex: 1 });
    await wait(60);
    host.send({ type: C2S.HOST_EARLY_SETTLE, expectedQIndex: 0 });
    await wait(120);
    await capture(STAGE.REVEAL);

    host.send({ type: C2S.HOST_FINISH, expectedQIndex: 0 });
    await wait(120);
    await capture(STAGE.FINAL);

    host.ws.close();
    guest.ws.close();
    await app.close();

    // 只盯「某些 stage 才有」的载荷字段 —— question / reveal / final / myResult 这类。
    // 每个 stage 都带的通用字段（stage / bank / total / serverNow …）不是这类 bug 的来源，
    // 把它们算进来只会制造噪音，把真正的漏读淹掉。
    const count = new Map();
    for (const keys of seen.values()) for (const k of keys) count.set(k, (count.get(k) ?? 0) + 1);
    const stageSpecific = [...count.entries()]
      .filter(([k, n]) => n < seen.size && !ALWAYS_SKIP.has(k))
      .map(([k]) => k);
    assert.ok(stageSpecific.length >= 3, `没抓到 stage 专属字段（抓到 ${stageSpecific}），测试本身失效了`);

    const screenSrc = page('screen');
    const guestSrc = page('index');
    const missing = [];
    for (const k of stageSpecific) {
      const stages = [...seen].filter(([, ks]) => ks.has(k)).map(([s]) => s).join('/');
      if (!reads(guestSrc, k)) missing.push(`index.html 没读 m.${k}（${stages} 态才有）`);
      if (GUEST_ONLY.has(k)) continue;
      if (!reads(screenSrc, k)) missing.push(`screen.html 没读 m.${k}（${stages} 态才有）`);
    }
    assert.deepEqual(missing, [], '\n  ' + missing.join('\n  '));
  });
});
