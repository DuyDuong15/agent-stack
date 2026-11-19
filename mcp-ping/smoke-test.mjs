import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({ name: 'onboarding-smoke-test', version: '1.0.0' });
try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:8005/mcp')));
    const tools = await client.listTools();
    assert(tools.tools.some(t => t.name === 'ping'));
    const result = await client.callTool({ name: 'ping', arguments: { name: 'Duong' } });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.message, 'pong, xin chào Duong');
    assert.match(data.verificationCode, /^[0-9a-f-]{36}$/);
    console.log('PASS: MCP initialize, tools/list and tools/call', data);
} finally { await client.close(); }
