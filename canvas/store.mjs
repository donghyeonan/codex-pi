// Workspace file store for the canvas: artifacts (agent/terminal-written) and
// browser-owned board/notes/thread state for one task. The root task is the legacy
// <workspace>/.canvas itself; later tasks live in <workspace>/.canvas/tasks/<id>.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const LIMITS = {
  artifactFiles: 500,
  artifactJsonBytes: 2 * 1024 * 1024,
  textBytes: 512 * 1024,
  title: 200,
  columns: 100,
  rows: 5000,
  cell: 4096,
  facts: 50,
  fact: 2000,
  sources: 50,
  imageBytes: 10 * 1024 * 1024,
  htmlBytes: 2 * 1024 * 1024,
  stateBytes: 1024 * 1024,
  boardItems: 2000,
  notes: 500,
  noteText: 20000,
  messages: 500,
  messageText: 100 * 1024,
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const TYPES = new Set(['markdown', 'table', 'chart', 'image', 'html']);
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const HTML_EXT = new Set(['.html', '.htm']);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const isId = (s) => typeof s === 'string' && ID_RE.test(s);
export const ROOT_TASK = 'root';
const TASK_RE = /^[a-f0-9]{16}$/;
export const isTaskId = (s) => s === ROOT_TASK || (typeof s === 'string' && TASK_RE.test(s));
// Root .canvas entries owned by the root task. Everything else there (agent.json, current-task.json,
// tasks/, user files) is shared or foreign and is never deleted with the root task.
const ROOT_OWNED = /^(?:artifacts|pi-sessions|(?:board|notes|thread|thread-pi|conversation-(?:codex|pi)-[a-f0-9]{24})\.json|\.(?:board|notes|thread|thread-pi|conversation-(?:codex|pi)-[a-f0-9]{24})\.json\.\d+\.[a-f0-9]{12}\.tmp)$/;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : undefined);

function defaultBoard() { return { rev: 0, viewport: { x: 0, y: 0, zoom: 1 }, items: {} }; }
function defaultNotes() { return { rev: 0, items: [] }; }
function defaultThread() { return { threadId: null, messages: [] }; }

export class Store extends EventEmitter {
  constructor(workspace, task = ROOT_TASK) {
    super();
    if (!isTaskId(task)) throw new HttpError(400, 'invalid task id');
    this.workspace = workspace;
    this.task = task;
    this.rel = task === ROOT_TASK ? [] : ['tasks', task];
    this.artifactsRel = ['.canvas', ...this.rel, 'artifacts'].join('/');
    this.canvasDir = path.join(workspace, '.canvas', ...this.rel);
    this.artifactsDir = path.join(this.canvasDir, 'artifacts');
    this.artifacts = [];
    this.artifactsKey = '';
    this.lock = Promise.resolve();
    this.watcher = null;
    this.pollTimer = null;
    this.debounce = null;
    this.retryTimer = null;
    this.closed = false;
  }

  // Creates/verifies each directory level in order so a symlinked level is refused before anything is created through it.
  async prepare() {
    const real = await fsp.realpath(this.workspace);
    const st = await fsp.stat(real);
    if (!st.isDirectory()) throw new Error(`workspace is not a directory: ${this.workspace}`);
    this.workspace = real;
    this.canvasRoot = path.join(real, '.canvas');
    this.canvasDir = path.join(this.canvasRoot, ...this.rel);
    this.artifactsDir = path.join(this.canvasDir, 'artifacts');
    let dir = real;
    for (const part of ['.canvas', ...this.rel, 'artifacts']) {
      dir = path.join(dir, part);
      await fsp.mkdir(dir).catch((e) => { if (e.code !== 'EEXIST') throw e; });
      const l = await fsp.lstat(dir);
      if (l.isSymbolicLink() || !l.isDirectory()) throw new HttpError(409, `refusing non-directory or symlink: ${dir}`);
    }
  }

  async init() {
    await this.prepare();
    await this.rescan(false);
    this.watch();
  }

