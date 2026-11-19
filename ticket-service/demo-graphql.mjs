import {readFileSync} from 'node:fs';
const response=await fetch('http://127.0.0.1:8013/graphql',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':process.env.GRAPHQL_API_KEY},body:JSON.stringify({query:readFileSync(new URL('./design/examples.graphql',import.meta.url),'utf8'),operationName:'TicketDashboard',variables:{page:{limit:3}}})});
const result=await response.json();console.log(JSON.stringify(result,null,2));
if(!response.ok||result.errors) process.exitCode=1;
