import {tracedDatabase} from '../telemetry/index.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,randomBytes} from 'node:crypto';
import {normalizeTicket} from '../ticket-service/create-ticket.mjs';
import {ticketRequestContext,referenceProvided,priorityProvided} from './capability-policy.mjs';
const fail=(code,message,extra={})=>Object.assign(new Error(message),{code,...extra});
const fold=s=>s.normalize('NFD').replace(/\p{M}/gu,'').replace(/[đĐ]/g,'d').trim().toLowerCase();
const employeeFields='id code name department active';
export function createDraftService({dbPath=':memory:',bridge,graphql,clock=()=>Date.now(),ttlMs=600000}) {
 const db=tracedDatabase(new DatabaseSync(dbPath),'drafts');
 db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS drafts (
 id TEXT PRIMARY KEY, nonce TEXT UNIQUE NOT NULL, room_id TEXT NOT NULL, user_id TEXT NOT NULL,
 source_event TEXT NOT NULL, payload TEXT NOT NULL, preview_text TEXT NOT NULL,
 preview_event TEXT, preview_ts INTEGER, expires_at INTEGER NOT NULL,
 state TEXT NOT NULL, idem_key TEXT NOT NULL UNIQUE, confirmation_event TEXT, result TEXT);
 UPDATE drafts SET state='UNKNOWN' WHERE state='PROCESSING';`);
 let queue=Promise.resolve();
 const serial=fn=>(...args)=>{const result=queue.then(()=>fn(...args));queue=result.catch(()=>{});return result;};
 const get=id=>db.prepare('SELECT * FROM drafts WHERE id=? OR nonce=?').get(id,id);
 const set=(id,state)=>db.prepare('UPDATE drafts SET state=? WHERE id=?').run(state,id);
 function checkContext(ctx,draft) {
  const e=ctx.latest;
  if(!e||e.sender!==ctx.userId||typeof e.content?.body!=='string'||e.content?.['m.relates_to']?.rel_type==='m.replace'||e.unsigned?.redacted_because||!Number.isFinite(e.origin_server_ts)||clock()-e.origin_server_ts>ttlMs||e.origin_server_ts>clock()+10000) throw fail('CONFIRMATION_REQUIRED','Không có tin nhắn người dùng hợp lệ, còn hiệu lực.');
  if(draft&&(ctx.roomId!==draft.room_id||ctx.userId!==draft.user_id)) throw fail('CONFIRMATION_REQUIRED','Sai user hoặc phòng của draft.');
  return e;
 }
 function command(ctx) {
  let body=ctx.latest.content.body.trim();
   const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   const names=[ctx.botId];
   if(ctx.latest.content['m.mentions']?.user_ids?.includes(ctx.botId)) names.push(ctx.botId.replace(/^@/,'').split(':')[0]);
   for(const name of names) {
    const label=escape(name);
    body=body.replace(new RegExp('^'+label+'(?=[:\\s])\\s*:?\\s*'),'').replace(new RegExp('\\s+'+label+'\\s*$'),'').trim();
   }
  return fold(body);
 }
 async function resolve(reference,field) {
  const data=await graphql(`query($filter:EmployeeFilter){employees(filter:$filter,pagination:{limit:100}){total items{${employeeFields}}}}`,{filter:{q:reference.trim()}});
  if(data.errors?.length||!data.data?.employees) throw fail('EMPLOYEE_LOOKUP_FAILED','Chưa lấy được nhân viên.');
  const page=data.data.employees;
  if(page.total!==1||page.items.length!==1) throw fail(page.total?'EMPLOYEE_AMBIGUOUS':'EMPLOYEE_NOT_FOUND','Hỏi người dùng chọn mã nhân viên trước khi tạo draft.',{field,candidates:page.items,total:page.total});
  if(!page.items[0].active) throw fail('INVALID_EMPLOYEE_REFERENCE','Nhân viên đã ngừng hoạt động.',{field});
  return page.items[0];
 }
 async function prepare(input) {
  const ctx=await bridge.context();const source=checkContext(ctx);
  const intent=ticketRequestContext(ctx);
  if(!intent.allowed) throw fail(intent.code,'Chỉ hỗ trợ tra cứu nhân viên/ticket, thống kê và tạo ticket khi người dùng yêu cầu rõ. Chưa hỗ trợ tạo/sửa/xóa nhân viên hoặc sửa/xóa ticket. Không chuyển yêu cầu đó thành ticket.');
  const missing=['title','description','requester','priority'].filter(k=>typeof input[k]!=='string'||!input[k].trim());
  if(!missing.includes('priority')&&!priorityProvided(intent,input.priority)) missing.push('priority');
  if(!input.assignee && !(input.assignee===null && /\b(chua giao|chua phan cong|khong giao cho ai|de trong nguoi (xu ly|thuc hien)|unassigned|leave unassigned)\b/.test(intent.text))) missing.push('assignee');
  if(missing.length) throw fail('MISSING_FIELDS','Hỏi người dùng bổ sung trường bắt buộc, chưa tạo ticket.',{missing});
  const requester=await resolve(input.requester,'requester');
  if(!referenceProvided(intent,input.requester,requester)) throw fail('MISSING_FIELDS','Người dùng chưa chỉ định người yêu cầu; không được tự chọn.',{missing:['requester']});
  const assignee=input.assignee?await resolve(input.assignee,'assignee'):null;
  if(assignee&&!referenceProvided(intent,input.assignee,assignee)) throw fail('MISSING_FIELDS','Hỏi người thực hiện; chỉ để Chưa giao khi người dùng chọn rõ.',{missing:['assignee']});
  const payload=normalizeTicket({title:input.title,description:input.description,requesterId:requester.id,assigneeId:assignee?.id??null,priority:input.priority,dueAt:input.dueAt??null});
  if(payload.dueAt&&Date.parse(payload.dueAt)<=clock()) throw fail('BAD_USER_INPUT','Deadline phải ở tương lai.');
  const encoded=JSON.stringify(payload);
  const same=db.prepare("SELECT * FROM drafts WHERE room_id=? AND user_id=? AND source_event=? AND payload=? AND state IN ('PENDING','COMPLETED') ORDER BY rowid DESC LIMIT 1").get(ctx.roomId,ctx.userId,source.event_id,encoded);
  if(same&&same.expires_at>clock()) return {draftId:same.id,nonce:same.nonce,state:same.state,preview:same.preview_text,result:same.result?JSON.parse(same.result):undefined};
  const pending=db.prepare("SELECT * FROM drafts WHERE room_id=? AND user_id=? AND state IN ('PROCESSING','UNKNOWN')").get(ctx.roomId,ctx.userId);
  if(pending) throw fail('OUTCOME_UNKNOWN','Còn draft chưa rõ kết quả; retry cùng draft, không tạo draft mới.',{draftId:pending.id});
  const id=randomUUID(),nonce=randomBytes(6).toString('hex'),expiresAt=clock()+ttlMs;
  const due=payload.dueAt?`${payload.dueAt} (giờ Việt Nam: ${new Date(payload.dueAt).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})})`:'Không có';
  const text=`BẢN XEM TRƯỚC TICKET — CHƯA TẠO\nDraft: ${id}\nTiêu đề: ${payload.title}\nMô tả: ${payload.description}\nNgười yêu cầu: ${requester.name} (${requester.code}, ${requester.department})\nNgười xử lý: ${assignee?`${assignee.name} (${assignee.code}, ${assignee.department})`:'Chưa giao'}\nƯu tiên: ${payload.priority}\nDeadline: ${due}\nTrạng thái khi tạo: OPEN\nXác nhận trước: ${new Date(expiresAt).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit',year:'numeric',hour12:false})} (giờ Việt Nam)\nĐể đồng ý, gửi đúng: XÁC NHẬN ${nonce}\nĐể từ chối, gửi: HỦY ${nonce}\nCó thể mention bot trước câu lệnh. Thay đổi nội dung cần bản xem trước mới.`;
  db.exec('BEGIN IMMEDIATE');
  try {db.prepare("UPDATE drafts SET state='SUPERSEDED' WHERE room_id=? AND user_id=? AND state='PENDING'").run(ctx.roomId,ctx.userId);
   db.prepare('INSERT INTO drafts(id,nonce,room_id,user_id,source_event,payload,preview_text,expires_at,state,idem_key) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,nonce,ctx.roomId,ctx.userId,source.event_id,encoded,text,expiresAt,'PREPARING','draft_'+id);db.exec('COMMIT');
  } catch(e) {db.exec('ROLLBACK');throw e;}
  try {const sent=await bridge.preview(ctx.roomId,'preview_'+id,text);db.prepare("UPDATE drafts SET preview_event=?,preview_ts=?,state='PENDING' WHERE id=?").run(sent.eventId,sent.ts,id);} catch {set(id,'FAILED');throw fail('PREVIEW_FAILED','Chưa gửi được preview, không thể tạo ticket.');}
  return {draftId:id,nonce,state:'PENDING',expiresAt:new Date(expiresAt).toISOString(),preview:text,instruction:'Preview đã gửi vào Matrix. Chờ user gửi đúng mã xác nhận. Không tự gọi confirm hoặc thêm nội dung vào mã.'};
 }
 async function act(id,mode) {
  const draft=get(id);if(!draft) throw fail('DRAFT_NOT_FOUND','Không có draft này.');
  const ctx=await bridge.context();const e=checkContext(ctx,draft);
  if(draft.state==='COMPLETED') return {draftId:draft.id,state:'COMPLETED',...JSON.parse(draft.result),instruction:'Đã tạo trước đó; không tạo lại, không thể hủy ticket đã commit.'};
  if(['CANCELLED','SUPERSEDED','EXPIRED','FAILED','PREPARING'].includes(draft.state)) throw fail('DRAFT_NOT_PENDING',`Draft đang ở trạng thái ${draft.state}; không tạo ticket.`);
  if(draft.state==='PENDING'&&clock()>=draft.expires_at) {set(draft.id,'EXPIRED');throw fail('DRAFT_EXPIRED','Draft đã hết hạn.');}
  if(!draft.preview_event||e.event_id===draft.source_event||e.origin_server_ts<=draft.preview_ts) throw fail('CONFIRMATION_REQUIRED','Phải có xác nhận mới sau preview.');
  const cmd=command(ctx),confirm=cmd===`xac nhan ${draft.nonce}`,cancel=cmd===`huy ${draft.nonce}`||['khong','khong tao','khong dong y','huy'].includes(cmd);
  if(cancel) {
   if(draft.state==='UNKNOWN'||draft.state==='PROCESSING') throw fail('OUTCOME_UNKNOWN','Có thể đã commit. Retry cùng draft để lấy kết quả trước khi xử lý tiếp.');
   set(draft.id,'CANCELLED');return {draftId:draft.id,state:'CANCELLED',instruction:'Đã hủy draft; không tạo ticket.'};
  }
  if(mode==='cancel'||!confirm) throw fail('CONFIRMATION_REQUIRED',`Cần người dùng gửi đúng XÁC NHẬN ${draft.nonce}, hoặc HỦY ${draft.nonce}.`);
  db.prepare("UPDATE drafts SET state='PROCESSING',confirmation_event=? WHERE id=?").run(e.event_id,draft.id);
  let result;
  try {result=await graphql('mutation($input:CreateTicketInput!,$key:String!){createTicket(input:$input,idempotencyKey:$key){replayed ticket{id code title description requesterId assigneeId priority status dueAt createdAt updatedAt}}}',{input:JSON.parse(draft.payload),key:draft.idem_key});}
  catch {set(draft.id,'UNKNOWN');throw fail('OUTCOME_UNKNOWN','Chưa biết ticket đã tạo chưa. Retry cùng draft và mã, không tạo draft mới.');}
  if(result.data?.createTicket?.ticket?.id) {const value=result.data.createTicket;db.prepare("UPDATE drafts SET state='COMPLETED',result=? WHERE id=?").run(JSON.stringify(value),draft.id);return {draftId:draft.id,state:'COMPLETED',...value};}
  const code=result.errors?.[0]?.extensions?.code;
  if(['BAD_USER_INPUT','INVALID_EMPLOYEE_REFERENCE','IDEMPOTENCY_CONFLICT','TICKET_DUPLICATE'].includes(code)) {set(draft.id,'FAILED');throw fail(code,result.errors?.[0]?.message??'Tạo ticket bị từ chối; sửa và tạo bản xem trước mới.',{details:result.errors?.[0]?.extensions?.details});}
  set(draft.id,'UNKNOWN');throw fail('OUTCOME_UNKNOWN','Chưa có kết quả chắc chắn; retry cùng draft/key.',{upstreamCode:code});
 }
 return {prepare:serial(prepare),confirm:serial(id=>act(id,'confirm')),cancel:serial(id=>act(id,'cancel')),get:id=>get(id),close:()=>db.close()};
}
