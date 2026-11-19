import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync} from 'node:fs';
const folder=new URL(`./backups/${Date.now()}/`,import.meta.url);mkdirSync(folder,{recursive:true});
for(const [source,name] of [['ticket-service/data/employee.sqlite','employee'],['ticket-service/data/ticket.sqlite','ticket'],['mcp-ping/data/drafts.sqlite','drafts']]) {
 if(!existsSync(new URL(source,import.meta.url))) throw new Error(`Missing database: ${source}. Initialize the services once before Compose.`);
 const db=new DatabaseSync(new URL(source,import.meta.url));
 db.prepare('VACUUM INTO ?').run(decodeURIComponent(new URL(name+'.sqlite',folder).pathname).replace(/^\/(\w:)/,'$1'));db.close();
}
console.log('Backed up employee, ticket and drafts databases.');
