import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerTicketTools} from './ticket-tools.mjs';
function tool(fetchImpl) {const handlers={};registerTicketTools({registerTool:(n,_,h)=>handlers[n]=h},{apiKey:'test',fetchImpl,logger:()=>{}});return handlers.ticket_statistics;}
test('MCP preserves partial data and marks GraphQL errors',async()=>{
 const run=tool(async()=>Response.json({data:{ticketStatistics:null},errors:[{message:'private info',path:['ticketStatistics'],extensions:{code:'UPSTREAM_TIMEOUT',requestId:'r'}}]}));
 const r=await run({});assert.equal(r.isError,true);const b=JSON.parse(r.content[0].text);assert.equal(b.data.ticketStatistics,null);assert.equal(b.errors[0].code,'UPSTREAM_TIMEOUT');assert.ok(!r.content[0].text.includes('private info'));
});
test('MCP marks HTTP, malformed JSON and connection failures as errors',async()=>{
 for(const fetcher of [async()=>new Response('bad',{status:502}),async()=>Response.json({}),async()=>{throw new Error('secret');}]) {
 const r=await tool(fetcher)({});assert.equal(r.isError,true);assert.ok(!r.content[0].text.includes('secret'));
 }
});
