// Sends read-only test questions to the existing Onboarding room, then restores Ticket API after the failure case.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {root,settings} from '../../configuration.mjs';
const folder=new URL('../../docs/bai4/',import.meta.url);mkdirSync(folder,{recursive:true});
const credentials=JSON.parse(readFileSync(new URL('../../local-credentials.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const base=settings.MATRIX_URL+'/_matrix/client/v3',room=settings.MATRIX_ROOM_ID,bot='@openclaw:localhost';
const login=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'m.login.password',identifier:{type:'m.id.user',user:credentials.username},password:credentials.password}),signal:AbortSignal.timeout(15000)});
if(!login.ok)throw new Error('Matrix login failed: '+login.status);
const {access_token:token}=await login.json();
async function matrix(path,body,method=body?'PUT':'GET') {const r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error('Matrix HTTP '+r.status);return r.json();}
let since=(await matrix('/sync?timeout=0')).next_batch;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const evidence={checkedAt:new Date().toISOString(),method:'Real Matrix messages in the Element Onboarding room; sent via Matrix API',success:[],error:null};
const save=()=>writeFileSync(new URL('chat-evidence.json',folder),JSON.stringify(evidence,null,2));
async function ask(label,expectFailure=false) {
 const question='Hãy gọi đúng một lần tool search_tickets với filter.code = IT-000001 để đọc dữ liệu mới, rồi cho biết tiêu đề, người yêu cầu và người xử lý. Không dùng số liệu cũ, không cần gọi thêm tool. Kiểm tra Bài 4 '+label+'.';
 const started=Date.now();const sent=await matrix(`/rooms/${encodeURIComponent(room)}/send/m.room.message/${randomUUID()}`,{msgtype:'m.text',body:bot+' '+question,format:'org.matrix.custom.html',formatted_body:`<a href="https://matrix.to/#/${bot}">openclaw</a> ${question}`,'m.mentions':{user_ids:[bot]}});
 console.log('Sent Bài 4 chat '+label);
 let reply;
 while(Date.now()-started<180000&&!reply){const sync=await matrix('/sync?timeout=10000&since='+encodeURIComponent(since));since=sync.next_batch;reply=(sync.rooms?.join?.[room]?.timeline?.events??[]).find(e=>e.type==='m.room.message'&&e.sender===bot&&e.origin_server_ts>=started);}
 if(!reply)throw new Error('No bot reply for '+label);
 let traces=[];
 for(let i=0;i<20;i++){
  const query=new URLSearchParams({service:'mcp',start:String(started*1000),end:String(Date.now()*1000),limit:'100'});
  const r=await fetch('http://127.0.0.1:16686/api/traces?'+query,{signal:AbortSignal.timeout(10000)});const data=await r.json();
  traces=(data.data??[]).filter(t=>t.spans.some(s=>s.operationName==='tools/call search_tickets'));
  const expected=expectFailure?['mcp','graphql']:['mcp','graphql','employee-api','ticket-api'];
  if(traces.length&&traces.every(t=>expected.every(n=>Object.values(t.processes).some(p=>p.serviceName===n))))break;
  await delay(500);
 }
 if(traces.length!==1)throw new Error(`Expected exactly one tool trace for ${label}; received ${traces.length}. Bot reply: ${reply.content.body}`);
 const t=traces[0];const rootSpan=t.spans.find(s=>t.processes[s.processID].serviceName==='mcp'&&s.operationName==='POST /mcp');
 if(!rootSpan)throw new Error('MCP server span missing');
 const hasError=t.spans.some(s=>s.tags?.some(tag=>tag.key==='error'&&tag.value===true));if(hasError!==expectFailure)throw new Error('Unexpected error status for '+label);
 writeFileSync(new URL(`chat-${label}.json`,folder),JSON.stringify(t,null,2));
 const result={label,question,eventId:sent.event_id,replyEventId:reply.event_id,reply:reply.content.body,traceId:t.traceID,chatRoundTripMs:reply.origin_server_ts-started,mcpDurationMs:rootSpan.duration/1000,traceparentPresent:rootSpan.tags.find(tag=>tag.key==='w3c.traceparent.present')?.value,traceparentValid:rootSpan.tags.find(tag=>tag.key==='w3c.traceparent.valid')?.value,hasError};
 console.log(JSON.stringify({label,traceId:t.traceID,hasError,traceparentPresent:result.traceparentPresent,chatRoundTripMs:result.chatRoundTripMs}));return result;
}
const compose=['compose','--env-file','ticket-service/.env','-f','compose.yaml','-f','compose.otel.yaml'];
try {
 for(let i=1;i<=5;i++){evidence.success.push(await ask('success-'+i));save();}
 try {
  execFileSync('docker',[...compose,'stop','ticket'],{cwd:root,stdio:'pipe'});
  evidence.error=await ask('error',true);save();
 }finally{execFileSync('docker',[...compose,'up','-d','--no-deps','--wait','ticket'],{cwd:root,stdio:'pipe'});}
 console.log('PASS: five real chat questions + one error question; Ticket API restored.');
}finally{save();await fetch(base+'/logout',{method:'POST',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});}
