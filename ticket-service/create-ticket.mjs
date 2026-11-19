import {createHash} from 'node:crypto';
export const fault=(status,code,message,details)=>Object.assign(new Error(message),{status,code,...(details?{details}:{})});
export function normalizeTicket(value) {
 const invalid=(field,message)=>{throw fault(400,'VALIDATION_ERROR',message,[{field,code:'INVALID_VALUE',message}]);};
 if(!value||typeof value!=='object'||Array.isArray(value)) invalid('body','Expected object');
 const fields=['title','description','requesterId','assigneeId','priority','dueAt'];
 for(const field of Object.keys(value)) if(!fields.includes(field)) invalid(field,'Unknown field');
 const out={};
 for(const [field,max] of [['title',200],['description',4000]]) {if(typeof value[field]!=='string'||!value[field].trim()||value[field].trim().length>max) invalid(field,`Expected 1-${max} characters`);out[field]=value[field].trim();}
 for(const field of ['requesterId','assigneeId']) {
  const v=value[field];
  if(field==='assigneeId'&&v==null) {out[field]=null;continue;}
  if(typeof v!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v)) invalid(field,'Expected UUID');
  out[field]=v.toLowerCase();
 }
 if(!['LOW','MEDIUM','HIGH'].includes(value.priority)) invalid('priority','Invalid priority');out.priority=value.priority;
 out.dueAt=null;
 if(value.dueAt!=null) {
  const v=value.dueAt,m=typeof v==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/i.exec(v);
  if(!m||+m[2]<1||+m[2]>12||+m[3]<1||+m[3]>new Date(Date.UTC(+m[1],+m[2],0)).getUTCDate()||+m[4]>23||+m[5]>59||+m[6]>59||+(m[8]??0)>23||+(m[9]??0)>59||!Number.isFinite(Date.parse(v))) invalid('dueAt','Expected valid date-time with timezone');
  out.dueAt=new Date(v).toISOString();
 }
 return out;
}
export function createTicketWriter({store,apiKey,clock=()=>new Date()}) {
 const scope=createHash('sha256').update(apiKey+'\nPOST /tickets').digest('hex');
 const normalized=(input,key)=>{
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw fault(400,'VALIDATION_ERROR','Idempotency-Key must contain 8-128 letters/digits/_/-');
  const payload=normalizeTicket(input),hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return {payload,hash};
 };
 const write=async(input,key)=>{
  const {payload,hash}=normalized(input,key);
  const previous=store.replay(scope,key,hash);if(previous) return previous;
  if(payload.dueAt&&payload.dueAt<=clock().toISOString()) throw fault(400,'VALIDATION_ERROR','Deadline must be in the future',[{field:'dueAt',code:'INVALID_VALUE',message:'Deadline must be in the future'}]);
  const now=clock().toISOString();
  if(payload.dueAt&&payload.dueAt<=now) throw fault(400,'VALIDATION_ERROR','Deadline must be after creation time');
  return store.create(scope,key,hash,payload,now);
 };
 write.lookup=(input,key)=>{const {hash}=normalized(input,key);return store.replay(scope,key,hash)??{ticket:null,replayed:false};};
 return write;
}
