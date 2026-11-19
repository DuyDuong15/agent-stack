// Real browser login in an isolated context. Never persists tokens/passwords in evidence.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {settings} from './configuration.mjs';
process.chdir(fileURLToPath(new URL('.',import.meta.url)));
const c=JSON.parse(fs.readFileSync('keycloak.local.json','utf8'));
fs.mkdirSync('docs/screenshots',{recursive:true});
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const evidence={checkedAt:new Date().toISOString(),checks:[]};
let cleanupToken;
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 let ssoToken;
 page.on('response',async response=>{
  if(/\/_matrix\/client\/[^/]+\/login$/.test(response.url())&&response.request().method()==='POST'&&response.ok()) {
   const data=await response.json();
   if(data.user_id==='@duong-sso:localhost') {ssoToken=data.access_token;cleanupToken=data.access_token;}
  }
 });
 await page.goto('http://localhost:8080/#/login',{waitUntil:'domcontentloaded',timeout:120000});
 const sso=page.getByRole('button',{name:/keycloak/i});
 await sso.waitFor({timeout:120000});
 await page.screenshot({path:'docs/screenshots/bai3-element-sso.png'});
 evidence.checks.push('Element offers Keycloak sign-in');
 await sso.click();
 await page.locator('#username').waitFor({timeout:60000});
 await page.screenshot({path:'docs/screenshots/bai3-keycloak-login.png'});
 await page.locator('#username').fill(c.username);
 await page.locator('#password').fill(c.password);
 await page.locator('#kc-login').click();
 await page.waitForTimeout(5000);
 // Synapse first-login consent/account creation screens differ by installed version.
 for(let i=0;i<6;i++) {
  const body=await page.locator('body').innerText();
  console.log('Login step',i,body.slice(0,1800));
  if(page.url().startsWith('http://localhost:8080')) break;
  const button=page.getByRole('button',{name:/^(continue|confirm|accept|sign in|register)$/i}).first();
  const link=page.getByRole('link',{name:/^(continue|confirm|accept|sign in)$/i}).first();
  if(await button.count()) await button.click();
  else if(await link.count()) await link.click();
  else break;
  await page.waitForTimeout(3000);
 }
 await page.waitForURL('http://localhost:8080/**',{timeout:60000});
 try {await page.waitForFunction(()=>localStorage.getItem('mx_user_id')==='@duong-sso:localhost',null,{timeout:90000});}
 catch(error) {console.log('Element login screen:',(await page.locator('body').innerText()).slice(0,1800));throw error;}
 evidence.checks.push('OIDC callback completed; Element logged in as @duong-sso:localhost');
 await page.waitForTimeout(8000);
 await page.screenshot({path:'docs/screenshots/bai3-element-logged-in.png'});
 const token=ssoToken;
 const base='http://127.0.0.1:8008/_matrix/client/v3';
 const who=await fetch(base+'/account/whoami',{headers:{Authorization:`Bearer ${token}`}});
 if(!who.ok||(await who.json()).user_id!=='@duong-sso:localhost') throw new Error('SSO session verification failed');
 evidence.checks.push('SSO Matrix token verified with /account/whoami');
 async function matrix(path,auth,method='GET',body,retries=2) {
  const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  if(r.status===429&&retries>0) {
   const e=await r.json();const delay=(e.retry_after_ms??30000)+500;
   if(delay>600000) throw new Error('Matrix rate limit exceeds 10 minutes; retry the test later');
   console.log('Waiting for Matrix login rate limit',delay,'ms');
   await new Promise(resolve=>setTimeout(resolve,delay));
   return matrix(path,auth,method,body,retries-1);
  }
  if(!r.ok) throw new Error(`Matrix ${method} ${path.split('?')[0]}: HTTP ${r.status}`);
  return r.json();
 }
 const admin=JSON.parse(fs.readFileSync('local-credentials.json','utf8').replace(/^\uFEFF/,''));
 const oc=JSON.parse(fs.readFileSync('openclaw.local.json','utf8').replace(/^\uFEFF/,''));
 let adminToken;
 for(const [label,user,password] of (process.argv.includes('--chat-only')?[]:[['admin',admin.username,admin.password],['bot',oc.channels.matrix.userId,oc.channels.matrix.password]])) {
  const session=await matrix('/login','', 'POST',{type:'m.login.password',identifier:{type:'m.id.user',user},password,initial_device_display_name:'Bai3 password regression test'});
  evidence.checks.push(`${label} password login still works`);
  if(label==='admin') adminToken=session.access_token;
  else await matrix('/logout',session.access_token,'POST',{});
 }
 try {
  const room=settings.MATRIX_ROOM_ID;
  const roomPath='/rooms/'+encodeURIComponent(room);
  const joined=await matrix('/joined_rooms',token);
  if(!joined.joined_rooms.includes(room)) {
   if(!adminToken) throw new Error('Run full test once to invite SSO user before using --chat-only');
   await matrix(roomPath+'/invite',adminToken,'POST',{user_id:'@duong-sso:localhost'});
   await matrix('/join/'+encodeURIComponent(room),token,'POST',{});
  }
  let since=(await matrix('/sync?timeout=0',token)).next_batch;
  const question='Goi tool ping voi name duong-sso, tra lai verificationCode de kiem tra MCP sau dang nhap SSO.';
  await matrix(roomPath+'/send/m.room.message/sso-'+Date.now(),token,'PUT',{msgtype:'m.text',body:'@openclaw:localhost '+question,format:'org.matrix.custom.html',formatted_body:'<a href="https://matrix.to/#/@openclaw:localhost">openclaw</a> '+question,'m.mentions':{user_ids:['@openclaw:localhost']}});
  console.log('SSO identity verified; test message sent with an Element-style mention');
  const end=Date.now()+150000;let reply;
  while(Date.now()<end&&!reply) {
   const data=await matrix('/sync?timeout=10000&since='+encodeURIComponent(since),token);since=data.next_batch;
   reply=(data.rooms?.join?.[room]?.timeline?.events??[]).find(e=>e.sender==='@openclaw:localhost'&&e.type==='m.room.message');
  }
  if(!reply) throw new Error('No bot response to SSO user');
  evidence.botReply=reply.content.body;
  evidence.checks.push('SSO user joined Onboarding, sent message and received bot reply');
  await page.goto('http://localhost:8080/#/room/'+room,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForTimeout(10000);
  console.log('Element after login:',(await page.locator('body').innerText()).slice(0,1800));
  await page.screenshot({path:'docs/screenshots/bai3-sso-bot-chat.png'});
 } finally {if(adminToken) await matrix('/logout',adminToken,'POST',{});}
 console.log('PASS: browser SSO and Matrix identity');
 fs.writeFileSync('docs/BAI-3-LIVE-EVIDENCE.json',JSON.stringify(evidence,null,2)+'\n');
} finally {
 if(cleanupToken) await fetch('http://127.0.0.1:8008/_matrix/client/v3/logout',{method:'POST',headers:{Authorization:`Bearer ${cleanupToken}`},signal:AbortSignal.timeout(5000)}).catch(()=>{});
 await browser.close();
}
