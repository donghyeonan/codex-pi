import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handle } from './context-hook.mjs';
test('threshold, deduplication, reset, invalid telemetry and resume', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-hook-'));
 try {
  const transcript = path.join(root, 'session');
  const input = { hook_event_name: 'PostToolUse', session_id: '../../x', transcript_path: transcript };
  const usage = (used, max=100) => fs.writeFileSync(transcript, JSON.stringify({ type:'event_msg', payload:{type:'token_count',info:{last_token_usage:{total_tokens:used},total_token_usage:{total_tokens:999999},model_context_window:max}}})+'\n');
  usage(20); assert.equal(handle(input,root),null);
  usage(69); assert.equal(handle(input,root),null);
  usage(70); assert.match(handle(input,root).hookSpecificOutput.additionalContext,/30% remaining/);
  assert.equal(handle(input,root),null);
  usage(79); assert.equal(handle(input,root),null);
  usage(80); assert.match(handle(input,root).hookSpecificOutput.additionalContext,/20% remaining/);
  usage(90); assert.equal(handle(input,root),null);
  usage(75); assert.equal(handle(input,root),null);
  usage(80); assert.equal(handle(input,root),null);
  usage(10); assert.equal(handle(input,root),null);
  usage(90); assert.ok(handle(input,root));
  usage(90,0); assert.equal(handle(input,root),null);
  fs.writeFileSync(transcript,'broken'); assert.equal(handle(input,root),null);
  assert.match(handle({hook_event_name:'SessionStart'},root).hookSpecificOutput.additionalContext,/latest/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
