import {context,trace,propagation,SpanKind,SpanStatusCode,isSpanContextValid,ROOT_CONTEXT} from '@opentelemetry/api';
const tracer=trace.getTracer('agent-onboarding','1.0.0');
export function traceIds() {
 const sc=trace.getSpan(context.active())?.spanContext();
 return {otelTraceID:sc&&isSpanContextValid(sc)?sc.traceId:null,otelSpanID:sc&&isSpanContextValid(sc)?sc.spanId:null};
}
export function log(entry,levelname='INFO') {
 console.log(JSON.stringify({asctime:new Date().toISOString(),levelname,...entry,...(entry.event==='rest_response'?{upstreamService:entry.service}:{}),service:process.env.OTEL_SERVICE_NAME??entry.service??'unconfigured',...traceIds()}));
}
export function markError(code='OPERATION_FAILED',span=trace.getSpan(context.active())) {
 span?.setStatus({code:SpanStatusCode.ERROR,message:code});span?.setAttribute('error.type',code);
}
export function inSpan(name,attributes,fn,kind=SpanKind.INTERNAL) {
 return tracer.startActiveSpan(name,{attributes,kind},span=>{
  const end=value=>{
   if(value?.errors?.length||value?.isError) markError(value.errors?.[0]?.extensions?.code??'TOOL_OR_GRAPHQL_ERROR',span);
   span.end();return value;
  };
  const fail=error=>{const code=error.code??error.cause?.code??error.name??'ERROR';markError(String(code),span);span.addEvent('exception',{'exception.type':String(code),'exception.message':'Operation failed; inspect correlated application log'});span.end();throw error;};
  try {const value=fn(span);return value&&typeof value.then==='function'?value.then(end,fail):end(value);}catch(error){return fail(error);}
 });
}
const safePath=url=>new URL(url,'http://local').pathname.replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi,':id');
export function httpTrace(handler) {
 return (req,res,...args)=>{
  if(req.url==='/health')return handler(req,res,...args);
  const parent=propagation.extract(ROOT_CONTEXT,req.headers);
  const remote=trace.getSpanContext(parent);
  const route=safePath(req.url);
  return context.with(parent,()=>tracer.startActiveSpan(`${req.method} ${route}`,{kind:SpanKind.SERVER,attributes:{'http.request.method':req.method,'http.route':route,'w3c.traceparent.present':typeof req.headers.traceparent==='string','w3c.traceparent.valid':Boolean(remote&&isSpanContextValid(remote))}},span=>{
   const active=context.active();const ids=traceIds();if(ids.otelTraceID)res.setHeader('X-Trace-Id',ids.otelTraceID);
   let ended=false;
   const finish=()=>{if(ended)return;ended=true;context.with(active,()=>{
    span.setAttribute('http.response.status_code',res.statusCode);
    if(res.statusCode>=400)markError('HTTP_'+res.statusCode,span);
    if(!res.writableFinished)markError('CLIENT_DISCONNECTED',span);
    log({event:'http_request',method:req.method,route,status:res.statusCode});span.end();
   });};
   res.once('finish',finish);res.once('close',finish);
   try {const result=handler(req,res,...args);if(result?.catch) return result.catch(error=>{markError(error.code??error.name,span);if(!res.headersSent)res.writeHead(500);res.end();});return result;}
   catch(error){markError(error.code??error.name,span);if(!res.headersSent)res.writeHead(500);res.end();}
  }));
 };
}
// JSON service calls only. Buffering the response keeps the client span open through body delivery.
export function tracedFetch(fetchImpl,url,options={}) {
 const target=new URL(url);const method=options.method??'GET';
 return inSpan(`${method} ${safePath(target)}`,{'http.request.method':method,'server.address':target.hostname,'server.port':Number(target.port||80),'url.path':safePath(target)},async span=>{
  const headers=new Headers(options.headers);const carrier={};propagation.inject(context.active(),carrier);
  for(const [key,value] of Object.entries(carrier))headers.set(key,value);
  const response=await fetchImpl(url,{...options,headers});
  span.setAttribute('http.response.status_code',response.status);
  if(response.status>=400)markError('HTTP_'+response.status,span);
  const data=await response.arrayBuffer();
  return new Response(data,{status:response.status,statusText:response.statusText,headers:response.headers});
 },SpanKind.CLIENT);
}
export function tracedDatabase(db,namespace) {
 return new Proxy(db,{get(target,key){
  if(key==='prepare')return sql=>{
   const statement=target.prepare(sql);const operation=sql.trim().split(/\s+/)[0].toUpperCase();
   return new Proxy(statement,{get(s,k){const value=s[k];if(['get','all','run'].includes(k))return (...args)=>inSpan(`sqlite.${operation} ${namespace}`,{'db.system.name':'sqlite','db.namespace':namespace,'db.operation.name':operation},()=>value.apply(s,args),SpanKind.CLIENT);return typeof value==='function'?value.bind(s):value;}});
  };
  const value=target[key];return typeof value==='function'?value.bind(target):value;
 }});
}
export function instrumentMcp(server) {
 const register=server.registerTool.bind(server);
 server.registerTool=(name,config,handler)=>register(name,config,(...args)=>inSpan('tools/call '+name,{'rpc.system':'mcp','rpc.method':'tools/call','mcp.tool.name':name},async()=>{
  const result=await handler(...args);log({event:'mcp_tool_complete',tool:name,isError:Boolean(result.isError)});return result;
 }));return server;
}
export async function flushTelemetry(){await globalThis[Symbol.for('onboarding.telemetry')]?.shutdown();}
