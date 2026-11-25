// Worker agent (spec §8): claim → verify signed task and artifacts → train in the sidecar under Governor
// permits → durable outbox → idempotent upload. Network, policy and lifecycle live here (Node); the
// sidecar only computes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createClient} from './client.mjs';
import {createOutbox} from './outbox.mjs';
import {startSidecar as defaultSidecar} from './sidecar.mjs';
import {verifyJSON} from '../protocol/sign.mjs';
import {sha256,hashJSON} from '../protocol/hash.mjs';
import {decode} from '../protocol/safetensors.mjs';
import {getProfile,verifyTensors,frozenAHash,schemaHash} from '../protocol/schema.mjs';
import {ComputeError} from '../protocol/errors.mjs';
const sleep=(ms,signal)=>new Promise(r=>{const t=setTimeout(r,ms);signal?.addEventListener('abort',()=>{clearTimeout(t);r();},{once:true});});
const jitter=ms=>ms*(0.8+Math.random()*0.4);
const FINAL=['STALE','CONFLICT','DUPLICATE_DIFFERENT','LEASE_EXPIRED','INVALID_SCHEMA','INVALID_TENSOR','NONFINITE','TOKEN_MISMATCH','HASH_MISMATCH','NOT_OWNER','FORBIDDEN_SCOPE','UNSUPPORTED_PROTOCOL'];
export function createWorker({stateDir,identity,link,governor,runtime,capabilities,startSidecar=defaultSidecar,onState=()=>{},onEvent=()=>{},pauseHoldMs=60000,now=Date.now}){
  fs.mkdirSync(path.join(stateDir,'tasks'),{recursive:true});
  const outbox=createOutbox(path.join(stateDir,'outbox'));
  const client=createClient({endpoint:link.endpoint,fingerprint:link.fingerprint,identity});
  let state='CONNECTING',reason=null,session=null,stopping=false,loop=null,hb=null,current=null,sidecar=null,abort=new AbortController(),lastAccepted=null,errors=0;
  const metrics={tasks_accepted:0,tasks_rejected:0,supervised_tokens:0,optimizer_steps:0,busy_ms:0,bytes_in:0,bytes_out:0,last_loss:null,tokens_per_s:null,model_load_s:null,peak_allocated_bytes:null,peak_reserved_bytes:null,mlx_peak_bytes:null,cpu_fraction:null};
  function setState(s,r=null,extra){if(s!==state||r!==reason){state=s;reason=r;onState({state:s,reason:r,task:current?publicTask(current):null,...extra});}}
  const publicTask=t=>({task_id:t.manifest.task_id,round:t.manifest.round,experiment_id:t.manifest.experiment_id,run_id:t.manifest.run_id,step:t.step||0,steps:t.manifest.local_steps,expected_tokens:t.manifest.expected_supervised_tokens});
  const ev=(code,details)=>onEvent({ts:now(),code,details});
  async function connect(){
    setState('CONNECTING');
    await client.syncTime();governor.setServerOffset(client.offset);
    session=await client.post('/v2/devices/session',{});
    if(session.state==='pending'){setState('CONNECTING','pending_approval');}
    clearInterval(hb);hb=setInterval(()=>heartbeat().catch(()=>{}),10000);hb.unref?.();
    await heartbeat();
  }
  async function heartbeat(){
    if(!session)return;
    const b=client.bytes;metrics.bytes_in=b.in;metrics.bytes_out=b.out;
    const caps=capabilities();
    try{
      const r=await client.post('/v2/devices/heartbeat',{session_id:session.session_id,status:{state,pause_reason:reason},metrics:{...metrics},capabilities:caps,runtime_version:caps.runtime_version});
      session.state=r.state;errors=0;
    }catch(e){
      if(e.code==='SESSION_SUPERSEDED'||e.code==='REVOKED'){ev('session.'+e.code.toLowerCase(),{message:e.message});await halt(e.code==='REVOKED'?'revoked':'session_superseded');}
      throw e;
    }
  }
  async function halt(why){stopping=true;abort.abort();setState('ERROR_RECOVERABLE',why);}
  async function flushOutbox(){
    for(const entry of outbox.pending()){
      if(stopping)return;
      const g=governor.decide({phase:'network'});if(!g.run&&g.reason!=='user_active'&&g.reason!=='game')return;   // uploads are tiny; only policy stops block them
      await upload(entry);
    }
  }
  async function upload(entry){
    setState('UPLOADING');
    const m=entry.task;
    const meta={task_id:m.task_id,lease_id:m.lease_id,session_id:session.session_id,idempotency_key:entry.key,payload_sha256:entry.payload_sha256,bytes:entry.bytes,update_kind:'absolute_b',
      experiment_id:m.experiment_id,run_id:m.run_id,round:m.round,base_adapter_hash:m.base_adapter_hash,schema_hash:m.schema_hash,config_hash:m.config_hash,dataset_shard_hash:m.dataset_shard_hash,model_variant_id:m.model_variant_id,...entry.meta};
    try{
      let st=await client.post('/v2/updates',meta);
      outbox.update(entry.key,{state:'declared',update_id:st.update_id,attempts:(entry.attempts||0)+1});
      if(st.state==='declared')st=await client.put(`/v2/updates/${st.update_id}/content`,outbox.bytes(entry.key));
      if(st.state==='uploaded')st=await client.post(`/v2/updates/${st.update_id}/commit`,{session_id:session.session_id});
      const closed=['accepted','rejected','quarantined'].includes(st.state);
      outbox.update(entry.key,{state:st.state==='accepted'?'acked':closed?'rejected':'declared',result:st,closed_at:closed?now():undefined});
      if(st.state==='accepted'){metrics.tasks_accepted++;lastAccepted={at:now(),round:m.round,task_id:m.task_id};ev('update.accepted',{round:m.round,task:m.task_id});}
      else if(closed){metrics.tasks_rejected++;ev('update.'+st.state,{reason:st.reason});}
      setState('WAITING_ROUND');
    }catch(e){
      if(FINAL.includes(e.code)){outbox.update(entry.key,{state:'rejected',result:{code:e.code,message:e.message},closed_at:now()});metrics.tasks_rejected++;ev('update.rejected',{code:e.code,message:e.message});return;}
      ev('upload.retry',{code:e.code,message:e.message});throw e;   // transient: same bytes later
    }
  }
  async function fetchArtifact(sha){
    const r=await client.get('/v2/artifacts/'+sha,{json:false});
    if(sha256(r.bytes)!==sha)throw new ComputeError('HASH_MISMATCH','artifact digest mismatch');
    return r.bytes;
  }
  function verifyTask(m,sig){
    if(!verifyJSON(link.coordinator_key,m,sig))throw new ComputeError('BAD_SIGNATURE','task manifest signature invalid');
    if(m.device_id!==identity.device_id)throw new ComputeError('NOT_OWNER','task issued for another device');
    if(m.task_type!=='ffa_lora_sft'||m.update_kind!=='absolute_b'||m.protocol_version!=='2.0')throw new ComputeError('UNSUPPORTED_PROTOCOL','unsupported task type');
    const p=getProfile(m.model_profile);
    if(m.model_profile!==runtime.profile_id||m.model_variant_id!==runtime.variant_id)throw new ComputeError('INVALID_SCHEMA','task needs another model variant');
    if(m.schema_hash!==schemaHash(p)||m.rank!==p.rank||m.alpha!==p.alpha)throw new ComputeError('INVALID_SCHEMA','task schema differs from the local profile');
    if(!(m.local_steps>=1&&m.local_steps<=200&&m.batch_size===1&&[256,512].includes(m.max_length)))throw new ComputeError('INVALID_SCHEMA','task size outside the allowed range');
    // Only whitelisted fields drive the sidecar: no command, URL or path from the coordinator is ever used.
    return p;
  }
  async function runTask(m,sig){
    const p=verifyTask(m,sig);
    current={manifest:m,step:0};setState('PREPARING');
    const dir=path.join(stateDir,'tasks',m.task_id.replace(/[^\w-]/g,''));fs.mkdirSync(dir,{recursive:true});
    const baseBytes=await fetchArtifact(m.base_adapter_hash),rowsBytes=await fetchArtifact(m.dataset_shard_hash);
    const base=verifyTensors(decode(baseBytes).tensors,p,true);
    if(frozenAHash(base)!==m.frozen_A_hash)throw new ComputeError('FROZEN_A_CHANGED','base adapter A differs from the experiment');
    const rows=JSON.parse(rowsBytes.toString('utf8')).rows;
    if(JSON.stringify(rows.map(r=>r.id))!==JSON.stringify(m.row_ids))throw new ComputeError('HASH_MISMATCH','row set differs from the task');
    if(hashJSON(rows.map(r=>r.target_mask))!==m.mask_checksum)throw new ComputeError('HASH_MISMATCH','mask checksum differs');
    const tokens=rows.reduce((a,r)=>a+r.target_mask.slice(1).filter(Boolean).length,0);
    if(tokens!==m.expected_supervised_tokens)throw new ComputeError('TOKEN_MISMATCH','local supervised token count differs from the task');
    fs.writeFileSync(path.join(dir,'base.safetensors'),baseBytes);fs.writeFileSync(path.join(dir,'rows.json'),rowsBytes);
    const pre=governor.decide({phase:'preflight'});if(!pre.run){await client.post(`/v2/tasks/${m.task_id}/abandon`,{lease_id:m.lease_id,session_id:session.session_id,reason:'policy:'+pre.reason}).catch(()=>{});current=null;return;}
    let leaseLost=false;
    const renewEvery=Math.max(5000,Math.min(30000,m.lease_ttl_seconds*1000/3));
    const renew=setInterval(()=>client.post(`/v2/tasks/${m.task_id}/renew`,{lease_id:m.lease_id,session_id:session.session_id}).catch(e=>{if(['LEASE_EXPIRED','NOT_OWNER','STALE','REVOKED'].includes(e.code)){leaseLost=true;ev('lease.lost',{code:e.code});}}),renewEvery);
    const logical=os.availableParallelism?.()||os.cpus().length,threads=governor.cpuThreads(logical);
    let wallStart=performance.now(),lastAcc=wallStart,pausedSince=null,stopSent=false,result=null;
    const accountNow=(gpuMs=0)=>{const t=performance.now();governor.account({wallMs:t-lastAcc,gpuMs});lastAcc=t;};
    try{
      setState('PREPARING','loading_model');
      sidecar=startSidecar({python:runtime.python,threads,extraEnv:runtime.extraEnv,onLog:l=>ev('sidecar.log',{line:l}),onEvent:async e=>{
        if(e.type==='loaded'){metrics.model_load_s=e.model_load_s??null;setState('TRAINING');}
        if(e.type==='step'){
          current.step=e.step;metrics.last_loss=e.loss;metrics.optimizer_steps++;metrics.busy_ms+=e.compute_ms||0;
          for(const k of ['peak_allocated_bytes','peak_reserved_bytes','mlx_peak_bytes'])if(Number.isFinite(e[k]))metrics[k]=Math.max(metrics[k]||0,e[k]);
          if(e.compute_ms>0)metrics.tokens_per_s=Math.round(e.supervised_tokens/(e.compute_ms/1000)*10)/10;
          if(Number.isFinite(e.cpu_ms)&&e.wall_ms>0)metrics.cpu_fraction=Math.round(e.cpu_ms/e.wall_ms/logical*1000)/1000;
          accountNow(e.compute_ms||0);
          current.sleepMs=governor.afterStep(e.compute_ms||0);
          client.post(`/v2/tasks/${m.task_id}/progress`,{lease_id:m.lease_id,session_id:session.session_id,step:e.step,steps:m.local_steps,supervised_tokens:e.supervised_tokens_total,loss:e.loss,state:'TRAINING'}).catch(()=>{});
          onState({state,reason,task:publicTask(current),metrics:{...metrics}});
        }
        if(e.type==='permit_request')permitLoop(e).catch(err=>ev('permit.error',{message:err.message}));
      }});
      async function permitLoop(e){
        if(current.sleepMs>0){setState('TRAINING','throttle');await sleep(current.sleepMs,abort.signal);accountNow();}
        for(;;){
          if(stopping||leaseLost){if(!stopSent){stopSent=true;sidecar.send({cmd:'stop',id:e.id,reason:stopping?'stopping':'lease_lost'});}return;}
          const d=governor.decide();
          if(d.run){pausedSince=null;setState('TRAINING');sidecar.send({cmd:'permit',id:e.id});return;}
          pausedSince??=performance.now();setState('PAUSED',d.reason);
          if(performance.now()-pausedSince>pauseHoldMs){stopSent=true;sidecar.send({cmd:'stop',id:e.id,reason:'policy:'+d.reason});return;}
          await sleep(1000,abort.signal);
          lastAcc=performance.now();   // paused time is not budget time
        }
      }
      const call=sidecar.call('train',{task:{task_id:m.task_id,lease_id:m.lease_id,round:m.round,local_steps:m.local_steps,grad_accum:m.grad_accum,max_length:m.max_length,optimizer:m.optimizer,rank:m.rank,alpha:m.alpha,
        profile:p.id,targets:p.targets,layers:p.layers,expected_supervised_tokens:m.expected_supervised_tokens,base_adapter_hash:m.base_adapter_hash,frozen_A_hash:m.frozen_A_hash},
        paths:{task_dir:dir,model_dir:runtime.model_dir},backend:runtime.backend});
      result=await call.promise;
    }catch(e){
      if(e.code==='STOPPED'){
        ev('task.stopped',{reason:e.message});
        await client.post(`/v2/tasks/${m.task_id}/abandon`,{lease_id:m.lease_id,session_id:session.session_id,reason:String(e.message).slice(0,60)}).catch(()=>{});
        return;
      }
      ev('task.failed',{code:e.code,message:e.message});
      await client.post(`/v2/tasks/${m.task_id}/abandon`,{lease_id:m.lease_id,session_id:session.session_id,reason:'error:'+String(e.code||'').slice(0,40)}).catch(()=>{});
      throw e;
    }finally{
      clearInterval(renew);accountNow();
      if(sidecar){setState(stopping?'STOPPING':state,'releasing_gpu');await sidecar.stop(10000).catch(()=>{});sidecar=null;}
    }
    // Verify locally before the outbox: exact B schema, finite, complete steps, token count.
    const updBytes=fs.readFileSync(result.update_path);
    verifyTensors(decode(updBytes).tensors,p,false);
    if(result.steps!==m.local_steps||result.supervised_tokens!==m.expected_supervised_tokens||result.a_unchanged!==true)throw new ComputeError('INVALID_SCHEMA','incomplete or inconsistent local result');
    metrics.supervised_tokens+=result.supervised_tokens;
    const entry=outbox.put(m,updBytes,{steps:result.steps,supervised_tokens:result.supervised_tokens,timing:result.timing||{},runtime_version:result.runtime_version,backend:runtime.backend});
    fs.rmSync(path.join(dir,'checkpoint'),{recursive:true,force:true});
    current=null;
    await upload(outbox.pending().find(x=>x.key===entry.key)||entry).catch(()=>{});
  }
  async function main(){
    let backoff=2000;
    while(!stopping){
      try{
        if(!session)await connect();
        await flushOutbox();
        if(session.state==='pending'){setState('CONNECTING','pending_approval');await sleep(5000,abort.signal);await heartbeat().catch(()=>{});continue;}
        const d=governor.decide();
        if(!d.run){setState('PAUSED',d.reason);await sleep(2000,abort.signal);continue;}
        const r=await client.post('/v2/tasks/claim',{session_id:session.session_id,capabilities:capabilities()});
        backoff=2000;
        if(!r.task){setState(r.reason==='waiting_round'?'WAITING_ROUND':'IDLE',r.reason);await sleep(jitter(Math.min(30,r.retry_after_s||5)*1000),abort.signal);continue;}
        await runTask(r.task,r.signature);
      }catch(e){
        if(stopping)break;
        if(['REVOKED','SESSION_SUPERSEDED'].includes(e.code)){await halt(e.code==='REVOKED'?'revoked':'session_superseded');break;}
        setState('ERROR_RECOVERABLE',e.code||'error',{message:e.message});ev('worker.error',{code:e.code,message:e.message});
        if(e.network||e.code==='UNAVAILABLE')session=null;
        await sleep(jitter(backoff),abort.signal);backoff=Math.min(30000,backoff*2);
      }
    }
  }
  return {
    start(){if(!loop){stopping=false;abort=new AbortController();loop=main().finally(()=>{loop=null;});}return loop;},
    async stop(){
      stopping=true;setState('STOPPING',current?'safe_boundary':null);abort.abort();
      try{sidecar?.send({cmd:'stop',id:'*',reason:'stopping'});}catch{}
      const grace=setTimeout(()=>sidecar?.kill(),12000);
      await loop?.catch(()=>{});clearTimeout(grace);clearInterval(hb);governor.save();
      setState('STOPPED');
    },
    get state(){return {state,reason,task:current?publicTask(current):null,metrics:{...metrics},last_accepted:lastAccepted,outbox:outbox.pending().length,session:session?{state:session.state}:null};},
    outbox,client
  };
}
