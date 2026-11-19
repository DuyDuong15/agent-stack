import {inSpan,tracedDatabase} from '../telemetry/index.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {fault} from './create-ticket.mjs';
import {statuses, priorities} from './fixtures.mjs';
const fold = s => s.normalize('NFD').replace(/\p{M}/gu,'').replace(/[đĐ]/g,'d').toLowerCase();
const employeeColumns = ['id','code','name','department','active'];
const ticketColumns = ['id','code','title','description','requester_id','assignee_id','priority','status','due_at','created_at','updated_at'];
const camel = name => name.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
const overdue = "(status IN ('OPEN','IN_PROGRESS') AND due_at IS NOT NULL AND due_at < ?)";
export function openStore({kind,dbPath,seed}) {
  const db=tracedDatabase(new DatabaseSync(dbPath),kind);
  const table=kind==='employee'?'employees':'tickets';
  const columns=kind==='employee'?employeeColumns:ticketColumns;
  const exists=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  db.function('fold',{deterministic:true},fold);
  db.function('lower',{deterministic:true},value=>value.toLowerCase());
  db.exec('PRAGMA busy_timeout=5000');
  try {
    if(dbPath!==':memory:' && exists('records') && !exists(table)) {
      // SQLite creates a consistent backup, including committed WAL contents.
      db.prepare('VACUUM INTO ?').run(`${dbPath}.before-columns-${Date.now()}.bak`);
    }
    db.exec('BEGIN IMMEDIATE');
    if(!exists(table)) {
      db.exec(kind==='employee'?`CREATE TABLE employees (
        id TEXT PRIMARY KEY NOT NULL, code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
        department TEXT NOT NULL CHECK(length(trim(department)) BETWEEN 1 AND 100),
        active INTEGER NOT NULL CHECK(active IN (0,1))) STRICT;`
        :`CREATE TABLE tickets (
        id TEXT PRIMARY KEY NOT NULL, code TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
        description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 4000),
        requester_id TEXT NOT NULL, assignee_id TEXT,
        priority TEXT NOT NULL CHECK(priority IN ('LOW','MEDIUM','HIGH')),
        status TEXT NOT NULL CHECK(status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')),
        due_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
        CREATE INDEX tickets_created ON tickets(created_at DESC,id ASC);
        CREATE INDEX tickets_requester ON tickets(requester_id);
        CREATE INDEX tickets_assignee ON tickets(assignee_id);
        CREATE INDEX tickets_status_priority ON tickets(status,priority);`);
      const legacy=exists('records');
      const rows=legacy?db.prepare('SELECT id,payload FROM records').all().map(row=>{
        const value=JSON.parse(row.payload);
        if(row.id!==value.id) throw new Error('Legacy ID mismatch; migration cancelled');
        return value;
      }):seed[table];
      const insert=db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
      for(const row of rows) insert.run(...columns.map(c=>c==='active'?Number(row.active):row[camel(c)]));
      if(legacy) db.exec('DROP TABLE records');
      db.exec('PRAGMA user_version=1');
    }
    if(kind==='ticket') db.exec(`CREATE TABLE IF NOT EXISTS ticket_idempotency (
      scope TEXT NOT NULL, key TEXT NOT NULL, payload_hash TEXT NOT NULL,
      response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,key)) STRICT;
      PRAGMA user_version=2;`);
    db.exec('COMMIT');
  } catch(e) {db.exec('ROLLBACK');db.close();throw e;}
  const map=row=>row&&Object.fromEntries(columns.map(c=>[camel(c),c==='active'?Boolean(row[c]):row[c]]));
  function select(q,now,stats=false) {
    const clauses=[],args=[];
    const add=(sql,...values)=>{clauses.push(sql);args.push(...values);};
    if(q.ids) {
      const items=db.prepare(`SELECT * FROM employees WHERE id IN (${q.ids.map(()=>'?').join(',')}) ORDER BY code`).all(...q.ids).map(map);
      return {items,missingIds:q.ids.filter(id=>!items.some(e=>e.id===id))};
    }
    if(kind==='employee') {
      if(q.q) add('(instr(fold(name),?)>0 OR fold(code)=?)',fold(q.q),fold(q.q));
      if(q.department) add('fold(department)=?',fold(q.department));
      if(q.active!==undefined) add('active=?',Number(q.active));
    } else {
      if(q.q) add('(instr(fold(title),?)>0 OR instr(fold(description),?)>0)',fold(q.q),fold(q.q));
      for(const [key,column] of [['code','code'],['status','status'],['priority','priority'],['requesterId','requester_id'],['assigneeId','assignee_id']]) if(q[key]!==undefined) add(`${column}=?`,q[key]);
      if(q.unassigned!==undefined) add(`assignee_id IS ${q.unassigned?'':'NOT '}NULL`);
      if(q.overdue!==undefined) add(`${q.overdue?'':'NOT '}${overdue}`,now);
      if(q.createdFrom) add('created_at>=?',q.createdFrom);
      if(q.createdTo) add('created_at<?',q.createdTo);
    }
    const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
    if(stats) {
      const sums=["count(*) AS total", "coalesce(sum(status IN ('OPEN','IN_PROGRESS')),0) AS openCount",`coalesce(sum(${overdue}),0) AS overdueCount`,...statuses.map(s=>`coalesce(sum(status='${s}'),0) AS ${s}`),...priorities.map(p=>`coalesce(sum(priority='${p}'),0) AS ${p}`)];
      const row=db.prepare(`SELECT ${sums.join(',')} FROM tickets${where}`).get(now,...args);
      return {total:row.total,openCount:row.openCount,overdueCount:row.overdueCount,byStatus:Object.fromEntries(statuses.map(s=>[s,row[s]])),byPriority:Object.fromEntries(priorities.map(p=>[p,row[p]])),evaluatedAt:now};
    }
    const limit=q.limit??20,offset=q.offset??0;
    // Count and page see the same snapshot, including concurrent external edits.
    db.exec('BEGIN');
    try {
      const {total}=db.prepare(`SELECT count(*) AS total FROM ${table}${where}`).get(...args);
      const items=db.prepare(`SELECT * FROM ${table}${where} ORDER BY ${kind==='employee'?'code ASC':'created_at DESC,id ASC'} LIMIT ? OFFSET ?`).all(...args,limit,offset).map(map);
      db.exec('COMMIT');
      return {items,total,limit,offset,...(kind==='ticket'?{evaluatedAt:now}:{})};
    } catch(e) {db.exec('ROLLBACK');throw e;}
  }
  function replay(scope,key,hash) {
    const saved=db.prepare('SELECT payload_hash,response FROM ticket_idempotency WHERE scope=? AND key=?').get(scope,key);
    if(!saved) return null;
    if(saved.payload_hash!==hash) throw fault(409,'IDEMPOTENCY_CONFLICT','Key already used for a different payload');
    return {ticket:JSON.parse(saved.response),replayed:true};
  }
  function create(scope,key,hash,payload,now) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const saved=replay(scope,key,hash);if(saved) {db.exec('COMMIT');return saved;}
      // Transaction serializes duplicate checks across processes, including different idempotency keys.
      const duplicate=db.prepare("SELECT code FROM tickets WHERE requester_id=? AND assignee_id IS ? AND lower(trim(title))=lower(?) AND status IN ('OPEN','IN_PROGRESS') LIMIT 1").get(payload.requesterId,payload.assigneeId,payload.title);
      if(duplicate) throw fault(409,'TICKET_DUPLICATE',`An open ticket with the same title, requester and assignee already exists (${duplicate.code})`);
      const {n}=db.prepare("SELECT coalesce(max(CAST(substr(code,4) AS INTEGER)),0)+1 AS n FROM tickets").get();
      const ticket={id:randomUUID(),code:'IT-'+String(n).padStart(6,'0'),...payload,status:'OPEN',createdAt:now,updatedAt:now};
      db.prepare(`INSERT INTO tickets (${ticketColumns.join(',')}) VALUES (${ticketColumns.map(()=>'?').join(',')})`).run(...ticketColumns.map(c=>ticket[camel(c)]));
      db.prepare('INSERT INTO ticket_idempotency VALUES (?,?,?,?,?)').run(scope,key,hash,JSON.stringify(ticket),now);
      db.exec('COMMIT');return {ticket,replayed:false};
    } catch(e) {db.exec('ROLLBACK');throw e;}
  }
  return {
   select:(q,now,stats)=>inSpan(kind+(stats?'.statistics':'.search'),{},()=>select(q,now,stats)),
   replay:(...args)=>inSpan('ticket.replay',{},()=>replay(...args)),
   create:(...args)=>inSpan('ticket.create',{},()=>create(...args)),
   detail:id=>inSpan(kind+'.detail',{},()=>map(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id))),close:()=>db.close()
  };
}
