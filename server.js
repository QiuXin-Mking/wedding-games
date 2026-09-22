/**
 * 入口：HTTP 静态托管 + WebSocket 同端口升级。
 *
 * 单进程、单端口（C1/C3）。静态托管用 Node 内置 http 手写，
 * 不引 Express —— C6 规定运行时依赖只允许 ws 一个。
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

import { loadBank, resolveBankName } from './src/quizbank.js';
import { loadDefaultPool } from './src/nicknames.js';
import { EventLog } from './src/eventlog.js';
import { Hub } from './src/hub.js';
import { now } from './src/clock.js';
import { C2S, S2C, ROLE, REJECT } from './src/protocol.js';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
// 事件日志必须放在 releases/ 之外，否则重新部署会冲掉已产生的比赛数据
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');

/** 路由到实际文件。**只有这张表里的路径可达**，其余一律 404 */
const ROUTES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/screen': 'screen.html',
  '/host': 'host.html',
  // 主持人手册。不带口令、不含技术细节，把链接直接发给主持人即可。
  '/guide': 'guide.html',
  // 给非技术人员看的流程说明。可以直接转发给新人、长辈、婚礼策划。
  '/how': 'how.html',
  // 后台运维页。口令独立 —— 这页能一键清空全场成绩
  // 鸣谢页：可转发的网页版，大屏那份在 screen.html 里
  '/thanks': 'thanks.html',
  '/admin': 'admin.html',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * 解析请求路径到磁盘文件，并确保不越出 public/。
 * 手写静态托管最容易出的洞就是路径穿越（`/../../etc/passwd`），
 * 这里用白名单 + 前缀校验双保险。
 * @returns {string|null}
 */
function resolveStatic(urlPath) {
  const mapped = ROUTES[urlPath];
  if (mapped) return join(PUBLIC_DIR, mapped);

  // 浏览器要 import 协议常量，这是 public/ 之外唯一放行的文件
  if (urlPath === '/src/protocol.js') return join(ROOT, 'src', 'protocol.js');

  // public/ 下的静态资源（图片、二维码等）
  const clean = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const abs = join(PUBLIC_DIR, clean);
  if (!abs.startsWith(PUBLIC_DIR + sep)) return null;
  return abs;
}

