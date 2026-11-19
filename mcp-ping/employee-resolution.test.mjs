import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerTicketTools} from './ticket-tools.mjs';
function setup(total) {const handlers={},calls=[];registerTicketTools({registerTool:(n,_,h)=>handlers[n]=h},{apiKey:'test',logger:()=>{},fetchImpl:async(_,opts)=>{const body=JSON.parse(opts.body);calls.push(body);return Response.json(body.query.includes('employees(')?{data:{employees:{total,items:Array.from({length:total},(_,i)=>({id:`id${i}`,code:`EMP-00${i+1}`,name:'Nam',department:'IT'}))}}}:{data:{ticketStatistics:{total:12}}});}});return {handlers,calls};}
test('ambiguous name blocks BOTH ticket tools before ticket query',async()=>{for(const name of ['ticket_statistics','search_tickets']) {const {handlers,calls}=setup(2);const r=await handlers[name]({filter:{assignee:'Nam'}});assert.equal(r.isError,true);assert.equal(JSON.parse(r.content[0].text).code,'EMPLOYEE_AMBIGUOUS');assert.equal(calls.length,1);}});
test('explicit unique selection resolves to ID; missing name stops; raw ID blocked',async()=>{
 const {handlers,calls}=setup(1);assert.equal((await handlers.ticket_statistics({filter:{assignee:'EMP-001'}})).isError,false);assert.equal(calls[1].variables.filter.assigneeId,'id0');assert.equal(calls[1].variables.filter.assignee,undefined);
 const missing=setup(0);assert.equal(JSON.parse((await missing.handlers.ticket_statistics({filter:{assignee:'Nobody'}})).content[0].text).code,'EMPLOYEE_NOT_FOUND');assert.equal(missing.calls.length,1);
 const raw=setup(1);assert.equal((await raw.handlers.ticket_statistics({filter:{assigneeId:'id0'}})).isError,true);assert.equal(raw.calls.length,0);
});
test('unconfirmed expanded name cannot query tickets',async()=>{
 const handlers={};let requests=0;
 registerTicketTools({registerTool:(n,_,h)=>handlers[n]=h},{apiKey:'test',verifyPersonReference:async()=>false,logger:()=>{},fetchImpl:async()=>{requests++;return Response.json({data:{employees:{total:1,items:[{id:'id0',code:'EMP-001',name:'Nguyễn Văn Nam'}]}}});}});
 const r=await handlers.ticket_statistics({filter:{assignee:'Nguyễn Văn Nam'}});
 assert.equal(JSON.parse(r.content[0].text).code,'EMPLOYEE_SELECTION_UNCONFIRMED');assert.equal(requests,1);
});
