import {createMatrixBridge} from './matrix-bridge.mjs';
const bridge=createMatrixBridge();
const fold=s=>s.normalize('NFD').replace(/\p{M}/gu,'').replace(/[đĐ]/g,'d').toLowerCase();
export function allowsUnscopedTickets(text) {
 const normalized=fold(text).replace(/@?openclaw(?::localhost)?/g,'').trim();
 return /\b(toan (bo|he thong)|tat ca ticket|tong ticket (trong|cua) he thong|khong (dung )?bo loc|all tickets|system-wide)\b/.test(normalized);
}
export async function verifyTicketScope(filter) {
 if(filter.requester||filter.assignee||filter.code) return true;
 const {latest}=await bridge.context();
 return Boolean(latest&&typeof latest.content?.body==='string'&&Date.now()-latest.origin_server_ts<=300000&&allowsUnscopedTickets(latest.content.body));
}
export async function verifyPersonReference(reference,candidate) {
 const {latest}=await bridge.context();
 if(!latest||typeof latest.content.body!=='string'||Date.now()-latest.origin_server_ts>300000) return false;
 const text=fold(latest.content.body).replace(/[^a-z0-9-]+/g,' ');
 const contains=v=>(' '+text+' ').includes(' '+fold(v).replace(/[^a-z0-9-]+/g,' ').trim()+' ');
 return contains(reference)||Boolean(candidate&&(contains(candidate.code)||contains(candidate.name)));
}
