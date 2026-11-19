import {log,flushTelemetry} from '../telemetry/index.mjs';
import {createGraphqlApi} from './graphql-api.mjs';
import {settings} from '../configuration.mjs';
const server=createGraphqlApi({apiKey:settings.GRAPHQL_API_KEY,employeeKey:settings.EMPLOYEE_API_KEY,ticketKey:settings.TICKET_API_KEY});
server.listen(Number(settings.GRAPHQL_PORT),settings.GRAPHQL_HOST,()=>log({event:'ready',service:'graphql',port:Number(settings.GRAPHQL_PORT)}));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(async()=>{await flushTelemetry();process.exit(0);}));
