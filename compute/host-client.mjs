// Server-side handle of the compute host child process: lazy start (only when the Compute feature is
// switched on), request/response over IPC, restart with backoff after a crash, broker and sensor relay.
import {fork} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const HOST=path.join(path.dirname(fileURLToPath(import.meta.url)),'host.mjs');
export function createComputeHost({dir,onSecret=null,log=()=>{}}){
  let child=null,ready=null,seq=0,closing=false,crashes=0,lastSensors=null;
  const waiters=new Map(),busy=new Map();
  function start(){
    if(ready)return ready;
    ready=new Promise((resolve,reject)=>{
      const env={...process.env,KVALAH_COMPUTE_DIR:dir};
      child=fork(HOST,[],{env,stdio:['ignore','inherit','inherit','ipc'],serialization:'advanced'});
      const t=setTimeout(()=>reject(Error('compute host did not start')),30000);
      child.on('message',async m=>{
        if(m?.type==='ready'){clearTimeout(t);crashes=0;if(lastSensors)child.send({type:'sensors',sensors:lastSensors});for(const [id,b] of busy)child.send({type:'broker',id,busy:b});resolve();}
        else if(m?.type==='response'){const w=waiters.get(m.id);if(w){waiters.delete(m.id);m.ok?w.resolve(m.data):w.reject(Object.assign(Error(m.error.message),{code:m.error.code,status:m.error.status}));}}
        else if(m?.type==='secret'){
          let reply;
          try{if(!onSecret)throw Error('no OS secret store in this mode');reply={type:'secret-reply',id:m.id,ok:true,data:await onSecret(m.op,m.data)};}
          catch(e){reply={type:'secret-reply',id:m.id,ok:m.op==='available',data:m.op==='available'?false:undefined,error:e.message};}
          child?.send(reply);
        }
      });
      child.on('exit',(code,signal)=>{
        clearTimeout(t);for(const [,w] of waiters)w.reject(Object.assign(Error('compute host stopped'),{code:'UNAVAILABLE'}));waiters.clear();
        child=null;ready=null;
        if(!closing){crashes++;log(`compute host exited (${code??signal}); restart #${crashes}`);if(crashes<=5)setTimeout(()=>start().catch(()=>{}),Math.min(30000,1000*2**crashes)).unref?.();}
        reject(Error('compute host exited'));
      });
    });
    ready.catch(()=>{});
    return ready;
  }
  async function request(method,route,body){
    await start();
    const id=++seq;
    return new Promise((resolve,reject)=>{waiters.set(id,{resolve,reject});child.send({type:'request',id,method,route,body});});
  }
  return {
    start,request,get running(){return !!child;},
    sensors(s){lastSensors={...lastSensors,...s};child?.send({type:'sensors',sensors:s});},
    broker(id,isBusy){if(isBusy)busy.set(id,true);else busy.delete(id);child?.send({type:'broker',id,busy:isBusy});},
    async close(){
      closing=true;if(!child)return;
      const c=child;await new Promise(r=>{const t=setTimeout(()=>{try{c.kill('SIGKILL');}catch{}r();},20000);c.once('exit',()=>{clearTimeout(t);r();});try{c.send({type:'shutdown'});}catch{c.kill();}});
    }
  };
}
