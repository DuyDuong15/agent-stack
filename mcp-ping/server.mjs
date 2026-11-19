import {httpTrace,tracedFetch,instrumentMcp,log,markError,flushTelemetry} from '../telemetry/index.mjs';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {mkdirSync} from 'node:fs';
import {createMatrixBridge} from './matrix-bridge.mjs';
import {createDraftService} from './ticket-drafts.mjs';
import {registerWriteTools} from './write-tools.mjs';
import {registerTicketTools} from './ticket-tools.mjs';
import {verifyPersonReference,verifyTicketScope} from './matrix-person-guard.mjs';
import {settings,localPath} from '../configuration.mjs';
import {dirname} from 'node:path';
const {GRAPHQL_API_KEY}=settings;
mkdirSync(dirname(localPath(settings.DRAFT_DB)),{recursive:true});
const drafts=createDraftService({dbPath:localPath(settings.DRAFT_DB),bridge:createMatrixBridge(),graphql:async(query,variables)=>{
 const r=await tracedFetch(fetch,settings.GRAPHQL_URL,{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':GRAPHQL_API_KEY},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(Number(settings.GRAPHQL_TIMEOUT_MS))});
 if(r.status>=500) throw new Error('GraphQL unavailable');const body=await r.json();if(!body||(!Object.hasOwn(body,'data')&&!Array.isArray(body.errors))) throw new Error('Invalid GraphQL response');return body;
}});

const app = express();
app.use(httpTrace((req,res,next)=>next()));
app.use(express.json());
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'onboarding-ticket' }));
app.post('/mcp', async (req, res) => {
    const server = instrumentMcp(new McpServer({ name: 'onboarding-ticket', version: '1.1.0' }));
    registerTicketTools(server,{apiKey:GRAPHQL_API_KEY,verifyPersonReference,verifyTicketScope});
    registerWriteTools(server,drafts);
    server.registerTool('ping', {
        description: 'Kiểm tra kết nối MCP thật. Gọi khi người dùng yêu cầu ping hoặc kiểm tra MCP. name là tên người dùng. Trả lại cả verificationCode để đối chiếu log server.',
        inputSchema: { name: z.string().trim().min(1).max(100) },
    }, async ({ name }) => {
        const result = { status:'ok', message: `pong, xin chào ${name}`, verificationCode: randomUUID() };
        log({event:'tool_call',tool:'ping',verificationCode:result.verificationCode});
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        markError(error.code??error.name);log({event:'request_error',code:error.code??error.name},'ERROR');
        if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    }
});
app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());
const listener=app.listen(Number(settings.MCP_PORT), settings.MCP_HOST, () => log({event:'ready',service:'mcp',port:Number(settings.MCP_PORT)}));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>listener.close(async()=>{drafts.close();await flushTelemetry();process.exit(0);}));
