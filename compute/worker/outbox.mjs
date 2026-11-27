// Durable outbox (spec §8 step 4): the exact update bytes and metadata are fsync'ed before any network send.
// After a crash or an uncertain acknowledgement the same bytes are re-sent with the same idempotency key;
// the update is never regenerated.
import fs from 'node:fs';
import path from 'node:path';
import {sha256} from '../protocol/hash.mjs';
import {randomUUID} from 'node:crypto';
import {hashFile} from '../fusion/stream.mjs';
const RETAIN_MS=7*24*3600e3;
const terminal=new Set(['acked','accepted','committed','awaiting_ack','rejected','abandoned','expired','quarantined','corrupt','cancelled']);
function writeAtomic(file,data){
  const tmp=file+'.'+randomUUID()+'.tmp';
  try{
    const fd=fs.openSync(tmp,'wx',0o600);
    try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(tmp,file);
    if(process.platform!=='win32'){
      const parent=fs.openSync(path.dirname(file),'r');
      try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
    }
  }finally{fs.rmSync(tmp,{force:true});}
}
export function createOutbox(dir,{now=Date.now}={}){
  fs.mkdirSync(dir,{recursive:true});
  const entryDir=k=>{if(!/^[0-9a-f]{64}$/.test(k))throw Error('bad outbox key');return path.join(dir,k);};
  const read=k=>{
    for(const filename of ['meta.json','previous.json']){
      try{
        const record=JSON.parse(fs.readFileSync(path.join(entryDir(k),filename),'utf8'));
        if(record.key===k&&record.task&&/^[0-9a-f]{64}$/.test(record.payload_sha256))return record;
      }catch{}
    }
    return null;
  };
  function store(task,payload,bytes,meta,{signature,scope},persist){
    const key=sha256(['kc2-update',task.task_id,task.lease_id,payload].join('|'));
    const d=entryDir(key);if(read(key))return read(key);
    fs.mkdirSync(d,{recursive:true});
    persist(path.join(d,'update.safetensors'));
    const rec={key,task,signature,scope,payload_sha256:payload,bytes,meta,state:'pending',created_at:now(),attempts:0};
    const json=JSON.stringify(rec);
    writeAtomic(path.join(d,'previous.json'),json);
    writeAtomic(path.join(d,'meta.json'),json);return rec;
  }
  return {
    put(task,bytes,meta,{signature,scope}={}){
      return store(task,sha256(bytes),bytes.length,meta,{signature,scope},file=>writeAtomic(file,bytes));
    },
    putFile(task,source,expected,meta,{scope}={}){
      const size=fs.statSync(source).size;
      if(hashFile(source,{expectedBytes:size})!==expected)throw Object.assign(Error('outbox source changed'),{code:'HASH_MISMATCH'});
      return store(task,expected,size,meta,{scope},file=>{
        const temporary=file+'.'+randomUUID();
        try{fs.copyFileSync(source,temporary,fs.constants.COPYFILE_EXCL);
          const fd=fs.openSync(temporary,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
          if(hashFile(temporary,{expectedBytes:size})!==expected)throw Object.assign(Error('outbox copy changed'),{code:'HASH_MISMATCH'});
          fs.renameSync(temporary,file);
        }finally{fs.rmSync(temporary,{force:true});}
      });
    },
    file(key){
      const record=read(key),file=path.join(entryDir(key),'update.safetensors');
      if(!record||hashFile(file,{expectedBytes:record.bytes})!==record.payload_sha256)throw Object.assign(Error('outbox entry corrupt'),{code:'HASH_MISMATCH'});
      return file;
    },
    update(key,patch){
      const prior=read(key);
      if(!prior)throw Error('missing outbox entry');
      const rec={...prior,...patch},dir=entryDir(key);
      writeAtomic(path.join(dir,'previous.json'),JSON.stringify(prior));
      writeAtomic(path.join(dir,'meta.json'),JSON.stringify(rec));
      return rec;
    },
    bytes(key){
      try{
        const b=fs.readFileSync(path.join(entryDir(key),'update.safetensors')),rec=read(key);
        if(b.length===rec?.bytes&&sha256(b)===rec.payload_sha256)return b;
      }catch(error){if(error.code!=='ENOENT')throw error;}
      throw Object.assign(Error('outbox entry corrupt'),{code:'HASH_MISMATCH'});
    },
    pending(){return this.all().filter(r=>!terminal.has(r.state)).sort((a,b)=>a.created_at-b.created_at);},
    accepted(){return this.all().filter(r=>r.state==='accepted'||r.state==='acked');},
    awaitingAck(){return this.all().filter(r=>r.state==='awaiting_ack');},
    all(){return fs.readdirSync(dir).filter(k=>/^[0-9a-f]{64}$/.test(k)).map(read).filter(Boolean);},
    gc(){let n=0;for(const r of this.all())if(terminal.has(r.state)&&!['accepted','acked'].includes(r.state)&&
      now()-(r.closed_at||r.created_at)>RETAIN_MS){fs.rmSync(entryDir(r.key),{recursive:true,force:true});n++;}return n;}
  };
}