  // ---------- artifacts ----------
  async rescan(emit = true, retry = true) {
    const list = [];
    let partial = false;
    let names = [];
    try {
      const l = await fsp.lstat(this.artifactsDir);
      if (l.isSymbolicLink() || !l.isDirectory()) throw new Error('artifacts dir is not a directory');
      names = (await fsp.readdir(this.artifactsDir)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
    } catch (err) {
      // A closed store must never recreate a task directory that is being deleted.
      if (err.code === 'ENOENT' && !this.closed) {
        await fsp.mkdir(this.artifactsDir, { recursive: true }).catch(() => {});
        if (!this.closed) setImmediate(() => this.watch());
      }
    }
    for (const name of names.slice(0, LIMITS.artifactFiles)) {
      const stem = name.slice(0, -5);
      const id = isId(stem) ? stem : `invalid-${crypto.createHash('sha1').update(stem).digest('hex').slice(0, 10)}`;
      const art = await this.loadArtifact(id, name);
      if (art.error && art.retry) partial = true;
      delete art.retry;
      list.push(art);
    }
    if (names.length > LIMITS.artifactFiles) {
      list.push({ id: 'too-many-artifacts', title: 'Too many artifacts', type: 'markdown', error: `only the first ${LIMITS.artifactFiles} artifact files are shown` });
    }
    const key = JSON.stringify(list);
    const changed = key !== this.artifactsKey;
    this.artifacts = list;
    this.artifactsKey = key;
    if (changed && emit) this.emit('change', 'artifacts');
    // A partially written file (e.g. a non-atomic terminal write) gets one delayed re-read.
    if (partial && retry && !this.closed && !this.retryTimer) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.rescan(true, false).catch(() => {}); }, 750);
      this.retryTimer.unref?.();
    }
    return list;
  }

  async loadArtifact(id, name) {
    const errorCard = (message, extra = {}) => ({ id, title: name, type: 'markdown', error: message, ...extra });
    if (!isId(name.slice(0, -5))) return errorCard('invalid artifact file name (use letters, digits, ., _, -)');
    const file = path.join(this.artifactsDir, name);
    let raw;
    try {
      const l = await fsp.lstat(file);
      if (l.isSymbolicLink()) return errorCard('symlinked artifact files are not allowed');
      if (!l.isFile()) return errorCard('artifact is not a regular file');
      if (l.size > LIMITS.artifactJsonBytes) return errorCard(`artifact JSON exceeds ${LIMITS.artifactJsonBytes} bytes`);
      raw = await readNoFollow(file, LIMITS.artifactJsonBytes);
    } catch (err) {
      return errorCard(`cannot read artifact: ${err.code || err.message}`, { retry: true });
    }
    let data;
    try { data = JSON.parse(raw.toString('utf8')); } catch (err) {
      return errorCard(`malformed JSON: ${err.message.slice(0, 200)}`, { retry: true });
    }
    try {
      return await this.normalize(id, data);
    } catch (err) {
      return errorCard(err.message, { title: (isPlain(data) && str(data.title, LIMITS.title)) || name, type: TYPES.has(data?.type) ? data.type : 'markdown' });
    }
  }

  async normalize(id, d) {
    if (!isPlain(d)) throw new Error('artifact must be a JSON object');
    if (!TYPES.has(d.type)) throw new Error(`unsupported type ${JSON.stringify(String(d.type)).slice(0, 40)}; expected markdown|table|chart|image|html`);
    const a = { id, title: str(d.title, LIMITS.title) || id, type: d.type };
    const text = (v, field) => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'string') throw new Error(`${field} must be a string`);
      if (Buffer.byteLength(v) > LIMITS.textBytes) throw new Error(`${field} exceeds ${LIMITS.textBytes} bytes`);
      return v;
    };
    if (d.type === 'markdown') {
      a.content = text(d.content, 'content') ?? '';
    } else if (d.type === 'table' || d.type === 'chart') {
      if (!Array.isArray(d.columns) || d.columns.length === 0 || d.columns.length > LIMITS.columns || !d.columns.every((c) => typeof c === 'string' && c.length <= 200)) {
        throw new Error(`columns must be 1..${LIMITS.columns} strings`);
      }
      if (!Array.isArray(d.rows) || d.rows.length > LIMITS.rows) throw new Error(`rows must be an array of at most ${LIMITS.rows} rows`);
      a.columns = d.columns.slice();
      a.rows = d.rows.map((r, i) => {
        if (!Array.isArray(r) || r.length > LIMITS.columns) throw new Error(`row ${i} must be an array of at most ${LIMITS.columns} cells`);
        return r.map((c) => {
          if (c === null || typeof c === 'number' || typeof c === 'boolean') return typeof c === 'number' && !Number.isFinite(c) ? null : c;
          if (typeof c === 'string') return c.length > LIMITS.cell ? c.slice(0, LIMITS.cell) : c;
          throw new Error(`row ${i} contains a non-scalar cell`);
        });
      });
      if (d.type === 'chart') {
        const c = d.chart;
        if (!isPlain(c) || !['bar', 'line'].includes(c.kind) || !a.columns.includes(c.x) || !a.columns.includes(c.y)) {
          throw new Error('chart must be {kind:"bar"|"line", x:<column>, y:<column>}');
        }
        a.chart = { kind: c.kind, x: c.x, y: c.y };
      }
    } else if (d.type === 'image') {
      a.src = await this.checkSrc(d.src, 'image');
    } else if (d.type === 'html') {
      if (d.src !== undefined && d.src !== null) a.src = await this.checkSrc(d.src, 'html');
      else {
        const c = text(d.content, 'content');
        if (c === undefined) throw new Error('html artifact needs content or src');
        if (Buffer.byteLength(c) > LIMITS.htmlBytes) throw new Error('html content too large');
        a.content = c;
      }
    }
    if (a.src) {
      const source = await fsp.stat(path.join(this.artifactsDir, a.src));
      a.rev = `${source.mtimeMs}:${source.size}`;
    }
    if (d.facts !== undefined) {
      if (!Array.isArray(d.facts) || d.facts.length > LIMITS.facts || !d.facts.every((f) => typeof f === 'string')) throw new Error(`facts must be at most ${LIMITS.facts} strings`);
      a.facts = d.facts.map((f) => f.slice(0, LIMITS.fact));
    }
    if (d.sources !== undefined) {
      if (!Array.isArray(d.sources) || d.sources.length > LIMITS.sources) throw new Error(`sources must be at most ${LIMITS.sources} entries`);
      a.sources = d.sources.map((s, i) => {
        if (!isPlain(s) || typeof s.label !== 'string' || (typeof s.url !== 'string' && typeof s.path !== 'string')) throw new Error(`source ${i} must be {label,url} or {label,path}`);
        const local = typeof s.path === 'string' ? s.path : (path.isAbsolute(s.url) || s.url.startsWith('./') || s.url.startsWith('../')) ? s.url : null;
        // Local citations are display-only metadata, never a filesystem-serving capability.
        if (local !== null) return { label: s.label.slice(0, 300), path: local.slice(0, 2000) };
        let u;
        try { u = new URL(s.url); } catch { throw new Error(`source ${i} url is invalid`); }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`source ${i} url must be http(s)`);
        return { label: s.label.slice(0, 300), url: u.href.slice(0, 2000) };
      });
    }
    const interp = text(d.interpretation, 'interpretation');
    if (interp !== undefined) a.interpretation = interp;
    return a;
  }

  // Accept artifact-relative paths (or the workspace prefix), never absolute paths or symlink components.
  async checkSrc(src, kind) {
    if (typeof src !== 'string') throw new Error(`src must be a relative file path in ${this.artifactsRel}`);
    src = src.replace(/^\.\//, '');
    if (src.startsWith(this.artifactsRel + '/')) src = src.slice(this.artifactsRel.length + 1);
    const parts = src.split('/');
    if (src.length > 2000 || parts.length > 16 || parts.some(p => !FILE_RE.test(p) || p.includes('..'))) throw new Error(`src must be a safe relative file path in ${this.artifactsRel}`);
    let current = this.artifactsDir;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const parent = await fsp.lstat(current);
      if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error('src directories must not be symlinks or files');
    }
    const ext = path.extname(src).toLowerCase();
    if (kind === 'image' && !IMAGE_MIME[ext]) throw new Error('image src must be .png, .jpg, .jpeg, .gif or .webp');
    if (kind === 'html' && !HTML_EXT.has(ext)) throw new Error('html src must be .html or .htm');
    const file = path.join(this.artifactsDir, src);
    let l;
    try { l = await fsp.lstat(file); } catch { throw new Error(`src file not found: ${src}`); }
    if (l.isSymbolicLink()) throw new Error('src must not be a symlink');
    if (!l.isFile()) throw new Error('src must be a regular file');
    const max = kind === 'image' ? LIMITS.imageBytes : LIMITS.htmlBytes;
    if (l.size > max) throw new Error(`src exceeds ${max} bytes`);
    const realDir = await fsp.realpath(this.artifactsDir);
    if (!(await fsp.realpath(file)).startsWith(realDir + path.sep)) throw new Error('src escapes the artifacts dir');
    return src;
  }

  // Bytes for GET /api/artifact/:id/content (html or image only). Re-validates at read time.
  async artifactContent(id) {
    if (!isId(id)) throw new HttpError(404, 'unknown artifact');
    const art = await this.loadArtifact(id, `${id}.json`);
    if (art.error) throw new HttpError(404, 'artifact unavailable');
    if (art.type === 'html' && art.content !== undefined) {
      return { type: 'text/html; charset=utf-8', body: Buffer.from(art.content, 'utf8') };
    }
    if ((art.type === 'html' || art.type === 'image') && art.src) {
      const kind = art.type;
      try { await this.checkSrc(art.src, kind); } catch (e) { throw new HttpError(404, e.message); }
      const max = kind === 'image' ? LIMITS.imageBytes : LIMITS.htmlBytes;
      const body = await readNoFollow(path.join(this.artifactsDir, art.src), max);
      const type = kind === 'image' ? IMAGE_MIME[path.extname(art.src).toLowerCase()] : 'text/html; charset=utf-8';
      return { type, body };
    }
    throw new HttpError(404, 'artifact has no servable content');
  }

  watch() {
    if (this.closed) return;
    try { this.watcher?.close(); } catch {}
    this.watcher = null;
    try {
      this.watcher = fs.watch(this.artifactsDir, { persistent: false, recursive: true }, () => this.schedule());
      this.watcher.on('error', () => { try { this.watcher?.close(); } catch {} this.watcher = null; this.fallbackPoll(); });
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    } catch {
      this.fallbackPoll();
    }
  }

  // Only used when fs.watch is unavailable/broken: slow poll that also tries to re-arm the watcher.
  fallbackPoll() {
    if (this.closed || this.pollTimer) return;
    this.pollTimer = setInterval(() => { this.rescan().catch(() => {}); this.watch(); }, 5000);
    this.pollTimer.unref?.();
  }

  schedule() {
    if (this.closed) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.rescan().catch(() => {}), 100);
    this.debounce.unref?.();
  }

  // ---------- browser-owned JSON state ----------
  // After close (task switched away or deleted) queued and late writes fail instead of touching the old task.
  withLock(fn) {
    const guarded = () => { if (this.closed) throw new HttpError(409, 'this task is no longer open; reload the canvas'); return fn(); };
    const run = this.lock.then(guarded, guarded);
    this.lock = run.catch(() => {});
    return run;
  }

  async readJson(name, fallback, validate) {
    const file = path.join(this.canvasDir, name);
    try {
      const l = await fsp.lstat(file);
      if (l.isSymbolicLink() || !l.isFile() || l.size > LIMITS.stateBytes * 2) throw new Error('not a safe regular state file');
      const data = JSON.parse((await readNoFollow(file, LIMITS.stateBytes * 2)).toString('utf8'));
      return validate(data);
    } catch (error) {
      if (error.code === 'ENOENT') return fallback();
      throw new HttpError(409, `${name} cannot be read safely; preserve and repair the file before saving: ${error.message}`);
    }
  }

  async writeJson(name, data) {
    const file = path.join(this.canvasDir, name);
    try {
      const l = await fsp.lstat(file);
      if (l.isSymbolicLink() || !l.isFile()) throw new HttpError(500, `refusing to overwrite non-regular ${name}`);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    const tmp = path.join(this.canvasDir, `.${name}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const fh = await fsp.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      await fh.writeFile(JSON.stringify(data, null, 2) + '\n');
      await fh.sync();
    } finally { await fh.close(); }
    try { await fsp.rename(tmp, file); } catch (err) { await fsp.rm(tmp, { force: true }); throw err; }
  }

  getBoard() { return this.readJson('board.json', defaultBoard, (d) => { const v = validateBoard(d, true); return { rev: v.rev, viewport: v.viewport, items: v.items }; }); }
  getNotes() { return this.readJson('notes.json', defaultNotes, (d) => { const v = validateNotes(d, true); return { rev: v.rev, items: v.items }; }); }
  getThread(engine = 'codex') {
    if (!['codex', 'pi'].includes(engine)) throw new HttpError(400, 'unknown agent');
    return this.readJson(engine === 'pi' ? 'thread-pi.json' : 'thread.json', defaultThread, (d) => {
      if (!isPlain(d)) return defaultThread();
      const threadId = typeof d.threadId === 'string' && d.threadId.length <= 200 ? d.threadId : null;
      const messages = Array.isArray(d.messages) ? d.messages.filter((m) => isPlain(m) && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string').slice(-LIMITS.messages).map((m) => ({ role: m.role, text: m.text.slice(0, LIMITS.messageText) })) : [];
      return { threadId, messages, ...(engine === 'pi' && typeof d.sessionFile === 'string' && d.sessionFile.length <= 2000 ? { sessionFile: d.sessionFile } : {}) };
    });
  }

  putBoard(body) {
    return this.withLock(async () => {
      const next = validateBoard(body, false);
      const cur = await this.getBoard();
      if (next.rev !== cur.rev) throw Object.assign(new HttpError(409, 'board revision conflict'), { current: cur });
      const out = { rev: cur.rev + 1, viewport: next.viewport, items: next.items };
      await this.writeJson('board.json', out);
      this.emit('change', 'board');
      return out;
    });
  }

  putNotes(body) {
    return this.withLock(async () => {
      const next = validateNotes(body, false);
      const cur = await this.getNotes();
      if (next.rev !== cur.rev) throw Object.assign(new HttpError(409, 'notes revision conflict'), { current: cur });
      const out = { rev: cur.rev + 1, items: next.items };
      await this.writeJson('notes.json', out);
      this.emit('change', 'notes');
      return out;
    });
  }

  putThread(thread, engine = 'codex') {
    if (!['codex', 'pi'].includes(engine)) throw new HttpError(400, 'unknown agent');
    return this.withLock(() => this.writeJson(engine === 'pi' ? 'thread-pi.json' : 'thread.json', {
      threadId: thread.threadId,
      ...(engine === 'pi' && thread.sessionFile ? { sessionFile: thread.sessionFile } : {}),
      messages: thread.messages.slice(-LIMITS.messages).map((m) => ({ role: m.role, text: String(m.text).slice(0, LIMITS.messageText) })),
    }));
  }

  close() {
    this.closed = true;
    clearTimeout(this.debounce);
    clearTimeout(this.retryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    try { this.watcher?.close(); } catch {}
  }
}

function validRev(r) { return Number.isSafeInteger(r) && r >= 0; }

export function validateBoard(b, lenient) {
  const bad = (m) => { throw new HttpError(400, m); };
  if (!isPlain(b)) bad('board must be an object');
  if (!validRev(b.rev)) bad('rev must be a non-negative integer');
  const v = b.viewport;
  if (!isPlain(v) || ![v.x, v.y, v.zoom].every(Number.isFinite) || v.zoom < 0.01 || v.zoom > 100) bad('viewport must be {x,y,zoom} finite numbers, zoom 0.01..100');
  if (!isPlain(b.items)) bad('items must be an object');
  const keys = Object.keys(b.items);
  if (keys.length > LIMITS.boardItems) bad(`at most ${LIMITS.boardItems} board items`);
  for (const k of keys) {
    if (k.length > 200 || k === '__proto__') bad('invalid board item key');
    if (!isPlain(b.items[k])) bad(`board item ${k.slice(0, 50)} must be an object`);
  }
  const items = JSON.parse(JSON.stringify(b.items));
  if (!lenient && JSON.stringify(items).length > LIMITS.stateBytes) bad('board too large');
  return { rev: b.rev, viewport: { x: v.x, y: v.y, zoom: v.zoom }, items };
}

export function validateNotes(n, lenient) {
  const bad = (m) => { throw new HttpError(400, m); };
  if (!isPlain(n)) bad('notes must be an object');
  if (!validRev(n.rev)) bad('rev must be a non-negative integer');
  if (!Array.isArray(n.items) || n.items.length > LIMITS.notes) bad(`items must be an array of at most ${LIMITS.notes} notes`);
  const seen = new Set();
  const items = n.items.map((it) => {
    if (!isPlain(it) || typeof it.id !== 'string' || !it.id || it.id.length > 100 || typeof it.text !== 'string' || it.text.length > LIMITS.noteText) bad('note must be {id:string<=100, text:string}');
    if (seen.has(it.id)) bad('duplicate note id');
    seen.add(it.id);
    return { id: it.id, text: it.text };
  });
  void lenient;
  return { rev: n.rev, items };
}

// ---------- tasks ----------
const taskDir = (canvasRoot, id) => (id === ROOT_TASK ? canvasRoot : path.join(canvasRoot, 'tasks', id));
const realDir = (l) => l.isDirectory() && !l.isSymbolicLink();

export async function taskExists(canvasRoot, id) {
  if (!isTaskId(id)) return false;
  if (id === ROOT_TASK) return true;
  for (const p of [path.join(canvasRoot, 'tasks'), taskDir(canvasRoot, id)]) {
    const l = await fsp.lstat(p).catch(() => null);
    if (!l || !realDir(l)) return false;
  }
  return true;
}

export async function taskInfo(canvasRoot, id) {
  let meta = null;
  if (id !== ROOT_TASK) try {
    const file = path.join(taskDir(canvasRoot, id), 'task.json');
    if ((await fsp.lstat(file)).isFile()) meta = JSON.parse((await readNoFollow(file, 64 * 1024)).toString('utf8'));
  } catch {}
  const title = typeof meta?.title === 'string' && meta.title.trim() ? meta.title.slice(0, LIMITS.title) : null;
  return { id, title, createdAt: typeof meta?.createdAt === 'string' ? meta.createdAt.slice(0, 40) : null };
}

async function rootHasContent(canvasRoot) {
  for (const name of await fsp.readdir(canvasRoot)) {
    if (!ROOT_OWNED.test(name)) continue;
    if (name !== 'artifacts' && name !== 'pi-sessions') return true;
    if ((await fsp.readdir(path.join(canvasRoot, name)).catch(() => [''])).length) return true;
  }
  return false;
}

// Retained tasks, newest first. The root task is listed while open or while it still owns content.
export async function listTasks(canvasRoot, currentId) {
  const items = [], tasksDir = path.join(canvasRoot, 'tasks');
  const l = await fsp.lstat(tasksDir).catch(() => null);
  const names = l && realDir(l) ? (await fsp.readdir(tasksDir)).filter((n) => TASK_RE.test(n)) : [];
  for (const id of names.slice(0, 1000)) if (await taskExists(canvasRoot, id)) items.push(await taskInfo(canvasRoot, id));
  if (currentId === ROOT_TASK || await rootHasContent(canvasRoot)) items.push(await taskInfo(canvasRoot, ROOT_TASK));
  return items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

// Removes only task-owned files. fs.rm unlinks symlinks without following them, so link targets survive.
export async function deleteTaskFiles(canvasRoot, id) {
  if (!isTaskId(id)) throw new HttpError(400, 'invalid task id');
  const root = await fsp.lstat(canvasRoot);
  if (!realDir(root)) throw new HttpError(409, 'refusing to delete through a symlinked .canvas');
  if (id === ROOT_TASK) {
    for (const name of await fsp.readdir(canvasRoot)) if (ROOT_OWNED.test(name)) await fsp.rm(path.join(canvasRoot, name), { recursive: true, force: true });
    return;
  }
  for (const p of [path.join(canvasRoot, 'tasks'), taskDir(canvasRoot, id)]) {
    const l = await fsp.lstat(p).catch((e) => { throw e.code === 'ENOENT' ? new HttpError(404, 'unknown task') : e; });
    if (!realDir(l)) throw new HttpError(409, `refusing to delete non-directory or symlink: ${p}`);
  }
  await fsp.rm(taskDir(canvasRoot, id), { recursive: true });
}

async function readNoFollow(file, max) {
  const fh = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new HttpError(404, 'not a regular file');
    if (st.size > max) throw new HttpError(413, 'file too large');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const { bytesRead } = await fh.read(buf, off, st.size - off, off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return buf.subarray(0, off);
  } finally { await fh.close(); }
}
