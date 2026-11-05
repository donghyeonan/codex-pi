import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../server.mjs';
import {Store} from '../store.mjs';
import {ChatManager} from '../codex.mjs';
import {chooseAgent,detectAgents} from '../agents.mjs';
import {validatePiAnswer,piEnvironment} from '../pi.mjs';
const piCommand=[process.execPath,new URL('./fake-pi.mjs',import.meta.url).pathname],codexCommand=[process.execPath,new URL('./fake-codex.mjs',import.meta.url).pathname];
async function setup(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'canvas-agents-'));const app=await startServer({workspace:root,port:0,backend:'auto',piCommand,codexCommand});t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true})});return app}
async function api(app,route,data){const res=await fetch(app.origin+'/api/'+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});return{status:res.status,body:await res.json()}}
function until(manager,predicate){if(predicate(manager.snapshot()))return Promise.resolve();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{manager.off('state',check);reject(new Error('state deadline'))},3000);function check(){if(predicate(manager.snapshot())){clearTimeout(timer);manager.off('state',check);resolve()}}manager.on('state',check)})}
test('selection prefers local Pi, provided Codex context or Codex-only environment; explicit missing engine fails',async()=>{
 assert.equal(chooseAgent('auto',{pi:'pi',codex:'codex'},{}),'pi');
 assert.equal(chooseAgent('auto',{pi:null,codex:'codex'},{}),'codex');
 assert.equal(chooseAgent('auto',{pi:'pi',codex:'codex'},{CODEX_THREAD_ID:'provided'}),'codex');
 assert.equal(chooseAgent('codex',{pi:'pi',codex:'codex'},{}),'codex');
 assert.throws(()=>chooseAgent('pi',{pi:null,codex:'codex'},{}),/not installed/);
 assert.deepEqual(await detectAgents({home:'/no-such-home',env:{PATH:''}}),{pi:null,codex:null});
 const env=piEnvironment({PATH:'/bin',PI_SESSION_FILE:'/live',PI_SESSION_ID:'live',PEN_PI_BRIDGE_CONFIG:'/active',CODEX_HOME:'/provided/auth'});assert.equal(env.PI_SESSION_FILE,undefined);assert.equal(env.PEN_PI_BRIDGE_CONFIG,undefined);assert.equal(env.CODEX_HOME,'/provided/auth');
});
test('Pi/Codex switch preserves independent resumable threads and shared artifacts; busy switch rejected',async t=>{
 const app=await setup(t);assert.equal(app.chat.snapshot().engine,'pi');
 let r=await api(app,'chat',{text:'hello'});assert.equal(r.status,202);await until(app.chat,s=>s.status==='idle'&&s.messages.some(m=>m.text==='pi:1\u2028그대로'));
 assert.equal(app.chat.snapshot().messages.filter(m=>m.role==='user').length,1);
 const piId=app.chat.snapshot().threadId;
 assert.equal((await api(app,'agent',{backend:'codex'})).status,200);assert.equal(app.chat.snapshot().messages.length,0);
 await api(app,'chat',{text:'hello codex'});await until(app.chat,s=>s.status==='idle'&&s.messages.some(m=>m.text==='echo:1'));
 const codexId=app.chat.snapshot().threadId;
 assert.equal((await api(app,'agent',{backend:'pi'})).status,200);assert.equal(app.chat.snapshot().threadId,piId);
 await api(app,'chat',{text:'continue'});await until(app.chat,s=>s.status==='idle'&&s.messages.some(m=>m.text==='pi:2\u2028그대로'));
 assert.equal(app.chat.snapshot().messages.some(m=>m.text==='echo:1'),false);
 await api(app,'chat',{text:'HANG'});assert.equal((await api(app,'agent',{backend:'codex'})).status,409);await api(app,'interrupt',{});await until(app.chat,s=>s.status==='idle');
 assert.equal((await api(app,'agent',{backend:'codex'})).status,200);assert.equal(app.chat.snapshot().threadId,codexId);
 assert.equal((await app.store.getThread()).threadId,codexId);assert.equal((await app.store.getThread('pi')).threadId,piId);
});
test('Pi /q uses explicit RPC UI responses; cancellation is not an answer',async t=>{
 const app=await setup(t);const turn=api(app,'chat',{text:'/q'});
 await until(app.chat,s=>s.pending.length===1);assert.equal(app.chat.snapshot().pending[0].method,'pi/select');
 assert.equal((await api(app,'answer',{id:'question-1',result:{value:'forged'}})).status,400);
 assert.equal((await api(app,'answer',{id:'question-1',result:{cancelled:true}})).status,200);assert.equal((await turn).status,202);await until(app.chat,s=>s.status==='idle');assert.ok(!app.chat.snapshot().messages.some(m=>m.text.startsWith('answer:')));
 const second=api(app,'chat',{text:'/q'});await until(app.chat,s=>s.pending.length===1);await api(app,'answer',{id:'question-1',result:{value:'B'}});await second;await until(app.chat,s=>s.status==='idle');assert.ok(app.chat.snapshot().messages.some(m=>m.text==='answer:B'));
 assert.throws(()=>validatePiAnswer({method:'confirm'},{}),/explicit/);
});
test('assistant completion retires the live bubble before persisted state; duplicate item event is ignored',async()=>{
 const m=new ChatManager({store:{putThread:async()=>{}}}),client={};m.client=client;const events=[];m.on('delta',e=>events.push(e));m.on('state',()=>events.push('state'));
 const event={method:'item/completed',params:{item:{id:'a',type:'agentMessage',text:'one reply'}}};m.onNotification(client,event);m.onNotification(client,event);
 assert.equal(m.messages.length,1);assert.deepEqual(events[0],{reset:true,text:''});assert.equal(events[1],'state');
});
test('nested src and workspace-prefixed src remain confined; traversal and parent symlinks rejected',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'canvas-src-'));const store=new Store(root);await store.init();t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true})});
 await fs.mkdir(path.join(store.artifactsDir,'stageshow-assets'));await fs.writeFile(path.join(store.artifactsDir,'stageshow-assets/a.jpg'),'fixture');
 assert.equal(await store.checkSrc('.canvas/artifacts/stageshow-assets/a.jpg','image'),'stageshow-assets/a.jpg');
 const cited=await store.normalize('cited',{type:'image',src:'.canvas/artifacts/stageshow-assets/a.jpg',sources:[{label:'Local code',url:'/private/example.ts'}]});assert.deepEqual(cited.sources,[{label:'Local code',path:'/private/example.ts'}]);
 await assert.rejects(store.normalize('bad-url',{type:'markdown',sources:[{label:'Bad',url:'javascript:alert(1)'}]}),/http/);
 await assert.rejects(store.checkSrc('../outside.jpg','image'),/safe/);await assert.rejects(store.checkSrc('/etc/passwd','image'),/safe/);
 await fs.symlink(os.tmpdir(),path.join(store.artifactsDir,'outside'));await assert.rejects(store.checkSrc('outside/a.jpg','image'),/symlink/);
 await fs.writeFile(path.join(store.artifactsDir,'nested.json'),JSON.stringify({type:'image',src:'.canvas/artifacts/stageshow-assets/a.jpg'}));assert.equal((await store.artifactContent('nested')).body.toString(),'fixture');
});
