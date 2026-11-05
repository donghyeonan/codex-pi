#!/usr/bin/env node
// Codex Canvas local server: loopback-only, token-authenticated API over a workspace's
// .canvas directory plus an optional `codex app-server --stdio` chat.
//   node canvas/server.mjs --workspace /absolute/dir [--port 3000]
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, HttpError, ROOT_TASK, isTaskId, taskExists, taskInfo, listTasks, deleteTaskFiles } from './store.mjs';
import { AgentManager, detectAgents } from './agents.mjs';
import { DEFAULT_REFS, listRefs, readRef, resolveReferences } from './refs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-src 'self' blob: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; sandbox allow-scripts";
const MAX_BODY = 2 * 1024 * 1024;

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Content-Length': buf.length,
    ...headers,
  });
  res.end(buf);
}

async function readBody(req, res) {
  const type = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'Content-Type must be application/json');
  if (Number(req.headers['content-length']) > MAX_BODY * 8) { res.setHeader('Connection', 'close'); throw new HttpError(413, 'request body too large'); }
  const chunks = [];
  let size = 0;
  // Drain (bounded) instead of aborting mid-upload so the client receives the 413.
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY * 8) { req.destroy(); break; }
    if (size <= MAX_BODY) chunks.push(c);
  }
  if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { throw new HttpError(400, 'malformed JSON body'); }
}

