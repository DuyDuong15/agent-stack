import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDraftService} from './ticket-drafts.mjs';
const employee={id:'10000000-0000-4000-8000-000000000001',code:'EMP-001',name:'Nguyễn Văn Nam',department:'IT',active:true};
const input={title:'Laptop broken',description:'Cannot boot laptop',requester:'EMP-001',priority:'HIGH',assignee:null};
function harness() {
 let time=Date.parse('2026-11-17T00:00:00Z'),count=0,ctx={roomId:'r',userId:'u',botId:'b'};const writes=[],previews=[];
 ctx.userMessages=[];
 const message=(body,extra={})=>{ctx.latest={type:'m.room.message',event_id:'e'+(++count),sender:'u',origin_server_ts:++time,content:{body},...extra};ctx.userMessages.unshift(ctx.latest);return ctx.latest;};message('Create a ticket. Requester EMP-001. Priority HIGH. Chưa giao.');
 let matches=1,active=true,loseResponse=false;
 const results=new Map();
 const bridge={context:async()=>structuredClone(ctx),preview:async(room,id,text)=>{previews.push(text);return {eventId:id,ts:++time};}};
 const graphql=async(q,variables)=>{
  if(q.startsWith('query')) return {data:{employees:{total:matches,items:Array.from({length:matches},(_,i)=>({...employee,id:employee.id.slice(0,-1)+(i+1),active}))}}};
  writes.push(variables);
  const existing=results.get(variables.key),value=existing??{ticket:{...variables.input,id:'ticket-id',code:'IT-000031',status:'OPEN'},replayed:false};results.set(variables.key,value);
  if(loseResponse) {loseResponse=false;throw new Error('response lost after commit');}
  return {data:{createTicket:{...value,replayed:!!existing}}};
 };
 const dbPath=join(mkdtempSync(join(tmpdir(),'ticket-draft-')),'draft.sqlite');
 const options={bridge,graphql,clock:()=>time,dbPath};
 return {options,ctx,message,writes,previews,results,advance:n=>time+=n,setMatches:n=>matches=n,setActive:v=>active=v,lose:()=>loseResponse=true};
}
test('prepare is not a write; forged/early/wrong user/wrong room/edited confirmations blocked',async()=>{
 const h=harness(),d=createDraftService(h.options);
 try {
 const p=await d.prepare(input);assert.equal(h.writes.length,0);assert.ok(h.previews[0].includes(input.description));
 await assert.rejects(d.confirm(p.draftId),{code:'CONFIRMATION_REQUIRED'});
 h.message('XÁC NHẬN '+p.nonce,{sender:'attacker'});await assert.rejects(d.confirm(p.draftId),{code:'CONFIRMATION_REQUIRED'});
 h.message('XÁC NHẬN '+p.nonce);h.ctx.roomId='other';await assert.rejects(d.confirm(p.draftId),{code:'CONFIRMATION_REQUIRED'});h.ctx.roomId='r';
 h.message('XÁC NHẬN '+p.nonce,{content:{body:'XÁC NHẬN '+p.nonce,'m.relates_to':{rel_type:'m.replace'}}});await assert.rejects(d.confirm(p.draftId),{code:'CONFIRMATION_REQUIRED'});
 h.message('XÁC NHẬN wrong');await assert.rejects(d.confirm(p.draftId),{code:'CONFIRMATION_REQUIRED'});
 assert.equal(h.writes.length,0);
 h.message('b XÁC NHẬN '+p.nonce);const result=await d.confirm(p.draftId);assert.equal(result.state,'COMPLETED');assert.equal(h.writes.length,1);assert.equal(h.writes[0].input.title,input.title);
 await d.confirm(p.draftId);assert.equal(h.writes.length,1);
 } finally {d.close();}
});
test('missing fields, ambiguous or inactive employee do not produce valid draft/mutation',async()=>{
 const h=harness(),d=createDraftService(h.options);
 try {await assert.rejects(d.prepare({title:'x'}),{code:'MISSING_FIELDS'});h.setMatches(2);await assert.rejects(d.prepare(input),{code:'EMPLOYEE_AMBIGUOUS'});h.setMatches(1);h.setActive(false);await assert.rejects(d.prepare(input),{code:'INVALID_EMPLOYEE_REFERENCE'});assert.equal(h.previews.length,0);assert.equal(h.writes.length,0);}finally{d.close();}
});

