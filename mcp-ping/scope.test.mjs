import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allowsUnscopedTickets} from './matrix-person-guard.mjs';
import {registerTicketTools} from './ticket-tools.mjs';
test('omitted employee filter cannot silently broaden a personal question',async()=>{
 const h={};let calls=0;
 registerTicketTools({registerTool:(n,_,fn)=>h[n]=fn},{apiKey:'test',verifyTicketScope:async f=>Boolean(f.assignee),fetchImpl:async()=>{calls++;return Response.json({data:{employees:{total:2,items:[{code:'EMP-001'},{code:'EMP-002'}]}}});},logger:()=>{}});
 for(const name of ['ticket_statistics','search_tickets']) {
 const result=JSON.parse((await h[name]({filter:{}})).content[0].text);assert.equal(result.code,'TICKET_SCOPE_REQUIRED');
 }
 assert.equal(calls,0);
 const result=JSON.parse((await h.ticket_statistics({filter:{assignee:'Nam'}})).content[0].text);assert.equal(result.code,'EMPLOYEE_AMBIGUOUS');assert.equal(calls,1);
});
test('global statistics requires an explicit global scope',()=>{
 assert.equal(allowsUnscopedTickets('Nam đang được giao bao nhiêu ticket @openclaw:localhost'),false);
 assert.equal(allowsUnscopedTickets('Thống kê TOÀN BỘ hệ thống ticket'),true);
 assert.equal(allowsUnscopedTickets('EMP-001 có bao nhiêu ticket'),false);
});
