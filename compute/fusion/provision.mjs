import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createArtifactCache} from '../worker/artifacts.mjs';
import {canonicalJSON,isHex64,sha256} from '../protocol/hash.mjs';
import {chunkSizes,defaultChunkSize} from '../protocol/transfer.mjs';
import {fail} from '../protocol/errors.mjs';
import {verifyEnvelope} from './registry.mjs';

const MAX_ARTIFACT=64*1024*1024;
const kinds=new Set(['backbone','tokenizer','expert','train','architecture','runtime-lock']);

// Build descriptors from locally registered bytes. Logical names never become peer-controlled paths.
export function putArtifact(cas,kind,bytes,source,chunkBytes=defaultChunkSize){
  if(!kinds.has(kind)||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_ARTIFACT||!chunkSizes.includes(chunkBytes)||
    typeof source!=='string'||!source.trim()||source.length>256)fail('INVALID_SCHEMA','invalid provisioned artifact');
  const parts=[];
  for(let start=0;start<bytes.length;start+=chunkBytes){
    const part=bytes.subarray(start,start+chunkBytes);
    parts.push({sha256:cas.put(part),bytes:part.length});
  }
  return {kind,sha256:cas.put(bytes),bytes:bytes.length,source,chunk_bytes:chunkBytes,parts};
}

function checkArtifacts(artifacts){
  if(!Array.isArray(artifacts)||artifacts.length<1||artifacts.length>64)fail('INVALID_SCHEMA','invalid provision artifact list');
  for(const a of artifacts){
    if(!a||!kinds.has(a.kind)||!isHex64(a.sha256)||!Number.isSafeInteger(a.bytes)||a.bytes<=0||a.bytes>MAX_ARTIFACT||
      typeof a.source!=='string'||!a.source||a.source.length>256||!chunkSizes.includes(a.chunk_bytes)||!Array.isArray(a.parts)||
      a.parts.length!==Math.ceil(a.bytes/a.chunk_bytes)||!a.parts.every((p,i)=>p&&isHex64(p.sha256)&&p.bytes===Math.min(a.bytes-i*a.chunk_bytes,a.chunk_bytes)))
      fail('INVALID_SCHEMA','invalid provision chunk manifest');
  }
}

export function signAssignment(registry,{device,expert,artifacts,ttl=3600000,now=Date.now()}){
  checkArtifacts(artifacts);
  if(typeof device!=='string'||!device||device.length>128||!expert?.checkpoint||!Number.isSafeInteger(ttl)||ttl<=0||ttl>24*3600000||
    artifacts.filter(a=>a.kind==='expert').length!==1||artifacts.find(a=>a.kind==='expert')?.sha256!==expert.checkpoint.hash||
    !artifacts.some(a=>a.kind==='train'))fail('INVALID_SCHEMA','assignment requires a pinned expert and its training shard');
  return registry.signed({kind:'assignment',id:randomUUID(),device,expert:expert.id,parent:expert.checkpoint.hash,schema:expert.schema_sha256,
    base:expert.base,expires:now+ttl,artifacts});
}

export function validateAssignment(envelope,{publicKey,device,now=Date.now()}){
  const m=verifyEnvelope(envelope,publicKey);
  if(m.kind!=='assignment'||m.device!==device||!Number.isSafeInteger(m.expires)||m.expires<=now||!isHex64(m.parent)||!isHex64(m.schema))
    fail('FORBIDDEN_SCOPE','assignment expired or is bound to another device');
  checkArtifacts(m.artifacts);
  return m;
}

