// Worker agent (spec §8): claim → verify signed task and artifacts → train in the sidecar under Governor
// permits → durable outbox → idempotent upload. Network, policy and lifecycle live here (Node); the
// sidecar only computes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createClient} from './client.mjs';
import {createOutbox} from './outbox.mjs';
import {createArtifactCache} from './artifacts.mjs';
import {maintainLease} from './lease.mjs';
import {startSidecar as defaultSidecar} from './sidecar.mjs';
import {verifyJSON} from '../protocol/sign.mjs';
import {hashJSON,sha256} from '../protocol/hash.mjs';
import {defaultChunkSize,chunkSizes} from '../protocol/transfer.mjs';
import {decode} from '../protocol/safetensors.mjs';
import {getProfile,verifyTensors,frozenAHash,schemaHash,trainableCount} from '../protocol/schema.mjs';
import {ComputeError} from '../protocol/errors.mjs';
import {isPrivateAddress} from '../../lan.mjs';
const sleep=(ms,signal)=>delay(ms,undefined,{signal}).catch(error=>{if(error.name!=='AbortError')throw error;});
const jitter=ms=>ms*(0.8+Math.random()*0.4);
const FINAL=['STALE','CONFLICT','DUPLICATE_DIFFERENT','LEASE_EXPIRED','INVALID_SCHEMA','INVALID_TENSOR','NONFINITE','UPDATE_NORM_LIMIT','TOKEN_MISMATCH','HASH_MISMATCH','NOT_OWNER','FORBIDDEN_SCOPE','UNSUPPORTED_PROTOCOL'];
export function createWorker({stateDir,identity,link,governor,runtime,capabilities,startSidecar=defaultSidecar,onState=()=>{},onEvent=()=>{},pauseHoldMs=60000,now=Date.now,makeClient=createClient}){
  fs.mkdirSync(path.join(stateDir,'tasks'),{recursive:true});
  const outbox=createOutbox(path.join(stateDir,'outbox'),{now});
  const scope=hashJSON([link.project_id,link.endpoint,link.fingerprint,identity.device_id]);
  const address=new URL(link.endpoint).hostname.replace(/^\[|\]$/g,'');
  const trafficScope=isPrivateAddress(address)||address==='localhost'?'lan':'wan';
  const trafficRemaining=()=>governor.trafficRemaining(trafficScope);
  const networkDecision=()=>governor.decide({phase:'network',scope:trafficScope});
  const client=makeClient({endpoint:link.endpoint,fingerprint:link.fingerprint,identity,
    onTraffic:(bytes,direction)=>governor.accountTraffic(bytes,direction,trafficScope),
    onRequest:info=>{metrics.transfer_ms=(metrics.transfer_ms||0)+info.duration_ms;ev('rpc.transfer',info);}});
  const cache=createArtifactCache(path.join(stateDir,'cache-v1',scope),{limitBytes:()=>governor.policy.cache_limit_gib*2**30,onEvent:(code,details)=>ev(code,details)});
  const serverNow=()=>now()+(client.offset||0);
  const entries=()=>outbox.pending().filter(e=>e.scope===scope);
  let state='CONNECTING',reason=null,session=null,stopping=false,loop=null,hb=null,current=null,sidecar=null,abort=new AbortController(),lastAccepted=null,lastRpcError=null,heartbeatRunning=false;
  let sidecarEvents=null,idleWatch=null,sidecarClosing=null,sidecarThreads=null;
  const runtimeMode=()=>governor.policy.runtime_mode??(governor.policy.keep_warm?'warm':'cold');
  const metrics={tasks_accepted:0,tasks_rejected:0,accepted_tokens:0,supervised_tokens:0,optimizer_steps:0,busy_ms:0,bytes_in:0,bytes_out:0,last_loss:null,tokens_per_s:null,model_load_s:null,peak_allocated_bytes:null,peak_reserved_bytes:null,mlx_peak_bytes:null,cpu_fraction:null};
  const acceptedIds=new Set();
  for(const entry of outbox.all().filter(e=>e.scope===scope&&['accepted','committed','acked'].includes(e.state)).sort((a,b)=>a.closed_at-b.closed_at)){
    const id=entry.result?.update_id;
    if(!id||acceptedIds.has(id))continue;
    acceptedIds.add(id);
    metrics.tasks_accepted++;
    metrics.accepted_tokens+=entry.meta.supervised_tokens||0;
    lastAccepted={at:entry.closed_at,round:entry.task.round,task_id:entry.task.task_id};
  }
  outbox.gc();
  function setState(s,r=null,extra){if(s!==state||r!==reason){state=s;reason=r;onState({state:s,reason:r,task:current?publicTask(current):null,...extra});}}
  const publicTask=t=>({task_id:t.manifest.task_id,round:t.manifest.round,experiment_id:t.manifest.experiment_id,run_id:t.manifest.run_id,step:t.step||0,steps:t.manifest.local_steps,expected_tokens:t.manifest.expected_supervised_tokens,lease:t.lease?.snapshot??null});
  const ev=(code,details)=>onEvent({ts:now(),code,details});
  async function connect(){
    setState('CONNECTING');
    await client.syncTime();governor.setServerOffset(client.offset);
    session=await client.post('/v2/devices/session',{});
    if(session.state==='pending'){setState('CONNECTING','pending_approval');}
    clearInterval(hb);hb=setInterval(()=>heartbeat().catch(()=>{}),10000);hb.unref?.();
    await heartbeat();
  }
  async function reconcileAccepted(){
    const entries=[...outbox.awaitingAck(),...outbox.accepted()].filter(e=>e.scope===scope&&(e.result?.update_id||e.update_id)&&
      (!e.last_status_check||now()-e.last_status_check>=60000));
    for(const entry of entries.slice(0,4)){
      const st=await client.get('/v2/updates/'+(entry.result?.update_id||entry.update_id)+'/status',{signal:abort.signal});
      if(st.task_id!==entry.task.task_id||st.payload_sha256!==entry.payload_sha256)continue;
      if(entry.state==='awaiting_ack'){
        if(['accepted','rejected','quarantined'].includes(st.state))closeUpdate(entry,st);
        else closeUpdate(entry,{state:'expired',reason:'LEASE_EXPIRED',update_id:st.update_id});
        continue;
      }
      outbox.update(entry.key,{last_status_check:now(),result:st,
        ...(st.round_state==='COMMITTED'?{state:'committed',closed_at:now()}:null)});
    }
  }
  async function heartbeat(){
    if(!session||heartbeatRunning||stopping)return;
    heartbeatRunning=true;
    const b=client.bytes;metrics.bytes_in=b.in;metrics.bytes_out=b.out;
    const caps=capabilities();
    try{
      const admission=governor.decide({phase:'admission'}),network=networkDecision();
      const r=await client.post('/v2/devices/heartbeat',{session_id:session.session_id,status:{state,pause_reason:reason,
        eligible:admission.run&&network.run&&state!=='BLOCKED_BY_TRAFFIC_POLICY',blocking_reason:admission.reason||network.reason||
          (state==='BLOCKED_BY_TRAFFIC_POLICY'?'traffic_cap':null)},
        metrics:{...metrics,traffic_remaining:trafficRemaining(),temperature_c:governor.sensors?.gpu?.temperature_c??null,
          ram_available_bytes:governor.sensors?.ram_available_bytes??governor.sensors?.ram_free_bytes??null,
          vram_used_bytes:governor.sensors?.gpu?.memory_used_bytes??null,power_w:governor.sensors?.gpu?.power_w??null},
        capabilities:caps,runtime_version:caps.runtime_version},{signal:abort.signal});
      session.state=r.state;
      if(!current&&session.state==='active')await reconcileAccepted();
    }catch(e){
      if(e.code==='SESSION_SUPERSEDED'||e.code==='REVOKED'){ev('session.'+e.code.toLowerCase(),{message:e.message});await halt(e.code==='REVOKED'?'revoked':'session_superseded');}
      if(!stopping)recordRpcError('heartbeat.error',e);
      throw e;
    }finally{heartbeatRunning=false;}
  }
  async function halt(why){stopping=true;abort.abort();setState('ERROR_RECOVERABLE',why);}
  function recordRpcError(code,error,details={}){
    if(error.rpc)lastRpcError={at:now(),...error.rpc,...details};
    ev(code,{code:error.code,...error.rpc,...details});
  }
  function renew(m,signal){
    const phase=state==='UPLOADING'?'upload':state==='PAUSED'?'paused':state==='TRAINING'?'compute':'prepare';
    return client.post('/v2/tasks/'+m.task_id+'/renew',{lease_id:m.lease_id,session_id:session.session_id,phase},{signal:AbortSignal.any([abort.signal,signal])});
  }
  function leaseFor(m){
    return maintainLease({task:m,renew:signal=>renew(m,signal),serverNow,onEvent:ev});
  }
  function closeUpdate(entry,status){
    const accepted=status.state==='accepted';
    const phase=accepted?(status.round_state==='COMMITTED'?'committed':'accepted'):status.state;
    outbox.update(entry.key,{state:phase,result:status,closed_at:now()});
    if(accepted&&!acceptedIds.has(status.update_id)){
      acceptedIds.add(status.update_id);
      metrics.tasks_accepted++;
      metrics.accepted_tokens+=entry.meta.supervised_tokens;
      lastAccepted={at:now(),round:entry.task.round,task_id:entry.task.task_id};
    }else if(!accepted)metrics.tasks_rejected++;
    ev('update.'+status.state,{round:entry.task.round,task:entry.task.task_id,reason:status.reason});
  }
  function payloadOptions(lease){
    lease.check();
    const g=networkDecision();
    if(!g.run&&!['user_active','game'].includes(g.reason)){
      const error=new ComputeError(g.reason==='traffic_cap'?'TRAFFIC_CAP':'UNAVAILABLE',g.reason);
      error.policyReason=g.reason;
      throw error;
    }
    return {signal:AbortSignal.any([abort.signal,lease.signal]),payload:true,maxPayload:trafficRemaining()};
  }
  function blockedByTraffic(){
    setState('BLOCKED_BY_TRAFFIC_POLICY','traffic_cap');
  }
  async function upload(entry,lease,options){
    const id=entry.update_id,p='/v2/updates/'+id,sid=session.session_id;
    const bytes=outbox.bytes(entry.key);
    if(governor.policy.transfer_mode==='legacy'||!client.features?.includes('chunked-update-v1'))
      return client.put(p+'/content?session_id='+encodeURIComponent(sid),bytes,payloadOptions(lease));
    const body={session_id:sid,chunk_bytes:governor.policy.update_chunk_bytes??defaultChunkSize};
    let progress=await client.post(p+'/transfer/begin',body,options);
    if(progress.state!=='declared')return progress;
    const size=progress.chunk_bytes;
    if(progress.upload_id!==id||!chunkSizes.includes(size)||!Array.isArray(progress.missing)||
        progress.missing.some(i=>!Number.isSafeInteger(i)||i<0||i>=Math.ceil(bytes.length/size)))
      throw new ComputeError('INVALID_SCHEMA','invalid upload status');
    const required=progress.missing.reduce((n,i)=>n+Math.min(size,bytes.length-i*size),0);
    if(required>trafficRemaining())throw new ComputeError('TRAFFIC_CAP','missing chunks exceed traffic budget');
    for(const i of progress.missing){
      const chunk=bytes.subarray(i*size,(i+1)*size);
      const params=new URLSearchParams({session_id:sid,sha256:sha256(chunk)});
      progress=await client.put(p+'/parts/'+i+'?'+params,chunk,payloadOptions(lease));
      outbox.update(entry.key,{state:'uploading',upload_id:id,chunk_bytes:size,confirmed_chunks:progress.received??[]});
      metrics.uploaded_chunks=progress.received?.length??0;
      metrics.total_chunks=Math.ceil(bytes.length/size);
    }
    return client.post(p+'/transfer/complete',body,options);
  }
  async function deliver(initial,activeLease){
    let entry=initial,lease=activeLease;
    const m=entry.task,options={signal:abort.signal};
    try{
      try{verifyTask(m,entry.signature,{delivery:true});}
      catch(error){closeUpdate(entry,{state:'corrupt',reason:error.code});return;}
      if(!current)current={manifest:m,step:entry.meta.steps,lease};
      while(!stopping){
        try{
          setState('UPLOADING',entry.attempts?'retrying':null);
          let st;
          if(entry.update_id){
            st=await client.get('/v2/updates/'+entry.update_id+'/status',options);
          }else{
            const meta={...entry.meta,task_id:m.task_id,lease_id:m.lease_id,session_id:session.session_id,idempotency_key:entry.key,
              payload_sha256:entry.payload_sha256,bytes:entry.bytes,update_kind:'absolute_b',
              experiment_id:m.experiment_id,run_id:m.run_id,round:m.round,base_adapter_hash:m.base_adapter_hash,
              schema_hash:m.schema_hash,config_hash:m.config_hash,dataset_shard_hash:m.dataset_shard_hash,model_variant_id:m.model_variant_id};
            st=await client.post('/v2/updates',meta,options);
          }
          if(st.task_id!==m.task_id||st.payload_sha256!==entry.payload_sha256)throw new ComputeError('HASH_MISMATCH','coordinator status does not match the saved update');
          if(['accepted','rejected','quarantined'].includes(st.state)){closeUpdate(entry,st);return;}
          entry=outbox.update(entry.key,{state:st.state,update_id:st.update_id});
          if(!lease){
            const renewed=await renew(m,abort.signal);
            lease=leaseFor({...m,lease_expires_at:renewed.lease_expires_at});
            current.lease=lease;
          }
          lease.check();
          if(st.state==='declared'){
            st=await upload(entry,lease,options);
            entry=outbox.update(entry.key,{state:st.state});
          }
          if(st.state==='uploaded'){
            lease.check();
            entry=outbox.update(entry.key,{state:'committing'});
            st=await client.post('/v2/updates/'+st.update_id+'/commit',{session_id:session.session_id},options);
          }
          if(['accepted','rejected','quarantined'].includes(st.state)){closeUpdate(entry,st);return;}
          throw new ComputeError('INVALID_TRANSITION','unexpected update state');
        }catch(error){
          if(stopping)return;
          if(['REVOKED','SESSION_SUPERSEDED'].includes(error.code))throw error;
          if(error.code==='CLOCK_SKEW'){
            await client.syncTime().catch(err=>recordRpcError('clock.error',err));
          }
          const expired=error.code==='LEASE_EXPIRED'||serverNow()>=m.round_deadline_at;
          if(expired&&entry.update_id){
            try{
              const st=await client.get('/v2/updates/'+entry.update_id+'/status',options);
              if(st.task_id===m.task_id&&st.payload_sha256===entry.payload_sha256&&['accepted','rejected','quarantined'].includes(st.state)){
                closeUpdate(entry,st);return;
              }
            }catch{
              outbox.update(entry.key,{state:'awaiting_ack',last_error:{code:error.code},closed_at:now()});
              return;
            }
          }
          if(expired||FINAL.includes(error.code)||(!['CLOCK_SKEW','CHUNK_RETRY'].includes(error.code)&&[400,401,403,404,409,413,422].includes(error.status))){
            // The commit reply and a concurrent renewal can race. Reconcile on the next pass after
            // a lost reply, even after the local lease timer has fired.
            closeUpdate(entry,{state:expired?'expired':error.code==='HASH_MISMATCH'?'corrupt':'rejected',reason:error.code});
            return;
          }
          if(error.code==='TRAFFIC_CAP'){
            blockedByTraffic();
            const prior=trafficRemaining();
            outbox.update(entry.key,{state:'blocked',last_error:{code:error.code}});
            while(!stopping&&serverNow()<m.round_deadline_at&&!lease?.signal.aborted&&trafficRemaining()<=prior)
              await sleep(3000,abort.signal);
            continue;
          }
          const attempts=entry.attempts+1;
          const ms=Math.max(jitter(Math.min(30000,1000*2**Math.min(5,attempts-1))),1000*(error.retryAfter||0));
          const retry=Math.min(ms,Math.max(0,m.round_deadline_at-serverNow()));
          entry=outbox.update(entry.key,{state:'retry_wait',attempts,next_retry_at:now()+retry,last_error:error.rpc??{code:error.code}});
          recordRpcError('upload.retry',error,{next_retry_at:entry.next_retry_at,attempt:attempts});
          setState(error.policyReason?'PAUSED':'UPLOADING',error.policyReason||error.code||'retry_wait');
          await sleep(retry,abort.signal);
        }
      }
    }finally{
      if(lease!==activeLease)lease?.stop();
      if(!activeLease)current=null;
    }
  }
  async function fetchArtifact(sha,bytes,lease,reserve){
    return cache.get(sha,async()=>{
      const opts=payloadOptions(lease);
      opts.maxPayload=Math.max(0,opts.maxPayload-reserve);
      if(Number.isSafeInteger(bytes)&&bytes>opts.maxPayload)throw new ComputeError('TRAFFIC_CAP','artifact exceeds the remaining traffic budget');
      const r=await client.get('/v2/artifacts/'+sha,{...opts,json:false});
      return r.bytes;
    },bytes);
  }
  function verifyTask(m,sig,{delivery=false}={}){
    if(!verifyJSON(link.coordinator_key,m,sig))throw new ComputeError('BAD_SIGNATURE','task manifest signature invalid');
    if(m.project_id!==link.project_id||m.device_id!==identity.device_id)throw new ComputeError('NOT_OWNER','task issued for another device');
    if(!/^task-[\w-]+$/.test(m.task_id)||!/^lease-[a-f0-9]+$/.test(m.lease_id)||
      !Number.isSafeInteger(m.lease_expires_at)||!Number.isSafeInteger(m.round_deadline_at)||m.lease_expires_at>m.round_deadline_at){
      throw new ComputeError('INVALID_SCHEMA','invalid task lease');
    }
    if(m.task_type!=='ffa_lora_sft'||m.update_kind!=='absolute_b'||m.protocol_version!=='2.0')throw new ComputeError('UNSUPPORTED_PROTOCOL','unsupported task type');
    const p=getProfile(m.model_profile);
    if(!delivery&&(m.model_profile!==runtime.profile_id||m.model_variant_id!==runtime.variant_id))throw new ComputeError('INVALID_SCHEMA','task needs another model variant');
    if(!delivery&&!p.test_only&&(p.variants[m.model_variant_id]?.backend!==runtime.backend||!m.model_files_digest||m.model_files_digest!==runtime.files_digest))throw new ComputeError('MODEL_UNVERIFIED','task model does not match the verified local variant');
    if(m.schema_hash!==schemaHash(p)||m.rank!==p.rank||m.alpha!==p.alpha)throw new ComputeError('INVALID_SCHEMA','task schema differs from the local profile');
    if(!(m.local_steps>=1&&m.local_steps<=200&&m.batch_size===1&&[256,512].includes(m.max_length)))throw new ComputeError('INVALID_SCHEMA','task size outside the allowed range');
    // Only whitelisted fields drive the sidecar: no command, URL or path from the coordinator is ever used.
    return p;
  }
  async function runTask(m,sig){
    const p=verifyTask(m,sig);
    const lease=leaseFor(m);
    current={manifest:m,step:0,lease};setState('PREPARING');
    const dir=path.join(stateDir,'tasks',m.task_id.replace(/[^\\w-]/g,''));
    let saved=false;
    try{
      const reserve=trainableCount(p)*4+64*1024;
      metrics.traffic_reserved=reserve;
      for(const [field,size] of [['base_adapter_hash','base_adapter_bytes'],['dataset_shard_hash','dataset_shard_bytes']]){
        const decision=governor.decide({phase:'admission'});
        if(!decision.run)throw new ComputeError('STOPPED','policy:'+decision.reason);
        lease.check();
        const bytes=await fetchArtifact(m[field],m[size],lease,reserve);
        fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,field==='base_adapter_hash'?'base.safetensors':'rows.json'),bytes);
      }
      const baseBytes=fs.readFileSync(path.join(dir,'base.safetensors'));
      const rowsBytes=fs.readFileSync(path.join(dir,'rows.json'));
      const base=verifyTensors(decode(baseBytes).tensors,p,true);
      if(frozenAHash(base)!==m.frozen_A_hash)throw new ComputeError('FROZEN_A_CHANGED','base adapter A differs from the experiment');
      const rows=JSON.parse(rowsBytes.toString('utf8')).rows;
      if(JSON.stringify(rows.map(r=>r.id))!==JSON.stringify(m.row_ids))throw new ComputeError('HASH_MISMATCH','row set differs from the task');
      if(hashJSON(rows.map(r=>r.target_mask))!==m.mask_checksum)throw new ComputeError('HASH_MISMATCH','mask checksum differs');
      const tokens=rows.reduce((a,r)=>a+r.target_mask.slice(1).filter(Boolean).length,0);
      if(tokens!==m.expected_supervised_tokens)throw new ComputeError('TOKEN_MISMATCH','local supervised token count differs from the task');
      const pre=governor.decide({phase:'preflight'});
      if(!pre.run)throw new ComputeError('STOPPED','policy:'+pre.reason);
      lease.check();
      const result=await train(m,p,dir,lease);
      const updBytes=fs.readFileSync(result.update_path);
      verifyTensors(decode(updBytes).tensors,p,false);
      if(result.steps!==m.local_steps||result.supervised_tokens!==m.expected_supervised_tokens||result.a_unchanged!==true)throw new ComputeError('INVALID_SCHEMA','incomplete or inconsistent local result');
      metrics.supervised_tokens+=result.supervised_tokens;
      const entry=outbox.put(m,updBytes,{steps:result.steps,supervised_tokens:result.supervised_tokens,timing:result.timing||{},runtime_version:result.runtime_version,backend:runtime.backend},{signature:sig,scope});
      saved=true;
      await deliver(entry,lease);
      if(!stopping)fs.rmSync(dir,{recursive:true,force:true});
    }catch(error){
      if(!saved&&!stopping&&!lease.signal.aborted){
        await client.post('/v2/tasks/'+m.task_id+'/abandon',{lease_id:m.lease_id,session_id:session.session_id,reason:error.code==='STOPPED'?error.message:'error:'+error.code},{signal:abort.signal}).catch(e=>recordRpcError('abandon.error',e));
      }
      if(error.code!=='STOPPED')throw error;
      setState('PAUSED',error.message.replace(/^policy:/,''));
      await sleep(2000,abort.signal);
    }finally{
      lease.stop();
      metrics.traffic_reserved=0;
      current=null;
    }
  }
  async function closeSidecar(){
    clearInterval(idleWatch);idleWatch=null;
    if(sidecar){
      const sc=sidecar;sidecar=null;metrics.resident_model=0;governor.setSensors?.({worker_memory_bytes:null});
      sidecarClosing=sc.stop(10000).catch(()=>{});
    }
    await sidecarClosing;
  }
  function monitorResident(){
    const since=performance.now();
    clearInterval(idleWatch);
    idleWatch=setInterval(()=>{
      const mode=runtimeMode(),policy=governor.policy;
      const maxAge=Math.min(policy.runtime_idle_s??60,mode==='adaptive'?45:3600)*1000;
      if(stopping||mode==='cold'||!governor.decide({phase:'resident'}).run||performance.now()-since>=maxAge)
        void closeSidecar();
    },1000);
    idleWatch.unref?.();
  }
  async function train(m,p,dir,lease){
    const logical=os.availableParallelism?.()||os.cpus().length,threads=governor.cpuThreads(logical);
    let lastAcc=performance.now(),pausedSince=null,stopSent=false;
    const signal=AbortSignal.any([abort.signal,lease.signal]);
    const accountNow=(gpuMs=0)=>{const t=performance.now();governor.account({wallMs:t-lastAcc,gpuMs});lastAcc=t;};
    const retain=runtimeMode()!=='cold';
    let finished=false;
    try{
      setState('PREPARING','loading_model');
      clearInterval(idleWatch);idleWatch=null;
      await sidecarClosing;
      if(sidecar&&(!sidecar.running||sidecarThreads!==threads||!retain))await closeSidecar();
      sidecarEvents=async e=>{
        if(e.type==='loaded'){
          metrics.model_load_s=e.model_load_s??null;metrics.model_cache_hits=(metrics.model_cache_hits||0)+(e.cache_hit?1:0);
          metrics.resident_model=retain?1:0;setState('TRAINING');
        }
        if(e.type==='step'){
          current.step=e.step;metrics.last_loss=e.loss;metrics.optimizer_steps++;metrics.busy_ms+=e.compute_ms||0;
          for(const k of ['peak_allocated_bytes','peak_reserved_bytes','mlx_peak_bytes'])if(Number.isFinite(e[k]))metrics[k]=Math.max(metrics[k]||0,e[k]);
          const memory=e.peak_reserved_bytes??e.mlx_peak_bytes;
          if(Number.isFinite(memory))governor.setSensors?.({worker_memory_bytes:memory});
          if(e.compute_ms>0)metrics.tokens_per_s=Math.round(e.supervised_tokens/(e.compute_ms/1000)*10)/10;
          if(Number.isFinite(e.cpu_ms)&&e.wall_ms>0)metrics.cpu_fraction=Math.round(e.cpu_ms/e.wall_ms/logical*1000)/1000;
          accountNow(e.compute_ms||0);
          current.sleepMs=governor.afterStep(e.compute_ms||0);
          client.post(`/v2/tasks/${m.task_id}/progress`,{lease_id:m.lease_id,session_id:session.session_id,step:e.step,steps:m.local_steps,supervised_tokens:e.supervised_tokens_total,loss:e.loss,state:'TRAINING'},{signal}).catch(()=>{});
          onState({state,reason,task:publicTask(current),metrics:{...metrics}});
        }
        if(e.type==='permit_request')permitLoop(e).catch(err=>ev('permit.error',{message:err.message}));
      };
      if(!sidecar){
        sidecarThreads=threads;
        sidecar=startSidecar({python:runtime.python,threads,extraEnv:runtime.extraEnv,onLog:l=>ev('sidecar.log',{line:l}),
          onEvent:e=>sidecarEvents?.(e)});
      }
      async function permitLoop(e){
        if(current.sleepMs>0){setState('TRAINING','throttle');await sleep(Math.min(current.sleepMs,2147483647),signal);accountNow();}
        for(;;){
          if(stopping||lease.signal.aborted){if(!stopSent){stopSent=true;sidecar.send({cmd:'stop',id:e.id,reason:stopping?'stopping':'lease_lost'});}return;}
          const d=governor.decide({phase:e.step===0?'preflight':'compute'});
          if(d.run){pausedSince=null;setState('TRAINING');sidecar.send({cmd:'permit',id:e.id});return;}
          pausedSince??=performance.now();setState('PAUSED',d.reason);
          const hardBlock=['disabled','temperature','thermal_state','memory_pressure','low_memory','low_vram','worker_memory_limit','strict_operation_unbounded','cpu_zero','gpu_zero'].includes(d.reason);
          if(hardBlock||performance.now()-pausedSince>pauseHoldMs){stopSent=true;sidecar.send({cmd:'stop',id:e.id,reason:'policy:'+d.reason});return;}
          await sleep(1000,signal);
          lastAcc=performance.now();   // paused time is not budget time
        }
      }
      const call=sidecar.call('train',{task:{task_id:m.task_id,lease_id:m.lease_id,run_id:m.run_id,round:m.round,round_attempt:m.round_attempt,dataset_shard_hash:m.dataset_shard_hash,mask_checksum:m.mask_checksum,model_files_digest:m.model_files_digest,
        local_steps:m.local_steps,grad_accum:m.grad_accum,max_length:m.max_length,optimizer:m.optimizer,rank:m.rank,alpha:m.alpha,
        profile:p.id,targets:p.targets,layers:p.layers,expected_supervised_tokens:m.expected_supervised_tokens,base_adapter_hash:m.base_adapter_hash,frozen_A_hash:m.frozen_A_hash},
        paths:{task_dir:dir,model_dir:runtime.model_dir},backend:runtime.backend,retain_model:retain});
      const result=await call.promise;
      finished=true;
      return result;
    }finally{
      accountNow();
      sidecarEvents=null;
      if(!finished||!retain||stopping)await closeSidecar();
      else monitorResident();
    }
  }
  async function main(){
    let backoff=2000;
    while(!stopping){
      try{
        if(!session)await connect();
        if(session.state==='pending'){setState('CONNECTING','pending_approval');await sleep(5000,abort.signal);await heartbeat().catch(()=>{});continue;}
        const pending=entries()[0];
        if(pending){await deliver(pending);continue;}
        const d=governor.decide({phase:'admission'});
        const network=networkDecision();
        if(d.run&&!network.run){if(network.reason==='traffic_cap')blockedByTraffic();else setState('PAUSED',network.reason);await sleep(2000,abort.signal);continue;}
        if(!d.run){setState('PAUSED',d.reason);await sleep(2000,abort.signal);continue;}
        if(runtime.profile_id&&trafficRemaining()<trainableCount(getProfile(runtime.profile_id))*4+64*1024){
          blockedByTraffic();await sleep(3000,abort.signal);continue;
        }
        const r=await client.post('/v2/tasks/claim',{session_id:session.session_id,capabilities:capabilities(),available_payload_bytes:trafficRemaining()},{signal:abort.signal});
        if(r.reason==='insufficient_traffic_budget'){
          blockedByTraffic();await sleep(10000,abort.signal);continue;
        }
        if(!r.task){setState(r.reason==='waiting_round'?'WAITING_ROUND':'IDLE',r.reason);await sleep(jitter(Math.min(30,r.retry_after_s||5)*1000),abort.signal);continue;}
        await runTask(r.task,r.signature);
        backoff=2000;
      }catch(e){
        if(stopping)break;
        if(['REVOKED','SESSION_SUPERSEDED'].includes(e.code)){await halt(e.code==='REVOKED'?'revoked':'session_superseded');break;}
        setState('ERROR_RECOVERABLE',e.code||'error',{message:e.message});ev('worker.error',{code:e.code,message:e.message});
        if(e.code==='CLOCK_SKEW')await client.syncTime().catch(err=>recordRpcError('clock.error',err));
        if(e.rpc)recordRpcError('rpc.error',e);
        await sleep(jitter(backoff),abort.signal);backoff=Math.min(30000,backoff*2);
      }
    }
  }
  return {
    start(){if(!loop){stopping=false;abort=new AbortController();loop=main().finally(async()=>{await closeSidecar();loop=null;});}return loop;},
    async stop(){
      stopping=true;setState('STOPPING',current?'safe_boundary':null);abort.abort();
      try{sidecar?.send({cmd:'stop',id:'*',reason:'stopping'});}catch{}
      const grace=setTimeout(()=>sidecar?.kill(),12000);
      await loop?.catch(()=>{});clearTimeout(grace);clearInterval(hb);client.close?.();governor.save();
      setState('STOPPED');
    },
    get state(){return {state,reason,task:current?publicTask(current):null,metrics:{...metrics},last_accepted:lastAccepted,outbox:entries().length,last_rpc_error:lastRpcError,session:session?{state:session.state}:null};},
    outbox,client
  };
}
