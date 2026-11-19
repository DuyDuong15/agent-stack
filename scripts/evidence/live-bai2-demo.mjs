// Sends real demo messages and creates ONE sample ticket after explicit confirmation.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const requireMcp=createRequire(new URL('../../mcp-ping/package.json',import.meta.url));
const {Client}=requireMcp('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=requireMcp('@modelcontextprotocol/sdk/client/streamableHttp.js');
const cfg=JSON.parse(readFileSync(new URL('../../local-credentials.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const env=parseEnv(readFileSync(new URL('../../ticket-service/.env',import.meta.url),'utf8'));
const base='http://127.0.0.1:8008/_matrix/client/v3';
const login=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'m.login.password',identifier:{type:'m.id.user',user:cfg.username},password:cfg.password})});
if(!login.ok) throw new Error('Matrix demo login failed: '+login.status);
const {access_token:token}=await login.json();
const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
const records=[];let room,since;
async function request(path,body) {const r=await fetch(base+path,{method:body?'PUT':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});if(!r.ok) throw new Error('Matrix '+r.status);return r.json();}
async function total() {const r=await fetch('http://127.0.0.1:8012/ticket-statistics',{headers:{'X-API-Key':env.TICKET_API_KEY}});assert.equal(r.status,200);return (await r.json()).total;}
function draft(nonce) {const db=new DatabaseSync(fileURLToPath(new URL('../../mcp-ping/data/drafts.sqlite',import.meta.url)),{readOnly:true});try{return db.prepare('SELECT id,state,result FROM drafts WHERE nonce=?').get(nonce);}finally{db.close();}}
async function say(label,body,predicate=()=>true) {
 await request(`/rooms/${encodeURIComponent(room)}/send/m.room.message/${randomUUID()}`,{msgtype:'m.text',body:'@openclaw:localhost '+body});
 console.log('Sent '+label);const responses=[];const deadline=Date.now()+150000;
 while(Date.now()<deadline) {
  const sync=await request('/sync?timeout=10000&since='+encodeURIComponent(since));since=sync.next_batch;
  for(const e of sync.rooms?.join?.[room]?.timeline?.events??[]) if(e.type==='m.room.message'&&e.sender==='@openclaw:localhost') {
   responses.push(e.content.body);console.log(JSON.stringify({label,body:e.content.body}));
   if(predicate(e.content.body)) {records.push({label,question:body,responses});return e.content.body;}
  }
 }
 throw new Error('No expected reply: '+label);
}
const pause=()=>new Promise(r=>setTimeout(r,5000));
try {
 const rooms=await request('/joined_rooms');for(const id of rooms.joined_rooms){const state=await request(`/rooms/${encodeURIComponent(id)}/state`);if(state.some(e=>e.type==='m.room.name'&&e.content.name==='Onboarding')){if(room) throw new Error('Ambiguous room');room=id;}}
 assert.ok(room);since=(await request('/sync?timeout=0')).next_batch;
 const before=await total();
 await say('missing-fields','Tôi muốn tạo một ticket mới, nhưng chưa cung cấp nội dung. Hãy hỏi tôi thông tin cần thiết, không lấy nội dung từ lịch sử.');assert.equal(await total(),before);await pause();
 const content='Tiêu đề: Demo Bài 2 kiểm tra laptop. Mô tả: Laptop thử nghiệm không khởi động, cần IT kiểm tra. Người yêu cầu EMP-001. Người xử lý EMP-002. Ưu tiên HIGH. Không có deadline.';
 const preview=await say('prepare-cancel','Chuẩn bị ticket mới để tôi xem trước. '+content,t=>t.includes('BẢN XEM TRƯỚC TICKET'));
 const nonce=/XÁC NHẬN ([a-f0-9]{12})/.exec(preview)?.[1];assert.ok(nonce);assert.equal(await total(),before);await pause();
 await say('cancel','HỦY '+nonce,t=>draft(nonce)?.state==='CANCELLED'&&!t.includes('BẢN XEM TRƯỚC'));
 assert.equal(draft(nonce).state,'CANCELLED');assert.equal(await total(),before);await pause();
 await say('inactive','Chuẩn bị ticket mới. Tiêu đề: Demo nhân viên inactive. Mô tả: Kiểm tra quyền người yêu cầu. Người yêu cầu EMP-008. Ưu tiên LOW. Không giao người xử lý, không có deadline.',t=>!/BẢN XEM TRƯỚC/.test(t));
 assert.equal(await total(),before);await pause();
 const valid=await say('prepare-success','Chuẩn bị một ticket mới, bỏ yêu cầu EMP-008 vừa rồi. '+content,t=>t.includes('BẢN XEM TRƯỚC TICKET'));
 const validNonce=/XÁC NHẬN ([a-f0-9]{12})/.exec(valid)?.[1];assert.ok(validNonce);assert.equal(await total(),before);await pause();
 await say('confirm','XÁC NHẬN '+validNonce,t=>/IT-\d{6,}/.test(t));
 const saved=draft(validNonce);assert.equal(saved.state,'COMPLETED');assert.equal(await total(),before+1);
 const client=new Client({name:'bai2-retry-demo',version:'1'});
 try {await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8005/mcp')));const retry=await client.callTool({name:'confirm_ticket',arguments:{draftId:saved.id}});assert.ok(!retry.isError);assert.equal(JSON.parse(retry.content[0].text).ticket.id,JSON.parse(saved.result).ticket.id);}finally{await client.close();}
 assert.equal(await total(),before+1);
 records.push({label:'verified',before,after:await total(),draftId:saved.id,ticket:JSON.parse(saved.result).ticket,retryCreatedAnotherTicket:false});
 console.log('PASS: missing/inactive/cancel no creation; confirmed creates exactly one; retry does not duplicate.');
} finally {
 mkdirSync(new URL('../../docs/',import.meta.url),{recursive:true});
 writeFileSync(new URL('../../docs/BAI-2-LIVE-EVIDENCE.json',import.meta.url),JSON.stringify({time:new Date().toISOString(),records},null,2)+'\n');
 await fetch(base+'/logout',{method:'POST',headers}).catch(()=>{});
}
