import {writeFileSync,existsSync,readFileSync,appendFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
const file=new URL('./.env',import.meta.url);
if(!existsSync(file)) {writeFileSync(file,`EMPLOYEE_API_KEY=${randomBytes(32).toString('hex')}\nTICKET_API_KEY=${randomBytes(32).toString('hex')}\n`,{flag:'wx'});console.log('Created local service credentials in .env (not displayed).');}
else console.log('Existing .env retained.');
if(!parseEnv(readFileSync(file,'utf8')).GRAPHQL_API_KEY) {
 appendFileSync(file,`\nGRAPHQL_API_KEY=${randomBytes(32).toString('hex')}\n`);
 console.log('Created GraphQL credential (not displayed).');
}
