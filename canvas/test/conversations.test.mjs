import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../server.mjs';
const commands={piCommand:[process.execPath,new URL('./fake-pi.mjs',import.meta.url).pathname],codexCommand:[process.execPath,new URL('./fake-codex.mjs',import.meta.url).pathname]};
async function api(app,route,data){const r=await fetch(app.origin+'/api/'+route,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:r.status,body:await r.json()}}
function idle(app){if(app.chat.snapshot().status==='idle')return Promise.resolve();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{app.chat.off('state',check);reject(new Error('idle deadline'))},3000);function check(){if(app.chat.snapshot().status==='idle'){clearTimeout(timer);app.chat.off('state',check);resolve()}}app.chat.on('state',check)})}
test('New archives a conversation; selection and server restart resume the same native Pi session',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'canvas-conversations-'));let app=await startServer({workspace:root,port:0,backend:'pi',...commands});t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true})});
 assert.equal((await api(app,'chat',{text:'First conversation'})).status,202);await idle(app);
 const first=app.chat.snapshot().threadId;
 assert.equal((await api(app,'conversations',{})).status,200);assert.equal(app.chat.snapshot().threadId,null);assert.equal(app.chat.snapshot().messages.length,0);
 const saved=(await api(app,'conversations')).body.items;assert.equal(saved.length,1);assert.equal(saved[0].title,'First conversation');
 assert.equal((await api(app,'chat',{text:'Second conversation'})).status,202);await idle(app);assert.notEqual(app.chat.snapshot().threadId,first);
 assert.equal((await api(app,'conversations',{id:saved[0].id})).status,200);assert.equal(app.chat.snapshot().threadId,first);assert.ok(!app.chat.snapshot().messages.some(m=>m.text==='Second conversation'));
 await app.close();app=await startServer({workspace:root,port:0,backend:'pi',...commands});assert.equal(app.chat.snapshot().threadId,first);
 await api(app,'chat',{text:'Continue first'});await idle(app);assert.ok(app.chat.snapshot().messages.some(m=>m.text==='pi:2\u2028그대로'));
 const second=(await api(app,'conversations')).body.items;assert.equal(second.length,1);assert.equal(second[0].title,'Second conversation');
 const before=app.chat.snapshot().messages;
 assert.equal((await api(app,'conversations',{id:'../thread-pi'})).status,400);
 assert.equal((await api(app,'conversations',{id:'conversation-codex-'+ 'f'.repeat(24)})).status,400);
 assert.equal((await api(app,'conversations',{id:'conversation-pi-'+ 'f'.repeat(24)})).status,409);assert.deepEqual(app.chat.snapshot().messages,before);
 await api(app,'chat',{text:'HANG'});assert.equal((await api(app,'conversations',{})).status,409);await api(app,'interrupt',{});await idle(app);
});
