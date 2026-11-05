import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {AppServerClient, ChatManager, validateSelection} from './codex.mjs';
import {HttpError, LIMITS} from './store.mjs';

export function piEnvironment(inherited = process.env) {
  const env={...inherited};
  for(const k of Object.keys(env))if(k.startsWith('PEN_')||['PI_SESSION_ID','PI_SESSION_FILE','PI_MODEL','PI_PROVIDER','PI_REASONING_LEVEL','PI_CODING_AGENT_SESSION_DIR'].includes(k))delete env[k];
  return env;
}
export class PiClient extends AppServerClient {
  constructor(options){super(options);this.sessionDir=options.sessionDir;this.sessionFile=options.sessionFile;}
  async start(){
    const [cmd,...pre]=this.argv;
    const args=[...pre,'--mode','rpc','--session-dir',this.sessionDir];
    if(this.sessionFile)args.push('--session',this.sessionFile);else args.push('--name','Canvas');
    const child=spawn(cmd,args,{cwd:this.cwd,env:piEnvironment(),stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});this.child=child;
    child.stdin.on('error',()=>{});child.stderr.on('data',b=>{this.stderrTail=(this.stderrTail+b.toString('utf8')).slice(-4096)});
    const decoder=new StringDecoder('utf8');let buffer='';
    child.stdout.on('data',chunk=>{buffer+=decoder.write(chunk);if(buffer.length>16*1024*1024){child.kill();return;}let i;while((i=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,i).replace(/\r$/,'');buffer=buffer.slice(i+1);this.onLine(line)}});
    child.once('exit',(code,signal)=>{this.exited=true;for(const c of this.calls.values()){clearTimeout(c.timer);c.reject(new Error('Pi exited; prompt will not be replayed'))}this.calls.clear();this.emit('exit',{code,signal})});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});
    this.state=await this.request('get_state',{},this.timeouts.initialize);
  }
  onLine(line){if(!line.trim())return;let m;try{m=JSON.parse(line)}catch{return;}
    if(m.type==='response'&&this.calls.has(m.id)){const c=this.calls.get(m.id);this.calls.delete(m.id);clearTimeout(c.timer);m.success?c.resolve(m.data||{}):c.reject(new Error(String(m.error||'Pi command failed').slice(0,1000)));}
    else this.emit('event',m);
  }
  request(type,payload={},timeoutMs=this.timeouts.default){return new Promise((resolve,reject)=>{const id=String(this.nextId++);const timer=setTimeout(()=>{this.calls.delete(id);reject(new Error(`Pi ${type} timed out`))},timeoutMs);this.calls.set(id,{resolve,reject,timer});try{this.send({...payload,type,id})}catch(e){clearTimeout(timer);this.calls.delete(id);reject(e)}})}
}
const textOf=m=>typeof m?.content==='string'?m.content:(m?.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
export function validatePiAnswer(request,result){
 if(!result||typeof result!=='object')throw new HttpError(400,'answer required');
 if(result.cancelled===true)return{cancelled:true};
 if(request.method==='confirm'){if(typeof result.confirmed!=='boolean')throw new HttpError(400,'explicit confirmation required');return{confirmed:result.confirmed};}
 if(typeof result.value!=='string'||result.value.length>20000)throw new HttpError(400,'text answer required (max 20000 chars)');
 if(request.method==='select'&&!request.options?.includes(result.value))throw new HttpError(400,'choose an offered option');
 return{value:result.value};
}
export class PiChatManager extends ChatManager {
 constructor(options){super(options);this.sessionFile=null;this.sessionDir=path.join(this.store.canvasDir,'pi-sessions');this.sentInputs=new Set();this.nativeRunning=false;}
 async init(){const t=await this.store.getThread('pi');this.threadId=t.threadId;this.messages=t.messages;this.sessionFile=t.sessionFile||null;}
 persist(){return this.store.putThread({threadId:this.threadId,sessionFile:this.sessionFile,messages:this.messages},'pi').catch(e=>this.fail(`could not save Pi transcript: ${e.message}`));}
 snapshot(){return{...super.snapshot(),model:this.model||null};}
 async ensureClient(){
  if(this.client&&!this.client.exited)return this.client;
  if(this.starting)return this.starting;
  this.starting=(async()=>{
   await fs.mkdir(this.sessionDir,{recursive:true,mode:0o700});
   if((await fs.lstat(this.sessionDir)).isSymbolicLink())throw new Error('Pi session directory must not be a symlink');
   const dir=await fs.realpath(this.sessionDir);
   if(this.sessionFile){
    if(!path.resolve(this.sessionFile).startsWith(dir+path.sep))throw new Error('Refusing to open a Pi session outside this Canvas workspace');
    try{const real=await fs.realpath(this.sessionFile);if(!real.startsWith(dir+path.sep))throw new Error('Refusing a Pi session symlink outside this workspace');}
    catch(e){if(e.code==='ENOENT'&&!this.messages.length)this.sessionFile=null;else throw e;}
   }
   const client=new PiClient({command:this.command,cwd:this.store.workspace,sessionDir:dir,sessionFile:this.sessionFile,timeouts:{initialize:120000,...this.rpcTimeouts}});
   this.client=client;
   client.on('event',e=>this.onPiEvent(e));client.on('exit',info=>this.onExit(client,info));
   try{await client.start();const s=client.state;if(!s.sessionFile||!path.resolve(s.sessionFile).startsWith(dir+path.sep))throw new Error('Pi did not return a Canvas-owned session');this.sessionFile=s.sessionFile;this.threadId=s.sessionId;this.model=s.model?{id:s.model.id,provider:s.model.provider}:null;await this.persist();return client;}
   catch(e){await client.close();this.client=null;throw new Error(`Pi unavailable: ${e.message}`)}
  })();try{return await this.starting}finally{this.starting=null}
 }
 async chat(body,artifacts,references=[]){
  if(!body||typeof body.text!=='string'||!body.text.trim()||body.text.length>20000)throw new HttpError(400,'text is required (max 20000 chars)');
  if(this.turnBusy||this.status==='running')throw new HttpError(409,'a turn is already running');
  const selection=body.selection==null?null:validateSelection(body.selection,artifacts);
  this.turnBusy=true;this.status='running';this.changed();let user;
  try{const client=await this.ensureClient();const message=body.text.trimStart().startsWith('/')?body.text:this.buildInput(body.text,selection,artifacts,references);
   user={role:'user',text:body.text};this.messages.push(user);this.sentInputs.add(message);this.changed();
   const result=await client.request('prompt',{message},this.pendingDeadlineMs);
   if(result.disposition==='handled'){this.sentInputs.delete(message);if(!this.nativeRunning)this.endTurn();}
   await this.persist();this.changed();return{threadId:this.threadId};
  }catch(e){if(user)this.messages=this.messages.filter(m=>m!==user);this.endTurn();this.status=/unavailable/.test(e.message)?'unavailable':'idle';this.changed();throw new HttpError(502,e.message)}
 }
 onPiEvent(e){
  if(e.type==='agent_start'){this.nativeRunning=true;this.turnBusy=true;this.status='running';this.changed();}
  if(e.type==='message_start'&&e.message?.role==='assistant')this.emit('delta',{reset:true,text:''});
  if(e.type==='message_update'&&e.assistantMessageEvent?.type==='text_delta')this.emit('delta',{text:e.assistantMessageEvent.delta});
  if(e.type==='message_end'){
   const m=e.message,text=textOf(m);
   if(m?.role==='user'&&this.sentInputs.has(text)){this.sentInputs.delete(text);return;}
   if(m?.role==='assistant'){this.emit('delta',{reset:true,text:''});if(m.stopReason==='error')this.fail(m.errorMessage||'Pi model response failed');}
   if(text&&['assistant','user'].includes(m?.role)){this.messages.push({role:m.role,text:text.slice(0,LIMITS.messageText)});this.messages=this.messages.slice(-LIMITS.messages);this.persist();this.changed();}
  }
  if(e.type==='agent_settled'){this.nativeRunning=false;this.endTurn();this.persist();this.changed();}
  if(e.type==='extension_error')this.fail(e.error||'Pi extension failed');
  if(e.type==='extension_ui_request'){
   if(!['select','confirm','input','editor'].includes(e.method)){if(e.method==='notify'&&e.notifyType==='error')this.fail(e.message);return;}
   if(this.pending.some(p=>p.id===e.id)||this.pending.length>=20){this.client.send({type:'extension_ui_response',id:e.id,cancelled:true});return;}
   const p={id:e.id,method:'pi/'+e.method,params:e};
   p.timer=setTimeout(()=>{if(this.removePending(p.id)){this.client?.send({type:'extension_ui_response',id:p.id,cancelled:true});this.changed()}},Math.min(e.timeout||this.pendingDeadlineMs,this.pendingDeadlineMs));p.timer.unref?.();this.pending.push(p);this.changed();
  }
 }
 answer(body){const p=this.pending.find(p=>p.id===body?.id);if(!p)throw new HttpError(404,'no such pending request');const result=validatePiAnswer(p.params,body.result);this.client.send({type:'extension_ui_response',id:p.id,...result});this.removePending(p.id);this.changed();return{};}
 async interrupt(){if(!this.client||!this.turnBusy)throw new HttpError(409,'no running turn');await this.client.request('clear_queue',{},15000);await this.client.request('abort',{},15000);return{};}
 onExit(client,{code,signal}){if(client!==this.client)return;this.client=null;for(const p of [...this.pending])this.removePending(p.id);const running=this.turnBusy;this.nativeRunning=false;this.endTurn();if(!this.closed){this.fail(`Pi exited (${signal||code})${running?'; the running prompt will not be replayed':''}`);this.changed();}}
 async close(){this.closed=true;for(const p of [...this.pending]){this.removePending(p.id);try{this.client?.send({type:'extension_ui_response',id:p.id,cancelled:true})}catch{}}const c=this.client;this.client=null;if(c)await c.close();}
}
