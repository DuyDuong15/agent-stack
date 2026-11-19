const fold=s=>s.normalize('NFD').replace(/\p{M}/gu,'').replace(/[đĐ]/g,'d').toLowerCase();
const text=e=>fold(e.content?.body??'');
export function ticketRequestContext(ctx) {
 const events=ctx.userMessages??[ctx.latest];const collected=[];
 for(const e of events.slice(0,20)) {
  if(e.sender!==ctx.userId||e.content?.['m.relates_to']?.rel_type==='m.replace') continue;
  if(ctx.latest.origin_server_ts-e.origin_server_ts>1800000) break;
  const body=text(e);collected.push(body);
  if(/\b(?:xac nhan|huy)\s+[a-f0-9]{12}\b/.test(body)) break;
  // Explicit ticket request is required; a title supplied by the model is not evidence.
  if(/\b(?:tao|chuan bi|create|prepare|new)\b[^.!?\n]{0,65}\bticket\b/.test(body)&&!/\b(?:khong|dung|do not|don't)\s+(?:tao|create|prepare)\b/.test(body)) return {allowed:true,text:collected.join('\n')};
  if(/\b(?:tao|them|sua|xoa|cap nhat|create|add|update|delete)\b[^.!?\n]{0,60}\b(?:nhan vien|employee|user|tai khoan)\b/.test(body)) return {allowed:false,code:'UNSUPPORTED_OPERATION'};
  if(/\b(?:sua|xoa|cap nhat|update|delete|close|dong)\b[^.!?\n]{0,40}\bticket\b/.test(body)) return {allowed:false,code:'UNSUPPORTED_OPERATION'};
 }
 return {allowed:false,code:'TICKET_INTENT_REQUIRED'};
}
export function referenceProvided(context,reference,candidate) {
 const body=' '+context.text.replace(/[^a-z0-9-]+/g,' ')+' ';
 return [reference,candidate?.code,candidate?.name].filter(Boolean).some(v=>body.includes(' '+fold(v).replace(/[^a-z0-9-]+/g,' ').trim()+' '));
}
export function priorityProvided(context,priority) {
 const aliases={HIGH:'high|cao',MEDIUM:'medium|trung binh',LOW:'low|thap'};
 const value=aliases[priority];if(!value) return false;
 return new RegExp(`(?:uu tien|priority)\\s*[:=-]?\\s*(?:${value})\\b|(?:^|\\n)\\s*(?:${value})\\s*$`,'m').test(context.text);
}