export function createProvisionStore({root,quotaBytes,onEvent=()=>{}}){
  if(!Number.isSafeInteger(quotaBytes)||quotaBytes<2*MAX_ARTIFACT)fail('INVALID_SCHEMA','provision cache quota is too small');
  const complete=createArtifactCache(path.join(root,'complete'),{limitBytes:()=>Math.floor(quotaBytes/2),onEvent});
  const partial=createArtifactCache(path.join(root,'parts'),{limitBytes:()=>Math.floor(quotaBytes/2),onEvent});
  return {
    async provision(envelope,{publicKey,device,consented,fetchCoordinator,peers=[],allowPeerDownload=false,permit=()=>0,charge=()=>{},signal}){
      if(!consented)fail('FORBIDDEN_SCOPE','artifact provisioning requires local consent');
      const manifest=validateAssignment(envelope,{publicKey,device});
      const items=[];
      for(const artifact of manifest.artifacts){
        signal?.throwIfAborted();
        const bytes=await complete.get(artifact.sha256,async()=>{
          const buffers=[];
          for(const part of artifact.parts){
            signal?.throwIfAborted();
            if(manifest.expires<=Date.now())fail('FORBIDDEN_SCOPE','artifact assignment expired');
            const bytes=await partial.get(part.sha256,async()=>{
              const sources=allowPeerDownload?peers.slice(0,4):[];
              for(const fetch of [...sources,fetchCoordinator]){
                signal?.throwIfAborted();
                if(permit()<part.bytes)fail('TRAFFIC_CAP','the next chunk exceeds the local traffic budget');
                // The transport charges actual bytes, including invalid/truncated peer responses.
                let response;
                try{response=await fetch(manifest,part,{signal,maxBytes:part.bytes,charge});}catch(error){
                  if(signal?.aborted||error.code==='TRAFFIC_CAP'||fetch===fetchCoordinator)throw error;
                  continue;
                }
                if(Buffer.isBuffer(response)&&response.length===part.bytes&&sha256(response)===part.sha256)return response;
              }
              fail('HASH_MISMATCH','artifact chunk failed size or hash validation');
            },part.bytes);
            buffers.push(bytes);
          }
          return Buffer.concat(buffers,artifact.bytes);
        },artifact.bytes);
        if(bytes.length!==artifact.bytes)fail('HASH_MISMATCH','incorrect artifact length');
        items.push({kind:artifact.kind,sha256:artifact.sha256,bytes});
      }
      return {assignment:manifest.id,expert:manifest.expert,items};
    }
  };
}

// Coordinator-side publication is separate from its existing artifact ACL. Signed, expiring
// grants are indexed by the authenticated device and checked again for every ranged operation.
export function createGrantStore(registry,root){
  fs.mkdirSync(root,{recursive:true});
  const file=id=>{
    if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(id))fail('INVALID_SCHEMA','invalid device identity');
    return path.join(root,id+'.json');
  };
  function find(device){
    try{return JSON.parse(fs.readFileSync(file(device),'utf8'));}catch(e){if(e.code==='ENOENT')fail('NOT_FOUND','no expert assigned');throw e;}
  }
  return {
    grant(envelope){
      const parsed=validateAssignment(envelope,{device:envelope.manifest.device,publicKey:registry.publicKey});
      const dest=file(parsed.device),temp=dest+'.'+randomUUID();
      try{fs.writeFileSync(temp,canonicalJSON(envelope),{flag:'wx',mode:0o600,flush:true});fs.renameSync(temp,dest);}
      finally{fs.rmSync(temp,{force:true});}
      return parsed.id;
    },
    revoke(device){fs.rmSync(file(device),{force:true});},
    manifest(device){const envelope=find(device);validateAssignment(envelope,{device,publicKey:registry.publicKey});return {envelope,publicKey:registry.publicKey};},
    chunk(device,assignment,hash){
      const m=validateAssignment(find(device),{device,publicKey:registry.publicKey});
      const part=m.artifacts.flatMap(a=>a.parts).find(p=>p.sha256===hash);
      if(m.id!==assignment||!part)fail('FORBIDDEN_SCOPE','chunk is outside the active assignment');
      const result=registry.cas.get(hash);
      if(result.length!==part.bytes)fail('HASH_MISMATCH','chunk length does not match assignment');
      return result;
    }
  };
}
