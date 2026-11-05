import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {ChatManager} from './codex.mjs';
import {PiChatManager} from './pi.mjs';
import {HttpError,LIMITS} from './store.mjs';
async function executable(file){try{await fs.access(file,1);return (await fs.stat(file)).isFile()}catch{return false}}
export async function detectAgents({env=process.env,home=os.homedir(),codexCommand,piCommand}={}){
 async function which(name){for(const dir of (env.PATH||'').split(path.delimiter)){if(!dir)continue;for(const suffix of process.platform==='win32'?['.cmd','.exe','']:['']){const f=path.join(dir,name+suffix);if(await executable(f))return f}}return null}
 const managed=path.join(home,'.local/share/pi-personal/current/entry.mjs');
 const pi=piCommand||(await fs.access(managed).then(()=>[process.execPath,managed]).catch(()=>null))||await which('pi');
 const codex=codexCommand||await which('codex');
 return{pi,codex};
}
export function chooseAgent(requested,available,env=process.env){
 if(!['auto','pi','codex'].includes(requested))throw new HttpError(400,'agent must be auto, pi or codex');
 if(requested!=='auto'){if(!available[requested])throw new HttpError(409,`${requested} CLI is not installed`);return requested;}
 // A provided Codex context wins; otherwise local Pi is preferred, then stock Codex.
 if(env.CODEX_THREAD_ID&&!env.PI_SESSION_ID&&available.codex)return'codex';
 if(available.pi)return'pi';
 return'codex';
}
export class AgentManager extends EventEmitter{
 constructor({store,prefs=store,backend,commands,env=process.env,pendingDeadlineMs,rpcTimeouts}={}){super();Object.assign(this,{store,prefs,requested:backend,commands,env,pendingDeadlineMs,rpcTimeouts});this.instances=new Map();this.current=null;this.switching=false;}
 async init(){
  const saved=await this.prefs.readJson('agent.json',()=>({}),d=>d&&['auto','pi','codex'].includes(d.backend)?d:{});
  this.requested=this.requested||this.env.CANVAS_AGENT||saved.backend||'auto';
  this.engine=chooseAgent(this.requested,this.commands,this.env);
  this.current=await this.manager(this.engine);
 }
 async manager(engine){
  if(this.instances.has(engine))return this.instances.get(engine);
  const Manager=engine==='pi'?PiChatManager:ChatManager;
  const manager=new Manager({store:this.store,command:this.commands[engine]||engine,pendingDeadlineMs:this.pendingDeadlineMs,rpcTimeouts:this.rpcTimeouts});
  for(const event of ['state','delta','error'])manager.on(event,data=>{if(this.current===manager)this.emit(event,data)});
  await manager.init();this.instances.set(engine,manager);return manager;
 }
 busy(){return this.switching||this.current.turnBusy||this.current.pending.length>0}
 snapshot(){return{...this.current.snapshot(),supportsConversations:true,engine:this.engine,agentMode:this.requested,availableAgents:{pi:Boolean(this.commands.pi),codex:Boolean(this.commands.codex)},switching:this.switching};}
 async select(backend){
  if(this.busy())throw new HttpError(409,'Finish or stop the current turn and pending questions before switching agents');
  const next=chooseAgent(backend,this.commands,this.env);this.switching=true;
  try{const manager=await this.manager(next);await this.prefs.writeJson('agent.json',{backend});if(next!==this.engine){await this.current.persist();await this.current.close();this.instances.delete(this.engine);}this.current=manager;this.engine=next;this.requested=backend;this.switching=false;this.emit('delta',{reset:true,text:''});this.emit('state');return this.snapshot()}finally{this.switching=false}
 }
 async conversations(){
  const names=(await fs.readdir(this.store.canvasDir)).filter(n=>new RegExp(`^conversation-${this.engine}-[a-f0-9]{24}\\.json$`).test(n));
  const items=[];
  for(const name of names){const saved=await this.store.readJson(name,()=>null,d=>d);if(saved?.thread?.threadId&&saved.thread.threadId!==this.current.threadId)items.push({id:name.slice(0,-5),title:saved.title||'Conversation',updatedAt:saved.updatedAt});}
  return{engine:this.engine,items:items.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))};
 }
 async conversation(id){
  if(this.busy())throw new HttpError(409,'Finish or stop the current turn before changing conversations');
  if(id!==undefined&&(typeof id!=='string'||!new RegExp(`^conversation-${this.engine}-[a-f0-9]{24}$`).test(id)))throw new HttpError(400,'Invalid conversation');
  this.switching=true;this.emit('state');
  try{
   const target=id?await this.store.readJson(id+'.json',()=>null,d=>d):{thread:{threadId:null,messages:[]}};
   if(!target?.thread||!Array.isArray(target.thread.messages)||target.thread.messages.length>LIMITS.messages||target.thread.messages.some(m=>!m||typeof m!=='object'||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||m.text.length>LIMITS.messageText)||!(target.thread.threadId===null||typeof target.thread.threadId==='string'))throw new HttpError(409,'Conversation cannot be read safely');
   if(target.thread.threadId&&this.engine==='pi'&&(typeof target.thread.sessionFile!=='string'||target.thread.sessionFile.length>2000))throw new HttpError(409,'Pi conversation is missing its session path');
   if(id&&target.thread.threadId===this.current.threadId)throw new HttpError(409,'This conversation is already active');
   const current=this.current,thread={threadId:current.threadId,messages:current.messages,...(current.sessionFile?{sessionFile:current.sessionFile}:{})};
   if(thread.threadId){const archive='conversation-'+this.engine+'-'+createHash('sha256').update(thread.threadId).digest('hex').slice(0,24);const first=thread.messages.find(m=>m.role==='user'&&!m.text.trimStart().startsWith('/'))||thread.messages.find(m=>m.role==='user');await this.store.writeJson(archive+'.json',{engine:this.engine,title:(first?.text||'Conversation').slice(0,80),updatedAt:new Date().toISOString(),thread});}
   await current.close();this.instances.delete(this.engine);
   try{await this.store.putThread(target.thread,this.engine)}finally{this.current=await this.manager(this.engine)}
   this.switching=false;this.emit('delta',{reset:true,text:''});return this.snapshot();
  }finally{this.switching=false;this.emit('state')}
 }
 chat(...args){if(this.switching)throw new HttpError(409,'Agent is switching');return this.current.chat(...args)}
 interrupt(){return this.current.interrupt()}
 answer(...args){return this.current.answer(...args)}
 async close(){await Promise.all([...this.instances.values()].map(m=>m.close()))}
}
