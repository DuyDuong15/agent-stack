import {existsSync,readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export const root=fileURLToPath(new URL('.',import.meta.url));
const envFile=name=>{const path=resolve(root,name);return existsSync(path)?parseEnv(readFileSync(path,'utf8')):{};};
// Never load the root .env: that file contains the LLM key, which the backend does not need.
export const settings={...envFile('backend.env.example'),...envFile('ticket-service/.env'),...envFile('.env.backend'),...process.env};
export const localPath=value=>resolve(root,value);
