// Fresh-machine bootstrap. Never import the developer's credentials or databases.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomBytes,createHmac} from 'node:crypto';
import net from 'node:net';

const root=fileURLToPath(new URL('.',import.meta.url));
process.chdir(root);
const stateFile='review.local.json';
const element=path.resolve(root,'../element-web');
const commit='75eaab6ca5ac7ab4bac91a6097c8e77bb469455d';
const synapseImage='matrixdotorg/synapse@sha256:c6b5dba477c41b22167e771174456364b7c9c83a4cb2d5d7ee1e530334c5cd06';
const names=['synapse','keycloak','openclaw-box'];
const secret=()=>randomBytes(24).toString('hex');
function run(cmd,args,options={}) {
    // Captured output is deliberately not printed on failure: commands can handle secrets.
    try { return execFileSync(cmd,args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:64*1024*1024,...options}).trim(); }
    catch { throw new Error(`${cmd} ${args[0]??''} failed (output withheld to protect credentials).`); }
}
const docker=(...args)=>run('docker',args);
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(url) {
    for(let i=0;i<120;i++) {
        try { if((await fetch(url,{signal:AbortSignal.timeout(2000)})).ok) return; } catch {}
        await sleep(2000);
    }
    throw new Error(`Service not ready: ${url}`);
}
async function request(url,body,token) {
    const res=await fetch(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
    if(!res.ok) throw new Error(`HTTP ${res.status}: ${new URL(url).pathname}`);
    return res.json();
}
async function portFree(port) {
    return new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)));});
}
async function main() {
    if(Number(process.versions.node.split('.')[0])<24) throw new Error('Install Node.js 24 or later.');
    if(docker('info','--format','{{.OSType}}')!=='linux') throw new Error('Switch Docker Desktop to Linux containers.');
    run('git',['--version']);
    const containers=docker('ps','-a','--format','{{.Names}}').split('\n');
    const prior=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
    if(!prior) {
        const conflicts=containers.filter(n=>names.includes(n)||n.startsWith('agent-backend-'));
        const localFiles=['local-credentials.json','keycloak.local.json','openclaw.local.json','matrix-session.local.json','.env.backend','compose.review.local.json','ticket-service/data/employee.sqlite','ticket-service/data/ticket.sqlite','mcp-ping/data/drafts.sqlite'].filter(f=>fs.existsSync(f));
        const volumes=docker('volume','ls','--format','{{.Name}}').split('\n').filter(n=>['agent-review-synapse','agent-onboarding-keycloak','openclaw-data'].includes(n)||n.startsWith('agent-backend_'));
        if(conflicts.length||localFiles.length||volumes.length||fs.existsSync(element)) throw new Error('Existing environment detected. Setup is for a clean review machine only; nothing has been overwritten. Use the existing start scripts on the development machine.');
        for(const p of [8008,8080,8180,8005,8011,8012,8013,16686,4317,4318]) if(!await portFree(p)) throw new Error(`Port ${p} is in use.`);
    } else if(prior.root!==root) throw new Error('Setup state belongs to another directory. Do not copy review.local.json between machines.');
    if(process.argv.includes('--check')) {console.log('Prerequisites OK. No files or containers changed.');return;}
    if(!prior&&!process.env.REVIEW_OPENAI_KEY?.trim()) throw new Error('Run setup-review.ps1 to enter your OpenAI API key securely.');
    const c=prior??{root,openaiKey:process.env.REVIEW_OPENAI_KEY.trim(),user:'reviewer',password:secret(),botPassword:secret(),gatewayToken:secret()};
    delete process.env.REVIEW_OPENAI_KEY;
    save(stateFile,c);
    const stage=async(name,fn)=>{if(c[name]) return;console.log(`Setup: ${name} (downloads/builds can take several minutes)`);await fn();c[name]=true;save(stateFile,c);};
    await stage('dependencies',async()=>{
        for(const folder of ['telemetry','ticket-service','mcp-ping']) {
            // npm.cmd needs cmd.exe on Windows. All arguments here are fixed, no user input.
            if(process.platform==='win32') run('cmd.exe',['/d','/c','npm ci'],{cwd:path.join(root,folder)});
            else run('npm',['ci'],{cwd:path.join(root,folder)});
        }
        run(process.execPath,['ticket-service/setup-local.mjs']);
    });
    const has=name=>docker('ps','-a','--format','{{.Names}}').split('\n').includes(name);
    await stage('synapse',async()=>{
        docker('volume','create','agent-review-synapse');
        if(!has('synapse')) {
            docker('run','--rm','-e','SYNAPSE_SERVER_NAME=localhost','-e','SYNAPSE_REPORT_STATS=no','-v','agent-review-synapse:/data',synapseImage,'generate');
            docker('run','-d','--name','synapse','--restart','unless-stopped','-p','127.0.0.1:8008:8008','--add-host','host.docker.internal:host-gateway','-v','agent-review-synapse:/data',synapseImage);
        } else docker('start','synapse');
        await wait('http://localhost:8008/_matrix/client/versions');
    });
    docker('start','synapse');
    await wait('http://localhost:8008/_matrix/client/versions');
    const base='http://localhost:8008/_matrix/client/v3';
    const login=(user,password)=>request(base+'/login',{type:'m.login.password',identifier:{type:'m.id.user',user},password});
    await stage('accounts',async()=>{
        const registrationSecret=docker('exec','synapse','python','-c',"import yaml; print(yaml.safe_load(open('/data/homeserver.yaml'))['registration_shared_secret'])");
        for(const [username,password] of [[c.user,c.password],['openclaw',c.botPassword]]) {
            try {await login(username,password);continue;} catch {}
            const endpoint='http://localhost:8008/_synapse/admin/v1/register';
            const {nonce}=await request(endpoint);
            const mac=createHmac('sha1',registrationSecret).update([nonce,username,password,'notadmin'].join('\0')).digest('hex');
            await request(endpoint,{nonce,username,password,admin:false,mac});
        }
    });
    await stage('room',async()=>{
        const user=await login(c.user,c.password),bot=await login('openclaw',c.botPassword);
        if(!c.roomId) {c.roomId=(await request(base+'/createRoom',{name:'Onboarding review',preset:'private_chat',invite:[bot.user_id]},user.access_token)).room_id;save(stateFile,c);}
        await request(base+'/join/'+encodeURIComponent(c.roomId),{},bot.access_token);
        save('local-credentials.json',{username:c.user,password:c.password,userId:user.user_id,roomId:c.roomId});
        save('matrix-session.local.json',{userId:bot.user_id,accessToken:bot.access_token,deviceId:bot.device_id,homeserver:'http://host.docker.internal:8008'});
        fs.writeFileSync('.env.backend',`MATRIX_USER_ID=${user.user_id}\nMATRIX_ROOM_ID=${c.roomId}\n`);
        save('compose.review.local.json',{services:{mcp:{environment:{MATRIX_USER_ID:user.user_id,MATRIX_ROOM_ID:c.roomId}}}});
    });
    await stage('openclaw',async()=>{
        docker('volume','create','openclaw-data');
        if(!has('openclaw-box')) docker('run','-d','--name','openclaw-box','--restart','unless-stopped','--add-host','host.docker.internal:host-gateway','-v','openclaw-data:/root/.openclaw','node:22-bookworm','sleep','infinity');
        else docker('start','openclaw-box');
        docker('exec','openclaw-box','npm','install','-g','openclaw@2026.4.2');
        docker('exec','openclaw-box','mkdir','-p','/root/.openclaw/workspace','/root/.openclaw/credentials/matrix');
        const config={models:{providers:{openai:{baseUrl:'https://api.openai.com/v1',apiKey:c.openaiKey,api:'openai-completions',models:[{id:'gpt-4o-mini',name:'gpt-4o-mini'}]}}},agents:{defaults:{model:{primary:'openai/gpt-4o-mini'},heartbeat:{every:'0m'}}},gateway:{mode:'local',bind:'loopback',auth:{mode:'token',token:c.gatewayToken}},channels:{matrix:{enabled:true,homeserver:'http://host.docker.internal:8008',userId:'@openclaw:localhost',password:c.botPassword,deviceName:'Review OpenClaw',encryption:false,autoJoin:'always',dm:{policy:'allowlist',allowFrom:[`@${c.user}:localhost`]},groupPolicy:'open',allowPrivateNetwork:true}},plugins:{entries:{matrix:{enabled:true}},allow:['matrix','openai']},tools:{web:{search:{enabled:false}},profile:'minimal'},mcp:{servers:{onboarding:{url:'http://host.docker.internal:8005/mcp',transport:'streamable-http'}}}};
        save('openclaw.local.json',config);
        docker('cp','openclaw.local.json','openclaw-box:/root/.openclaw/openclaw.json');
        docker('cp','matrix-session.local.json','openclaw-box:/root/.openclaw/credentials/matrix/credentials.json');
        const rules=fs.readFileSync('mcp-ping/employee-chat-rules.md','utf8').replace('This is read-only onboarding; do not create tickets.','Ticket creation is allowed only through the confirmation tools.');
        run('docker',['exec','-i','openclaw-box','sh','-c','cat > /root/.openclaw/workspace/AGENTS.md'],{input:rules});
        run(process.execPath,['sync-bot-rules.mjs']);
        docker('exec','openclaw-box','openclaw','config','validate');
    });
    await stage('sso',async()=>{run(process.execPath,['setup-keycloak.mjs']);});
    await stage('databases',async()=>{
        const {openStore}=await import('./ticket-service/store.mjs');
        const {fixtures}=await import('./ticket-service/fixtures.mjs');
        const {createDraftService}=await import('./mcp-ping/ticket-drafts.mjs');
        fs.mkdirSync('ticket-service/data',{recursive:true});fs.mkdirSync('mcp-ping/data',{recursive:true});
        for(const kind of ['employee','ticket']) {
            const dbPath=`ticket-service/data/${kind}.sqlite`;
            openStore({kind,dbPath,seed:fixtures()}).close();
        }
        if(!fs.existsSync('mcp-ping/data/drafts.sqlite')) createDraftService({dbPath:'mcp-ping/data/drafts.sqlite'}).close();
    });
    await stage('element',async()=>{
        if(!fs.existsSync(element)) run('git',['clone','https://github.com/element-hq/element-web.git',element]);
        run('git',['checkout',commit],{cwd:element});
        const patch=path.join(root,'artifacts/element-uia-fix.patch');
        if(fs.existsSync(patch)) {
            let applied=false;try {run('git',['apply','--reverse','--check',patch],{cwd:element});applied=true;} catch {}
            if(!applied) run('git',['apply',patch],{cwd:element});
        }
        save(path.join(element,'apps/web/config.json'),{default_server_config:{'m.homeserver':{base_url:'http://localhost:8008',server_name:'localhost'}},disable_custom_urls:true,disable_guests:true,brand:'Onboarding review'});
        if(process.platform==='win32') run('cmd.exe',['/d','/c','npx --yes pnpm@12.18.0 install --frozen-lockfile'],{cwd:element});
        else run('npx',['--yes','pnpm@12.18.0','install','--frozen-lockfile'],{cwd:element});
    });
    console.log('Setup complete. Run .\\start-review.ps1. Login details: local-credentials.json; SSO: keycloak.local.json. Never share these files.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
