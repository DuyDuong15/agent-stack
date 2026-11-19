import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMatrixBridge} from './matrix-bridge.mjs';
test('Matrix bridge reads scoped bot session, rejects other room, never reuses stale user command',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'matrix-test-')),credentialsFile=join(dir,'session.json');
 writeFileSync(credentialsFile,JSON.stringify({userId:'@bot:test',accessToken:'test-token'}));
 let chunk=[{type:'m.room.message',sender:'@other:test'},{type:'m.room.message',sender:'@user:test',content:{body:'old confirmation'}}];
 const bridge=createMatrixBridge({url:'http://matrix.test',userId:'@user:test',roomId:'!room:test',credentialsFile,fetchImpl:async(url,options)=>{assert.equal(options.headers.Authorization,'Bearer test-token');assert.ok(url.startsWith('http://matrix.test/'));return Response.json({chunk});}});
 try {
 assert.equal((await bridge.context()).latest,undefined);
 chunk=chunk.slice(1);assert.equal((await bridge.context()).latest.content.body,'old confirmation');
 await assert.rejects(bridge.preview('!wrong:test','txn','text'),/scope/);
 } finally {rmSync(dir,{recursive:true});}
});
