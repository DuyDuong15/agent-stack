import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {root,settings} from '../../configuration.mjs';
const folder=new URL('../../docs/bai4/',import.meta.url);mkdirSync(folder,{recursive:true});
const jaeger=process.env.JAEGER_URL??'http://127.0.0.1:16686';
const endpoint=process.env.MCP_URL??`http://127.0.0.1:${settings.MCP_PORT}/mcp`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function call(name,args,headers={}) {
 const start=performance.now();const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Connection:'close',...headers},body:JSON.stringify({jsonrpc:'2.0',id:Date.now(),method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(30000)});
 const body=await r.json();assert.ok(body.result,JSON.stringify(body));const result=JSON.parse(body.result.content[0].text);
 return {traceId:r.headers.get('x-trace-id'),durationMs:performance.now()-start,result,isError:body.result.isError??false};
}
export async function readTrace(id,services=[]) {
 for(let i=0;i<40;i++){
  const r=await fetch(`${jaeger}/api/traces/${id}`,{signal:AbortSignal.timeout(5000)});const b=await r.json();const t=b.data?.[0];
  if(t&&services.every(n=>Object.values(t.processes).some(p=>p.serviceName===n)))return t;
  await sleep(500);
 }throw new Error('Trace incomplete or not exported: '+id);
}
const services=['mcp','graphql','ticket-api','employee-api'];
const samples=[];
for(let i=0;i<5;i++){
 const result=await call('search_tickets',{filter:{code:'IT-000001'}});assert.equal(result.result.status,'ok');assert.equal(result.result.data.tickets.total,1);
 const t=await readTrace(result.traceId,services);assert.ok(t.spans.some(s=>s.operationName.startsWith('sqlite.SELECT')));
 const ids=new Set(t.spans.map(s=>s.traceID));assert.equal(ids.size,1);const spanIds=new Set(t.spans.map(s=>s.spanID));
 assert.equal(t.spans.filter(s=>!s.references?.length).length,1);for(const s of t.spans)for(const ref of s.references??[])assert.ok(spanIds.has(ref.spanID));
 writeFileSync(new URL(`success-${i+1}.json`,folder),JSON.stringify(t,null,2));
 samples.push({traceId:result.traceId,requestMs:result.durationMs});console.log(JSON.stringify({case:'success',run:i+1,traceId:result.traceId,spanCount:t.spans.length}));
}
const incoming=randomBytes(16).toString('hex');const propagated=await call('search_tickets',{filter:{code:'IT-000001'}},{traceparent:`00-${incoming}-1234567890abcdef-01`});assert.equal(propagated.traceId,incoming);await readTrace(incoming,services);
const rejected=await call('search_tickets',{filter:{code:'IT-000001',createdFrom:'2030-01-01T00:00:00Z',createdTo:'2020-01-01T00:00:00Z'}});assert.equal(rejected.result.status,'rejected');
const rejectedTrace=await readTrace(rejected.traceId,['mcp','graphql','ticket-api']);writeFileSync(new URL('business-error.json',folder),JSON.stringify(rejectedTrace,null,2));
const compose=['compose','--env-file','ticket-service/.env','-f','compose.yaml','-f','compose.otel.yaml'];
let failure;
try {
 execFileSync('docker',[...compose,'stop','ticket'],{cwd:root,stdio:'pipe'});
 failure=await call('search_tickets',{filter:{code:'IT-000001'}});assert.equal(failure.result.status,'unavailable');
 const t=await readTrace(failure.traceId,['mcp','graphql']);assert.ok(t.spans.some(s=>s.tags?.some(t=>t.key==='error'&&t.value===true)));writeFileSync(new URL('upstream-error.json',folder),JSON.stringify(t,null,2));
}finally{execFileSync('docker',[...compose,'up','-d','--no-deps','--wait','ticket'],{cwd:root,stdio:'pipe'});}
const recovered=await call('search_tickets',{filter:{code:'IT-000001'}});assert.equal(recovered.result.status,'ok');
const logs=execFileSync('docker',[...compose,'logs','--no-color','--no-log-prefix','mcp','graphql','employee','ticket'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024}).split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
const correlated=logs.filter(l=>l.otelTraceID===samples[0].traceId);assert.ok(correlated.length>=4);assert.ok(correlated.every(l=>l.otelSpanID));
writeFileSync(new URL('correlated-logs.jsonl',folder),correlated.map(l=>JSON.stringify(l)).join('\n')+'\n');
writeFileSync(new URL('validation.json',folder),JSON.stringify({checkedAt:new Date().toISOString(),samples,inboundPropagation:{passed:true,traceId:incoming},businessErrorTraceId:rejected.traceId,upstreamErrorTraceId:failure.traceId,recovered:true,measurement:'Direct MCP calls, same search_tickets(code=IT-000001); excludes LLM and Matrix'},null,2));
console.log('PASS: five connected traces, inbound propagation, business rejection, stopped upstream and recovery; correlated logs saved.');