export async function startServer({ workspace, port = 3000, backend, codexCommand, piCommand, pendingDeadlineMs, rpcTimeouts, publicDir = path.join(HERE, 'public'), refsDir = process.env.CANVAS_REFS_DIR, refs = { ...DEFAULT_REFS, ...(refsDir ? { userDir: refsDir } : {}) } } = {}) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error('--workspace must be an absolute directory path');
  // Root-level preferences (agent.json, current-task.json) shared by all tasks.
  const prefs = new Store(workspace);
  await prefs.prepare();
  const canvasRoot = prefs.canvasRoot;
  const commands = await detectAgents({ codexCommand, piCommand });
  let current = null, switching = false, taskOp = false, epoch = 0;

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenBuf = Buffer.from(`Bearer ${token}`);
  const clients = new Set();
  // Short-lived, single-use capability for iframe navigations (which cannot send Bearer headers).
  const renderTickets = new Map();
  let allowedHosts = new Set();
  let allowedOrigins = new Set();

  const getState = async () => {
    const t = current;
    return { task: { ...t.info, epoch: t.epoch }, artifacts: t.store.artifacts, board: await t.store.getBoard(), notes: await t.store.getNotes(), chat: t.chat.snapshot() };
  };

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) { try { res.write(frame); } catch {} }
  };
  let stateTimer = null;
  const scheduleState = () => {
    if (stateTimer || !clients.size) return;
    stateTimer = setTimeout(async () => {
      stateTimer = null;
      try { broadcast('state', await getState()); } catch (e) { broadcast('error', { message: e.message }); }
    }, 30);
  };

  // ---------- tasks: one open task (store + agents) at a time ----------
  async function openTask(id, requested, created) {
    const store = new Store(workspace, id);
    await store.init();
    const chat = new AgentManager({ store, prefs, commands, backend: requested, pendingDeadlineMs, rpcTimeouts });
    try {
      if (created) await store.writeJson('task.json', { createdAt: created, title: null });
      await chat.init();
    } catch (e) { store.close(); await chat.close().catch(() => {}); throw e; }
    const t = { id, store, chat, info: await taskInfo(canvasRoot, id), epoch: ++epoch };
    // Events from a task that was switched away from are dropped, so they cannot leak into the open one.
    store.on('change', () => { if (current === t) scheduleState(); });
    chat.on('state', () => { if (current === t) scheduleState(); });
    chat.on('delta', (d) => { if (current === t) broadcast('delta', d); });
    chat.on('error', (e) => { if (current === t) broadcast('error', { message: e.message }); });
    return t;
  }
  const closeTask = async (t) => {
    await t.chat.close().catch(() => {});
    await t.store.withLock(() => t.store.close()).catch(() => t.store.close()); // drains queued saves first
  };
  const lockTasks = () => {
    if (taskOp) throw new HttpError(409, '다른 작업 전환이나 삭제가 진행 중입니다. 잠시 후 다시 시도해 주세요.');
    taskOp = true;
  };
  // Scoped routes use the open task. A browser names the task it is showing; a mismatch is a stale tab.
  const scoped = (req) => {
    if (switching) throw new HttpError(409, '작업을 전환하는 중입니다. 잠시 후 다시 시도해 주세요.');
    const shown = req.headers['x-canvas-task'];
    if (shown !== undefined && shown !== current.id) throw new HttpError(409, '다른 작업이 열려 있습니다. 새로고침한 뒤 다시 시도해 주세요.');
    return current;
  };
  async function transition(nextId, { create = false, after } = {}) {
    lockTasks();
    let next;
    try {
      if (current.chat.busy()) throw new HttpError(409, '에이전트가 작업 중이거나 답변을 기다리고 있습니다. 완료하거나 중단한 뒤 다시 시도해 주세요.');
      switching = true;
      if (create) nextId = crypto.randomBytes(8).toString('hex');
      else if (!(await taskExists(canvasRoot, nextId))) throw new HttpError(404, 'unknown task');
      const old = current;
      next = await openTask(nextId, old.chat.requested, create ? new Date().toISOString() : null);
      await prefs.writeJson('current-task.json', { id: nextId });
      current = next;
      await closeTask(old);
      if (after) await after(old);
    } catch (e) {
      if (next && current !== next) await closeTask(next);
      if (create && nextId && current?.id !== nextId) await deleteTaskFiles(canvasRoot, nextId).catch(() => {});
      throw e;
    } finally {
      switching = false; taskOp = false;
      if (next && current === next) broadcast('delta', { reset: true, text: '' }); // a refused switch must not clear a running turn's stream
      scheduleState();
    }
    return getState();
  }
  async function deleteTask(id) {
    if (!isTaskId(id)) throw new HttpError(400, 'invalid task id');
    if (id === current.id) {
      // The open task is closed first (its agent stopped, queued saves drained), then its files are removed.
      const others = (await listTasks(canvasRoot, null)).filter((t) => t.id !== id);
      return transition(others[0]?.id, { create: !others.length, after: () => deleteTaskFiles(canvasRoot, id) });
    }
    lockTasks();
    try { await deleteTaskFiles(canvasRoot, id); } finally { taskOp = false; }
    return getState();
  }
  const saved = await prefs.readJson('current-task.json', () => ({}), (d) => d).catch(() => ({}));
  const startId = (await taskExists(canvasRoot, saved?.id)) ? saved.id : ROOT_TASK;
  current = await openTask(startId, backend || (codexCommand && !piCommand ? 'codex' : undefined));

  const authorized = (req) => {
    const h = Buffer.from(String(req.headers.authorization || ''));
    return h.length === tokenBuf.length && crypto.timingSafeEqual(h, tokenBuf);
  };

  const handle = async (req, res) => {
    if (!allowedHosts.has(String(req.headers.host || ''))) return send(res, 421, { error: 'invalid Host' });
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) return send(res, 403, { error: 'foreign Origin' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (p.startsWith('/render/') && req.method === 'GET') {
      const key = p.slice('/render/'.length), ticket = renderTickets.get(key);
      renderTickets.delete(key);
      if (!ticket || ticket.expires < Date.now()) return send(res, 404, { error: 'expired render ticket' });
      if (ticket.store !== current.store) return send(res, 404, { error: 'expired render ticket' });
      const { type, body } = await ticket.store.artifactContent(ticket.id);
      return send(res, 200, body, { 'Content-Type': type, 'Content-Security-Policy': `${ARTIFACT_CSP}; frame-ancestors 'self'; form-action 'none'; base-uri 'none'`, 'X-Frame-Options': 'SAMEORIGIN' });
    }
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      const entry = STATIC[p];
      if (!entry) return send(res, 404, { error: 'not found' });
      let body;
      try { body = await fsp.readFile(path.join(publicDir, entry[0])); } catch { return send(res, 404, { error: `${entry[0]} not found` }); }
      return send(res, 200, req.method === 'HEAD' ? Buffer.alloc(0) : body, { 'Content-Type': entry[1], 'Content-Security-Policy': APP_CSP });
    }

    if (!authorized(req)) return send(res, 401, { error: 'missing or invalid token' }, { 'WWW-Authenticate': 'Bearer' });
    const route = `${req.method} ${p}`;
    try {
      if (route === 'GET /api/state') return send(res, 200, await getState());
      if (route === 'GET /api/events') {
        res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'Content-Security-Policy': "default-src 'none'" });
        res.write(`event: state\ndata: ${JSON.stringify(await getState())}\n\n`);
        clients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (route === 'GET /api/tasks') return send(res, 200, { current: current.id, items: await listTasks(canvasRoot, current.id) });
      if (route === 'POST /api/tasks') {
        const body = await readBody(req, res);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'task request required');
        if (body.id === undefined) return send(res, 200, await transition(null, { create: true }));
        if (!isTaskId(body.id)) throw new HttpError(400, 'invalid task id');
        return send(res, 200, body.id === current.id ? await getState() : await transition(body.id));
      }
      if (route === 'POST /api/tasks/delete') return send(res, 200, await deleteTask((await readBody(req, res))?.id));
      if (route === 'PUT /api/board') { const body = await readBody(req, res); return send(res, 200, await scoped(req).store.putBoard(body)); }
      if (route === 'PUT /api/notes') { const body = await readBody(req, res); return send(res, 200, await scoped(req).store.putNotes(body)); }
      if (route === 'GET /api/conversations') return send(res, 200, await scoped(req).chat.conversations());
      if (route === 'POST /api/conversations') {
        const body = await readBody(req, res);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'conversation request required');
        return send(res, 200, await scoped(req).chat.conversation(body.id));
      }
      if (route === 'POST /api/agent') {
        const body = await readBody(req, res);
        return send(res, 200, await scoped(req).chat.select(body?.backend));
      }
      if (route === 'GET /api/refs') return send(res, 200, { dir: refs.userDir, items: (await listRefs(refs)).map(({ path: _p, source: _s, ...r }) => r) });
      if (route === 'GET /api/refs/file') { const { type, body } = await readRef(refs, url.searchParams.get('id') || ''); return send(res, 200, body, { 'Content-Type': type }); }
      if (route === 'POST /api/chat') {
        const body = await readBody(req, res);
        const references = await resolveReferences(body?.references, refs);
        const t = scoped(req);
        const first = t.id !== ROOT_TASK && !t.info.title && !t.chat.snapshot().messages.length;
        const out = await t.chat.chat(body, t.store.artifacts, references);
        // A new task is named after its first prompt; the root task stays the workspace's 기본 작업.
        if (first && !body.text.trimStart().startsWith('/')) {
          t.info = { ...t.info, title: body.text.trim().slice(0, 80) };
          await t.store.withLock(() => t.store.writeJson('task.json', { createdAt: t.info.createdAt, title: t.info.title })).catch((e) => broadcast('error', { message: `작업 이름 저장 실패: ${e.message}` }));
          scheduleState();
        }
        return send(res, 202, out);
      }
      if (route === 'POST /api/interrupt') { await readBody(req, res); return send(res, 200, await scoped(req).chat.interrupt()); }
      if (route === 'POST /api/answer') { const body = await readBody(req, res); return send(res, 200, scoped(req).chat.answer(body)); }
      const render = /^\/api\/artifact\/([^/]+)\/render$/.exec(p);
      if (render && req.method === 'POST') {
        await readBody(req, res);
        const id = decodeURIComponent(render[1]);
        const { store } = scoped(req);
        const artifact = store.artifacts.find(a => a.id === id);
        if (artifact?.type !== 'html' || artifact.error) throw new HttpError(404, 'HTML artifact unavailable');
        for (const [key, ticket] of renderTickets) if (ticket.expires < Date.now()) renderTickets.delete(key);
        if (renderTickets.size >= 1000) throw new HttpError(429, 'too many render tickets');
        const key = crypto.randomBytes(32).toString('base64url');
        renderTickets.set(key, { id, store, expires: Date.now() + 30000 });
        return send(res, 200, { url: `/render/${key}` });
      }
      const m = /^\/api\/artifact\/([^/]+)\/content$/.exec(p);
      if (m && req.method === 'GET') {
        let id;
        try { id = decodeURIComponent(m[1]); } catch { throw new HttpError(404, 'unknown artifact'); }
        const { type, body } = await scoped(req).store.artifactContent(id);
        return send(res, 200, body, { 'Content-Type': type, 'Content-Security-Policy': ARTIFACT_CSP });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const out = { error: status === 500 ? 'internal error' : err.message };
      if (err.current) out.current = err.current;
      if (status === 500) console.error('[canvas]', err);
      if (!res.headersSent) send(res, status, out);
      else res.end();
    }
  };

  const server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.destroy(); } catch {} }); });
  server.requestTimeout = 0; // SSE is long-lived; individual bodies are size-bounded
  server.headersTimeout = 30000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const actualPort = server.address().port;
  allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
  allowedOrigins = new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);

  let closing = null;
  const close = () => closing ||= (async () => {
    clearTimeout(stateTimer);
    for (const res of clients) { try { res.end(); } catch {} }
    clients.clear();
    await closeTask(current);
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r()));
  })();

  return {
    url: `http://127.0.0.1:${actualPort}/#token=${token}`,
    origin: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    token,
    workspace: prefs.workspace,
    get store() { return current.store; },
    get chat() { return current.chat; },
    get task() { return current.id; },
    close,
  };
}

function parseArgs(argv) {
  const out = { port: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--refs') out.refsDir = argv[++i];
    else if (a === '--agent') out.backend = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('--port must be 0..65535');
  return out;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (args.help || !args.workspace) {
    console.log('usage: node canvas/server.mjs --workspace /absolute/dir [--port 3000] [--refs ~/.codex-pi/refs] [--agent auto|pi|codex]');
    process.exit(args.help ? 0 : 2);
  }
  let app;
  try { app = await startServer({ workspace: args.workspace, port: args.port, backend: args.backend, ...(args.refsDir ? { refsDir: path.resolve(args.refsDir) } : {}) }); } catch (e) { console.error(`codex canvas: ${e.message}`); process.exit(1); }
  console.log(app.url);
  const stop = () => { app.close().finally(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
