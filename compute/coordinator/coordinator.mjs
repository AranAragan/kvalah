// Kvalah Compute v0.2 coordinator: enrollment, experiments, rounds, leases, quorum, validation, FedAvg and
// crash recovery. Pure state machine over SQLite + CAS; the HTTPS layer (api.mjs) only authenticates and
// forwards. Admin operations are local-only (host IPC / CLI), never exposed on the network.
import path from 'node:path';
import fs from 'node:fs';
import {randomBytes,randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import {openDB,tx} from './db.mjs';
import {createCAS} from './cas.mjs';
import {createTransferStore} from './transfer.mjs';
import {fail,ComputeError} from '../protocol/errors.mjs';
import {sha256,hashJSON,canonicalJSON,isHex64} from '../protocol/hash.mjs';
import {getProfile,schemaHash,frozenAHash,verifyTensors,PROTOCOL_VERSION,tensorSchema,trainableCount} from '../protocol/schema.mjs';
import {decode,encode} from '../protocol/safetensors.mjs';
import {canonicalAdapter} from '../protocol/canonical.mjs';
import {fedavg} from '../protocol/aggregate.mjs';
import {normalizeConfig,configHash,optimizerHash} from '../protocol/config.mjs';
import {newKeyPair,validPublicKey,signJSON,verifyBytes,keyFingerprint} from '../protocol/sign.mjs';
import {auditSplitGroups,PREPROCESSING_VERSION} from '../datasets/engine.mjs';
import {researchProvenance,verifiedConversionImport} from '../mlx-conversion.mjs';

export const MAX_UPDATE_BYTES=8*1024*1024;
const MAX_ADAPTER_L2=1024;
const PAIR_TTL_MS=10*60*1000,PAIR_ATTEMPTS=5,HEARTBEAT_OFFLINE_MS=30*1000;
const J=v=>v==null?null:JSON.stringify(v),P=s=>s==null?null:JSON.parse(s);
const alias=s=>{const a=String(s||'').normalize('NFKC').replace(/[\u0000-\u001f<>"'`\\]/g,'').trim().slice(0,40);if(!a)fail('INVALID_SCHEMA','device alias is required');return a;};
const pairCode=()=>{const A='ABCDEFGHJKMNPQRSTUVWXYZ23456789';const b=randomBytes(10);let s='';for(let i=0;i<10;i++)s+=A[b[i]%A.length];return s.slice(0,5)+'-'+s.slice(5);};
const normCode=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');

export function createCoordinator({dir,now=Date.now,evaluate=null,log=()=>{}}){
  fs.mkdirSync(dir,{recursive:true});
  const db=openDB(path.join(dir,'db','coordinator.sqlite'));
  const cas=createCAS(path.join(dir,'cas'));
  const listeners=new Set();
  // Coordinator signing key (signs task manifests). Private key never leaves this directory.
  const keyFile=path.join(dir,'coordinator-key.json');
  let key;
  if(fs.existsSync(keyFile))key=JSON.parse(fs.readFileSync(keyFile,'utf8'));
  else{key={...newKeyPair(),project_id:'proj-'+randomBytes(6).toString('hex'),created_at:now()};fs.writeFileSync(keyFile,JSON.stringify(key),{mode:0o600});}
  const projectId=key.project_id;

  function event(severity,code,ids={},details){
    const r=db.prepare('insert into events(ts,severity,code,experiment_id,device_id,task_id,details) values(?,?,?,?,?,?,?)').run(now(),severity,code,ids.experiment??null,ids.device??null,ids.task??null,J(details));
    const ev={seq:Number(r.lastInsertRowid),ts:now(),severity,code,...ids,details};
    for(const l of listeners){try{l(ev);}catch{}}
    log(`[${severity}] ${code}${ids.experiment?' exp='+ids.experiment:''}${ids.device?' dev='+ids.device.slice(0,8):''}${details?' '+JSON.stringify(details).slice(0,200):''}`);
    return ev;
  }
  const audit=(actor,action,details)=>db.prepare('insert into audit_log(ts,actor,action,details) values(?,?,?,?)').run(now(),actor,action,J(details));
  const device=id=>db.prepare('select * from devices where id=?').get(String(id));
  const experiment=id=>{const e=db.prepare('select * from experiments where id=?').get(String(id));if(!e)fail('NOT_FOUND','experiment not found');return e;};
  const currentRound=e=>db.prepare('select * from rounds where experiment_id=? and idx=? order by attempt desc limit 1').get(e.id,e.current_round);

  // ---------- enrollment ----------
  function createPairing({aliasHint}={}){
    const code=pairCode(),id='pair-'+randomBytes(6).toString('hex');
    db.prepare('insert into pairing_codes(id,code_hash,alias_hint,created_at,expires_at) values(?,?,?,?,?)').run(id,sha256(normCode(code)),aliasHint?alias(aliasHint):null,now(),now()+PAIR_TTL_MS);
    audit('admin','pairing.create',{id});event('info','pairing.created',{}, {id,expires_at:now()+PAIR_TTL_MS});
    return {id,code,expires_at:now()+PAIR_TTL_MS};
  }
  const challenges=new Map();
  function pairStart(){
    const challenge=randomBytes(24).toString('base64');challenges.set(challenge,now()+120000);
    for(const [c,exp] of challenges)if(exp<now())challenges.delete(c);
    return {challenge,project_id:projectId,coordinator_key:key.publicKey,protocol_version:PROTOCOL_VERSION};
  }
  // Worker proves: knowledge of the one-time code (HMAC, the code itself is not sent) and possession of its
  // private key (signature over challenge+code_mac+public key). The device then waits for admin approval.
  function pairComplete({challenge,device_id,public_key,alias:a,code_mac,signature,capabilities,runtime_version}){
    if(typeof challenge!=='string'||!challenges.has(challenge)||challenges.get(challenge)<now())fail('PAIRING_EXPIRED','pairing challenge expired; start again');
    challenges.delete(challenge);
    if(typeof device_id!=='string'||!/^dev-[0-9a-f]{32}$/.test(device_id))fail('INVALID_SCHEMA','bad device_id');
    if(!validPublicKey(public_key))fail('INVALID_SCHEMA','bad public key');
    const name=alias(a);
    const proof=Buffer.from(['KC2-PAIR',challenge,code_mac,public_key,device_id].join('\n'));
    if(!verifyBytes(public_key,proof,signature))fail('BAD_SIGNATURE','pairing signature invalid');
    const open=db.prepare('select * from pairing_codes where used_at is null and expires_at>? order by created_at desc').all(now());
    if(!open.length)fail('PAIRING_EXPIRED','no active pairing code');
    let hit=null;
    for(const p of open){
      // code_mac = HMAC_sha256(key=sha256(code), challenge|public_key)
      const expect=createHmac('sha256',Buffer.from(p.code_hash,'hex')).update(challenge+'|'+public_key).digest();
      let got;try{got=Buffer.from(String(code_mac),'base64');}catch{got=Buffer.alloc(0);}
      if(got.length===expect.length&&timingSafeEqual(got,expect)){hit=p;break;}
    }
    if(!hit){
      for(const p of open){db.prepare('update pairing_codes set attempts=attempts+1 where id=?').run(p.id);if(p.attempts+1>=PAIR_ATTEMPTS)db.prepare('update pairing_codes set expires_at=? where id=?').run(now(),p.id);}
      event('warn','pairing.failed',{device:device_id});fail('UNAUTHORIZED','pairing code is wrong');
    }
    const existing=device(device_id),byKey=db.prepare('select * from devices where public_key=?').get(public_key);
    if(existing&&existing.public_key!==public_key)fail('CONFLICT','device id already enrolled with another key; re-install creates a new id');
    if(byKey&&byKey.id!==device_id)fail('CONFLICT','public key already enrolled for another device');
    tx(db,()=>{
      db.prepare('update pairing_codes set used_at=?,device_id=? where id=?').run(now(),device_id,hit.id);
      if(existing)db.prepare("update devices set state='pending',alias=?,revoked_at=null,capabilities=?,runtime_version=? where id=?").run(name,J(capabilities||null),String(runtime_version||'').slice(0,40),device_id);
      else db.prepare("insert into devices(id,public_key,alias,state,created_at,capabilities,runtime_version) values(?,?,?,'pending',?,?,?)").run(device_id,public_key,name,now(),J(capabilities||null),String(runtime_version||'').slice(0,40));
    });
    const dup=db.prepare("select id from devices where alias=? and id<>? and state<>'revoked'").all(name,device_id);
    event('info','device.paired',{device:device_id},{alias:name,key_fingerprint:keyFingerprint(public_key),duplicate_alias:dup.length>0});
    return {device_id,state:'pending',project_id:projectId,coordinator_key:key.publicKey,key_fingerprint:keyFingerprint(public_key),duplicate_alias:dup.length>0};
  }
  function approveDevice(id){
    const d=device(id);if(!d)fail('NOT_FOUND','device not found');
    if(d.state==='revoked')fail('REVOKED','revoked devices must pair again');
    db.prepare("update devices set state='active',approved_at=? where id=?").run(now(),id);audit('admin','device.approve',{id});event('info','device.approved',{device:id});
    return listDevices().find(x=>x.id===id);
  }
  function revokeDevice(id,reason='admin'){
    const d=device(id);if(!d)fail('NOT_FOUND','device not found');
    tx(db,()=>{
      db.prepare("update devices set state='revoked',revoked_at=?,revoke_reason=?,session_id=null where id=?").run(now(),String(reason).slice(0,80),id);
      for(const t of db.prepare("select * from tasks where device_id=? and state='leased'").all(id)){
        db.prepare("update tasks set state='revoked',reason='device revoked' where task_id=?").run(t.task_id);
        db.prepare("update assignments set state='open' where id=? and state='leased'").run(t.assignment_id);
      }
    });
    audit('admin','device.revoke',{id,reason});event('warn','device.revoked',{device:id},{reason});
    return {ok:true};
  }
  function drainDevice(id,on=true){const d=device(id);if(!d)fail('NOT_FOUND','device not found');db.prepare('update devices set status=? where id=?').run(J({...(P(d.status)||{}),drain:!!on}),id);event('info',on?'device.drain':'device.undrain',{device:id});return {ok:true};}
  // Authenticated device for API calls. Returns the row or throws a stable error.
  function authDevice(id,{allowPending=false}={}){
    const d=device(id);if(!d)fail('UNAUTHORIZED','unknown device');
    if(d.state==='revoked')fail('REVOKED','device access was revoked');
    if(d.state==='pending'&&!allowPending)fail('PENDING_APPROVAL','waiting for administrator approval');
    return d;
  }
  function useNonce(n,deviceId,ttl){
    if(typeof n!=='string'||!/^[0-9a-f]{32}$/.test(n))fail('BAD_SIGNATURE','bad nonce');
    db.prepare('delete from nonces where expires_at<?').run(now());
    try{db.prepare('insert into nonces(nonce,device_id,expires_at) values(?,?,?)').run(n,deviceId,now()+ttl);}catch{fail('REPLAY','request replay detected');}
  }
  function startSession(id){
    const d=authDevice(id,{allowPending:true});const sid='ses-'+randomBytes(12).toString('hex');
    if(d.session_id&&d.last_heartbeat&&now()-d.last_heartbeat<HEARTBEAT_OFFLINE_MS)event('warn','device.session_superseded',{device:id},{note:'a newer session replaced an active one; if this was not you, revoke the device'});
    db.prepare('update devices set session_id=?,session_started=?,last_heartbeat=? where id=?').run(sid,now(),now(),id);
    return {session_id:sid,state:d.state,server_time:now(),heartbeat_s:10};
  }
  function checkSession(d,sid){if(!d.session_id||sid!==d.session_id){event('warn','device.session_conflict',{device:d.id});fail('SESSION_SUPERSEDED','another session of this installation is active');}}
  function heartbeat(id,{session_id,status,metrics,capabilities,runtime_version}={}){
    const d=authDevice(id,{allowPending:true});checkSession(d,session_id);
    const s=status&&typeof status==='object'?{state:String(status.state||'').slice(0,40),pause_reason:status.pause_reason?String(status.pause_reason).slice(0,60):null,
      eligible:status.eligible===true,blocking_reason:typeof status.blocking_reason==='string'?status.blocking_reason.slice(0,60):null,drain:!!(P(d.status)||{}).drain}:P(d.status);
    db.prepare('update devices set last_heartbeat=?,status=?,metrics=?,capabilities=coalesce(?,capabilities),runtime_version=coalesce(?,runtime_version) where id=?')
      .run(now(),J(s),J(sanitizeMetrics(metrics)),capabilities?J(sanitizeCaps(capabilities)):null,runtime_version?String(runtime_version).slice(0,40):null,id);
    return {ok:true,state:d.state,server_time:now()};
  }
  function sanitizeMetrics(m){if(!m||typeof m!=='object')return null;const o={};for(const [k,v] of Object.entries(m).slice(0,40))if(/^[a-z_0-9]{1,40}$/.test(k)&&(v===null||typeof v==='number'&&Number.isFinite(v)))o[k]=v;return o;}
  function sanitizeCaps(c){
    if(!c||typeof c!=='object')return null;
    const variants=(Array.isArray(c.variants)?c.variants:[]).slice(0,8).map(v=>({profile_id:String(v.profile_id||'').slice(0,60),variant_id:String(v.variant_id||'').slice(0,40),files_digest:isHex64(v.files_digest)?v.files_digest:null}));
    return {backend:String(c.backend||'').slice(0,20),device_name:String(c.device_name||'').slice(0,60),precision:String(c.precision||'').slice(0,12),
      memory_total_bytes:Number.isFinite(c.memory_total_bytes)?c.memory_total_bytes:null,memory_free_bytes:Number.isFinite(c.memory_free_bytes)?c.memory_free_bytes:null,
      unified_memory:!!c.unified_memory,preflight_ok:c.preflight_ok===true,preflight_max_length:[256,512].includes(c.preflight_max_length)?c.preflight_max_length:null,
      preflight_peak_bytes:Number.isSafeInteger(c.preflight_peak_bytes)&&c.preflight_peak_bytes>0?c.preflight_peak_bytes:null,variants};
  }
  function listDevices(){
    return db.prepare('select * from devices order by created_at').all().map(d=>{
      const caps=P(d.capabilities),age=d.last_heartbeat?now()-d.last_heartbeat:null;
      const dupAlias=db.prepare("select count(*) n from devices where alias=? and state<>'revoked'").get(d.alias).n>1;
      return {id:d.id,alias:d.alias,state:d.state,key_fingerprint:keyFingerprint(d.public_key),capabilities:caps,runtime_version:d.runtime_version,
        heartbeat_age_ms:age,online:age!=null&&age<HEARTBEAT_OFFLINE_MS&&d.state!=='revoked',status:P(d.status),metrics:P(d.metrics),
        accepted_count:d.accepted_count,last_accepted_at:d.last_accepted_at,duplicate_alias:dupAlias,created_at:d.created_at};
    });
  }
  function renameDevice(id,a){const d=device(id);if(!d)fail('NOT_FOUND','device not found');db.prepare('update devices set alias=? where id=?').run(alias(a),id);return {ok:true};}

  // ---------- registry & datasets ----------
  function registerVariant({profile_id,variant_id,files_digest,manifest,provenance,conversion}){
    const p=getProfile(profile_id);if(!p.variants[variant_id])fail('INVALID_SCHEMA','unknown variant');
    if(files_digest!=null&&!isHex64(files_digest))fail('INVALID_SCHEMA','bad files digest');
    const metadata={...manifest};
    delete metadata.local_conversion;
    let status=provenance==='verified'?'verified':'unverified';
    if(variant_id==='mlx-4bit'){
      status='unverified';
      const prev=db.prepare('select * from model_variants where profile_id=? and variant_id=?').get(p.id,variant_id);
      if(conversion!==undefined){
        if(!verifiedConversionImport(conversion)||conversion.profile_id!==p.id||conversion.variant_id!==variant_id||
          conversion.files_digest!==files_digest)fail('MODEL_UNVERIFIED','local conversion was not verified for this model digest');
        metadata.local_conversion=conversion;
        status='locally_attested';
      }else if(prev?.files_digest===files_digest&&researchProvenance({...prev,manifest:P(prev.manifest)})){
        return {ok:true,provenance:prev.provenance};
      }
    }else if(conversion!==undefined)fail('INVALID_SCHEMA','unexpected MLX conversion for this variant');
    db.prepare('insert or replace into model_variants(profile_id,variant_id,files_digest,provenance,manifest,updated_at) values(?,?,?,?,?,?)')
      .run(p.id,variant_id,files_digest??null,status,J(metadata),now());
    audit('admin','model.register',{profile_id,variant_id,files_digest,provenance:status,manifest_sha256:conversion?.conversion.manifest_sha256});
    return {ok:true,provenance:status};
  }
  const variants=()=>db.prepare('select * from model_variants').all().map(v=>({...v,manifest:P(v.manifest)}));
  // Dataset manifest + shards come from the Dataset Engine (datasets/engine.mjs); shards are stored in CAS.
  function registerDataset(manifest,shards){
    if(!manifest?.dataset_id||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(manifest.dataset_id))fail('DATASET_INVALID','bad dataset id');
    for(const [split,list] of Object.entries(manifest.shards||{}))for(const s of list){
      const bytes=shards[s.sha256];if(!bytes||sha256(bytes)!==s.sha256)fail('DATASET_INVALID','shard '+split+' missing or corrupt');
    }
    if(manifest.preprocessing_version===PREPROCESSING_VERSION||manifest.group_audit!==undefined){
      const audit=auditSplitGroups(manifest,h=>shards[h]);
      if(hashJSON(audit)!==hashJSON(manifest.group_audit??null))fail('DATASET_INVALID','dataset group audit differs from its shards');
    }
    const id=manifest.dataset_id+'@'+manifest.revision;
    if(db.prepare('select 1 from datasets where id=?').get(id))fail('IMMUTABLE','dataset revision already registered');
    for(const b of Object.values(shards)){const h=cas.put(b);db.prepare('insert or ignore into artifacts(sha256,kind,bytes,created_at) values(?,?,?,?)').run(h,'shard',b.length,now());}
    db.prepare('insert into datasets(id,manifest,manifest_hash,created_at) values(?,?,?,?)').run(id,canonicalJSON(manifest),hashJSON(manifest),now());
    audit('admin','dataset.register',{id});event('info','dataset.registered',{}, {id,splits:manifest.split_counts});
    return {id};
  }
  const datasetManifest=id=>{const d=db.prepare('select * from datasets where id=?').get(String(id));if(!d)fail('DATASET_REQUIRED','dataset '+String(id).slice(0,80)+' is not registered');return JSON.parse(d.manifest);};
  const listDatasets=()=>db.prepare('select id,manifest,manifest_hash,created_at from datasets order by created_at').all().map(d=>{const m=JSON.parse(d.manifest);return {id:d.id,created_at:d.created_at,license:m.license,source:m.source,split_counts:m.split_counts,tokens_by_split:m.tokens_by_split,synthetic:!!m.synthetic,tokenizer_hash:m.tokenizer_hash,profile_id:m.profile_id,max_length:m.max_length,group_audited:!!m.group_audit,manifest_hash:d.manifest_hash};});
  function trainRows(manifest){
    const rows=[];
    for(const s of manifest.shards.train){const shard=JSON.parse(cas.get(s.sha256).toString('utf8'));for(const r of shard.rows)rows.push(r);}
    return rows;
  }

  // ---------- experiments ----------
  const rowsPerRound=cfg=>cfg.quorum.target*cfg.local_steps*cfg.batch_size*cfg.grad_accum;
  const rowsAtSlot=(cfg,plan,round,slot)=>{
    const start=round*rowsPerRound(cfg)+plan.widths.slice(0,slot).reduce((sum,n)=>sum+n,0);
    return plan.order.slice(start,start+plan.widths[slot]);
  };
  function startingAdapter(cfg,p,models){
    const source=cfg.initial_checkpoint;
    if(!source){
      const tensors=canonicalAdapter(p,cfg.seed);
      return {tensors,bytes:encode(tensors,{kind:'kvalah-ffa-adapter',profile:p.id,round:'0'}),lineage:{parent:null,kind:'canonical_init',seed:cfg.seed}};
    }
    const e=experiment(source.experiment_id),prior=P(e.config),snapshot=P(e.model_snapshot)||[];
    const ck=db.prepare("select c.* from checkpoints c join rounds r on r.experiment_id=c.experiment_id and r.idx=c.round_idx-1 and r.checkpoint_hash=c.hash and r.state='COMMITTED' where c.experiment_id=? and c.hash=? and c.round_idx>0 order by c.round_idx desc limit 1").get(e.id,source.sha256);
    if(!ck||cfg.profile_id!==prior.profile_id||cfg.dataset_id!==prior.dataset_id||cfg.max_length!==prior.max_length||cfg.seed!==prior.seed||
      cfg.variants.length!==prior.variants.length||cfg.variants.some(v=>!prior.variants.includes(v))||
      models.length!==snapshot.length||models.some(v=>!snapshot.some(x=>x.variant_id===v.variant_id&&x.files_digest===v.files_digest))){
      fail('CHECKPOINT_INCOMPATIBLE','checkpoint must be committed and match the profile, base models, dataset revision, context length and seed');
    }
    const bytes=cas.get(ck.hash), tensors=verifyTensors(decode(bytes).tensors,p,true);
    if(frozenAHash(tensors)!==e.frozen_a_hash||frozenAHash(canonicalAdapter(p,cfg.seed))!==e.frozen_a_hash)fail('FROZEN_A_CHANGED','checkpoint frozen A differs from the experiment seed');
    const row_offset=(prior.initial_checkpoint?.row_offset??0)+ck.round_idx*rowsPerRound(prior);
    if(!Number.isSafeInteger(row_offset))fail('CHECKPOINT_INCOMPATIBLE','training row offset out of range');
    const lineage={kind:'continued',parent:ck.hash,source_experiment_id:e.id,source_round:ck.round_idx,row_offset};
    return {bytes,tensors,lineage};
  }
  function planRows(cfg,manifest){
    // Deterministic permutation per epoch (seeded), sequential non-overlapping slices per assignment.
    const rows=trainRows(manifest);
    if(!rows.length)fail('DATASET_REQUIRED','dataset has no train rows');
    const per=cfg.local_steps*cfg.batch_size*cfg.grad_accum,need=cfg.rounds*rowsPerRound(cfg);
    const offset=cfg.initial_checkpoint?.row_offset??0;
    const order=[];let epoch=Math.floor(offset/rows.length),skip=offset%rows.length;
    while(order.length<need){
      const perm=rows.map(r=>({r,k:sha256(`${cfg.seed}|${epoch}|${r.id}`)})).sort((a,b)=>a.k<b.k?-1:1).map(x=>({...x.r,epoch}));
      order.push(...perm.slice(skip,skip+need-order.length));epoch++;skip=0;
    }
    const widths=cfg.slot_steps?.map(n=>n*cfg.batch_size*cfg.grad_accum)??Array(cfg.quorum.target).fill(per);
    return {per,widths,epochs:epoch,order:order.slice(0,need)};
  }
  const supervised=r=>{let n=0;for(let i=1;i<r.target_mask.length;i++)n+=r.target_mask[i]?1:0;return n;};
  function dryRun(input){
    const cfg=normalizeConfig(input),p=getProfile(cfg.profile_id),m=datasetManifest(cfg.dataset_id);
    if(m.profile_id&&m.profile_id!==p.id)fail('DATASET_INVALID','dataset was tokenized for another model profile');
    if(m.max_length!==cfg.max_length)fail('DATASET_INVALID',`dataset was prepared with max_length ${m.max_length}`);
    const vs=variants().filter(v=>v.profile_id===p.id&&cfg.variants.includes(v.variant_id));
    const init=startingAdapter(cfg,p,vs);
    if(cfg.initial_checkpoint)Object.assign(cfg.initial_checkpoint,{source_round:init.lineage.source_round,row_offset:init.lineage.row_offset});
    const plan=planRows(cfg,m),slots=[];
    for(let r=0;r<cfg.rounds;r++)for(let s=0;s<cfg.quorum.target;s++){const rows=rowsAtSlot(cfg,plan,r,s);slots.push({round:r,slot:s,rows:rows.length,supervised_tokens:rows.reduce((a,x)=>a+supervised(x),0)});}
    return {config:cfg,config_hash:configHash(cfg),schema_hash:schemaHash(p),frozen_a_hash:frozenAHash(init.tensors),initial_adapter_sha256:sha256(init.bytes),
      trainable_params:Object.values(tensorSchema(p,false)).reduce((a,[o,r])=>a+o*r,0),targets:p.layers*Object.keys(p.targets).length,rank:p.rank,alpha:p.alpha,
      dataset:{id:cfg.dataset_id,license:m.license,split_counts:m.split_counts,tokens_by_split:m.tokens_by_split,synthetic:!!m.synthetic,tokenizer_hash:m.tokenizer_hash},
      epochs:plan.epochs,rows_per_task:plan.per,tasks:slots.length,supervised_tokens_total:slots.reduce((a,s)=>a+s.supervised_tokens,0),slots,
      model_variants:cfg.variants.map(v=>{const r=vs.find(x=>x.variant_id===v);return {variant_id:v,registered:!!r,files_digest:r?.files_digest||null,provenance:r?.provenance||'unregistered',research_eligible:!!r&&researchProvenance(r)};}),
      research_pass_possible:vs.length===cfg.variants.length&&vs.every(researchProvenance)&&!m.synthetic};
  }
  function createExperiment(input){
    const plan=dryRun(input),cfg=plan.config,id='exp-'+randomBytes(6).toString('hex'),run=(cfg.preset+'-'+randomBytes(3).toString('hex'));
    const profile=getProfile(cfg.profile_id);
    const modelSnapshot=variants().filter(v=>v.profile_id===cfg.profile_id&&cfg.variants.includes(v.variant_id))
      .map(({variant_id,files_digest,provenance,manifest})=>({variant_id,files_digest,provenance,manifest}));
    if(!profile.test_only&&cfg.variants.some(id=>!modelSnapshot.find(v=>v.variant_id===id&&v.files_digest)))fail('MODEL_UNVERIFIED','register a model digest for every selected variant first');
    if(!profile.test_only&&cfg.preset==='research'){
      if(!cfg.research_confirmed||modelSnapshot.some(v=>!researchProvenance(v)))fail('MODEL_UNVERIFIED','research requires approval and verified provenance for all variants');
      const pilots=db.prepare("select config,model_snapshot from experiments where state='COMPLETED' and json_extract(config,'$.preset')='pilot'").all();
      if(!pilots.some(p=>{
        const previous=P(p.config),models=P(p.model_snapshot)||[];
        return previous.profile_id===cfg.profile_id&&previous.dataset_id===cfg.dataset_id&&modelSnapshot.every(v=>models.some(m=>m.variant_id===v.variant_id&&m.files_digest===v.files_digest));
      }))fail('INVALID_TRANSITION','complete a pilot with the same dataset and model digests first');
    }
    db.prepare("insert into experiments(id,run_id,name,config,config_hash,state,created_at,model_snapshot) values(?,?,?,?,?,'CREATED',?,?)").run(id,run,cfg.name,canonicalJSON(cfg),plan.config_hash,now(),canonicalJSON(modelSnapshot));
    audit('admin','experiment.create',{id,config_hash:plan.config_hash});event('info','experiment.created',{experiment:id},{run_id:run,preset:cfg.preset});
    return {id,run_id:run,...plan};
  }
  function makeAssignments(e,cfg,roundIdx,attempt){
    const m=datasetManifest(cfg.dataset_id),plan=planRows(cfg,m);
    for(let s=0;s<cfg.quorum.target;s++){
      const rows=rowsAtSlot(cfg,plan,roundIdx,s);
      const body={assignment_kind:'sft_rows',dataset_id:cfg.dataset_id,round:roundIdx,slot:s,rows:rows.map(r=>({id:r.id,epoch:r.epoch,input_ids:r.input_ids,target_mask:r.target_mask}))};
      const bytes=Buffer.from(canonicalJSON(body)),h=cas.put(bytes);
      db.prepare('insert or ignore into artifacts(sha256,kind,bytes,created_at) values(?,?,?,?)').run(h,'assignment',bytes.length,now());
      const tokens=rows.reduce((a,r)=>a+supervised(r),0);
      if(!tokens)fail('NO_TARGET_TOKENS','assignment has no supervised tokens');
      db.prepare("insert into assignments(id,experiment_id,round_idx,round_attempt,slot,rows_sha,row_ids,expected_tokens,mask_checksum,state) values(?,?,?,?,?,?,?,?,?,'open')")
        .run('asg-'+randomBytes(8).toString('hex'),e.id,roundIdx,attempt,s,h,J(rows.map(r=>r.id)),tokens,hashJSON(rows.map(r=>r.target_mask)));
    }
  }
  function openRound(e,cfg,idx,attempt,parent){
    db.prepare("insert into rounds(experiment_id,idx,attempt,state,parent_hash,opened_at,deadline_at) values(?,?,?,'OPEN',?,?,?)").run(e.id,idx,attempt,parent,now(),now()+cfg.round_deadline_s*1000);
    makeAssignments(e,cfg,idx,attempt);
    db.prepare("update experiments set current_round=?,state='RUNNING',blocker=null where id=?").run(idx,e.id);
    event('info','round.opened',{experiment:e.id},{round:idx,attempt,parent:parent.slice(0,16),deadline_s:cfg.round_deadline_s});
  }
  function startExperiment(id){
    const e=experiment(id);if(e.state!=='CREATED')fail('INVALID_TRANSITION','experiment already started; create a new run to change settings');
    const cfg=JSON.parse(e.config),p=getProfile(cfg.profile_id);
    if(!p.test_only&&!e.model_snapshot)fail('MODEL_UNVERIFIED','this experiment predates model snapshots; create a new experiment with verified model digests');
    const {tensors:init,bytes,lineage}=startingAdapter(cfg,p,P(e.model_snapshot)||[]),h=cas.put(bytes);
    if(cfg.initial_checkpoint&&cfg.initial_checkpoint.row_offset!==lineage.row_offset)fail('CHECKPOINT_INCOMPATIBLE','checkpoint continuation differs from the saved configuration');
    tx(db,()=>{
      db.prepare('insert or ignore into artifacts(sha256,kind,bytes,created_at) values(?,?,?,?)').run(h,'checkpoint',bytes.length,now());
      db.prepare('insert or ignore into checkpoints(hash,experiment_id,round_idx,created_at,lineage) values(?,?,?,?,?)').run(h,e.id,0,now(),J(lineage));
      db.prepare('update experiments set started_at=?,initial_hash=?,frozen_a_hash=? where id=?').run(now(),h,frozenAHash(init),e.id);
      openRound({...e},cfg,0,1,h);
    });
    audit('admin','experiment.start',{id});event('info','experiment.started',{experiment:id},{initial:h.slice(0,16),frozen_a:frozenAHash(init).slice(0,16)});
    if(cfg.eval.initial)runEval(e.id,0,h);
    return status(id);
  }
  function pauseExperiment(id){const e=experiment(id);if(e.state!=='RUNNING')fail('INVALID_TRANSITION','only a running experiment can be paused');db.prepare("update experiments set state='PAUSED' where id=?").run(id);event('info','experiment.paused',{experiment:id},{note:'no new leases; running tasks may finish'});return status(id);}
  function carryAccepted(e,r,cfg){
    const p=getProfile(cfg.profile_id),models=P(e.model_snapshot)||[],used=new Set();
    const slots=db.prepare('select * from assignments where experiment_id=? and round_idx=? and round_attempt=? order by slot').all(e.id,r.idx,r.attempt+1);
    const possible=db.prepare(`select u.*, t.manifest, a.slot from updates u
      join tasks t on t.task_id=u.task_id join assignments a on a.id=t.assignment_id join devices d on d.id=u.device_id
      where u.state='accepted' and a.experiment_id=? and a.round_idx=? and a.round_attempt<=? and d.state='active'
      order by a.round_attempt desc,u.accepted_at desc,u.update_id`).all(e.id,r.idx,r.attempt);
    for(const slot of slots){
      for(const u of possible){
        if(u.slot!==slot.slot||used.has(u.device_id)||cfg.target_device_ids&&!cfg.target_device_ids.includes(u.device_id))continue;
        const m=P(u.manifest),v=models.find(v=>v.variant_id===m.model_variant_id),meta=P(u.meta);
        if(m.experiment_id!==e.id||m.round!==r.idx||m.base_adapter_hash!==r.parent_hash||
          m.config_hash!==e.config_hash||m.optimizer_hash!==optimizerHash(cfg)||m.schema_hash!==schemaHash(p)||m.frozen_A_hash!==e.frozen_a_hash||
          m.dataset_shard_hash!==slot.rows_sha||m.mask_checksum!==slot.mask_checksum||m.expected_supervised_tokens!==slot.expected_tokens||
          meta.supervised_tokens!==slot.expected_tokens||meta.steps!==(cfg.slot_steps?.[slot.slot]??cfg.local_steps)||
          !cfg.variants.includes(m.model_variant_id)||(!p.test_only&&!v?.files_digest)||m.model_files_digest!==(v?.files_digest??null))continue;
        try{cas.get(u.payload_sha);}catch{continue;}
        db.prepare("update assignments set state='accepted' where id=?").run(slot.id);
        db.prepare('insert into round_reuse values(?,?)').run(slot.id,u.update_id);
        used.add(u.device_id);
        break;
      }
    }
    return used.size;
  }
  function resumeExperiment(id){
    const e=experiment(id);if(!['PAUSED','BLOCKED'].includes(e.state))fail('INVALID_TRANSITION','experiment is not paused');
    const cfg=JSON.parse(e.config),r=currentRound(e);
    if(!getProfile(cfg.profile_id).test_only&&!e.model_snapshot)fail('MODEL_UNVERIFIED','this experiment predates model snapshots; create a new experiment with verified model digests');
    if(e.state==='BLOCKED'||r.state==='BLOCKED'||r.deadline_at<=now()){
      // Retry: new attempt from the same parent checkpoint, same planned rows; nothing partial is committed.
      const retained=tx(db,()=>{db.prepare("update rounds set state='FAILED' where experiment_id=? and idx=? and attempt=?").run(e.id,r.idx,r.attempt);
        db.prepare("update assignments set state='void' where experiment_id=? and round_idx=? and round_attempt=? and state<>'accepted'").run(e.id,r.idx,r.attempt);
        db.prepare("update tasks set state='void' where state='leased' and assignment_id in (select id from assignments where experiment_id=? and round_idx=? and round_attempt=?)").run(e.id,r.idx,r.attempt);
        openRound(e,cfg,r.idx,r.attempt+1,r.parent_hash);
        return cfg.reuse_accepted_updates===true?carryAccepted(e,r,cfg):0;});
      event('info','round.retry',{experiment:id},{round:r.idx,attempt:r.attempt+1,retained});
      if(retained)maybeSeal(id);
    }else{
      db.prepare("update experiments set state='RUNNING' where id=?").run(id);
      event('info','experiment.resumed',{experiment:id});
    }
    return status(id);
  }
  function cancelExperiment(id){
    const e=experiment(id);if(['CANCELLED','COMPLETED','FAILED'].includes(e.state))fail('INVALID_TRANSITION','experiment already finished');
    tx(db,()=>{
      db.prepare("update experiments set state='CANCELLED',finished_at=? where id=?").run(now(),id);
      db.prepare("update rounds set state='CANCELLED' where experiment_id=? and state in ('OPEN','COLLECTING','BLOCKED')").run(id);
      db.prepare("update tasks set state='cancelled' where state='leased' and assignment_id in (select id from assignments where experiment_id=?)").run(id);
    });
    audit('admin','experiment.cancel',{id});event('warn','experiment.cancelled',{experiment:id},{note:'unfinished round was not promoted'});return status(id);
  }
  const finishAfterRound=id=>{const e=experiment(id);const cfg=JSON.parse(e.config);db.prepare('update experiments set blocker=? where id=?').run(J({finish_after_round:true}),id);event('info','experiment.finish_after_round',{experiment:id});return status(id);};

  // ---------- tasks ----------
  function selectAssignment(rows,d,cfg){
    if(!cfg.adaptive_scheduler||rows.length<2)return rows[0];
    const m=P(d.metrics)||{};
    const speed=Math.max(0,m.tokens_per_s||0);
    const other=listDevices().filter(x=>x.id!==d.id&&x.online&&x.state==='active'&&x.status?.eligible===true);
    const target=other.reduce((sum,x)=>sum+(x.metrics?.tokens_per_s||0),0)/Math.max(1,other.length);
    const readySpeed=speed/(1+Math.max(0,m.tasks_rejected||0)/Math.max(1,m.tasks_accepted||0));
    const order=readySpeed>target&&readySpeed>0?-1:1;
    return rows.sort((a,b)=>order*(a.expected_tokens-b.expected_tokens)||a.slot-b.slot)[0];
  }
  function claim(deviceId,{session_id,capabilities,available_payload_bytes}={}){
    const d=authDevice(deviceId);checkSession(d,session_id);
    if(available_payload_bytes!==undefined&&(!Number.isSafeInteger(available_payload_bytes)||available_payload_bytes<0))
      fail('INVALID_SCHEMA','invalid traffic budget');
    if(capabilities)db.prepare('update devices set capabilities=? where id=?').run(J(sanitizeCaps(capabilities)),deviceId);
    const caps=sanitizeCaps(capabilities)||P(d.capabilities)||{};
    if((P(d.status)||{}).drain)return {task:null,reason:'drained',retry_after_s:30};
    if(!caps.preflight_ok)return {task:null,reason:'preflight_required',retry_after_s:30};
    const exps=db.prepare("select * from experiments where state='RUNNING' order by created_at").all();
    if(!exps.length)return {task:null,reason:'no_running_experiment',retry_after_s:15};
    for(const e of exps){
      const cfg=JSON.parse(e.config),r=currentRound(e);
      if(cfg.target_device_ids&&!cfg.target_device_ids.includes(deviceId))continue;
      if(!r||!['OPEN','COLLECTING'].includes(r.state))continue;
      const profile=getProfile(cfg.profile_id);
      if(!profile.test_only&&caps.preflight_max_length!==cfg.max_length)continue;
      const variant=(caps.variants||[]).find(v=>v.profile_id===cfg.profile_id&&cfg.variants.includes(v.variant_id)&&profile.variants[v.variant_id]?.backend===caps.backend);
      if(!variant)continue;
      const reg=P(e.model_snapshot)?.find(v=>v.variant_id===variant.variant_id);
      if((!profile.test_only&&!reg?.files_digest)||(reg?.files_digest&&variant.files_digest!==reg.files_digest)){event('warn','task.model_mismatch',{experiment:e.id,device:deviceId},{variant:variant.variant_id});continue;}
      const mine=db.prepare("select t.* from tasks t join assignments a on a.id=t.assignment_id where t.device_id=? and a.experiment_id=? and a.round_idx=? and a.round_attempt=? and t.state in ('leased','accepted')").get(deviceId,e.id,r.idx,r.attempt);
      if(mine?.state==='leased'){
        if(mine.lease_expires_at<=now())return {task:null,reason:'lease_expiring',retry_after_s:2};
        const task={...P(mine.manifest),lease_expires_at:mine.lease_expires_at};
        return {task,signature:signJSON(key.privateKey,task),resumed:true};
      }
      if(mine?.state==='accepted')return {task:null,reason:'waiting_round',retry_after_s:5};
      if(db.prepare(`select 1 from round_reuse x join assignments a on a.id=x.assignment_id join updates u on u.update_id=x.update_id
          where a.experiment_id=? and a.round_idx=? and a.round_attempt=? and u.device_id=?`).get(e.id,r.idx,r.attempt,deviceId))
        return {task:null,reason:'waiting_round',retry_after_s:5};
      const remaining=(r.deadline_at-now())/1000;
      if(remaining<cfg.lease_ttl_s/2)return {task:null,reason:'round_closing',retry_after_s:5};
      const out=tx(db,()=>{
        const a=selectAssignment(db.prepare("select * from assignments where experiment_id=? and round_idx=? and round_attempt=? and state='open' order by slot").all(e.id,r.idx,r.attempt),d,cfg);
        if(!a)return null;
        const size=h=>db.prepare('select bytes from artifacts where sha256=?').get(h)?.bytes??null;
        const baseBytes=size(r.parent_hash),rowsBytes=size(a.rows_sha);
        const required=(baseBytes??0)+(rowsBytes??0)+trainableCount(profile)*4+65536;
        if(available_payload_bytes!==undefined&&required>available_payload_bytes)return {required};
        const attempt=(db.prepare('select max(attempt) m from tasks where assignment_id=?').get(a.id).m||0)+1;
        const taskId='task-'+randomUUID(),leaseId='lease-'+randomBytes(12).toString('hex'),exp=Math.min(now()+cfg.lease_ttl_s*1000,r.deadline_at);
        const p=getProfile(cfg.profile_id);
        const manifest={protocol_version:PROTOCOL_VERSION,task_type:'ffa_lora_sft',task_id:taskId,lease_id:leaseId,attempt,project_id:projectId,
          experiment_id:e.id,run_id:e.run_id,round:r.idx,round_attempt:r.attempt,device_id:deviceId,model_profile:p.id,model_variant_id:variant.variant_id,
          model_files_digest:reg?.files_digest??null,
          base_adapter_hash:r.parent_hash,frozen_A_hash:e.frozen_a_hash,schema_hash:schemaHash(p),dataset_shard_hash:a.rows_sha,row_ids:P(a.row_ids),
          base_adapter_bytes:baseBytes,dataset_shard_bytes:rowsBytes,
          expected_supervised_tokens:a.expected_tokens,mask_checksum:a.mask_checksum,config_hash:e.config_hash,optimizer_hash:optimizerHash(cfg),
          local_steps:cfg.slot_steps?.[a.slot]??cfg.local_steps,batch_size:cfg.batch_size,grad_accum:cfg.grad_accum,max_length:cfg.max_length,optimizer:cfg.optimizer,
          rank:p.rank,alpha:p.alpha,update_kind:'absolute_b',lease_ttl_seconds:cfg.lease_ttl_s,lease_expires_at:exp,round_deadline_at:r.deadline_at,issued_at:now()};
        db.prepare("insert into tasks(task_id,lease_id,attempt,assignment_id,device_id,state,leased_at,lease_expires_at,manifest) values(?,?,?,?,?,'leased',?,?,?)").run(taskId,leaseId,attempt,a.id,deviceId,now(),exp,canonicalJSON(manifest));
        db.prepare("update assignments set state='leased' where id=?").run(a.id);
        if(r.state==='OPEN')db.prepare("update rounds set state='COLLECTING' where experiment_id=? and idx=? and attempt=?").run(e.id,r.idx,r.attempt);
        return manifest;
      });
      if(out?.required)return {task:null,reason:'insufficient_traffic_budget',required_bytes:out.required,retry_after_s:20};
      if(out){event('info','task.leased',{experiment:e.id,device:deviceId,task:out.task_id},{round:r.idx,slot_tokens:out.expected_supervised_tokens,attempt:out.attempt});return {task:out,signature:signJSON(key.privateKey,out)};}
      return {task:null,reason:'all_assignments_leased',retry_after_s:5};
    }
    return {task:null,reason:'no_compatible_task',retry_after_s:15};
  }
  function ownTask(deviceId,taskId,leaseId){
    const t=db.prepare('select * from tasks where task_id=?').get(String(taskId));
    if(!t)fail('NOT_FOUND','task not found');
    if(t.device_id!==deviceId)fail('NOT_OWNER','task belongs to another device');   // N02, no mutation
    if(leaseId!==undefined&&t.lease_id!==leaseId)fail('STALE','lease id does not match');
    return t;
  }
  function renew(deviceId,taskId,{lease_id,session_id,phase}){
    const d=authDevice(deviceId);checkSession(d,session_id);const t=ownTask(deviceId,taskId,lease_id);
    const server_time=now();
    if(t.state!=='leased'||t.lease_expires_at<=server_time)fail('LEASE_EXPIRED','lease expired');
    const m=P(t.manifest);
    const multiplier=['upload','finalize'].includes(phase)?1.5:1;
    const exp=Math.min(Math.max(t.lease_expires_at,server_time+m.lease_ttl_seconds*multiplier*1000),m.round_deadline_at);
    if(exp<=server_time)fail('LEASE_EXPIRED','round deadline reached');
    db.prepare('update tasks set lease_expires_at=?,renewed_at=? where task_id=?').run(exp,server_time,taskId);
    return {lease_expires_at:exp,round_deadline_at:m.round_deadline_at,server_time};
  }
  function progress(deviceId,taskId,{lease_id,session_id,step,steps,supervised_tokens,loss,state}){
    const d=authDevice(deviceId);checkSession(d,session_id);const t=ownTask(deviceId,taskId,lease_id);
    if(t.state!=='leased')fail('LEASE_EXPIRED','task is no longer active');
    const p={step:Number.isSafeInteger(step)?step:null,steps:Number.isSafeInteger(steps)?steps:null,supervised_tokens:Number.isSafeInteger(supervised_tokens)?supervised_tokens:null,
      loss:Number.isFinite(loss)?loss:null,state:typeof state==='string'?state.slice(0,24):null,self_reported:true,at:now()};
    db.prepare('update tasks set progress=? where task_id=?').run(J(p),taskId);return {ok:true};
  }
  function abandon(deviceId,taskId,{lease_id,session_id,reason}){
    const d=authDevice(deviceId);checkSession(d,session_id);const t=ownTask(deviceId,taskId,lease_id);
    if(t.state!=='leased')return {ok:true,state:t.state};
    tx(db,()=>{db.prepare("update tasks set state='abandoned',reason=? where task_id=?").run(String(reason||'').slice(0,80),taskId);db.prepare("update assignments set state='open' where id=? and state='leased'").run(t.assignment_id);});
    event('info','task.abandoned',{device:deviceId,task:taskId},{reason:String(reason||'').slice(0,80)});return {ok:true};
  }
  // Artifact scope: a device may read the parent checkpoint and row set of a task it holds, nothing else
  // (validation/test shards are never served).
  function artifactFor(deviceId,sha){
    authDevice(deviceId);
    if(!isHex64(sha))fail('INVALID_SCHEMA','bad hash');
    const ok=db.prepare("select 1 from tasks where device_id=? and state in ('leased','accepted','submitted') and (json_extract(manifest,'$.base_adapter_hash')=? or json_extract(manifest,'$.dataset_shard_hash')=?)").get(deviceId,sha,sha);
    if(!ok)fail('FORBIDDEN_SCOPE','artifact is outside this device scope');
    return cas.get(sha);
  }

  // ---------- updates ----------
  function declareUpdate(deviceId,meta){
    const d=authDevice(deviceId);checkSession(d,meta?.session_id);
    const t=ownTask(deviceId,meta?.task_id,meta?.lease_id);
    if(!isHex64(meta.payload_sha256))fail('INVALID_SCHEMA','payload_sha256 required');
    if(!Number.isSafeInteger(meta.bytes)||meta.bytes<=0)fail('INVALID_SCHEMA','bytes required');
    if(meta.bytes>MAX_UPDATE_BYTES)fail('TOO_LARGE','update exceeds '+MAX_UPDATE_BYTES+' bytes');
    if(meta.update_kind!=='absolute_b')fail('UNSUPPORTED_PROTOCOL','only update_kind=absolute_b is supported');
    const key=String(meta.idempotency_key||'');if(!/^[0-9a-f]{64}$/.test(key))fail('INVALID_SCHEMA','idempotency_key must be sha256 hex');
    const prior=db.prepare('select * from updates where idempotency_key=?').get(key);
    if(prior){
      if(prior.task_id!==t.task_id||prior.device_id!==deviceId)fail('CONFLICT','idempotency key belongs to another task');
      if(prior.payload_sha!==meta.payload_sha256)fail('DUPLICATE_DIFFERENT','same idempotency key with a different payload');
      return updateStatus(deviceId,prior.update_id);
    }
    const other=db.prepare("select * from updates where task_id=? and state in ('accepted','uploaded','declared')").get(t.task_id);
    if(other&&other.payload_sha!==meta.payload_sha256)fail('DUPLICATE_DIFFERENT','task already has a different update');
    if(other)return updateStatus(deviceId,other.update_id);
    const m=P(t.manifest);
    for(const k of ['experiment_id','run_id','round','base_adapter_hash','schema_hash','config_hash','dataset_shard_hash','model_variant_id']){
      if(meta[k]!==m[k])fail('STALE',`update ${k} does not match the task`,{field:k});
    }
    // Late uploads (lease expired / round sealed) are still stored so the audit trail shows them; commit
    // quarantines them and they never enter aggregation (N06). Revoked or cancelled tasks are refused outright.
    if(!['leased','expired','void'].includes(t.state))fail('STALE','task is '+t.state);
    const id='upd-'+randomBytes(10).toString('hex');
    const clean={steps:Number.isSafeInteger(meta.steps)?meta.steps:null,supervised_tokens:Number.isSafeInteger(meta.supervised_tokens)?meta.supervised_tokens:null,
      timing:sanitizeMetrics(meta.timing),runtime_version:String(meta.runtime_version||'').slice(0,60),backend:String(meta.backend||'').slice(0,20),self_reported:true};
    db.prepare("insert into updates(update_id,idempotency_key,task_id,device_id,payload_sha,bytes,state,meta,created_at) values(?,?,?,?,?,?,'declared',?,?)").run(id,key,t.task_id,deviceId,meta.payload_sha256,meta.bytes,J(clean),now());
    return updateStatus(deviceId,id);
  }
  function putContent(deviceId,updateId,bytes,sessionId){
    const start=performance.now();
    const device=authDevice(deviceId);
    const u=db.prepare('select * from updates where update_id=?').get(String(updateId));if(!u)fail('NOT_FOUND','update not found');
    if(u.device_id!==deviceId)fail('NOT_OWNER','update belongs to another device');
    if(bytes.length>MAX_UPDATE_BYTES)fail('TOO_LARGE','update too large');
    if(bytes.length!==u.bytes||sha256(bytes)!==u.payload_sha)fail('HASH_MISMATCH','content does not match the declared digest');
    const t=db.prepare('select * from tasks where task_id=?').get(u.task_id),m=P(t.manifest),p=getProfile(m.model_profile);
    if(sessionId||m.model_files_digest)checkSession(device,sessionId);
    if(u.state!=='declared')return updateStatus(deviceId,updateId);
    try{verifyTensors(decode(bytes,{maxBytes:MAX_UPDATE_BYTES}).tensors,p,false);}
    catch(e){db.prepare("update updates set state='rejected',reason=? where update_id=?").run(e.code||'INVALID_TENSOR',updateId);event('warn','update.rejected',{device:deviceId,task:u.task_id},{reason:e.code,message:e.message});throw e;}
    const checked=performance.now();
    const h=cas.put(bytes);db.prepare('insert or ignore into artifacts(sha256,kind,bytes,created_at) values(?,?,?,?)').run(h,'update',bytes.length,now());
    db.prepare("update updates set state='uploaded' where update_id=?").run(updateId);
    event('info','update.uploaded',{experiment:m.experiment_id,device:deviceId,task:t.task_id},{bytes:bytes.length,
      validation_ms:Math.round(checked-start),persist_ms:Math.round(performance.now()-checked)});
    return updateStatus(deviceId,updateId);
  }
  function commitUpdate(deviceId,updateId,{session_id}={}){
    const d=authDevice(deviceId);
    const u=db.prepare('select * from updates where update_id=?').get(String(updateId));if(!u)fail('NOT_FOUND','update not found');
    if(u.device_id!==deviceId)fail('NOT_OWNER','update belongs to another device');
    if(['accepted','rejected','quarantined'].includes(u.state))return updateStatus(deviceId,updateId);   // replay → stored ack (N03)
    checkSession(d,session_id);
    if(u.state!=='uploaded')fail('INVALID_TRANSITION','upload the content first');
    const t=db.prepare('select * from tasks where task_id=?').get(u.task_id),m=P(t.manifest),a=db.prepare('select * from assignments where id=?').get(t.assignment_id);
    const e=experiment(m.experiment_id),r=db.prepare('select * from rounds where experiment_id=? and idx=? and attempt=?').get(e.id,a.round_idx,a.round_attempt);
    const reject=(code,msg,state='rejected')=>{db.prepare('update updates set state=?,reason=? where update_id=?').run(state,code,updateId);event('warn','update.'+state,{experiment:e.id,device:deviceId,task:t.task_id},{reason:code,message:msg});fail(code,msg);};
    if(t.state!=='leased'||t.lease_expires_at<=now()||r.deadline_at<=now())reject('LEASE_EXPIRED','late update: lease expired, quarantined and not applied','quarantined');
    if(!['OPEN','COLLECTING'].includes(r.state)||e.state==='CANCELLED')reject('STALE','round is '+r.state,'quarantined');
    const meta=P(u.meta);
    // Weight is the coordinator's own count from the immutable assignment; the worker's figure must agree.
    if(meta.supervised_tokens!==a.expected_tokens)reject('TOKEN_MISMATCH',`reported ${meta.supervised_tokens} supervised tokens, assignment has ${a.expected_tokens}`);
    if(meta.steps!==m.local_steps)reject('INVALID_SCHEMA',`completed ${meta.steps} of ${m.local_steps} optimizer steps; only complete tasks are accepted`);
    const base=decode(cas.get(r.parent_hash)).tensors,upd=decode(cas.get(u.payload_sha)).tensors;
    let norm=0,delta=0;for(const k of Object.keys(upd)){const x=upd[k].data,b=base[k].data;for(let i=0;i<x.length;i++){norm+=x[i]*x[i];const dd=x[i]-b[i];delta+=dd*dd;}}
    if(!Number.isFinite(norm+delta)||Math.max(norm,delta)>MAX_ADAPTER_L2**2)
      reject('UPDATE_NORM_LIMIT','adapter or update delta exceeds the numerical safety bound');
    const accepted=tx(db,()=>{
      const fresh=db.prepare('select state from rounds where experiment_id=? and idx=? and attempt=?').get(e.id,r.idx,r.attempt);
      if(!['OPEN','COLLECTING'].includes(fresh.state))return false;
      db.prepare("update updates set state='accepted',accepted_at=?,norm=?,delta_norm=? where update_id=?").run(now(),Math.sqrt(norm),Math.sqrt(delta),updateId);
      db.prepare("update tasks set state='accepted' where task_id=?").run(t.task_id);
      db.prepare("update assignments set state='accepted' where id=?").run(a.id);
      db.prepare('update devices set accepted_count=accepted_count+1,last_accepted_at=? where id=?').run(now(),deviceId);
      return true;
    });
    if(!accepted)reject('STALE','round sealed while uploading','quarantined');
    event('info','update.accepted',{experiment:e.id,device:deviceId,task:t.task_id},{round:r.idx,tokens:a.expected_tokens,zero_delta:delta===0});
    maybeSeal(e.id);
    return updateStatus(deviceId,updateId);
  }
  function updateStatus(deviceId,updateId){
    const u=db.prepare('select * from updates where update_id=?').get(String(updateId));if(!u)fail('NOT_FOUND','update not found');
    if(u.device_id!==deviceId)fail('NOT_OWNER','update belongs to another device');
    const t=db.prepare('select * from tasks where task_id=?').get(u.task_id),m=P(t.manifest);
    const carried=db.prepare(`select r.state,r.checkpoint_hash from round_reuse x join assignments a on a.id=x.assignment_id
      join rounds r on (r.experiment_id,r.idx,r.attempt)=(a.experiment_id,a.round_idx,a.round_attempt)
      where x.update_id=? and r.state='COMMITTED'`).get(updateId);
    const r=carried||db.prepare('select state,checkpoint_hash from rounds where experiment_id=? and idx=? and attempt=?').get(m.experiment_id,m.round,m.round_attempt);
    return {update_id:u.update_id,task_id:u.task_id,state:u.state,reason:u.reason,payload_sha256:u.payload_sha,round:m.round,round_state:r?.state,round_checkpoint:r?.checkpoint_hash||null};
  }
  function authorizeTransfer(deviceId,id,sid){
    const d=authDevice(deviceId);checkSession(d,sid);
    const u=db.prepare('select * from updates where update_id=?').get(id);
    if(!u)fail('NOT_FOUND','update not found');
    if(u.device_id!==deviceId)fail('NOT_OWNER','update belongs to another device');
    const t=ownTask(deviceId,u.task_id);
    const deadline=P(t.manifest).round_deadline_at;
    if(u.state==='declared'&&(t.state!=='leased'||t.lease_expires_at<=now()||deadline<=now()))
      fail('LEASE_EXPIRED','partial upload lease is no longer valid');
    return {update:u,deadline};
  }
  const transfer=createTransferStore(db,{now,authorize:authorizeTransfer,store:putContent,status:updateStatus});

  // ---------- sealing / aggregation / recovery ----------
  function maybeSeal(expId,{deadline=false}={}){
    const e=experiment(expId),cfg=JSON.parse(e.config),r=currentRound(e);
    if(!r||!['OPEN','COLLECTING'].includes(r.state))return;
    const acc=db.prepare("select u.update_id,u.payload_sha,t.task_id,a.expected_tokens,t.device_id from updates u join tasks t on t.task_id=u.task_id join assignments a on a.id=t.assignment_id where a.experiment_id=? and a.round_idx=? and a.round_attempt=? and u.state='accepted'").all(e.id,r.idx,r.attempt);
    acc.push(...db.prepare(`select u.update_id,u.payload_sha,u.task_id,a.expected_tokens,u.device_id from round_reuse x
      join assignments a on a.id=x.assignment_id join updates u on u.update_id=x.update_id
      where (a.experiment_id,a.round_idx,a.round_attempt)=(?,?,?)`).all(e.id,r.idx,r.attempt));
    const devices=new Set(acc.map(x=>x.device_id));
    const minTokens=cfg.quorum.min_tokens??0;
    const enoughTokens=acc.reduce((sum,x)=>sum+x.expected_tokens,0)>=minTokens;
    const minimum=acc.length>=cfg.quorum.min&&devices.size>=cfg.quorum.min&&enoughTokens;
    const full=acc.length>=cfg.quorum.target&&devices.size>=cfg.quorum.target;
    const adaptiveWindow=cfg.quorum.mode==='adaptive'&&now()>=r.opened_at+(r.deadline_at-r.opened_at)*0.8;
    const canSealMinimum=cfg.quorum.mode==='minimum'||adaptiveWindow||
      (deadline&&['fault_tolerant','deadline','adaptive'].includes(cfg.quorum.mode));
    if(!(full&&enoughTokens)&&!(canSealMinimum&&minimum))return;
    const frozen=acc.map(x=>({update_id:x.update_id,task_id:x.task_id,payload_sha:x.payload_sha,weight:x.expected_tokens,device_id:x.device_id})).sort((a,b)=>a.task_id<b.task_id?-1:1);
    const excluded=db.prepare("select a.slot,a.state,a.id from assignments a where a.experiment_id=? and a.round_idx=? and a.round_attempt=? and a.state<>'accepted'").all(e.id,r.idx,r.attempt).map(x=>({assignment:x.id,slot:x.slot,reason:'not completed before deadline'}));
    const sealed=tx(db,()=>{
      const st=db.prepare('select state from rounds where experiment_id=? and idx=? and attempt=?').get(e.id,r.idx,r.attempt).state;
      if(!['OPEN','COLLECTING'].includes(st))return false;
      db.prepare("update rounds set state='SEALING',sealed_at=?,accepted=?,excluded=? where experiment_id=? and idx=? and attempt=?").run(now(),J(frozen),J(excluded),e.id,r.idx,r.attempt);
      db.prepare("update tasks set state='void',reason='round sealed' where state='leased' and assignment_id in (select id from assignments where experiment_id=? and round_idx=? and round_attempt=?)").run(e.id,r.idx,r.attempt);
      return true;
    });
    if(!sealed)return;
    event('info','round.sealed',{experiment:e.id},{round:r.idx,accepted:frozen.length,excluded:excluded.length,deadline});
    aggregateRound(e.id,r.idx,r.attempt);
  }
  function aggregateRound(expId,idx,attempt){
    const e=experiment(expId),cfg=JSON.parse(e.config),p=getProfile(cfg.profile_id);
    const r=db.prepare('select * from rounds where experiment_id=? and idx=? and attempt=?').get(expId,idx,attempt);
    if(r.state!=='SEALING'&&r.state!=='AGGREGATING')return;
    db.prepare("update rounds set state='AGGREGATING' where experiment_id=? and idx=? and attempt=?").run(expId,idx,attempt);
    const t0=Date.now();
    const frozen=P(r.accepted),base=decode(cas.get(r.parent_hash)).tensors;
    const result=fedavg(base,frozen.map(f=>({id:f.task_id,weight:f.weight,tensors:decode(cas.get(f.payload_sha)).tensors})),p);
    const bytes=encode(result.tensors,{kind:'kvalah-ffa-adapter',profile:p.id,round:String(idx+1)}),h=cas.put(bytes);
    if(frozenAHash(result.tensors)!==e.frozen_a_hash)fail('FROZEN_A_CHANGED','aggregation changed A');
    const ms=Date.now()-t0;
    tx(db,()=>{
      db.prepare('insert or ignore into artifacts(sha256,kind,bytes,created_at) values(?,?,?,?)').run(h,'checkpoint',bytes.length,now());
      db.prepare('insert or ignore into checkpoints(hash,experiment_id,round_idx,created_at,lineage) values(?,?,?,?,?)').run(h,expId,idx+1,now(),J({parent:r.parent_hash,round:idx,attempt,order:result.order,weights:result.weights,total_tokens:result.total}));
      db.prepare("update rounds set state='COMMITTED',committed_at=?,checkpoint_hash=?,aggregation_ms=? where experiment_id=? and idx=? and attempt=?").run(now(),h,ms,expId,idx,attempt);
      const fin=idx+1>=cfg.rounds||P(e.blocker)?.finish_after_round;
      if(fin)db.prepare("update experiments set state='COMPLETED',finished_at=?,current_round=? where id=?").run(now(),idx+1,expId);
      else if(e.state==='RUNNING'||e.state==='PAUSED')openRound({...e},cfg,idx+1,1,h);
      if(!fin&&e.state==='PAUSED')db.prepare("update experiments set state='PAUSED' where id=?").run(expId);
    });
    event('info','round.committed',{experiment:expId},{round:idx,checkpoint:h.slice(0,16),accepted:frozen.length,tokens:result.total,aggregation_ms:ms});
    const done=experiment(expId).state==='COMPLETED';
    if(cfg.eval.every&&(idx+1)%cfg.eval.every===0&&!done)runEval(expId,idx+1,h);
    if(done){event('info','experiment.completed',{experiment:expId},{rounds:idx+1});if(cfg.eval.final)runEval(expId,idx+1,h);}
  }
  let closed=false;
  function runEval(expId,round,hash){
    if(!evaluate){db.prepare('update experiments set eval=? where id=?').run(J({...(P(experiment(expId).eval)||{}),status:'NOT RUN: no trusted evaluator configured on this coordinator'}),expId);return;}
    Promise.resolve().then(()=>{
      const e=experiment(expId);
      return evaluate({experiment:P(e.config),modelSnapshot:P(e.model_snapshot),checkpoint:cas.get(hash),round,hash,split:'validation'});
    }).then(res=>{
      if(closed)return; // coordinator closed while the evaluator was running: drop the late result
      const e=experiment(expId),ev=P(e.eval)||{};ev.rounds=ev.rounds||{};ev.rounds[round]={...res,checkpoint:hash,at:now()};
      const r0=ev.rounds[0]?.nll,rf=ev.rounds[round]?.nll;
      if(e.state==='COMPLETED'&&Number.isFinite(r0)&&Number.isFinite(rf)&&round>0)ev.gate={rel_change:(rf-r0)/r0,passed:(r0-rf)/r0>=0.01,rule:'validation NLL reduction >= 1% vs r0 (engineering research target, not a guarantee)'};
      db.prepare('update experiments set eval=? where id=?').run(J(ev),expId);event('info','eval.done',{experiment:expId},{round,nll:res.nll});
    }).catch(err=>{
      if(closed)return;
      const e=experiment(expId),ev=P(e.eval)||{};
      ev.rounds??={};
      ev.rounds[round]={status:'NOT RUN',reason:err.code||'EVALUATION_FAILED',checkpoint:hash,at:now()};
      db.prepare('update experiments set eval=? where id=?').run(J(ev),expId);
      event('error','eval.failed',{experiment:expId},{round,code:err.code||'EVALUATION_FAILED'});
    });
  }
  const testJobs=new Map();
  function evaluateTest(id){
    const e=experiment(id);
    if(e.state!=='COMPLETED')fail('INVALID_TRANSITION','finish the experiment before evaluating on the Test split');
    if(testJobs.has(e.id))return testJobs.get(e.id);
    const cfg=P(e.config),m=datasetManifest(cfg.dataset_id),ck=latestCheckpoint(e.id);
    if(!ck||ck.round_idx<1)fail('CHECKPOINT_INCOMPATIBLE','no committed checkpoint for Test evaluation');
    if(!m.group_audit||!m.split_counts?.test)fail('DATASET_INVALID','Test evaluation requires a nonempty Test split with an audited dataset revision');
    const previous=P(e.eval)?.test;
    if(previous?.status==='DONE'&&previous.checkpoint===ck.hash)return Promise.resolve(previous);
    const groups=auditSplitGroups(m,h=>cas.get(h));
    if(hashJSON(groups)!==hashJSON(m.group_audit))fail('DATASET_INVALID','dataset group audit differs from its shards');
    const bytes=cas.get(ck.hash);
    const job=Promise.resolve().then(()=>evaluate?
      evaluate({experiment:cfg,modelSnapshot:P(e.model_snapshot),checkpoint:bytes,round:ck.round_idx,hash:ck.hash,split:'test'}):
      {status:'NOT RUN',reason:'no trusted evaluator configured'})
      .catch(err=>({status:'NOT RUN',reason:err.code||'EVALUATION_FAILED'}))
      .then(result=>{
        const test={...result,split:'test',checkpoint:ck.hash,round:ck.round_idx,dataset_id:cfg.dataset_id,
          group_audit_sha256:hashJSON(groups),test_groups_sha256:groups.fingerprints.test,at:now()};
        if(!closed){
          const ev=P(experiment(e.id).eval)||{};
          ev.test=test;
          db.prepare('update experiments set eval=? where id=?').run(J(ev),e.id);
          audit('admin','eval.test',{id:e.id,status:test.status,checkpoint:ck.hash,dataset_id:cfg.dataset_id});
          event('info','eval.test',{experiment:e.id},{round:ck.round_idx,status:test.status,nll:test.nll});
        }
        return test;
      }).finally(()=>testJobs.delete(e.id));
    testJobs.set(e.id,job);
    return job;
  }
  function tick(){
    transfer.prune();
    // Expire leases (assignment returns to open → replacement possible, no double counting).
    for(const t of db.prepare("select * from tasks where state='leased' and lease_expires_at<=?").all(now())){
      tx(db,()=>{db.prepare("update tasks set state='expired',reason='lease expired' where task_id=? and state='leased'").run(t.task_id);db.prepare("update assignments set state='open' where id=? and state='leased'").run(t.assignment_id);});
      event('warn','task.expired',{device:t.device_id,task:t.task_id},{note:'assignment reopened for an eligible device'});
    }
    for(const e of db.prepare("select * from experiments where state in ('RUNNING','PAUSED')").all()){
      const r=currentRound(e);if(!r)continue;
      if(['SEALING','AGGREGATING'].includes(r.state)){aggregateRound(e.id,r.idx,r.attempt);continue;}
      if(e.state==='RUNNING'&&P(e.config).quorum.mode==='adaptive'&&now()<r.deadline_at&&
          now()>=r.opened_at+(r.deadline_at-r.opened_at)*0.8)maybeSeal(e.id);
      if(['OPEN','COLLECTING'].includes(r.state)&&r.deadline_at<=now()&&e.state==='RUNNING'){
        maybeSeal(e.id,{deadline:true});
        const after=db.prepare('select state from rounds where experiment_id=? and idx=? and attempt=?').get(e.id,r.idx,r.attempt).state;
        if(['OPEN','COLLECTING'].includes(after)){
          const cfg=JSON.parse(e.config),acc=db.prepare("select count(*) n from assignments where experiment_id=? and round_idx=? and round_attempt=? and state='accepted'").get(e.id,r.idx,r.attempt).n;
          const waiting=db.prepare("select a.slot,t.device_id from assignments a left join tasks t on t.assignment_id=a.id and t.state='leased' where a.experiment_id=? and a.round_idx=? and a.round_attempt=? and a.state<>'accepted'").all(e.id,r.idx,r.attempt);
          const blocker={reason:'below_quorum_at_deadline',accepted:acc,min_quorum:cfg.quorum.min,target:cfg.quorum.target,mode:cfg.quorum.mode,waiting_slots:waiting.map(w=>({slot:w.slot,device:w.device_id||null}))};
          tx(db,()=>{db.prepare("update rounds set state='BLOCKED',blocker=? where experiment_id=? and idx=? and attempt=?").run(J(blocker),e.id,r.idx,r.attempt);db.prepare("update experiments set state='BLOCKED',blocker=? where id=?").run(J(blocker),e.id);
            db.prepare("update tasks set state='void',reason='round blocked' where state='leased' and assignment_id in (select id from assignments where experiment_id=? and round_idx=? and round_attempt=?)").run(e.id,r.idx,r.attempt);});
          event('error','round.blocked',{experiment:e.id},blocker);
        }
      }
    }
  }
  // Boot: verify committed lineage and finish interrupted aggregation deterministically (N09).
  function recover(){
    const problems=[];
    for(const c of db.prepare('select * from checkpoints').all()){if(!cas.has(c.hash))problems.push({checkpoint:c.hash,problem:'missing'});else try{cas.get(c.hash);}catch{problems.push({checkpoint:c.hash,problem:'corrupt'});}}
    for(const r of db.prepare("select * from rounds where state in ('SEALING','AGGREGATING')").all()){event('warn','recovery.aggregate',{experiment:r.experiment_id},{round:r.idx});aggregateRound(r.experiment_id,r.idx,r.attempt);}
    if(problems.length)event('error','recovery.corruption',{}, {problems:problems.slice(0,10)});
    return {problems};
  }
  recover();

  // ---------- views ----------
  function status(id){
    const e=experiment(id),cfg=JSON.parse(e.config),r=currentRound(e);
    const asg=r?db.prepare('select a.*,(select device_id from tasks t where t.assignment_id=a.id order by attempt desc limit 1) dev,(select progress from tasks t where t.assignment_id=a.id order by attempt desc limit 1) prog,(select state from tasks t where t.assignment_id=a.id order by attempt desc limit 1) tstate from assignments a where experiment_id=? and round_idx=? and round_attempt=? order by slot').all(e.id,r.idx,r.attempt):[];
    const committed=db.prepare("select count(*) n from rounds where experiment_id=? and state='COMMITTED'").get(e.id).n;
    const checkpoint=committed?latestCheckpoint(e.id):null;
    return {id:e.id,run_id:e.run_id,name:e.name,state:e.state,config:cfg,config_hash:e.config_hash,model_snapshot:P(e.model_snapshot),created_at:e.created_at,started_at:e.started_at,finished_at:e.finished_at,
      initial_hash:e.initial_hash,frozen_a_hash:e.frozen_a_hash,committed_rounds:committed,target_rounds:cfg.rounds,blocker:P(e.blocker),eval:P(e.eval),
      checkpoint:checkpoint?{sha256:checkpoint.hash,round:checkpoint.round_idx}:null,test_pending:testJobs.has(e.id),
      round:r?{idx:r.idx,attempt:r.attempt,state:r.state,parent_hash:r.parent_hash,opened_at:r.opened_at,deadline_at:r.deadline_at,remaining_ms:Math.max(0,r.deadline_at-now()),blocker:P(r.blocker),
        accepted:asg.filter(a=>a.state==='accepted').length,leased:asg.filter(a=>a.state==='leased').length,min_quorum:cfg.quorum.min,target:cfg.quorum.target,
        slots:asg.map(a=>({slot:a.slot,state:a.state,device_id:a.dev??db.prepare('select u.device_id from round_reuse x join updates u on u.update_id=x.update_id where x.assignment_id=?').get(a.id)?.device_id??null,
          task_state:a.tstate,expected_tokens:a.expected_tokens,progress:P(a.prog)}))}:null};
  }
  function rounds(id){
    experiment(id);
    return db.prepare('select * from rounds where experiment_id=? order by idx,attempt').all(id).map(r=>({idx:r.idx,attempt:r.attempt,state:r.state,parent_hash:r.parent_hash,checkpoint_hash:r.checkpoint_hash,
      opened_at:r.opened_at,sealed_at:r.sealed_at,committed_at:r.committed_at,duration_ms:r.committed_at?r.committed_at-r.opened_at:null,aggregation_ms:r.aggregation_ms,
      accepted:P(r.accepted),excluded:P(r.excluded),blocker:P(r.blocker),
      updates:db.prepare("select u.update_id,u.device_id,u.state,u.reason,u.payload_sha,u.norm,u.delta_norm,u.meta,t.task_id from updates u join tasks t on t.task_id=u.task_id join assignments a on a.id=t.assignment_id where a.experiment_id=? and a.round_idx=? and a.round_attempt=?").all(id,r.idx,r.attempt).map(u=>({...u,meta:P(u.meta)}))}));
  }
  const listExperiments=()=>db.prepare('select id from experiments order by created_at desc').all().map(x=>status(x.id));
  const events=(after=0,limit=200)=>db.prepare('select * from events where seq>? order by seq limit ?').all(Number(after)||0,Math.min(1000,limit)).map(e=>({...e,details:P(e.details)}));
  const latestEvents=(limit=200)=>db.prepare('select * from events order by seq desc limit ?').all(Math.min(1000,limit)).reverse().map(e=>({...e,details:P(e.details)}));
  const checkpoint=hash=>cas.get(hash);
  const latestCheckpoint=id=>{const e=experiment(id);return db.prepare('select * from checkpoints where experiment_id=? order by round_idx desc limit 1').get(e.id);};
  return {db,cas,projectId,coordinatorKey:key.publicKey,createPairing,pairStart,pairComplete,approveDevice,revokeDevice,drainDevice,renameDevice,authDevice,useNonce,startSession,heartbeat,listDevices,
    registerVariant,variants,registerDataset,datasetManifest,listDatasets,dryRun,createExperiment,startExperiment,pauseExperiment,resumeExperiment,cancelExperiment,finishAfterRound,
    claim,renew,progress,abandon,artifactFor,declareUpdate,putContent,commitUpdate,updateStatus,transfer,tick,recover,status,rounds,listExperiments,events,latestEvents,checkpoint,latestCheckpoint,evaluateTest,
    onEvent:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);},close:()=>{closed=true;db.close();}};
}
