import {httpTrace,tracedFetch,inSpan,log,markError} from '../telemetry/index.mjs';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {buildSchema,parse,validate,execute,GraphQLError,Kind} from 'graphql';
import DataLoader from 'dataloader';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {settings} from '../configuration.mjs';
const spec=JSON.parse(readFileSync(new URL('./design/openapi.json',import.meta.url),'utf8'));
const ajv=new Ajv({strict:false});addFormats(ajv);ajv.addSchema(spec,'contract');
const checks=Object.fromEntries(['Employee','Ticket','EmployeePage','TicketPage','EmployeeBatch','TicketStatistics'].map(n=>[n,ajv.compile({$ref:`contract#/components/schemas/${n}`})]));
const error=(code,message,service)=>new GraphQLError(message,{extensions:{code,...(service?{service}:{})}});
function uuid(v) {if(typeof v!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v)) throw error('BAD_USER_INPUT','Expected UUID string');return v.toLowerCase();}
function date(v) {
 const m=typeof v==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/i.exec(v);
 if(!m||+m[2]<1||+m[2]>12||+m[3]<1||+m[3]>new Date(Date.UTC(+m[1],+m[2],0)).getUTCDate()||+m[4]>23||+m[5]>59||+m[6]>59||+(m[8]??0)>23||+(m[9]??0)>59||!Number.isFinite(Date.parse(v))) throw error('BAD_USER_INPUT','Expected valid timestamp with timezone');
 return new Date(v).toISOString();
}
export function createGraphqlApi({apiKey,employeeKey,ticketKey,employeeUrl=settings.EMPLOYEE_API_URL,ticketUrl=settings.TICKET_API_URL,timeoutMs=Number(settings.REST_TIMEOUT_MS),fetchImpl=fetch,logger=log}) {
 if(!apiKey||!employeeKey||!ticketKey) throw new Error('GraphQL and REST credentials required');
 const schema=buildSchema(readFileSync(new URL('./design/schema.graphql',import.meta.url),'utf8')+'\n'+readFileSync(new URL('./design/schema-bai2.graphql',import.meta.url),'utf8'));
 for(const [name,coerce] of [['UUID',uuid],['DateTime',date]]) Object.assign(schema.getType(name),{serialize:coerce,parseValue:coerce,parseLiteral:node=>{if(node.kind!==Kind.STRING) throw error('BAD_USER_INPUT',`Expected ${name} string`);return coerce(node.value);}});
 async function rest(ctx,service,path,type,params={},detail=false) {
   const url=new URL(path,service==='EMPLOYEE'?employeeUrl:ticketUrl);
   for(const [k,v] of Object.entries(params)) if(v!==null&&v!==undefined) url.searchParams.set(k,String(v));
   const signal=AbortSignal.timeout(timeoutMs);
   try {
     const response=await tracedFetch(fetchImpl,url,{headers:{'X-API-Key':service==='EMPLOYEE'?employeeKey:ticketKey},signal,redirect:'error'});
     logger({event:'rest_response',requestId:ctx.requestId,service,path,status:response.status,upstreamRequestId:response.headers.get('x-request-id')});
     if(detail&&response.status===404) return null;
     if(!response.ok) throw error(response.status===400?'BAD_USER_INPUT':[401,403].includes(response.status)?'UPSTREAM_AUTH_ERROR':response.status>=500?'UPSTREAM_UNAVAILABLE':'UPSTREAM_BAD_RESPONSE','REST request failed',service);
     let body;try {body=await response.json();} catch(e) {if(signal.aborted) throw e;throw error('UPSTREAM_BAD_RESPONSE','Invalid REST JSON',service);}
     if(!checks[type](body)) throw error('UPSTREAM_BAD_RESPONSE','Invalid REST response shape',service);
     return body;
   } catch(e) {
     if(e instanceof GraphQLError) throw e;
     throw error(signal.aborted?'UPSTREAM_TIMEOUT':'UPSTREAM_UNAVAILABLE',signal.aborted?'REST request timed out':'REST service unavailable',service);
   }
 }
 const roots=schema.getQueryType().getFields();
 for(const [field,service,path,type,detail] of [
   ['employees','EMPLOYEE','/employees','EmployeePage',false],['employee','EMPLOYEE','/employees','Employee',true],
   ['tickets','TICKET','/tickets','TicketPage',false],['ticket','TICKET','/tickets','Ticket',true],['ticketStatistics','TICKET','/ticket-statistics','TicketStatistics',false]]) {
   roots[field].resolve=(_,args,ctx)=>rest(ctx,service,detail?`${path}/${args.id}`:path,type,{...args.filter,...args.pagination},detail);
 }
 for(const field of ['requester','assignee']) schema.getType('Ticket').getFields()[field].resolve=(ticket,_,ctx)=>ticket[field+'Id']===null?null:ctx.employees.load(ticket[field+'Id']);
 schema.getMutationType().getFields().createTicket.resolve=async(_,args,ctx)=>{
   if(!/^[A-Za-z0-9_-]{8,128}$/.test(args.idempotencyKey)) throw error('BAD_USER_INPUT','Invalid idempotency key');
   // Read the Ticket API's durable receipt first: retries must work even if Employee API is down.
   const probeSignal=AbortSignal.timeout(timeoutMs);
   let probe;
   try {
     const response=await tracedFetch(fetchImpl,new URL('/ticket-replays',ticketUrl),{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':ticketKey,'Idempotency-Key':args.idempotencyKey},body:JSON.stringify(args.input),signal:probeSignal,redirect:'error'});
     probe=await response.json();
     logger({event:'rest_response',requestId:ctx.requestId,service:'TICKET',method:'POST',path:'/ticket-replays',status:response.status});
     if(!response.ok) throw error(response.status===409?'IDEMPOTENCY_CONFLICT':response.status===400?'BAD_USER_INPUT':'UPSTREAM_UNAVAILABLE',response.status<500?probe?.error?.message??'Invalid creation request':'Ticket API unavailable','TICKET');
     if(probe.replayed===true&&checks.Ticket(probe.ticket)) return probe;
     if(probe.ticket!==null||probe.replayed!==false) throw error('UPSTREAM_BAD_RESPONSE','Invalid replay response','TICKET');
   } catch(e) {if(e instanceof GraphQLError) throw e;throw error(probeSignal.aborted?'UPSTREAM_TIMEOUT':'UPSTREAM_UNAVAILABLE','Cannot check previous creation result','TICKET');}
   const fields=['requesterId','assigneeId'].filter(k=>args.input[k]);
   const employees=await ctx.employees.loadMany(fields.map(k=>args.input[k]));
   const details=[];
   for(let i=0;i<fields.length;i++) {
     if(employees[i] instanceof Error) throw employees[i];
     if(!employees[i]||!employees[i].active) details.push({field:fields[i],code:employees[i]?'EMPLOYEE_INACTIVE':'EMPLOYEE_NOT_FOUND',message:'Employee is missing or inactive'});
   }
   if(details.length) throw new GraphQLError('Employee reference is missing or inactive',{extensions:{code:'INVALID_EMPLOYEE_REFERENCE',details}});
   const signal=AbortSignal.timeout(timeoutMs);
   try {
     const response=await tracedFetch(fetchImpl,new URL('/tickets',ticketUrl),{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':ticketKey,'Idempotency-Key':args.idempotencyKey},body:JSON.stringify(args.input),signal,redirect:'error'});
     logger({event:'rest_response',requestId:ctx.requestId,service:'TICKET',method:'POST',path:'/tickets',status:response.status,upstreamRequestId:response.headers.get('x-request-id')});
     let body;try {body=await response.json();} catch(e) {if(signal.aborted) throw e;throw error('UPSTREAM_BAD_RESPONSE','Invalid REST JSON','TICKET');}
     if(response.status!==201) {
       const code=response.status===400?'BAD_USER_INPUT':response.status===422?'INVALID_EMPLOYEE_REFERENCE':response.status===409&&['IDEMPOTENCY_CONFLICT','REQUEST_IN_PROGRESS','TICKET_DUPLICATE'].includes(body?.error?.code)?body.error.code:response.status===504?'UPSTREAM_TIMEOUT':[401,403].includes(response.status)?'UPSTREAM_AUTH_ERROR':response.status>=500?'UPSTREAM_UNAVAILABLE':'UPSTREAM_BAD_RESPONSE';
       const failure=error(code,response.status<500?body?.error?.message??'Ticket creation rejected':'Ticket creation failed','TICKET');
       if(response.status===422&&Array.isArray(body?.error?.details)) failure.extensions.details=body.error.details.filter(d=>['requesterId','assigneeId'].includes(d.field)).map(d=>({field:d.field,code:['EMPLOYEE_INACTIVE','EMPLOYEE_NOT_FOUND'].includes(d.code)?d.code:'INVALID_VALUE',message:'Employee is missing or inactive'}));
       if(code==='REQUEST_IN_PROGRESS') failure.extensions.retryAfter=Number(response.headers.get('retry-after'))||1;
       throw failure;
     }
     if(!checks.Ticket(body)||!['true','false'].includes(response.headers.get('idempotency-replayed'))) throw error('UPSTREAM_BAD_RESPONSE','Invalid created ticket response','TICKET');
     return {ticket:body,replayed:response.headers.get('idempotency-replayed')==='true'};
   } catch(e) {if(e instanceof GraphQLError) throw e;throw error(signal.aborted?'UPSTREAM_TIMEOUT':'UPSTREAM_UNAVAILABLE','Cannot determine creation result; retry with the same idempotency key','TICKET');}
 };
 for(const typeName of ['Query','Mutation','Ticket']) {
   const fields=schema.getType(typeName)?.getFields();
   for(const [name,field] of Object.entries(fields??{}))if(field.resolve){const resolve=field.resolve;field.resolve=(...args)=>inSpan('graphql.resolve '+typeName+'.'+name,{'graphql.field.name':name},()=>resolve(...args));}
 }
 return createServer(httpTrace(async(req,res)=>{
   const requestId=randomUUID();
   const format=e=>({message:e.extensions?.code?e.message:'Internal server error',...(e.locations?{locations:e.locations}:{}),...(e.path?{path:e.path}:{}),extensions:{code:e.extensions?.code??'INTERNAL_SERVER_ERROR',requestId,...(e.extensions?.service?{service:e.extensions.service}:{}),...(e.extensions?.details?{details:e.extensions.details}:{}),...(e.extensions?.retryAfter?{retryAfter:e.extensions.retryAfter}:{})}});
   const send=(status,body)=>{if(body.errors?.length)markError(body.errors[0].extensions?.code??'GRAPHQL_ERROR');res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Request-Id':requestId});res.end(JSON.stringify(body));};
   try {
     const received=Buffer.from(req.headers['x-api-key']??''),expected=Buffer.from(apiKey);
     if(received.length!==expected.length||!timingSafeEqual(received,expected)) return send(401,{errors:[format(error('UNAUTHENTICATED','Missing or invalid GraphQL credential'))]});
     if(req.url!=='/graphql') return send(404,{errors:[format(error('NOT_FOUND','Route not found'))]});
     if(req.method!=='POST') return send(405,{errors:[format(error('METHOD_NOT_ALLOWED','Use POST'))]});
     const chunks=[];let size=0;for await(const chunk of req) {size+=chunk.length;if(size>1048576) return send(413,{errors:[format(error('BAD_REQUEST','Request too large'))]});chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');
     let body;try {body=JSON.parse(raw);} catch {return send(400,{errors:[format(error('BAD_REQUEST','Invalid JSON'))]});}
     if(!body||typeof body.query!=='string'||(body.variables!=null&&(typeof body.variables!=='object'||Array.isArray(body.variables)))||(body.operationName!=null&&typeof body.operationName!=='string')) return send(400,{errors:[format(error('BAD_REQUEST','Invalid GraphQL request'))]});
     let document;try {document=parse(body.query);} catch {return send(400,{errors:[format(error('GRAPHQL_PARSE_FAILED','Invalid GraphQL syntax'))]});}
     const invalid=validate(schema,document);if(invalid.length) return send(400,{errors:invalid.map(e=>format(error(e.extensions?.code??'GRAPHQL_VALIDATION_FAILED',e.message)))});
     const ctx={requestId};
     ctx.employees=new DataLoader(ids=>inSpan('graphql.employee_batch',{'batch.size':ids.length},async()=>{
       const batch=await rest(ctx,'EMPLOYEE','/employees','EmployeeBatch',{ids:ids.join(',')});
       const found=new Map(batch.items.map(e=>[e.id,e]));
       if(ids.some(id=>!found.has(id)&&!batch.missingIds.includes(id))) throw error('UPSTREAM_BAD_RESPONSE','Incomplete employee batch','EMPLOYEE');
       return ids.map(id=>found.get(id)??null);
     }),{maxBatchSize:100});
     const result=await inSpan('graphql.execute',{},()=>execute({schema,document,contextValue:ctx,variableValues:body.variables,operationName:body.operationName}));
     const status=Object.hasOwn(result,'data')?200:400;
     if(result.errors) result.errors=result.errors.map(e=>format(status===400&&!e.extensions?.code?error('BAD_USER_INPUT',e.message):e));
     send(status,result);
   } catch {send(500,{errors:[format(error('INTERNAL_SERVER_ERROR','Internal server error'))]});}
 }));
}