test('Element display-name mention supports confirmation; duplicate command is rejected',async()=>{
 const h=harness();h.ctx.botId='@openclaw:localhost';const d=createDraftService(h.options);
 try {
 const p=await d.prepare(input);
 const command='XÁC NHẬN '+p.nonce;
 h.message('',{content:{body:command+'\n'+command+' openclaw','m.mentions':{user_ids:[h.ctx.botId]}}});
 await assert.rejects(d.confirm(p.draftId),{code:'CONFIRMATION_REQUIRED'});assert.equal(h.writes.length,0);
 h.message('',{content:{body:'openclaw: '+command,'m.mentions':{user_ids:[h.ctx.botId]},format:'org.matrix.custom.html',formatted_body:'<a href="https://matrix.to/#/@openclaw:localhost">openclaw</a>: '+command}});
 assert.equal((await d.confirm(p.draftId)).state,'COMPLETED');assert.equal(h.writes.length,1);
 } finally {d.close();}
});
test('cancel, supersede and expiry cannot create; same source prepare is idempotent',async()=>{
 const h=harness(),d=createDraftService(h.options);
 try {
 const a=await d.prepare(input);assert.equal((await d.prepare(input)).draftId,a.draftId);assert.equal(h.previews.length,1);
 h.message('change title');const b=await d.prepare({...input,title:'New title'});h.message('XÁC NHẬN '+a.nonce);await assert.rejects(d.confirm(a.draftId),{code:'DRAFT_NOT_PENDING'});
 h.message('HỦY '+b.nonce);assert.equal((await d.cancel(b.draftId)).state,'CANCELLED');h.message('XÁC NHẬN '+b.nonce);await assert.rejects(d.confirm(b.draftId),{code:'DRAFT_NOT_PENDING'});
 h.message('Create new ticket. Requester EMP-001. Priority HIGH. Unassigned.');const c=await d.prepare(input);h.advance(600001);h.message('XÁC NHẬN '+c.nonce);await assert.rejects(d.confirm(c.draftId),{code:'DRAFT_EXPIRED'});assert.equal(h.writes.length,0);
 }finally{d.close();}
});
test('restart after unknown commit preserves payload/key; retry yields same ticket',async()=>{
 const h=harness();let d=createDraftService(h.options);
 try {
 const p=await d.prepare(input);h.message('XÁC NHẬN '+p.nonce);h.lose();await assert.rejects(d.confirm(p.draftId),{code:'OUTCOME_UNKNOWN'});assert.equal(h.results.size,1);
 h.message('Create another ticket. Requester EMP-001. Priority HIGH. Unassigned.');await assert.rejects(d.prepare({...input,title:'replacement'}),{code:'OUTCOME_UNKNOWN'});
 d.close();d=createDraftService(h.options);h.message('XÁC NHẬN '+p.nonce);const retry=await d.confirm(p.nonce);assert.equal(retry.ticket.code,'IT-000031');assert.equal(retry.replayed,true);assert.equal(h.writes[0].key,h.writes[1].key);assert.equal(h.results.size,1);
 }finally{d.close();}
});
test('employee creation and follow-up fields cannot become ticket; no silent defaults',async()=>{
 const h=harness(),d=createDraftService(h.options);
 try {
 h.message('Tôi muốn tạo nhân viên mới');h.message('emp-009, tên Nguyễn Văn A, phòng IT, hoạt động');
 await assert.rejects(d.prepare({...input,title:'Tạo nhân viên mới'}),{code:'UNSUPPORTED_OPERATION'});assert.equal(h.previews.length,0);assert.equal(h.writes.length,0);
 h.message('Tạo ticket máy in hỏng');await assert.rejects(d.prepare(input),e=>e.code==='MISSING_FIELDS'&&e.missing.includes('priority'));
 h.message('Ưu tiên HIGH. Chưa giao.');await assert.rejects(d.prepare(input),e=>e.code==='MISSING_FIELDS'&&e.missing.includes('requester'));
 h.message('Người yêu cầu EMP-001');assert.equal((await d.prepare(input)).state,'PENDING');assert.equal(h.writes.length,0);
 }finally{d.close();}
});

test('assignee omission or fabricated unassigned choice cannot produce preview',async()=>{
 const h=harness(),d=createDraftService(h.options);
 try {
 h.message('Tạo ticket laptop hỏng, người yêu cầu EMP-001, ưu tiên HIGH');
 for(const assignee of [undefined,null,'']) await assert.rejects(d.prepare({...input,assignee}),e=>e.code==='MISSING_FIELDS'&&e.missing.includes('assignee'));
 assert.equal(h.previews.length,0);
 h.message('Chưa giao');assert.equal((await d.prepare(input)).state,'PENDING');
 assert.ok(h.previews[0].includes('Người xử lý: Chưa giao'));assert.equal(h.writes.length,0);
 }finally{d.close();}
});
