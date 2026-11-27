import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hashJSON,sha256} from '../protocol/hash.mjs';
import {fail} from '../protocol/errors.mjs';
import {checkStreamLayout,createStreamStore} from './stream.mjs';

// Filesystem counterpart of Compute v0.3's begin/parts/complete protocol. Authorization stays
// with the coordinator's device grant. The result is staged until an expert-specific validator seals it.
export function createDiskUploads(root,{quotaBytes,maxArtifact,maxSessions=8,authorize,seal}){
  if(!Number.isSafeInteger(quotaBytes)||quotaBytes<2||!Number.isSafeInteger(maxArtifact)||maxArtifact<1)fail('INVALID_SCHEMA','upload quota is required');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const disk=createStreamStore(path.join(root,'completed'),{quotaBytes:Math.floor(quotaBytes/2),artifactLimit:maxArtifact});
  const entry=id=>{
    if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))fail('INVALID_SCHEMA','invalid upload identifier');
    return path.join(root,id);
  };
  const manifest=folder=>JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));
  function load(folder){
    if(!fs.existsSync(path.join(folder,'manifest.json')))fail('NOT_FOUND','begin upload first');
    return manifest(folder);
  }
  function missing(folder,m){return m.artifact.parts.flatMap((p,i)=>fs.existsSync(path.join(folder,String(i)))?[]:[i]);}
  function receipt(folder){
    const file=path.join(folder,'receipt.json');
    return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  }
  const completing=new Set();
  function atomic(folder,name,bytes){
    const temporary=path.join(folder,randomUUID()+'.tmp');
    try{fs.writeFileSync(temporary,bytes,{mode:0o600,flag:'wx',flush:true});fs.renameSync(temporary,path.join(folder,name));}
    finally{fs.rmSync(temporary,{force:true});}
  }
  const status=(folder,m)=>({upload_id:m.id,missing:missing(folder,m),receipt:receipt(folder)});
  function prune(){
    for(const dir of fs.readdirSync(root,{withFileTypes:true})){
      if(!dir.isDirectory()||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(dir.name)||completing.has(dir.name))continue;
      const folder=entry(dir.name),m=load(folder);
      if(m.expires<=Date.now())fs.rmSync(folder,{recursive:true,force:true});
    }
  }
  return {
    begin(device,id,{artifact,tokens}){
      const limits=authorize(device,id);
      checkStreamLayout(artifact,{maxBytes:Math.min(maxArtifact,limits.maxBytes)});
      if(tokens!==limits.tokens)fail('TOKEN_MISMATCH','result tokens do not match assignment');
      const declared={sha256:artifact.sha256,bytes:artifact.bytes,chunk_bytes:artifact.chunk_bytes,parts:artifact.parts.map(p=>({sha256:p.sha256,bytes:p.bytes}))};
      prune();
      const folder=entry(id),m={id,device,tokens,expires:limits.expires,artifact:declared};
      if(fs.existsSync(folder)){
        const prior=load(folder);
        if(prior.device!==device||prior.tokens!==tokens||hashJSON(prior.artifact)!==hashJSON(declared))fail('DUPLICATE_DIFFERENT','upload declaration changed');
        return status(folder,prior);
      }
      let reserved=0,count=0;
      for(const dir of fs.readdirSync(root,{withFileTypes:true})){
        if(!dir.isDirectory()||!/^[0-9a-f-]{36}$/.test(dir.name))continue;
        const other=entry(dir.name);
        if(receipt(other))continue;
        const prior=load(other);
        if(prior.device===device)fail('RATE_LIMITED','device has another open Fusion upload');
        reserved+=prior.artifact.bytes;count++;
      }
      const {bavail,bsize}=fs.statfsSync(root);
      if(count>=maxSessions||reserved+declared.bytes>quotaBytes/2||2*declared.bytes>bavail*bsize)fail('DISK_SPACE','Fusion upload quota exceeded');
      fs.mkdirSync(folder,{mode:0o700});
      try{atomic(folder,'manifest.json',JSON.stringify(m));}
      catch(error){fs.rmdirSync(folder);throw error;}
      return status(folder,m);
    },
    put(device,id,index,hash,bytes){
      authorize(device,id);
      const folder=entry(id),m=load(folder);
      if(m.device!==device)fail('NOT_OWNER','Fusion upload belongs to another device');
      const committed=receipt(folder);
      if(committed)return committed;
      if(completing.has(id))fail('CONFLICT','Fusion upload is being sealed');
      const part=Number.isSafeInteger(index)&&index>=0?m.artifact.parts[index]:null;
      if(!part||part.bytes!==bytes.length||part.sha256!==hash||sha256(bytes)!==hash)fail('CHUNK_RETRY','invalid Fusion result part');
      atomic(folder,String(index),bytes);
      return status(folder,m);
    },
    async complete(device,id){
      authorize(device,id);
      const folder=entry(id),m=load(folder);
      if(m.device!==device)fail('NOT_OWNER','Fusion upload belongs to another device');
      const prior=receipt(folder);
      if(prior)return prior;
      if(completing.has(id)||missing(folder,m).length)fail('CONFLICT','Fusion upload is incomplete or already sealing');
      completing.add(id);
      try{
        const result=await disk.receive(m.artifact,(part,i)=>{
          authorize(device,id);
          const file=path.join(folder,String(i)),bytes=fs.readFileSync(file);
          if(bytes.length!==part.bytes||sha256(bytes)!==part.sha256){fs.unlinkSync(file);fail('CHUNK_RETRY','saved Fusion part is corrupt');}
          return bytes;
        },{permit:()=>m.artifact.chunk_bytes});
        authorize(device,id);
        const value=await seal(device,id,m,result.file);
        atomic(folder,'receipt.json',JSON.stringify(value));
        for(const i of m.artifact.parts.keys())fs.rmSync(path.join(folder,String(i)),{force:true});
        return value;
      }finally{completing.delete(id);}
    }
  };
}
