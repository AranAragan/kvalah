import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256} from '../protocol/hash.mjs';
import {ComputeError} from '../protocol/errors.mjs';

export function createArtifactCache(dir,{limitBytes,onEvent=()=>{}}) {
  fs.mkdirSync(dir,{recursive:true});
  const pending=new Map();
  const key=/^[0-9a-f]{64}$/;
  if(!fs.lstatSync(dir).isDirectory()||fs.lstatSync(dir).isSymbolicLink())throw Error('invalid artifact cache directory');

  function read(file,hash) {
    try {
      const info=fs.lstatSync(file);
      if(info.isFile()&&!info.isSymbolicLink()){
        const bytes=fs.readFileSync(file);
        if(sha256(bytes)===hash){
          const now=new Date();
          fs.utimesSync(file,now,now);
          onEvent('cache.hit',{bytes:bytes.length});
          return bytes;
        }
      }
      fs.unlinkSync(file);
      onEvent('cache.corrupt',{});
    }catch(error){
      if(error.code!=='ENOENT')throw error;
    }
    return null;
  }

  function reserve(bytes) {
    if(bytes>limitBytes())throw new ComputeError('UNAVAILABLE','artifact exceeds the cache disk quota');
    const files=fs.readdirSync(dir,{withFileTypes:true})
      .filter(entry=>entry.isFile()&&key.test(entry.name))
      .map(entry=>{const file=path.join(dir,entry.name);const stat=fs.statSync(file,{throwIfNoEntry:false});return {file,stat};})
      .filter(entry=>entry.stat)
      .sort((a,b)=>a.stat.mtimeMs-b.stat.mtimeMs);
    let used=files.reduce((sum,entry)=>sum+entry.stat.size,0);
    for(const {file,stat} of files){
      if(used+bytes<=limitBytes())break;
      fs.rmSync(file,{force:true});
      used-=stat.size;
      onEvent('cache.evicted',{bytes:stat.size});
    }
    const {bavail,bsize}=fs.statfsSync(dir);
    if(used+bytes>limitBytes()||bavail*bsize<bytes)throw new ComputeError('UNAVAILABLE','insufficient disk space for the artifact cache');
  }

  return {
    async get(hash,download,expectedBytes){
      if(!key.test(hash))throw new ComputeError('INVALID_SCHEMA','invalid artifact digest');
      if(pending.has(hash))return pending.get(hash);
      const work=(async()=>{
        const file=path.join(dir,hash),hit=read(file,hash);
        if(hit)return hit;
        onEvent('cache.miss',{});
        reserve(expectedBytes??16*1024*1024);
        const bytes=await download();
        if(sha256(bytes)!==hash)throw new ComputeError('HASH_MISMATCH','artifact digest mismatch');
        reserve(bytes.length);
        const temporary=file+'.'+randomUUID()+'.tmp';
        try{
          const fd=fs.openSync(temporary,'wx',0o600);
          try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
          fs.renameSync(temporary,file);
        }finally{fs.rmSync(temporary,{force:true});}
        return bytes;
      })();
      pending.set(hash,work);
      try{return await work;}finally{pending.delete(hash);}
    }
  };
}
