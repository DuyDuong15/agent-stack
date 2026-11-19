import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const docker = (...args) => execFileSync('docker', args, {encoding:'utf8', stdio:['pipe','pipe','pipe']}).trim();
const secret = () => randomBytes(24).toString('base64url');
const file = 'keycloak.local.json';
const c = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {
  url:'http://localhost:8180', realm:'geo', adminUsername:'admin', adminPassword:secret(),
  username:'duong-sso', password:secret(), clientId:'synapse', clientSecret:secret()
};
fs.writeFileSync(file, JSON.stringify(c,null,2)+'\n');
const exists = docker('ps','-a','--format','{{.Names}}').split('\n').includes('keycloak');
if (!exists) {
  docker('volume','create','agent-onboarding-keycloak');
  fs.writeFileSync('keycloak.local.env', `KC_BOOTSTRAP_ADMIN_USERNAME=${c.adminUsername}\nKC_BOOTSTRAP_ADMIN_PASSWORD=${c.adminPassword}\nKC_HTTP_PORT=8180\nKC_HOSTNAME=http://localhost:8180\n`);
  try { docker('run','-d','--name','keycloak','--env-file','keycloak.local.env','-p','8180:8180','-v','agent-onboarding-keycloak:/opt/keycloak/data','quay.io/keycloak/keycloak:26.8.2','start-dev'); }
  finally {fs.unlinkSync('keycloak.local.env');}
} else docker('start','keycloak');
console.log('Waiting for Keycloak...');
let ready = false;
for(let i=0;i<120;i++) {
  try { if ((await fetch(c.url+'/realms/master',{signal:AbortSignal.timeout(3000)})).ok) {ready=true;break;} } catch {}
  await new Promise(r=>setTimeout(r,2000));
}
if(!ready) throw new Error('Keycloak did not become ready');
const tokenRes = await fetch(c.url+'/realms/master/protocol/openid-connect/token', {method:'POST',body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:c.adminUsername,password:c.adminPassword})});
if(!tokenRes.ok) throw new Error(`Admin login: HTTP ${tokenRes.status}`);
const {access_token} = await tokenRes.json();
async function api(path, method='GET', body) {
  const r = await fetch(c.url+'/admin/realms'+path,{method,headers:{Authorization:`Bearer ${access_token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(!r.ok) throw new Error(`Keycloak ${method} ${path}: HTTP ${r.status}`);
  return r.status===204||r.status===201?null:r.json();
}
const realms = await api('');
if(!realms.some(r=>r.realm===c.realm)) await api('','POST',{realm:c.realm,enabled:true,registrationAllowed:false,sslRequired:'none'});
let clients = await api('/geo/clients?clientId=synapse');
if(!clients.length) {
 await api('/geo/clients','POST',{clientId:'synapse',enabled:true,protocol:'openid-connect',publicClient:false,secret:c.clientSecret,standardFlowEnabled:true,directAccessGrantsEnabled:false,redirectUris:['http://localhost:8008/_synapse/client/oidc/callback'],webOrigins:['http://localhost:8008']});
 clients = await api('/geo/clients?clientId=synapse');
}
c.clientSecret = (await api('/geo/clients/'+clients[0].id+'/client-secret')).value;
fs.writeFileSync(file,JSON.stringify(c,null,2)+'\n');
const users = await api('/geo/users?username='+encodeURIComponent(c.username)+'&exact=true');
if(!users.length) await api('/geo/users','POST',{username:c.username,enabled:true,firstName:'Duong',lastName:'SSO',email:'duong-sso@example.test',emailVerified:true,requiredActions:[],credentials:[{type:'password',value:c.password,temporary:false}]});
console.log('Realm geo, confidential client synapse, and user duong-sso ready. Credentials saved locally (ignored).');
// Keep all existing Synapse settings; back up the complete original inside its persistent volume.
docker('cp',file,'synapse:/tmp/keycloak-onboarding.json');
try {
 const py = `import json,yaml,shutil,datetime\np='/data/homeserver.yaml'\nc=json.load(open('/tmp/keycloak-onboarding.json'))\ns=yaml.safe_load(open(p))\nb=p+'.before-keycloak.'+datetime.datetime.now().strftime('%Y%m%d%H%M%S')\nshutil.copy2(p,b)\nprovider={'idp_id':'keycloak','idp_name':'Keycloak','issuer':'http://localhost:8180/realms/geo','client_id':'synapse','client_secret':c['clientSecret'],'scopes':['openid','profile','email'],'discover':False,'authorization_endpoint':'http://localhost:8180/realms/geo/protocol/openid-connect/auth','token_endpoint':'http://host.docker.internal:8180/realms/geo/protocol/openid-connect/token','userinfo_endpoint':'http://host.docker.internal:8180/realms/geo/protocol/openid-connect/userinfo','jwks_uri':'http://host.docker.internal:8180/realms/geo/protocol/openid-connect/certs','skip_verification':True,'user_mapping_provider':{'config':{'localpart_template':'{{ user.preferred_username }}','display_name_template':'{{ user.name }}','email_template':'{{ user.email }}'}}}\ns['public_baseurl']='http://localhost:8008/'\ns['oidc_providers']=[x for x in s.get('oidc_providers',[]) if x.get('idp_id')!='keycloak']+[provider]\ns.setdefault('password_config',{})['enabled']=True\nwith open(p,'w') as f: yaml.safe_dump(s,f,sort_keys=False)\nprint('Synapse config backed up to '+b)\n`;
 console.log(docker('exec','synapse','python','-c',py));
} finally {docker('exec','synapse','rm','-f','/tmp/keycloak-onboarding.json');}
docker('restart','synapse');
for(let i=0;i<60;i++) {
 try {
   const r=await fetch('http://localhost:8008/_matrix/client/v3/login',{signal:AbortSignal.timeout(2000)});
   if(r.ok) {const data=await r.json();if(data.flows.some(f=>f.type==='m.login.sso')&&data.flows.some(f=>f.type==='m.login.password')) {console.log('PASS: Synapse offers SSO and password login.');process.exit(0);}}
 } catch {}
 await new Promise(r=>setTimeout(r,2000));
}
throw new Error('Synapse login flows not ready; original configuration backup is in /data.');
