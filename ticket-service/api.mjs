import {httpTrace,log,markError} from '../telemetry/index.mjs';
import {createServer} from 'node:http';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {openStore} from './store.mjs';
import {fixtures,statuses,priorities} from './fixtures.mjs';
import {createTicketWriter,fault} from './create-ticket.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(field,message) { throw Object.assign(new Error(message),{status:400,code:'VALIDATION_ERROR',details:[{field,code:'INVALID_VALUE',message}]}); }
function uuid(value,field) { if(!uuidPattern.test(value)) fail(field,'Expected UUID'); return value.toLowerCase(); }
function date(value,field) {
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
  if(!m || +m[2]<1 || +m[2]>12 || +m[3]<1 || +m[3]>new Date(Date.UTC(+m[1],+m[2],0)).getUTCDate() || +m[4]>23 || +m[5]>59 || +m[6]>59 || +(m[8]??0)>23 || +(m[9]??0)>59 || !Number.isFinite(Date.parse(value))) fail(field,'Expected valid ISO date-time with timezone');
  return new Date(value).toISOString();
}
const ticketFilters=['q','code','status','priority','requesterId','assigneeId','unassigned','overdue','createdFrom','createdTo'];
function query(params,allowed,kind) {
  const q={};
  for(const [key,raw] of params) {
    if(!allowed.includes(key)) fail(key,'Unknown query parameter');
    if(Object.hasOwn(q,key)) fail(key,'Repeated query parameter');
    let v=raw;
    if(['q','department'].includes(key)) {v=raw.trim(); if(!v || v.length>(key==='department'?100:kind==='employee'?120:200)) fail(key,'Invalid text length');}
    if(['active','unassigned','overdue'].includes(key)) {if(!['true','false'].includes(raw)) fail(key,'Expected true or false'); v=raw==='true';}
    if(['limit','offset'].includes(key)) {v=Number(raw);if(!/^\d+$/.test(raw)||!Number.isSafeInteger(v)||v<(key==='limit'?1:0)||(key==='limit'&&v>100)) fail(key,'Invalid pagination');}
    if(['requesterId','assigneeId'].includes(key)) v=uuid(raw,key);
    if(['createdFrom','createdTo'].includes(key)) v=date(raw,key);
    if(key==='code'&&!/^IT-[0-9]{6,}$/.test(raw)) fail(key,'Invalid ticket code');
    if(key==='status'&&!statuses.includes(raw)) fail(key,'Unknown status');
    if(key==='priority'&&!priorities.includes(raw)) fail(key,'Unknown priority');
    if(key==='ids') {v=raw.split(',').map(id=>uuid(id,key));if(v.length>100||new Set(v).size!==v.length) fail(key,'Expected 1–100 unique IDs');}
    q[key]=v;
  }
  if(q.ids && Object.keys(q).length!==1) fail('ids','Batch cannot combine with filters or pagination');
  if(q.assigneeId && q.unassigned===true) fail('unassigned','Cannot combine with assigneeId');
  if(q.createdFrom && q.createdTo && q.createdFrom>=q.createdTo) fail('createdTo','Must be greater than createdFrom');
  return q;
}
export function createApi({kind,apiKey,dbPath=':memory:',clock=()=>new Date(),seed=fixtures(clock())}) {
  if(!['employee','ticket'].includes(kind)||!apiKey) throw new Error('Service kind and API key required');
  const store=openStore({kind,dbPath,seed});
  const write=kind==='ticket'?createTicketWriter({store,apiKey,clock}):null;
  const server=createServer(httpTrace(async(req,res)=>{
    const requestId=randomUUID();
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','X-Request-Id':requestId,'Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    try {
      const incoming=Buffer.from(req.headers['x-api-key']??'');const expected=Buffer.from(apiKey);
      if(incoming.length!==expected.length||!timingSafeEqual(incoming,expected)) throw Object.assign(new Error('Missing or invalid API key'),{status:401,code:'UNAUTHORIZED'});
      const url=new URL(req.url,'http://localhost');
      if(req.method==='POST'&&kind==='ticket'&&['/tickets','/ticket-replays'].includes(url.pathname)) {
        if(url.search) throw fault(400,'VALIDATION_ERROR','POST does not accept query parameters');
        if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')) throw fault(400,'VALIDATION_ERROR','Expected application/json');
        const chunks=[];let size=0;for await(const chunk of req) {size+=chunk.length;if(size>65536) throw fault(400,'VALIDATION_ERROR','Body exceeds 64 KiB');chunks.push(chunk);}
        let body;try {body=JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw fault(400,'VALIDATION_ERROR','Invalid JSON');}
        if(url.pathname==='/ticket-replays') return send(200,write.lookup(body,req.headers['idempotency-key']));
        const result=await write(body,req.headers['idempotency-key']);
        res.setHeader('Location','/tickets/'+result.ticket.id);res.setHeader('Idempotency-Replayed',String(result.replayed));
        return send(201,result.ticket);
      }
      if(req.method!=='GET') {res.setHeader('Allow',kind==='ticket'&&url.pathname==='/tickets'?'GET, POST':'GET');throw Object.assign(new Error('Method not allowed'),{status:405,code:'METHOD_NOT_ALLOWED'});}
      const base=kind==='employee'?'/employees':'/tickets';
      const stats=kind==='ticket'&&url.pathname==='/ticket-statistics';
      const detail=url.pathname.startsWith(base+'/')&&!url.pathname.slice(base.length+1).includes('/');
      if(url.pathname!==base&&!stats&&!detail) throw Object.assign(new Error('Route not found'),{status:404,code:'NOT_FOUND'});
      const q=query(url.searchParams,detail?[]:kind==='employee'?['q','department','active','ids','limit','offset']:[...ticketFilters,...(stats?[]:['limit','offset'])],kind);
      const now=clock().toISOString();
      if(detail) {
        let rawId;
        try {rawId=decodeURIComponent(url.pathname.slice(base.length+1));} catch {fail(kind+'Id','Malformed URL encoding');}
        const id=uuid(rawId,kind+'Id');
        const item=store.detail(id);
        if(!item) throw Object.assign(new Error('Resource not found'),{status:404,code:kind==='employee'?'EMPLOYEE_NOT_FOUND':'TICKET_NOT_FOUND'});
        return send(200,item);
      }
      return send(200,store.select(q,now,stats));
    } catch(e) {
      const status=e.status??500;
      markError(e.code??'INTERNAL_ERROR');log({event:'rest_error',requestId,code:e.code??'INTERNAL_ERROR',status},'ERROR');
      send(status,{error:{code:e.code??'INTERNAL_ERROR',message:status===500?'Unexpected service failure':e.message,...(e.details?{details:e.details}:{})},requestId});
    }
  }));
  server.on('close',()=>store.close());
  return server;
}
