// Bounded buffers on the wire and on disk. A signed artifact descriptor binds every byte range.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fail} from '../protocol/errors.mjs';
import {isHex64,sha256} from '../protocol/hash.mjs';
import {chunkSizes,partLength} from '../protocol/transfer.mjs';

export const MAX_STREAM_BYTES=32*1024**3;
export const MAX_PARTS=8192;
export const STREAM_CHUNK=chunkSizes.at(-1);

export function checkStreamLayout(artifact,{maxBytes=MAX_STREAM_BYTES}={}){
  const {sha256:hash,bytes,chunk_bytes:chunk,parts}=artifact??{};
  if(!isHex64(hash)||!Number.isSafeInteger(bytes)||bytes<1||bytes>maxBytes||!chunkSizes.includes(chunk)||
    !Array.isArray(parts)||parts.length!==Math.ceil(bytes/chunk)||parts.length>MAX_PARTS||
    !parts.every((p,i)=>p&&isHex64(p.sha256)&&p.bytes===partLength(bytes,chunk,i)))fail('INVALID_SCHEMA','invalid streamed artifact layout');
  return artifact;
}

function stat(file){
  const s=fs.lstatSync(file,{throwIfNoEntry:false});
  if(s&&(!s.isFile()||s.isSymbolicLink()))fail('FORBIDDEN_SCOPE','invalid artifact file');
  return s;
}

function readAt(fd,length,offset){
  const buffer=Buffer.allocUnsafe(length);
  let filled=0;
  while(filled<length){
    const count=fs.readSync(fd,buffer,filled,length-filled,offset+filled);
    if(!count)fail('HASH_MISMATCH','artifact ended before its advertised byte length');
    filled+=count;
  }
  return buffer;
}

function writeAt(fd,bytes,offset){
  let written=0;
  while(written<bytes.length){
    const count=fs.writeSync(fd,bytes,written,bytes.length-written,offset+written);
    if(!count)fail('DISK_SPACE','could not store the entire artifact range');
    written+=count;
  }
}

export function hashFile(file,{limit=MAX_STREAM_BYTES,expectedBytes}={}){
  const info=stat(file);
  if(!info||info.size>limit||(expectedBytes!==undefined&&expectedBytes!==info.size))fail('HASH_MISMATCH','artifact size mismatch');
  const whole=createHash('sha256');
  const fd=fs.openSync(file,'r');
  try{
    for(let start=0;start<info.size;start+=STREAM_CHUNK)whole.update(readAt(fd,Math.min(STREAM_CHUNK,info.size-start),start));
    if(fs.fstatSync(fd).size!==info.size)fail('HASH_MISMATCH','artifact size changed while reading');
    return whole.digest('hex');
  }finally{fs.closeSync(fd);}
}

export function indexStoredFile(file,{chunk=STREAM_CHUNK,maxBytes=MAX_STREAM_BYTES}={}){
  const info=stat(file);
  if(!info||!partLength(info.size,chunk,0)||info.size>maxBytes||Math.ceil(info.size/chunk)>MAX_PARTS)fail('TOO_LARGE','artifact exceeds the configured limits');
  const whole=createHash('sha256'),parts=[];
  const fd=fs.openSync(file,'r');
  try{
    for(let p=0;p<info.size;p+=chunk){
      const data=readAt(fd,Math.min(chunk,info.size-p),p);
      whole.update(data);parts.push({sha256:sha256(data),bytes:data.length});
    }
    const after=fs.fstatSync(fd);
    if(info.size!==after.size||info.mtimeMs!==after.mtimeMs)fail('HASH_MISMATCH','stored checkpoint was modified while indexing');
    return {sha256:whole.digest('hex'),bytes:info.size,chunk_bytes:chunk,parts};
  }finally{fs.closeSync(fd);}
}

export function readStoredPart(file,artifact,index){
  const part=artifact.parts[index];
  if(!part||part.bytes!==partLength(artifact.bytes,artifact.chunk_bytes,index)||stat(file)?.size!==artifact.bytes)
    fail('HASH_MISMATCH','invalid stored checkpoint part');
  const fd=fs.openSync(file,'r');
  try{
    const bytes=readAt(fd,part.bytes,index*artifact.chunk_bytes);
    if(sha256(bytes)!==part.sha256)fail('HASH_MISMATCH','stored checkpoint part digest mismatch');
    return bytes;
  }finally{fs.closeSync(fd);}
}

// The callback persists each chunk to CAS or hands it to a transport. It never receives the entire file.
export async function indexArtifact(file,{onChunk=()=>{},chunk=STREAM_CHUNK,maxBytes=MAX_STREAM_BYTES,expectedHash,signal}={}){
  const info=stat(file);
  if(!info||!partLength(info.size,chunk,0)||info.size>maxBytes||Math.ceil(info.size/chunk)>MAX_PARTS)fail('TOO_LARGE','artifact exceeds the configured limits');
  const whole=createHash('sha256'),parts=[];
  const fd=fs.openSync(file,'r');
  try{
    for(let pos=0;pos<info.size;pos+=chunk){
      signal?.throwIfAborted();
      const bytes=readAt(fd,Math.min(chunk,info.size-pos),pos);
      const part={sha256:sha256(bytes),bytes:bytes.length};
      whole.update(bytes);
      await onChunk(part,bytes);
      parts.push(part);
    }
    const after=fs.fstatSync(fd),hash=whole.digest('hex');
    if(info.mtimeMs!==after.mtimeMs||info.size!==after.size||(expectedHash&&expectedHash!==hash))fail('HASH_MISMATCH','artifact was modified or differs from its pinned digest');
    return {sha256:hash,bytes:info.size,chunk_bytes:chunk,parts};
  }finally{fs.closeSync(fd);}
}

