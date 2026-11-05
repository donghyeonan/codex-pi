// node --test canvas/test/tasks.test.mjs
// Task lifecycle in fresh temp workspaces with fake Codex/Pi; never touches a real workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {startServer} from '../server.mjs';
import {Store} from '../store.mjs';
const piCommand=[process.execPath,new URL('./fake-pi.mjs',import.meta.url).pathname],codexCommand=[process.execPath,new URL('./fake-codex.mjs',import.meta.url).pathname];
function fixture(t){
 const apps=[],dirs=[];
 t.after(async()=>{for(const a of apps)await a.close().catch(()=>{});for(const d of dirs)await fs.rm(d,{recursive:true,force:true})});
 return{async tmp(prefix='canvas-tasks-'){const d=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),prefix)));dirs.push(d);return d},
  async start(workspace,opts={}){const app=await startServer({workspace,port:0,codexCommand,backend:'codex',...opts});apps.push(app);return app}};
}
async function api(app,route,data,{method,task}={}){const r=await fetch(app.origin+'/api/'+route,{method:method||(data===undefined?'GET':'POST'),headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json',...(task?{'X-Canvas-Task':task}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:r.status,body:await r.json().catch(()=>null)}}
function idle(app){const chat=app.chat;if(chat.snapshot().status==='idle')return Promise.resolve();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{chat.off('state',check);reject(new Error('idle deadline'))},3000);function check(){if(chat.snapshot().status==='idle'){clearTimeout(timer);chat.off('state',check);resolve()}}chat.on('state',check)})}
async function snap(dir){const out={};async function walk(d){for(const e of await fs.readdir(d,{withFileTypes:true})){const p=path.join(d,e.name),rel=path.relative(dir,p);if(e.isSymbolicLink())out[rel]='link:'+await fs.readlink(p);else if(e.isDirectory()){out[rel+'/']='dir';await walk(p)}else out[rel]=crypto.createHash('sha1').update(await fs.readFile(p)).digest('hex')}}await walk(dir);return out}
const gone=(p)=>assert.rejects(fs.lstat(p),{code:'ENOENT'});

