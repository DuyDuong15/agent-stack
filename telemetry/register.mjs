import {NodeSDK} from '@opentelemetry/sdk-node';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-proto';
import {resourceFromAttributes} from '@opentelemetry/resources';
if(process.env.OTEL_TRACES_EXPORTER==='otlp') {
 const sdk=new NodeSDK({resource:resourceFromAttributes({'service.name':process.env.OTEL_SERVICE_NAME??'onboarding','service.version':'bai4','deployment.environment.name':'local'}),traceExporter:new OTLPTraceExporter(),instrumentations:[]});
 sdk.start();globalThis[Symbol.for('onboarding.telemetry')]=sdk;
}
