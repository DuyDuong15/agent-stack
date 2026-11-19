import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from './api.mjs';
import {fixtures,employeeId,ticketId} from './fixtures.mjs';
const now=new Date('2026-11-17T03:00:00.000Z');
const seed=fixtures(now);
seed.tickets[0].dueAt=now.toISOString();
seed.tickets[1].dueAt=new Date(now-1).toISOString();
const servers={};
for(const kind of ['employee','ticket']) {const server=createApi({kind,apiKey:'test-only',clock:()=>now,seed});await new Promise(r=>server.listen(0,'127.0.0.1',r));servers[kind]=server;}
after(async()=>{await Promise.all(Object.values(servers).map(s=>new Promise(r=>s.close(r))));});
async function call(kind,path,key='test-only',method='GET') {const response=await fetch(`http://127.0.0.1:${servers[kind].address().port}${path}`,{headers:{'X-API-Key':key},method});return {status:response.status,body:await response.json()};}
test('authentication and error envelope',async()=>{for(const kind of ['employee','ticket']) {const r=await call(kind,kind==='employee'?'/employees':'/tickets','wrong');assert.equal(r.status,401);assert.equal(r.body.error.code,'UNAUTHORIZED');assert.ok(r.body.requestId);assert.deepEqual(Object.keys(r.body).sort(),['error','requestId']);}});
test('employee search, accents, department and active',async()=>{
 assert.equal((await call('employee','/employees?q=nam')).body.total,2);
 assert.equal((await call('employee','/employees?q=dang')).body.items[0].name,'Đặng Minh Anh');
 assert.equal((await call('employee','/employees?q=emp-001')).body.total,1);
 assert.equal((await call('employee','/employees?department=nhan%20su')).body.total,3);
 assert.equal((await call('employee','/employees?active=false')).body.total,1);
 const r=await call('employee','/employees?limit=2&offset=2');assert.equal(r.body.total,8);assert.equal(r.body.items[0].code,'EMP-003');
});
test('batch sorted, includes inactive, reports missing',async()=>{
 const r=await call('employee',`/employees?ids=${employeeId(8)},${employeeId(1)},${employeeId(99)}`);
 assert.equal(r.status,200);assert.deepEqual(r.body.items.map(e=>e.code),['EMP-001','EMP-008']);assert.equal(r.body.items[1].active,false);assert.deepEqual(r.body.missingIds,[employeeId(99)]);
});
test('invalid employee queries rejected',async()=>{for(const query of ['q=%20','active=1','limit=0','offset=-1','limit=1.5','limit=101','q=nam&q=ha','unknown=x','ids=','ids=bad',`ids=${employeeId(1)},${employeeId(1)}`,`ids=${employeeId(1)}&limit=20`]) assert.equal((await call('employee','/employees?'+query)).status,400,query);});
test('detail UUID and missing resource semantics',async()=>{for(const [kind,base,id] of [['employee','employees',employeeId],['ticket','tickets',ticketId]]) {assert.equal((await call(kind,`/${base}/${id(1)}`)).status,200);assert.equal((await call(kind,`/${base}/bad`)).status,400);const r=await call(kind,`/${base}/${id(99)}`);assert.equal(r.status,404);assert.equal(r.body.error.code,kind.toUpperCase()+'_NOT_FOUND');}});
test('ticket page and statistics operate on entire filtered set',async()=>{
 const page=(await call('ticket','/tickets?limit=1')).body;const stats=(await call('ticket','/ticket-statistics')).body;
 assert.equal(page.items.length,1);assert.equal(page.total,30);assert.equal(page.items[0].code,'IT-000030');assert.equal(stats.total,30);assert.equal(stats.openCount,16);assert.equal(Object.values(stats.byStatus).reduce((a,b)=>a+b),30);assert.equal(Object.values(stats.byPriority).reduce((a,b)=>a+b),30);
 const filtered=(await call('ticket','/tickets?status=OPEN&priority=HIGH&limit=100')).body;
 const counts=(await call('ticket','/ticket-statistics?status=OPEN&priority=HIGH')).body;assert.equal(counts.total,filtered.total);assert.equal(counts.byStatus.CLOSED,0);assert.equal(counts.byPriority.LOW,0);
});
test('overdue strict boundary and complement',async()=>{
 const a=(await call('ticket','/tickets?overdue=true&limit=100')).body;const b=(await call('ticket','/tickets?overdue=false&limit=100')).body;
 assert.equal(a.total+b.total,30);assert.ok(!a.items.some(t=>t.id===ticketId(1)));assert.ok(a.items.some(t=>t.id===ticketId(2)));assert.ok(b.items.some(t=>t.id===ticketId(1)));assert.equal(a.evaluatedAt,now.toISOString());assert.equal((await call('ticket','/ticket-statistics')).body.overdueCount,a.total);
});
test('date bounds timezone normalization and invalid dates',async()=>{
 const from=seed.tickets[0].createdAt,to=seed.tickets[1].createdAt;
 const r=await call('ticket',`/tickets?createdFrom=${from}&createdTo=${to}`);assert.equal(r.body.total,1);
 const offset=encodeURIComponent(from.replace('03:00:00.000Z','10:00:00+07:00'));assert.equal((await call('ticket',`/tickets?createdFrom=${offset}&createdTo=${to}`)).body.total,1);
 for(const q of ['createdFrom=2026-02-30T00:00:00Z','createdFrom=2026-01-01','createdFrom=2026-01-01T25:00:00Z',`createdFrom=${from}&createdTo=${from}`]) assert.equal((await call('ticket','/tickets?'+q)).status,400,q);
});
test('ticket filters and empty results',async()=>{
 assert.equal((await call('ticket','/tickets?code=IT-000001')).body.total,1);
 assert.equal((await call('ticket','/tickets?q=may%20tinh')).body.total,10);
 assert.equal((await call('ticket',`/tickets?requesterId=${employeeId(99)}`)).body.total,0);
 const empty=(await call('ticket','/ticket-statistics?code=IT-999999')).body;assert.equal(empty.total,0);assert.ok(Object.values(empty.byStatus).every(n=>n===0));
 assert.equal((await call('ticket','/tickets?unassigned=true')).body.total,6);assert.equal((await call('ticket','/tickets?unassigned=false')).body.total,24);
 for(const q of ['status=BAD','priority=low','code=1','requesterId=bad','overdue=yes',`assigneeId=${employeeId(1)}&unassigned=true`]) assert.equal((await call('ticket','/tickets?'+q)).status,400,q);
 assert.equal((await call('ticket','/ticket-statistics?limit=1')).status,400);
 assert.equal((await call('ticket','/tickets','test-only','POST')).status,400);
});
