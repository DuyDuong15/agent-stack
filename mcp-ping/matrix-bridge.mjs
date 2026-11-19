import {readFileSync} from 'node:fs';
import {settings,localPath} from '../configuration.mjs';
export function createMatrixBridge({url=settings.MATRIX_URL,userId=settings.MATRIX_USER_ID,roomId=settings.MATRIX_ROOM_ID,credentialsFile=localPath(settings.MATRIX_CREDENTIALS_FILE),fetchImpl=fetch}={}) {
 const base=url.replace(/\/$/,'')+'/_matrix/client/v3';
 const auth=()=>{
  const value=JSON.parse(readFileSync(credentialsFile,'utf8').replace(/^\uFEFF/,''));
  if(!value.accessToken||!value.userId) throw new Error('Bot session missing');return value;
 };
 async function request(path,body) {
  const r=await fetchImpl(base+path,{method:body?'PUT':'GET',headers:{Authorization:`Bearer ${auth().accessToken}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
  if(!r.ok) throw new Error('Matrix request failed');return r.json();
 }
 async function context() {
  const {chunk}=await request(`/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=100`);
  const botId=auth().userId;
  // Do not reuse an older authorized user's command after another participant speaks.
  const recent=chunk.find(e=>e.type==='m.room.message'&&e.sender!==botId);
  const latest=recent?.sender===userId?recent:undefined;
  return {roomId,userId,botId,latest,userMessages:chunk.filter(e=>e.type==='m.room.message'&&e.sender===userId)};
 }
 async function preview(targetRoom,txnId,text) {
  if(targetRoom!==roomId) throw new Error('Room outside configured scope');
  const {event_id}=await request(`/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,{msgtype:'m.text',body:text});
  const event=await request(`/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(event_id)}`);
  return {eventId:event_id,ts:event.origin_server_ts};
 }
 return {context,preview};
}
