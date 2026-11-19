import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {NodeSDK} from '@opentelemetry/sdk-node';
import {InMemorySpanExporter,SimpleSpanProcessor} from '@opentelemetry/sdk-trace';
import {createApi} from '../ticket-service/api.mjs';
import {httpTrace,inSpan,tracedFetch,traceIds} from './index.mjs';
const exporter=new InMemorySpanExporter();
const sdk=new NodeSDK({autoDetectResources:false,spanProcessors:[new SimpleSpanProcessor({exporter})],logRecordProcessors:[],metricReaders:[]});sdk.start();
after(()=>sdk.shutdown());
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;}
const close=s=>new Promise(r=>{s.closeAllConnections();s.close(r);});
const settle=()=>new Promise(r=>setTimeout(r,20));
test('parallel inbound W3C contexts survive async HTTP and SQLite without leaking query/credentials',async()=>{
 exporter.reset();
 const employee=createApi({kind:'employee',apiKey:'private-api-key'});const employeeUrl=await listen(employee);
 const upstream=createServer(httpTrace(async(req,res)=>{
  const result=await inSpan('tools/call lookup',{},async()=>{
   await new Promise(r=>setTimeout(r,req.headers['x-delay']==='yes'?15:1));
   return (await tracedFetch(fetch,employeeUrl+'/employees?q=PRIVATE_PERSON',{headers:{'X-API-Key':'private-api-key'}})).json();
  });res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:traceIds().otelTraceID,total:result.total}));
 }));const url=await listen(upstream);
 try {
 const ids=['11111111111111111111111111111111','22222222222222222222222222222222'];
 const results=await Promise.all(ids.map(async(id,i)=>(await fetch(url,{headers:{traceparent:`00-${id}-1234567890abcdef-01`,'x-delay':i?'no':'yes'}})).json()));
 assert.deepEqual(results.map(r=>r.id),ids);await settle();
 const spans=exporter.getFinishedSpans();
 for(const id of ids){const group=spans.filter(s=>s.spanContext().traceId===id);assert.ok(group.some(s=>s.name.startsWith('sqlite.SELECT')));const client=group.find(s=>s.kind===2&&s.attributes['http.request.method']);const server=group.find(s=>s.kind===1&&s.attributes['http.route']==='/employees');assert.equal(server.parentSpanContext.spanId,client.spanContext().spanId);assert.ok(group.every(s=>s.spanContext().traceId===id));}
 assert.ok(!JSON.stringify(spans.map(s=>s.attributes)).includes('PRIVATE_PERSON'));assert.ok(!JSON.stringify(spans.map(s=>s.attributes)).includes('private-api-key'));
 }finally{await close(upstream);await close(employee);}
});
test('invalid traceparent starts a fresh valid root; handled GraphQL errors mark span ERROR',async()=>{
 exporter.reset();const server=createServer(httpTrace(async(req,res)=>{await inSpan('graphql.execute',{},async()=>({errors:[{extensions:{code:'BAD_USER_INPUT'}}]}));res.end();}));const url=await listen(server);
 try{const response=await fetch(url,{headers:{traceparent:'not-a-trace'}});await response.text();assert.match(response.headers.get('x-trace-id'),/^[0-9a-f]{32}$/);await settle();const spans=exporter.getFinishedSpans();assert.equal(spans.find(s=>s.kind===1).attributes['w3c.traceparent.valid'],false);assert.equal(spans.find(s=>s.name==='graphql.execute').status.code,2);}finally{await close(server);}
});
test('HTTP timeout is recorded on client span and still rejects to application',async()=>{
 exporter.reset();const server=createServer((_req,res)=>{setTimeout(()=>res.end('{}'),80);});const url=await listen(server);
 try{await assert.rejects(inSpan('timeout-case',{},()=>tracedFetch(fetch,url,{signal:AbortSignal.timeout(10)})));await settle();assert.equal(exporter.getFinishedSpans().find(s=>s.kind===2).status.code,2);}finally{await close(server);}
});
