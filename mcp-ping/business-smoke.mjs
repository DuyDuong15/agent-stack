import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client=new Client({name:'ticket-smoke',version:'1.0.0'});
try {
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8005/mcp')));
 const tools=await client.listTools();for(const name of ['ping','search_employees','search_tickets','get_ticket','ticket_statistics']) assert.ok(tools.tools.some(t=>t.name===name));
 const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text).data;};
 assert.equal((await call('search_employees',{filter:{q:'Nam'}})).employees.total,2);
 const page=(await call('search_tickets',{filter:{code:'IT-000001'}})).tickets;
 assert.equal(page.total,1);assert.ok(page.items[0].requester.name);
 assert.equal((await call('get_ticket',{id:page.items[0].id})).ticket.code,'IT-000001');
 assert.equal((await call('ticket_statistics',{filter:{code:'IT-000001'}})).ticketStatistics.total,1);
 assert.equal((await call('search_tickets',{filter:{code:'IT-999999'}})).tickets.total,0);
 console.log('PASS: 5 tools listed; employee ambiguity, ticket join/detail, statistics and empty result through MCP -> GraphQL -> REST');
} finally {await client.close();}