function atomic(file,text){
  const tmp=file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(tmp,text,{flag:'wx',flush:true,mode:0o600});fs.renameSync(tmp,file);}
  finally{fs.rmSync(tmp,{force:true});}
}

export function createStreamStore(root,{quotaBytes,artifactLimit=MAX_STREAM_BYTES,onEvent=()=>{}}){
  if(!Number.isSafeInteger(quotaBytes)||quotaBytes<1||!Number.isSafeInteger(artifactLimit)||artifactLimit<1||artifactLimit>MAX_STREAM_BYTES)
    fail('INVALID_SCHEMA','invalid Fusion transfer quota');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const running=new Set();
  const names=hash=>({complete:path.join(root,hash),partial:path.join(root,hash+'.partial'),ledger:path.join(root,hash+'.json')});
  function quota(artifact){
    let reserved=0;
    for(const entry of fs.readdirSync(root,{withFileTypes:true})){
      const file=path.join(root,entry.name);
      if(entry.isFile()&&isHex64(entry.name))reserved+=stat(file).size;
      if(entry.isFile()&&/^[0-9a-f]{64}\.json$/.test(entry.name)){
        const hash=entry.name.slice(0,64);
        if(hash===artifact.sha256||stat(names(hash).complete))continue;
        const size=JSON.parse(fs.readFileSync(file,'utf8')).bytes;
        if(!Number.isSafeInteger(size)||size<1||size>MAX_STREAM_BYTES)fail('DISK_SPACE','invalid recorded transfer reservation');
        reserved+=size;
      }
    }
    const {bavail,bsize}=fs.statfsSync(root);
    if(reserved+artifact.bytes>quotaBytes||artifact.bytes-(stat(names(artifact.sha256).partial)?.size??0)>bavail*bsize)
      fail('DISK_SPACE','Fusion artifact quota or free disk space exceeded');
  }
  function resolve(artifact){
    const file=names(artifact.sha256).complete;
    if(!stat(file))return null;
    if(hashFile(file,{expectedBytes:artifact.bytes})!==artifact.sha256)fail('HASH_MISMATCH','stored streamed artifact is corrupt');
    return file;
  }
  return {
    async receive(artifact,fetch,{permit=()=>0,signal}={}){
      checkStreamLayout(artifact,{maxBytes:artifactLimit});
      const existing=resolve(artifact);
      if(existing)return {file:existing,reused:artifact.parts.length,received:0};
      if(running.has(artifact.sha256))fail('CONFLICT','transfer is already open');
      const {complete,partial,ledger}=names(artifact.sha256);
      const received=new Set();
      running.add(artifact.sha256);
      let fd;
      try{
        quota(artifact);
        if(stat(ledger)){
          const old=JSON.parse(fs.readFileSync(ledger,'utf8'));
          if(old.chunk_bytes===artifact.chunk_bytes&&old.bytes===artifact.bytes&&Array.isArray(old.received)){
            for(const i of old.received)if(partLength(artifact.bytes,artifact.chunk_bytes,i))received.add(i);
          }
        }
        if(!stat(partial))received.clear();
        const save=()=>atomic(ledger,JSON.stringify({bytes:artifact.bytes,chunk_bytes:artifact.chunk_bytes,received:[...received]}));
        save();
        fd=fs.openSync(partial,stat(partial)?'r+':'wx+',0o600);
        let reused=0,downloads=0;
        for(const [i,part] of artifact.parts.entries()){
          signal?.throwIfAborted();
          const start=i*artifact.chunk_bytes;
          if(received.has(i)&&start+part.bytes<=fs.fstatSync(fd).size&&sha256(readAt(fd,part.bytes,start))===part.sha256){reused++;continue;}
          if(permit()<part.bytes)fail('TRAFFIC_CAP','artifact part exceeds transfer budget');
          const bytes=await fetch(part,i,{signal,maxBytes:part.bytes});
          if(!Buffer.isBuffer(bytes)||bytes.length!==part.bytes||sha256(bytes)!==part.sha256)fail('CHUNK_RETRY','artifact part failed its checksum');
          signal?.throwIfAborted();
          writeAt(fd,bytes,start);
          fs.fsyncSync(fd);
          received.add(i);downloads++;
          save();
          onEvent({part:i,bytes:part.bytes,received:received.size,parts:artifact.parts.length});
        }
        fs.ftruncateSync(fd,artifact.bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
        if(hashFile(partial,{expectedBytes:artifact.bytes})!==artifact.sha256)fail('HASH_MISMATCH','completed artifact checksum mismatch');
        fs.renameSync(partial,complete);
        fs.rmSync(ledger,{force:true});
        return {file:complete,reused,received:downloads};
      }finally{if(fd!==undefined)fs.closeSync(fd);running.delete(artifact.sha256);}
    },
    file(artifact){checkStreamLayout(artifact,{maxBytes:artifactLimit});return resolve(artifact);},
    discard(hash){
      if(!isHex64(hash)||running.has(hash))fail('CONFLICT','streamed artifact is still in use');
      for(const file of Object.values(names(hash)))fs.rmSync(file,{force:true});
    }
  };
}
