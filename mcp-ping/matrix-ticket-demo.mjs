// Explicit onboarding demo: sends one message to the existing Onboarding room.
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const config=JSON.parse(readFileSync(new URL('../local-credentials.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const base='http://127.0.0.1:8008/_matrix/client/v3';
const doLogin=()=>fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'m.login.password',identifier:{type:'m.id.user',user:config.username},password:config.password})});
let login=await doLogin();
if(login.status===429) {const error=await login.json();const delay=Math.min(error.retry_after_ms??30000,60000);console.log('Matrix rate limit; waiting '+delay+'ms');await new Promise(r=>setTimeout(r,delay+500));login=await doLogin();}
if(!login.ok) throw new Error('Matrix login failed');
const {access_token:token}=await login.json();
async function request(path,body) {const r=await fetch(base+path,{method:body?'PUT':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok) throw new Error(`Matrix request failed ${r.status}`);return r.json();}
let returnDone=false;
try {
 const {joined_rooms:rooms}=await request('/joined_rooms');let room;
 for(const id of rooms) {const state=await request(`/rooms/${encodeURIComponent(id)}/state`);if(state.some(e=>e.type==='m.room.name'&&e.content.name==='Onboarding')) {room=id;break;}}
 if(!room) throw new Error('Onboarding room not found');
 const initial=await request('/sync?timeout=0');let since=initial.next_batch;
 const marker=randomUUID().slice(0,8);
 const question=process.env.DEMO_QUESTION??'Hãy tra cứu lại thống kê TOÀN BỘ hệ thống ticket, không dùng bộ lọc nào và không lấy số liệu từ câu trả lời trước: tổng số, số đang mở và quá hạn. Sau đó tra IT-000001 và cho biết người yêu cầu. Hãy dùng MCP lấy dữ liệu mới.';
 await request(`/rooms/${encodeURIComponent(room)}/send/m.room.message/${randomUUID()}`,{msgtype:'m.text',body:'@openclaw:localhost '+question,format:'org.matrix.custom.html',formatted_body:'<a href="https://matrix.to/#/@openclaw:localhost">openclaw</a> '+question.replaceAll('&','&amp;').replaceAll('<','&lt;'), 'm.mentions':{user_ids:['@openclaw:localhost']}});
 console.log('Sent ticket demo to Onboarding, marker '+marker);
 const deadline=Date.now()+150000;
 while(Date.now()<deadline) {
   const sync=await request('/sync?timeout=10000&since='+encodeURIComponent(since));since=sync.next_batch;
   for(const event of sync.rooms?.join?.[room]?.timeline?.events??[]) if(event.type==='m.room.message'&&event.sender==='@openclaw:localhost') {
     console.log(JSON.stringify({sender:event.sender,body:event.content.body}));returnDone=true;
   }
   if(returnDone) break;
 }
 if(!returnDone) throw new Error('No bot response within demo timeout');
} finally {await fetch(base+'/logout',{method:'POST',headers:{Authorization:`Bearer ${token}`}});}
