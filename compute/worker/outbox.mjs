// Durable outbox (spec §8 step 4): the exact update bytes and metadata are fsync'ed before any network send.
// After a crash or an uncertain acknowledgement the same bytes are re-sent with the same idempotency key;
// the update is never regenerated.
import fs from 'node:fs';
import path from 'node:path';
import {sha256} from '../protocol/hash.mjs';
const RETAIN_MS=7*24*3600e3;
function writeAtomic(file,data){const tmp=file+'.tmp';const fd=fs.openSync(tmp,'w',0o600);try{fs.writeSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
export function createOutbox(dir,{now=Date.now}={}){
  fs.mkdirSync(dir,{recursive:true});
  const entryDir=k=>{if(!/^[0-9a-f]{64}$/.test(k))throw Error('bad outbox key');return path.join(dir,k);};
  const read=k=>{try{return JSON.parse(fs.readFileSync(path.join(entryDir(k),'meta.json'),'utf8'));}catch{return null;}};
  return {
    put(task,bytes,meta){
      const payload=sha256(bytes),key=sha256(['kc2-update',task.task_id,task.lease_id,payload].join('|'));
      const d=entryDir(key);if(read(key))return read(key);
      fs.mkdirSync(d,{recursive:true});
      writeAtomic(path.join(d,'update.safetensors'),bytes);
      const rec={key,task,payload_sha256:payload,bytes:bytes.length,meta,state:'pending',created_at:now(),attempts:0};
      writeAtomic(path.join(d,'meta.json'),JSON.stringify(rec));return rec;
    },
    update(key,patch){const rec={...read(key),...patch};writeAtomic(path.join(entryDir(key),'meta.json'),JSON.stringify(rec));return rec;},
    bytes(key){const b=fs.readFileSync(path.join(entryDir(key),'update.safetensors'));const rec=read(key);if(sha256(b)!==rec.payload_sha256)throw Object.assign(Error('outbox entry corrupt'),{code:'HASH_MISMATCH'});return b;},
    pending(){return fs.readdirSync(dir).filter(k=>/^[0-9a-f]{64}$/.test(k)).map(read).filter(r=>r&&!['acked','rejected','abandoned'].includes(r.state)).sort((a,b)=>a.created_at-b.created_at);},
    all(){return fs.readdirSync(dir).filter(k=>/^[0-9a-f]{64}$/.test(k)).map(read).filter(Boolean);},
    gc(){let n=0;for(const r of this.all())if(['acked','rejected','abandoned'].includes(r.state)&&now()-(r.closed_at||r.created_at)>RETAIN_MS){fs.rmSync(entryDir(r.key),{recursive:true,force:true});n++;}return n;}
  };
}
