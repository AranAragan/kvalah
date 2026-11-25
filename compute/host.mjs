// Compute host process: forked by server.mjs (crash isolation from the chat/agent server). Owns one
// Controller and talks to the server over the Node IPC channel only — no ports of its own except the
// optional Training Lab coordinator. Exits when the parent goes away, so closing Kvalah stops Compute.
import {createController} from './controller.mjs';
const dir=process.env.KVALAH_COMPUTE_DIR;
if(!dir||!process.send){console.error('compute host must be started by the Kvalah server');process.exit(2);}
const pending=new Map();let seq=0;
// Secret box backed by Electron safeStorage in the desktop main process (DPAPI / Keychain), relayed by the server.
function up(op,data){const id='s'+(++seq);process.send({type:'secret',id,op,data});return new Promise((resolve,reject)=>{const t=setTimeout(()=>{pending.delete(id);reject(Error('secret store did not answer'));},10000);pending.set(id,{resolve,reject,t});});}
let secretAvailable=false;
const secretBox={get available(){return secretAvailable;},scheme:'electron-safeStorage',seal:s=>up('seal',s),open:s=>up('open',s)};
const ctl=createController({dir,secretBox,log:m=>process.stderr.write('[compute] '+m+'\n')});
process.on('message',async m=>{
  if(!m||typeof m!=='object')return;
  if(m.type==='secret-reply'){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.t);m.ok?p.resolve(m.data):p.reject(Error(m.error||'secret store error'));return;}
  if(m.type==='sensors'){ctl.setSensors(m.sensors||{});return;}
  if(m.type==='broker'){ctl.setBroker(String(m.id),!!m.busy);return;}
  if(m.type==='shutdown'){await ctl.shutdown();process.exit(0);}
  if(m.type==='request'){
    try{const data=await ctl.handle(m.method,m.route,m.body||{});process.send({type:'response',id:m.id,ok:true,data});}
    catch(e){process.send({type:'response',id:m.id,ok:false,error:{code:e.code||'INTERNAL',message:String(e.message||e).slice(0,500),status:e.status||(e.code?400:500)}});}
  }
});
ctl.onEvent(e=>{try{process.send({type:'event',event:e});}catch{}});
process.on('disconnect',async()=>{await ctl.shutdown().catch(()=>{});process.exit(0);});
for(const s of ['SIGTERM','SIGINT'])process.on(s,async()=>{await ctl.shutdown().catch(()=>{});process.exit(0);});
up('available').then(v=>{secretAvailable=v===true;}).catch(()=>{secretAvailable=false;}).finally(async()=>{
  await ctl.boot().catch(e=>process.stderr.write('[compute] boot: '+e.message+'\n'));
  process.send({type:'ready'});
});
