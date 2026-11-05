#!/usr/bin/env node
// Test-only stand-in for `codex app-server --stdio`. Behaviour is selected by the user text:
//   APPROVAL -> item/commandExecution/requestApproval, waits for the answer
//   UNKNOWN  -> unknown server request, expects an immediate JSON-RPC error
//   HANG     -> never completes until turn/interrupt
//   EXIT     -> process exits mid-turn
//   default  -> streams "echo:<n>" and completes
// Every received message is appended to $FAKE_CODEX_LOG (JSONL) for assertions.
import fs from 'node:fs';
import readline from 'node:readline';

const log = (m) => { if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(m) + '\n'); };
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
log({ argv: process.argv.slice(2), cwd: process.cwd(), codexHome: process.env.CODEX_HOME ?? null });

let initialized = false;
let initRequested = false;
let turnN = 0;
let srvId = 1000;
const waiting = new Map(); // server request id -> resolver
const threads = new Set(['thr_existing']);
let active = null; // {threadId, turnId, hang}

const thread = (id) => ({ id, cliVersion: '0.0.0-fake', createdAt: 0, updatedAt: 0, cwd: process.cwd(), ephemeral: false, modelProvider: 'fake', preview: '', projectId: null, sessionId: id, source: 'appServer', status: { type: 'idle' }, turns: [] });
const turn = (id, status, items = []) => ({ id, status, items, error: null });

function serverRequest(method, params) {
  const id = srvId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

function complete(threadId, turnId, text, status = 'completed') {
  if (text) {
    for (const part of [text.slice(0, 3), text.slice(3)]) send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: `msg_${turnId}`, delta: part } });
    send({ method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { type: 'agentMessage', id: `msg_${turnId}`, text } } });
  }
  send({ method: 'turn/completed', params: { threadId, turn: turn(turnId, status) } });
  active = null;
}

async function runTurn(threadId, turnId, text) {
  send({ method: 'turn/started', params: { threadId, turn: turn(turnId, 'inProgress') } });
  if (text.includes('APPROVAL')) {
    const ans = await serverRequest('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'cmd_1', startedAtMs: Date.now(), command: 'ls', cwd: process.cwd(), reason: 'test' });
    send({ method: 'serverRequest/resolved', params: { threadId, requestId: ans.id } });
    complete(threadId, turnId, `approval:${JSON.stringify(ans.result?.decision ?? ans.error?.code)}`);
  } else if (text.includes('UNKNOWN')) {
    const ans = await serverRequest('bogus/method', { threadId });
    const ans2 = await serverRequest('item/tool/call', { threadId, turnId, callId: 'c', tool: 't', arguments: {} });
    complete(threadId, turnId, `unknown:${ans.error?.code},${ans2.error?.code}`);
  } else if (text.includes('MIDTURN')) {
    send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'mid_'+turnId, delta: 'one completed reply' } });
    send({ method: 'item/completed', params: { threadId, turnId, item: { type:'agentMessage', id:'mid_'+turnId, text:'one completed reply' } } });
    setTimeout(() => complete(threadId, turnId, ''), 700);
  } else if (text.includes('HANG')) {
    active.hang = true;
  } else if (text.includes('EXIT')) {
    setTimeout(() => process.exit(3), 20);
  } else {
    complete(threadId, turnId, `echo:${turnN}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  log(msg);
  if (msg.method === undefined && waiting.has(msg.id)) {
    const r = waiting.get(msg.id);
    waiting.delete(msg.id);
    r(msg);
    return;
  }
  if (msg.method === 'initialized') { initialized = initRequested; return; }
  if (msg.id === undefined) return;
  const reply = (result) => send({ id: msg.id, result });
  const fail = (message) => send({ id: msg.id, error: { code: -32600, message } });
  if (msg.method === 'initialize') {
    if (initRequested) return fail('already initialized');
    initRequested = true;
    return reply({ codexHome: process.env.CODEX_HOME || '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake' });
  }
  if (!initialized) return fail('Not initialized');
  const p = msg.params || {};
  switch (msg.method) {
    case 'thread/start': {
      const id = `thr_${Math.random().toString(36).slice(2, 8)}`;
      threads.add(id);
      return reply({ thread: thread(id), approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: process.cwd(), model: 'fake', modelProvider: 'fake', sandbox: { type: 'readOnly' } });
    }
    case 'thread/resume':
      if (!threads.has(p.threadId) && !String(p.threadId).startsWith('thr_')) return fail('no such thread');
      threads.add(p.threadId);
      return reply({ thread: thread(p.threadId), approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: process.cwd(), model: 'fake', modelProvider: 'fake', sandbox: { type: 'readOnly' } });
    case 'turn/start': {
      if (!threads.has(p.threadId)) return fail('thread not loaded');
      if (active) return fail('turn already active');
      const turnId = `turn_${++turnN}`;
      active = { threadId: p.threadId, turnId };
      reply({ turn: turn(turnId, 'inProgress') });
      const text = p.input?.[0]?.text || '';
      setTimeout(() => runTurn(p.threadId, turnId, text), 10);
      return;
    }
    case 'turn/interrupt':
      if (!active || active.turnId !== p.turnId) return fail('no such turn');
      reply({});
      complete(active.threadId, active.turnId, '', 'interrupted');
      return;
    default:
      return send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
});
rl.on('close', () => process.exit(0));
