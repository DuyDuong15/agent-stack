import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from './api.mjs';
import {createGraphqlApi} from './graphql-api.mjs';
import {fixtures,employeeId} from './fixtures.mjs';
const live=[];
async function start(s) {await new Promise(r=>s.listen(0,'127.0.0.1',r));live.push(s);return `http://127.0.0.1:${s.address().port}`;}
after(async()=>{await Promise.all(live.map(s=>new Promise(r=>s.close(r))));});
const employeeUrl=await start(createApi({kind:'employee',apiKey:'e'}));
const ticketUrl=await start(createApi({kind:'ticket',apiKey:'t'}));
const calls=[];
const config={apiKey:'g',employeeKey:'e',ticketKey:'t',employeeUrl,ticketUrl,logger:()=>{}};
const url=await start(createGraphqlApi({...config,fetchImpl:(u,o)=>{calls.push(String(u));return fetch(u,o);}}));
async function query(q,variables,base=url,key='g') {const r=await fetch(base+'/graphql',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':key},body:JSON.stringify({query:q,variables})});return {status:r.status,body:await r.json()};}
test('GraphQL joins real REST APIs, batches relations, preserves totals',async()=>{
 calls.length=0;
 const r=await query('{tickets(pagination:{limit:5}){total items{code requester{name} assignee{name}}} ticketStatistics{total openCount}}');
 assert.equal(r.status,200);assert.equal(r.body.errors,undefined);assert.equal(r.body.data.tickets.total,30);assert.equal(r.body.data.ticketStatistics.total,30);assert.equal(r.body.data.tickets.items.length,5);assert.ok(r.body.data.tickets.items[0].requester.name);
 assert.equal(calls.filter(u=>u.includes('ids=')).length,1);
 calls.length=0;await query('{tickets{items{code}}}');assert.equal(calls.filter(u=>u.includes('employees')).length,0);
});
test('GraphQL input/auth/scalars reject invalid requests',async()=>{
 for(const q of ['{tickets(pagination:null){total}}','{tickets(filter:{status:BAD}){total}}','{ticket(id:"bad"){id}}','{tickets(filter:{createdFrom:"2026-02-30T00:00:00Z"}){total}}']) assert.equal((await query(q)).status,400,q);
 assert.equal((await query('query($id:UUID!){ticket(id:$id){id}}',{id:'bad'})).status,400);
 assert.equal((await query('{tickets{total}}',undefined,url,'bad')).status,401);
 const r=await query('{tickets(pagination:{limit:0}){total}}');assert.equal(r.status,200);assert.equal(r.body.errors[0].extensions.code,'BAD_USER_INPUT');
 const empty=await query('{tickets(filter:{code:"IT-999999"}){total items{id}}}');assert.equal(empty.body.data.tickets.total,0);
 const missing=await query(`{employee(id:"${employeeId(999)}"){id}}`);assert.equal(missing.body.data.employee,null);assert.equal(missing.body.errors,undefined);
 assert.equal((await query('{employees(filter:{active:false}){total}}')).body.data.employees.total,1);
 assert.equal((await query('{employees(filter:{q:"Nam"}){total}}')).body.data.employees.total,2);
});
test('employee upstream errors keep ticket data with errors at relation path',async()=>{
 for(const [status,code] of [[401,'UPSTREAM_AUTH_ERROR'],[503,'UPSTREAM_UNAVAILABLE'],[200,'UPSTREAM_BAD_RESPONSE']]) {
   const base=await start(createGraphqlApi({...config,fetchImpl:(u,o)=>String(u).startsWith(employeeUrl)?Promise.resolve(new Response('{}',{status})):fetch(u,o)}));
   const r=await query('{tickets(pagination:{limit:1}){items{code requester{name}}}}',undefined,base);
   assert.equal(r.status,200);assert.ok(r.body.data.tickets.items[0].code);assert.equal(r.body.data.tickets.items[0].requester,null);assert.equal(r.body.errors[0].extensions.code,code);assert.deepEqual(r.body.errors[0].path,['tickets','items',0,'requester']);
 }
});
test('timeout and unavailable are distinct',async()=>{
 for(const timeout of [true,false]) {
 const base=await start(createGraphqlApi({...config,timeoutMs:20,fetchImpl:(_,o)=>timeout?new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>reject(o.signal.reason))):Promise.reject(new Error('private connection info'))}));
 const r=await query('{tickets{total}}',undefined,base);assert.equal(r.body.errors[0].extensions.code,timeout?'UPSTREAM_TIMEOUT':'UPSTREAM_UNAVAILABLE');assert.ok(!JSON.stringify(r.body).includes('private'));
 }
});
test('batch >100 IDs is chunked, unordered results map by ID, missing/inactive remain valid',async()=>{
 const seed=fixtures();const tickets=Array.from({length:100},(_,i)=>({...seed.tickets[0],id:`20000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,requesterId:employeeId(i+1),assigneeId:employeeId(i+101)}));
 const sizes=[];
 const base=await start(createGraphqlApi({...config,fetchImpl:async u=>{
   const address=new URL(u);if(address.pathname==='/tickets') return Response.json({items:tickets,total:100,limit:100,offset:0,evaluatedAt:new Date().toISOString()});
   const ids=address.searchParams.get('ids').split(',');sizes.push(ids.length);
   return Response.json({items:ids.filter(id=>id!==employeeId(200)).reverse().map(id=>({...seed.employees[0],id,active:false})),missingIds:ids.filter(id=>id===employeeId(200))});
 }}));
 const q='{tickets(pagination:{limit:100}){items{requesterId requester{id active} assigneeId assignee{id}}}}';
 const r=await query(q,undefined,base);assert.equal(r.body.errors,undefined);assert.deepEqual(sizes,[100,100]);
 assert.equal(r.body.data.tickets.items[99].assignee,null);for(const t of r.body.data.tickets.items) {assert.equal(t.requester.id,t.requesterId);assert.equal(t.requester.active,false);}
 await query(q,undefined,base);assert.equal(sizes.length,4);
});