test('legacy root .canvas is adopted in place; a new task starts empty; both reopen complete after restart',async t=>{
 const f=fixture(t),ws=await f.tmp(),log=path.join(await f.tmp('canvas-tasks-log-'),'codex.jsonl');
 await fs.mkdir(path.join(ws,'.canvas/artifacts'),{recursive:true});await fs.mkdir(path.join(ws,'src'));await fs.writeFile(path.join(ws,'src/data.csv'),'a,b\n1,2\n');
 const legacy={'artifacts/legacy.json':JSON.stringify({title:'Legacy',type:'markdown',content:'old'}),'board.json':JSON.stringify({rev:3,viewport:{x:1,y:2,zoom:1},items:{legacy:{x:5,y:6,w:100,h:100}}}),'notes.json':JSON.stringify({rev:2,items:[{id:'n1',text:'legacy note'}]}),'thread.json':JSON.stringify({threadId:'thr_existing',messages:[{role:'user',text:'old question'},{role:'assistant',text:'old answer'}]}),'agent.json':JSON.stringify({backend:'codex'}),'keep.txt':'user file'};
 for(const[k,v]of Object.entries(legacy))await fs.writeFile(path.join(ws,'.canvas',k),v);
 const before=await snap(ws);
 let app=await f.start(ws);
 let s=(await api(app,'state')).body;
 assert.deepEqual(s.task,{id:'root',title:null,createdAt:null,epoch:1});
 assert.deepEqual([s.artifacts.map(a=>a.id),s.board.rev,s.notes.items,s.chat.messages.map(m=>m.text)],[['legacy'],3,[{id:'n1',text:'legacy note'}],['old question','old answer']]);
 assert.deepEqual(await snap(ws),before,'startup adopts the legacy task without writing or moving anything');
 assert.deepEqual((await api(app,'tasks')).body,{current:'root',items:[{id:'root',title:null,createdAt:null}]});

 let r=await api(app,'tasks',{});assert.equal(r.status,200);
 const id=r.body.task.id;assert.match(id,/^[a-f0-9]{16}$/);assert.equal(r.body.task.title,null);assert.ok(Date.parse(r.body.task.createdAt));
 assert.deepEqual({artifacts:r.body.artifacts,board:r.body.board,notes:r.body.notes,messages:r.body.chat.messages,threadId:r.body.chat.threadId},{artifacts:[],board:{rev:0,viewport:{x:0,y:0,zoom:1},items:{}},notes:{rev:0,items:[]},messages:[],threadId:null});
 const after=await snap(ws);for(const[k,v]of Object.entries(before))assert.equal(after[k],v,k);
 assert.deepEqual(Object.keys(after).filter(k=>!(k in before)&&!k.startsWith('.canvas/tasks/')),['.canvas/current-task.json']);

 assert.equal(app.store.artifactsDir,path.join(ws,'.canvas/tasks',id,'artifacts'));
 await fs.writeFile(path.join(app.store.artifactsDir,'fresh.json'),JSON.stringify({title:'Fresh',type:'markdown',content:'new'}));await app.store.rescan();
 assert.equal((await api(app,'board',{rev:0,viewport:{x:9,y:9,zoom:2},items:{fresh:{x:1,y:1,w:50,h:50}}},{method:'PUT',task:id})).status,200);
 assert.equal((await api(app,'notes',{rev:0,items:[{id:'n2',text:'new note'}]},{method:'PUT',task:id})).status,200);
 process.env.FAKE_CODEX_LOG=log;
 try{assert.equal((await api(app,'chat',{text:'Plan the new task'},{task:id})).status,202);await idle(app)}finally{delete process.env.FAKE_CODEX_LOG}
 const turn=(await fs.readFile(log,'utf8')).trim().split('\n').map(l=>JSON.parse(l)).find(m=>m.method==='turn/start');
 assert.ok(turn.params.input[0].text.includes(`write one JSON file per artifact to .canvas/tasks/${id}/artifacts/<id>.json`),'agent is told the task-local artifact dir');
 assert.equal((await api(app,'state')).body.task.title,'Plan the new task');
 assert.deepEqual((await api(app,'tasks')).body.items.map(i=>[i.id,i.title]),[[id,'Plan the new task'],['root',null]]);

 r=await api(app,'tasks',{id:'root'});assert.equal(r.status,200);
 assert.deepEqual([r.body.task.id,r.body.artifacts.map(a=>a.id),r.body.board.rev,r.body.notes.items,r.body.chat.messages.length],['root',['legacy'],3,[{id:'n1',text:'legacy note'}],2]);
 await app.close();
 app=await f.start(ws);assert.equal((await api(app,'state')).body.task.id,'root','restart reopens the last open task');
 r=await api(app,'tasks',{id});
 assert.deepEqual(r.body.artifacts.map(a=>a.id),['fresh']);
 assert.deepEqual(r.body.board,{rev:1,viewport:{x:9,y:9,zoom:2},items:{fresh:{x:1,y:1,w:50,h:50}}});
 assert.deepEqual(r.body.notes.items,[{id:'n2',text:'new note'}]);
 assert.deepEqual(r.body.chat.messages.map(m=>m.text),['Plan the new task','echo:1']);
 assert.equal(r.body.task.title,'Plan the new task');
 await app.close();app=await f.start(ws);assert.equal((await api(app,'state')).body.task.id,id);
 const final=await snap(ws);for(const[k,v]of Object.entries(before))assert.equal(final[k],v,'legacy file untouched: '+k);
});

