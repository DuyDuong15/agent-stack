import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createGraphqlApi} from '../ticket-service/graphql-api.mjs';
import {registerTicketTools} from './ticket-tools.mjs';
import {createApi} from '../ticket-service/api.mjs';
const listen=async s=>{await new Promise(r=>s.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${s.address().port}`;};
const close=s=>new Promise(r=>{s.closeAllConnections();s.close(r);});
for(const mode of ['down','timeout','partial']) test(`real HTTP MCP handler -> GraphQL -> REST failure: ${mode}`,async()=>{
 const servers=[];
 try {
   const unavailable=createServer();const downUrl=await listen(unavailable);await close(unavailable);
   const ticket=mode==='timeout'?createServer(()=>{}):createApi({kind:'ticket',apiKey:'t'});servers.push(ticket);
   const ticketUrl=mode==='down'?downUrl:await listen(ticket);
   const graph=createGraphqlApi({apiKey:'g',employeeKey:'e',ticketKey:'t',ticketUrl,employeeUrl:downUrl,timeoutMs:100,logger:()=>{}});servers.push(graph);const url=await listen(graph);
   const handlers={};registerTicketTools({registerTool:(n,_,h)=>handlers[n]=h},{apiKey:'g',url:url+'/graphql',logger:()=>{}});
   const result=await handlers[mode==='partial'?'search_tickets':'ticket_statistics'](mode==='partial'?{pagination:{limit:1}}:{});
   const body=JSON.parse(result.content[0].text);
   assert.equal(result.isError,true);
   assert.equal(body.errors[0].code,mode==='timeout'?'UPSTREAM_TIMEOUT':'UPSTREAM_UNAVAILABLE');
   if(mode==='partial') {assert.equal(body.data.tickets.total,30);assert.ok(body.data.tickets.items[0].code);assert.equal(body.data.tickets.items[0].requester,null);}
   else assert.equal(body.data.ticketStatistics,null);
 } finally {for(const s of servers.reverse()) if(s.listening) await close(s);}
});
