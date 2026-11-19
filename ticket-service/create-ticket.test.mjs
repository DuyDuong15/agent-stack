import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApi} from './api.mjs';
import {createGraphqlApi} from './graphql-api.mjs';
import {employeeId} from './fixtures.mjs';
const input={title:' New incident ',description:' Laptop broken ',requesterId:employeeId(1),priority:'HIGH'};
async function listen(s) {await new Promise(r=>s.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${s.address().port}`;}
const close=s=>new Promise(r=>{if(!s.listening)return r();s.closeAllConnections();s.close(r);});
test('REST create, normalized replay, concurrent retry, persistence and validation',async()=>{
 let now=new Date('2026-11-17T00:00:00Z'),employeeDown=false;let lookups=0;
 const dbPath=join(mkdtempSync(join(tmpdir(),'create-tickets-')),'tickets.sqlite');
 const options={kind:'ticket',apiKey:'t',employeeKey:'e',dbPath,clock:()=>now,fetchImpl:async u=>{lookups++;if(employeeDown) throw new Error('down');return Response.json({items:new URL(u).searchParams.get('ids').split(',').filter(id=>id!==employeeId(99)).map(id=>({id,active:id!==employeeId(8)})),missingIds:[employeeId(99)]});}};
 let api=createApi(options),url=await listen(api);
 const post=async(body,key='operation-001')=>{const r=await fetch(url+'/tickets',{method:'POST',headers:{'X-API-Key':'t','Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});return {status:r.status,body:await r.json(),replayed:r.headers.get('idempotency-replayed'),location:r.headers.get('location')};};
 try {
 const first=await post({...input,dueAt:'2026-11-18T07:00:00+07:00'});assert.equal(first.status,201);assert.equal(first.body.code,'IT-000031');assert.equal(first.body.title,'New incident');assert.equal(first.body.status,'OPEN');assert.equal(first.body.assigneeId,null);assert.equal(first.location,'/tickets/'+first.body.id);
 now=new Date('2026-11-20T00:00:00Z');employeeDown=true;
 const replay=await post({...input,title:'New incident',description:'Laptop broken',assigneeId:null,dueAt:'2026-11-18T00:00:00Z'});assert.equal(replay.status,201);assert.equal(replay.replayed,'true');assert.deepEqual(replay.body,first.body);assert.equal(lookups,0);
 assert.equal((await post({...input,title:'changed'})).status,409);
 await close(api);api=createApi(options);url=await listen(api);assert.equal((await post({...input,dueAt:'2026-11-18T00:00:00Z'})).body.id,first.body.id);
 assert.equal((await post(input,'new-down-key')).status,409);employeeDown=false;
 const pair=await Promise.all([post({...input,title:'Different incident'},'parallel-key'),post({...input,title:'Different incident'},'parallel-key')]);assert.equal(pair[0].status,201);assert.equal(pair[0].body.id,pair[1].body.id);
 for(const body of [{...input,title:' '},{...input,requesterId:'bad'},{...input,dueAt:'2026-02-30T00:00:00Z'},{...input,dueAt:'2020-01-01T00:00:00Z'},{...input,unknown:true}]) assert.equal((await post(body,'validation-key')).status,400);
 assert.equal((await post({...input,requesterId:employeeId(8)},'inactive-key')).status,201);
 assert.equal((await post({...input,assigneeId:employeeId(99)},'missing-key')).status,201);
 assert.equal(lookups,0); // REST never contacts Employee; GraphQL owns reference validation.
 const list=await fetch(url+'/tickets',{headers:{'X-API-Key':'t'}});assert.equal((await list.json()).total,34);
 } finally {await close(api);}
});
test('GraphQL mutation -> REST -> Employee API; replay and error mapping',async()=>{
 const employee=createApi({kind:'employee',apiKey:'e'}),employeeUrl=await listen(employee);
 const ticket=createApi({kind:'ticket',apiKey:'t',employeeKey:'e',employeeUrl}),ticketUrl=await listen(ticket);
 const graph=createGraphqlApi({apiKey:'g',employeeKey:'e',ticketKey:'t',employeeUrl,ticketUrl,logger:()=>{}}),url=await listen(graph);
 const query='mutation($input:CreateTicketInput!,$key:String!){createTicket(input:$input,idempotencyKey:$key){replayed ticket{id code requester{name}}}}';
 const call=async(body,key,document=query)=>{const r=await fetch(url+'/graphql',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':'g'},body:JSON.stringify({query:document,variables:{input:body,key}})});return r.json();};
 try {const a=await call(input,'graphql-key');assert.equal(a.errors,undefined);assert.equal(a.data.createTicket.ticket.code,'IT-000031');assert.ok(a.data.createTicket.ticket.requester.name);
 const b=await call(input,'graphql-key');assert.equal(b.data.createTicket.replayed,true);assert.equal(b.data.createTicket.ticket.id,a.data.createTicket.ticket.id);
 assert.equal((await call(input,'different-key')).errors[0].extensions.code,'TICKET_DUPLICATE');
 assert.equal((await call({...input,title:'other'},'graphql-key')).errors[0].extensions.code,'IDEMPOTENCY_CONFLICT');
 const inactive=await call({...input,requesterId:employeeId(8)},'inactive-key');assert.equal(inactive.errors[0].extensions.code,'INVALID_EMPLOYEE_REFERENCE');assert.equal(inactive.errors[0].extensions.details[0].field,'requesterId');
 await close(employee);
 const receipt=await call(input,'graphql-key','mutation($input:CreateTicketInput!,$key:String!){createTicket(input:$input,idempotencyKey:$key){replayed ticket{id code}}}');
 assert.equal(receipt.errors,undefined);assert.equal(receipt.data.createTicket.replayed,true);
 assert.equal((await call({...input,title:'New while offline'},'offline-key')).errors[0].extensions.code,'UPSTREAM_UNAVAILABLE');
 } finally {await close(graph);await close(ticket);await close(employee);}
});