test('confirmed delete removes only task-owned files incl. task-local Pi sessions; source, shared and linked files survive',async t=>{
 const f=fixture(t),ws=await f.tmp(),outside=await f.tmp('canvas-tasks-outside-'),refsDir=await f.tmp('canvas-tasks-refs-');
 await fs.writeFile(path.join(ws,'source.txt'),'workspace source');await fs.mkdir(path.join(outside,'dir'));await fs.writeFile(path.join(outside,'dir/file.txt'),'external');await fs.writeFile(path.join(outside,'secret.png'),'external image');await fs.writeFile(path.join(refsDir,'ref.png'),'ref');
 await fs.mkdir(path.join(ws,'.canvas/artifacts'),{recursive:true});await fs.writeFile(path.join(ws,'.canvas/artifacts/legacy.json'),JSON.stringify({title:'Legacy',type:'markdown',content:'x'}));await fs.writeFile(path.join(ws,'.canvas/keep.txt'),'foreign');
 const app=await f.start(ws,{backend:'pi',piCommand,refsDir});
 const a=(await api(app,'tasks',{})).body.task.id,aDir=path.join(ws,'.canvas/tasks',a);
 assert.equal((await api(app,'chat',{text:'hello pi'})).status,202);await idle(app);
 assert.equal((await fs.readdir(path.join(aDir,'pi-sessions'))).length,1,'Pi session is task-local');
 await fs.writeFile(path.join(aDir,'artifacts/pic.png'),'attachment');
 await fs.symlink(path.join(outside,'dir'),path.join(aDir,'artifacts/linked-dir'));await fs.symlink(path.join(outside,'secret.png'),path.join(aDir,'artifacts/linked.png'));await fs.symlink(path.join(ws,'source.txt'),path.join(aDir,'artifacts/source-link.txt'));
 const b=(await api(app,'tasks',{})).body.task.id,bDir=path.join(ws,'.canvas/tasks',b);
 const keepB=await snap(bDir),outsideBefore=await snap(outside),refsBefore=await snap(refsDir);
 let r=await api(app,'tasks/delete',{id:a});assert.equal(r.status,200);assert.equal(r.body.task.id,b,'deleting another task keeps the open one');
 await gone(aDir);
 assert.deepEqual(await snap(outside),outsideBefore);assert.deepEqual(await snap(bDir),keepB);assert.equal(await fs.readFile(path.join(ws,'source.txt'),'utf8'),'workspace source');
 assert.equal((await api(app,'tasks/delete',{id:a})).status,404);
 r=await api(app,'tasks/delete',{id:b});assert.equal(r.status,200);
 assert.deepEqual([r.body.task.id,r.body.artifacts.map(x=>x.id)],['root',['legacy']],'deleting the open task opens the newest remaining one');
 await gone(bDir);
 assert.equal((await api(app,'chat',{text:'root pi'})).status,202);await idle(app);
 assert.equal((await fs.readdir(path.join(ws,'.canvas/pi-sessions'))).length,1);
 r=await api(app,'tasks/delete',{id:'root'});assert.equal(r.status,200);
 const c=r.body.task.id;assert.match(c,/^[a-f0-9]{16}$/,'with no task left a new empty one opens');assert.deepEqual([r.body.artifacts,r.body.chat.messages],[[],[]]);
 assert.deepEqual((await fs.readdir(path.join(ws,'.canvas'))).sort(),['current-task.json','keep.txt','tasks'],'root task files removed; shared/foreign entries kept');
 assert.deepEqual(await fs.readdir(path.join(ws,'.canvas/tasks')),[c]);
 assert.deepEqual((await api(app,'tasks')).body.items.map(i=>i.id),[c],'an emptied root task is no longer listed');
 assert.deepEqual(await snap(outside),outsideBefore);assert.deepEqual(await snap(refsDir),refsBefore);assert.equal(await fs.readFile(path.join(ws,'source.txt'),'utf8'),'workspace source');
});

test('invalid ids, traversal and symlinked task directories are refused without touching link targets',async t=>{
 const f=fixture(t),ws=await f.tmp(),outside=await f.tmp('canvas-tasks-outside-');await fs.writeFile(path.join(outside,'keep.txt'),'outside');
 const app=await f.start(ws);
 for(const body of [{id:'../x'},{id:'..'},{id:'root/..'},{id:'tasks/'+'a'.repeat(16)},{id:'A'.repeat(16)},{id:'a'.repeat(17)},{id:123},{id:''},[],null,'x'])assert.equal((await api(app,'tasks',body)).status,400,JSON.stringify(body));
 for(const body of [{id:'../../etc'},{id:'..'},{id:'/tmp'},{},null])assert.equal((await api(app,'tasks/delete',body)).status,400,JSON.stringify(body));
 assert.equal((await api(app,'tasks',{id:'a'.repeat(16)})).status,404);assert.equal((await api(app,'tasks/delete',{id:'a'.repeat(16)})).status,404);
 assert.throws(()=>new Store(ws,'../x'),/invalid task/);
 const linked='b'.repeat(16);await fs.mkdir(path.join(ws,'.canvas/tasks'));await fs.symlink(outside,path.join(ws,'.canvas/tasks',linked));
 assert.deepEqual((await api(app,'tasks')).body.items.map(i=>i.id),['root'],'symlinked task dirs are never listed');
 assert.equal((await api(app,'tasks',{id:linked})).status,404);assert.equal((await api(app,'tasks/delete',{id:linked})).status,409);
 assert.equal((await fs.lstat(path.join(ws,'.canvas/tasks',linked))).isSymbolicLink(),true);assert.deepEqual(await snap(outside),{'keep.txt':crypto.createHash('sha1').update('outside').digest('hex')});
 // A symlinked .canvas/tasks is never created through, and the open task stays put.
 const ws2=await f.tmp(),app2=await f.start(ws2);await fs.writeFile(path.join(ws2,'.canvas/notes.json'),JSON.stringify({rev:1,items:[{id:'n',text:'keep'}]}));await fs.symlink(outside,path.join(ws2,'.canvas/tasks'));
 for(const [route,body] of [['tasks',{}],['tasks/delete',{id:'root'}]]){const r=await api(app2,route,body);assert.equal(r.status,409,route);assert.match(r.body.error,/symlink/)}
 assert.deepEqual(await fs.readdir(outside),['keep.txt']);
 const s=(await api(app2,'state')).body;assert.deepEqual([s.task.id,s.notes.items],['root',[{id:'n',text:'keep'}]]);
});

