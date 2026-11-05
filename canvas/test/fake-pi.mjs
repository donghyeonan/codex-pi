import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
const args=process.argv.slice(2),get=key=>args[args.indexOf(key)+1];
const dir=get('--session-dir');fs.mkdirSync(dir,{recursive:true});
const sessionFile=args.includes('--session')?get('--session'):path.join(dir,randomUUID()+'.jsonl');
let saved=fs.existsSync(sessionFile)?JSON.parse(fs.readFileSync(sessionFile,'utf8')):{id:randomUUID(),count:0};
const persist=()=>fs.writeFileSync(sessionFile,JSON.stringify(saved));persist();
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const reply=(r,data={})=>send({id:r.id,type:'response',command:r.type,success:true,data});
function run(text){send({type:'agent_start'});send({type:'message_start',message:{role:'assistant',content:[]}});send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}});send({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop'}});send({type:'agent_end'});send({type:'agent_settled',aborted:false})}
let pending=null;
function on(r){
 if(r.type==='get_state')return reply(r,{sessionId:saved.id,sessionFile,model:{id:'fake-pi',provider:'fixture'},isStreaming:false});
 if(r.type==='extension_ui_response'){if(pending){const q=pending;pending=null;if(!r.cancelled)run('answer:'+r.value);reply(q,{disposition:'handled'})}return;}
 if(r.type==='prompt'){
  if(r.message==='/q'){pending=r;send({type:'extension_ui_request',id:'question-1',method:'select',title:'테스트 질문',options:['A','B']});return;}
  send({type:'message_end',message:{role:'user',content:r.message}});saved.count++;persist();reply(r,{disposition:'started'});
  if(r.message.includes('EXIT'))return setTimeout(()=>process.exit(3),5);
  if(r.message.includes('HANG'))return send({type:'agent_start'});
  setTimeout(()=>run(`pi:${saved.count}\u2028그대로`),5);return;
 }
 if(r.type==='abort'){send({type:'agent_settled',aborted:true});return reply(r)}
 if(r.type==='clear_queue')return reply(r);
 send({type:'response',id:r.id,success:false,error:'unknown command'});
}
let buffer='';const decoder=new StringDecoder('utf8');process.stdin.on('data',b=>{buffer+=decoder.write(b);let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line)on(JSON.parse(line))}});process.stdin.on('end',()=>process.exit(0));
