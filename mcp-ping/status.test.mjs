import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerTicketTools} from './ticket-tools.mjs';
import {registerWriteTools} from './write-tools.mjs';
function tools(fetchImpl){const h={};registerTicketTools({registerTool:(n,_,fn)=>h[n]=fn},{apiKey:'test',fetchImpl,logger:()=>{}});return h;}
const body=r=>JSON.parse(r.content[0].text);
test('MCP distinguishes empty search, existing employee with zero tickets, and HTTP400 business rejection',async()=>{
 const missing=tools(async()=>Response.json({data:{employees:{total:0,items:[]}}}));
 assert.equal(body(await missing.search_employees({})).status,'not_found');
 let calls=0;const zero=tools(async()=>Response.json(++calls===1?{data:{employees:{total:1,items:[{id:'10000000-0000-4000-8000-000000000003'}]}}}:{data:{tickets:{total:0,items:[]}}}));
 assert.equal(body(await zero.search_tickets({filter:{assignee:'EMP-003'}})).status,'ok');
 const bad=tools(async()=>Response.json({errors:[{message:'Bad filter',extensions:{code:'BAD_USER_INPUT'}}]},{status:400}));
 assert.equal(body(await bad.ticket_statistics({})).status,'rejected');
 const down=tools(async()=>new Response('down',{status:503}));
 assert.equal(body(await down.ticket_statistics({})).status,'unavailable');
});
test('write tools map duplicate to rejected and uncertain outcome to unavailable',async()=>{
 for(const [code,status] of [['TICKET_DUPLICATE','rejected'],['OUTCOME_UNKNOWN','unavailable']]) {
 const h={};registerWriteTools({registerTool:(n,_,fn)=>h[n]=fn},{confirm:async()=>{throw Object.assign(new Error('test'),{code});}});
 assert.equal(body(await h.confirm_ticket({draftId:'test'})).status,status);
 }
});