test('busy turns, overlapping task operations and stale tabs cannot switch, delete or leak across tasks',async t=>{
 const f=fixture(t),ws=await f.tmp(),app=await f.start(ws);
 assert.equal((await api(app,'chat',{text:'HANG please'})).status,202);
 const ctrl=new AbortController(),frames=[],events=await fetch(app.origin+'/api/events',{headers:{Authorization:'Bearer '+app.token},signal:ctrl.signal});(async()=>{try{for await(const c of events.body)frames.push(Buffer.from(c).toString())}catch{}})();
 for(const [route,body] of [['tasks',{}],['tasks/delete',{id:'root'}]]){const r=await api(app,route,body);assert.equal(r.status,409,route);assert.match(r.body.error,/에이전트/)}
 await new Promise(r=>setTimeout(r,80));ctrl.abort();assert.ok(frames.join('').includes('event: state'));assert.ok(!frames.join('').includes('"reset":true'),'a refused switch does not clear the running stream');
 assert.equal((await api(app,'state')).body.task.id,'root');assert.deepEqual((await fs.readdir(path.join(ws,'.canvas'))).filter(n=>n==='tasks'||n==='current-task.json'),[],'a refused transition leaves nothing behind');
 assert.equal((await api(app,'interrupt',{})).status,200);await idle(app);
 const a=(await api(app,'tasks',{})).body.task.id;
 // A tab still showing the root task cannot write into, chat in or read from the open task.
 for(const [route,body,method] of [['board',{rev:0,viewport:{x:0,y:0,zoom:1},items:{leak:{}}},'PUT'],['notes',{rev:0,items:[{id:'leak',text:'leak'}]},'PUT'],['chat',{text:'leak'}],['conversations',{}],['interrupt',{}],['answer',{id:1,result:{}}],['agent',{backend:'codex'}],['artifact/x/render',{}],['artifact/x/content',undefined,'GET']]){
  const r=await api(app,route,body,{method,task:'root'});assert.equal(r.status,409,route);assert.match(r.body.error,/다른 작업/);
 }
 let s=(await api(app,'state')).body;assert.deepEqual([s.task.id,s.board.rev,s.notes.items,s.chat.messages],[a,0,[],[]]);
 assert.equal(await fs.access(path.join(ws,'.canvas/board.json')).then(()=>true,()=>false),false,'stale write did not land in the root task either');
 assert.equal((await api(app,'board',{rev:0,viewport:{x:0,y:0,zoom:1},items:{}},{method:'PUT',task:a})).status,200,'the matching tab can save');
 // A save queued before a switch is drained into its own task; writes through the closed store are refused.
 const old=app.store,queued=old.putBoard({rev:1,viewport:{x:0,y:0,zoom:1},items:{kept:{x:1,y:1,w:1,h:1}}});
 const [saved,switched]=await Promise.all([queued,api(app,'tasks',{})]);
 assert.equal(saved.rev,2);assert.equal(switched.status,200);assert.deepEqual(switched.body.board.items,{});
 const b=switched.body.task.id,boardA=()=>fs.readFile(path.join(ws,'.canvas/tasks',a,'board.json'),'utf8').then(JSON.parse);
 assert.deepEqual((await boardA()).items,{kept:{x:1,y:1,w:1,h:1}});
 await assert.rejects(old.putBoard({rev:2,viewport:{x:0,y:0,zoom:1},items:{late:{}}}),e=>e.status===409);assert.deepEqual((await boardA()).items,{kept:{x:1,y:1,w:1,h:1}});
 // While a transition is draining saves, other task operations and scoped writes fail fast.
 const hold=app.store.withLock(()=>new Promise(r=>setTimeout(r,300)));
 const first=api(app,'tasks',{id:a});await new Promise(r=>setTimeout(r,100));
 let r=await api(app,'tasks',{});assert.equal(r.status,409);assert.match(r.body.error,/진행 중/);
 r=await api(app,'tasks/delete',{id:b});assert.equal(r.status,409);
 r=await api(app,'board',{rev:0,viewport:{x:0,y:0,zoom:1},items:{mid:{}}},{method:'PUT'});assert.equal(r.status,409);assert.match(r.body.error,/전환/);
 await hold;r=await first;assert.equal(r.status,200);assert.equal(r.body.task.id,a);assert.ok(r.body.task.epoch>switched.body.task.epoch,'each switch has a newer epoch for clients');
 assert.deepEqual((await fs.readdir(path.join(ws,'.canvas/tasks'))).sort(),[a,b].sort());
 s=(await api(app,'state')).body;assert.deepEqual(s.board.items,{kept:{x:1,y:1,w:1,h:1}});
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(ws,'.canvas/tasks',b,'board.json'),'utf8').catch(()=>'{"items":{}}')).items,{});
});