function serveStatic(req, res) {
  const urlPath = (req.url ?? '/').split('?')[0];
  const file = resolveStatic(urlPath);

  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }

  const type = MIME[extname(file)] ?? 'application/octet-stream';

  // 优先返回预压缩产物。峰值时 400 人同时拉首屏，CPU 要留给 WebSocket，
  // 不能在这时候做运行时压缩。
  const gz = `${file}.gz`;
  const acceptsGzip = (req.headers['accept-encoding'] ?? '').includes('gzip');
  const served = acceptsGzip && existsSync(gz) ? gz : file;
  const st = statSync(served);

  // 曾经用 cache-control: max-age=3600。它在婚礼当天并不省带宽 ——
  // 宾客每人只扫一次码，首次请求本来就没有缓存可用；强缓存只在「中途刷新 /
  // 重连」时才命中。而代价是：任何一次改版之后，凡是访问过的设备都会在
  // 一小时内继续吃旧版本。测试期真实踩到过：修好的页面部署上去，手机照样白屏。
  //
  // 改成 ETag + 304：浏览器每次问一句「变了吗」，没变回 304（几十字节，
  // 比 7 KB 的 200 还省），变了立刻拿到新版。两头都优于强缓存。
  const etag = `W/"${st.size.toString(16)}-${st.mtimeMs.toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    return res.end();
  }

  const headers = { 'content-type': type, 'cache-control': 'no-cache', etag };
  if (served === gz) {
    headers['content-encoding'] = 'gzip';
    headers.vary = 'Accept-Encoding';
  }
  res.writeHead(200, headers);
  res.end(readFileSync(served));
}

/**
 * 组装一个可运行的实例。导出以便测试在临时端口上起真服务。
 * @param {{port?: number, dataDir?: string, screenKey?: string, hostKey?: string, tickMs?: number}} [opts]
 */
export function createApp(opts = {}) {
  const screenKey = opts.screenKey ?? process.env.SCREEN_KEY ?? 'screen';
  const hostKey = opts.hostKey ?? process.env.HOST_KEY ?? 'host';
  const adminKey = opts.adminKey ?? process.env.ADMIN_KEY ?? 'admin';
  const dataDir = opts.dataDir ?? DATA_DIR;

  // 题库以 data/bank 为准（后台页切过就记在那儿），没有才看环境变量
  const bank = loadBank({ bank: resolveBankName(dataDir) });
  const nicknames = loadDefaultPool();

  // 只续用「还热着」的日志；几天前的彩排绝不会被当成本场继续
  const found = EventLog.openResumable(dataDir, { window: opts.resumeWindowMs });
  let log = found?.log ?? null;
  let resume = null;
  let resumeNote = null;

  if (found?.stale) {
    const days = (found.ageMs / 86400000).toFixed(1);
    resumeNote = `上一份日志已是 ${days} 天前的（多半是彩排），不续用，开新的一场`;
  } else if (found?.log) {
    // 题库对不上就不能接着跑：彩排用 test、正式用 wedding，
    // 硬接会把婚礼题库套在测试题库的作答记录上，连备用题下标都会错位
    const loggedBank = found.events.find((e) => e.type === 'boot')?.bank;
    if (loggedBank && loggedBank !== bank.name) {
      found.log.close();
      log = null;
      resumeNote = `日志记的是「${loggedBank}」题库、当前是「${bank.name}」，不续用，开新的一场`;
    } else {
      resume = found.events;
    }
  }
  if (!log) log = EventLog.create(dataDir);

  const hub = new Hub({ bank, nicknames, log, resume, dataDir });
  hub.resumeNote = resumeNote;
  // 每次启动都留一条痕迹，事后能看出重启过几次、几点重启（否则无从审计）
  if (resume) log.append([{ type: 'boot', bank: bank.name, questionCount: bank.total, resumed: resume.length }]);
  const server = createServer(serveStatic);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // 垃圾数据直接丢，不回应、不断开
      }
      handleMessage(hub, ws, msg, { screenKey, hostKey, adminKey });
    });
    ws.on('close', () => hub.detach(ws));
    ws.on('error', () => hub.detach(ws));
  });

  const timer = setInterval(() => hub.tick(), opts.tickMs ?? 200);
  timer.unref?.();

  return {
    hub,
    server,
    wss,
    /** @returns {Promise<number>} 实际监听的端口 */
    listen(port = opts.port ?? Number(process.env.PORT ?? 8888)) {
      return new Promise((resolve) => {
        // 显式指定 backlog。Node 默认 511，低于内核的 somaxconn 4096；
        // 400 人集中扫码时握手会挤在这个队列里。
        server.listen(port, '0.0.0.0', 1024, () => resolve(server.address().port));
      });
    },
    close() {
      clearInterval(timer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      log.close();
      return new Promise((r) => server.close(r));
    },
  };
}

function handleMessage(hub, ws, msg, keys) {
  const meta = hub.conns.get(ws);

  // hello 必须是第一条
  if (msg.type === C2S.HELLO) {
    const role = msg.role;
    if (role === ROLE.SCREEN && msg.key !== keys.screenKey) {
      return hub.send(ws, { type: S2C.REJECTED, reason: REJECT.BAD_KEY });
    }
    if (role === ROLE.HOST && msg.key !== keys.hostKey) {
      return hub.send(ws, { type: S2C.REJECTED, reason: REJECT.BAD_KEY });
    }
    if (role === ROLE.ADMIN && msg.key !== keys.adminKey) {
      return hub.send(ws, { type: S2C.REJECTED, reason: REJECT.BAD_KEY });
    }
    if (![ROLE.GUEST, ROLE.SCREEN, ROLE.HOST, ROLE.ADMIN].includes(role)) {
      return hub.send(ws, { type: S2C.REJECTED, reason: REJECT.BAD_KEY });
    }
    hub.attach(ws, role, msg.clientId ?? null);
    // 连接与每次重连后的第一条永远是 snapshot，前端据此无条件重建
    if (role === ROLE.ADMIN) return hub.send(ws, hub.adminState());
    return hub.send(ws, hub.snapshotFor(msg.clientId ?? null, role));
  }

  if (!meta) return hub.send(ws, { type: S2C.REJECTED, reason: REJECT.BAD_KEY });

  // 对时探针。客户端取 rtt 最小的样本算时钟偏移
  if (msg.type === C2S.SYNC) {
    return hub.send(ws, { type: S2C.PONG, t0: msg.t0, t1: now() });
  }

  if (msg.type === C2S.JOIN) {
    // 不回话比拒绝更糟：宾客端点完「进入」按钮就变灰，等的正是这条回执。
    // 静默 return 会让那台手机永远卡在灰按钮上，连「失败了」都不知道。
    if (meta.role !== ROLE.GUEST || !msg.clientId) {
      return hub.send(ws, { type: S2C.REJECTED, reason: REJECT.BAD_JOIN });
    }
    return void hub.handleJoin(ws, msg.clientId);
  }

  if (msg.type === C2S.ANSWER) {
    if (meta.role !== ROLE.GUEST || !meta.clientId) return;
    return void hub.handleAnswer(ws, meta.clientId, msg.qIndex, msg.optionIndex);
  }

  if (msg.type === C2S.ADMIN_RESET) {
    if (meta.role !== ROLE.ADMIN) {
      return hub.send(ws, { type: S2C.REJECTED, reason: REJECT.BAD_KEY });
    }
    try {
      hub.resetAll({ bankName: msg.bank });
    } catch (e) {
      // 换库失败（文件缺失、格式错）时旧库仍在跑，把原因原样告诉后台人员
      return hub.send(ws, { ...hub.adminState(), error: e.message });
    }
    return hub.send(ws, hub.adminState());
  }

  if (typeof msg.type === 'string' && msg.type.startsWith('host:')) {
    if (meta.role !== ROLE.HOST) {
      return hub.send(ws, { type: S2C.REJECTED, reason: REJECT.BAD_KEY });
    }
    hub.handleHostAction(ws, msg.type, msg);
    return;
  }
}

// 直接运行时才起服务；被 import 时（测试）不自动监听。
// 用 pathToFileURL 而不是手拼 file://，不去依赖 URL 规范对 Windows 盘符的特殊处理
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  const port = await app.listen();
  const bank = app.hub.game.bank;
  console.log(`婚礼答题服务已启动`);
  console.log(`  端口     ${port}`);
  console.log(`  题库     ${bank.label}（正题 ${bank.total} 道，备用 ${bank.spares.length} 道）`);
  console.log(`  昵称池   ${app.hub.game.nicknames.pool.length} 条`);
  if (app.hub.resumeNote) console.log(`  ${app.hub.resumeNote}`);
  if (app.hub.recovered) {
    console.log(`  已从事件日志恢复：${app.hub.recovered.applied} 条事件，` +
      `落在第 ${app.hub.recovered.qIndex + 1} 题结算态` +
      (app.hub.recovered.interrupted ? '（该题是被中断的，请决定换备用题或继续）' : ''));
  }
}
