import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {canonicalJSON,hashJSON,isHex64,sha256} from '../protocol/hash.mjs';
import {fail} from '../protocol/errors.mjs';
import {encode} from '../protocol/safetensors.mjs';
import {aggregateExpert} from './aggregate.mjs';
import {putArtifact} from './provision.mjs';
import {scheduleExperts} from './scheduler.mjs';

const ttl=2*60*1000;
const decode=x=>JSON.parse(x);

function initial(expert){
  let seed=Number.parseInt(hashJSON(expert.id).slice(0,8),16)>>>0;
  function sample(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32-.5;}
  return encode(Object.fromEntries(expert.tensors.map(t=>{
    const data=new Float32Array(t.shape.reduce((a,b)=>a*b,1));
    if(!t.name.endsWith('.B')&&!t.name.endsWith('.down.weight')){
      const scale=2/Math.sqrt(t.shape.at(-1));
      for(let i=0;i<data.length;i++)data[i]=sample()*scale;
    }
    return [t.name,{shape:t.shape,data}];
  })));
}

export function createFusionQueue(registry,{now=Date.now,devices=()=>[]}={}){
  const db=registry.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, expert TEXT NOT NULL, config TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL,
      checkpoint TEXT, failure TEXT);
    CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES runs(id), slot INTEGER NOT NULL, device TEXT NOT NULL,
      expiry INTEGER NOT NULL, state TEXT NOT NULL, manifest TEXT NOT NULL, progress TEXT, result TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS active_lease_by_device ON leases(device) WHERE state='leased';
    CREATE UNIQUE INDEX IF NOT EXISTS active_lease_by_slot ON leases(run,slot) WHERE state IN ('leased','accepted');
    CREATE UNIQUE INDEX IF NOT EXISTS active_run_by_expert ON runs(expert) WHERE status IN ('RUNNING','PAUSED','AGGREGATING','EVALUATING');`);
  const tx=registry.transaction;
  const get=id=>db.prepare('SELECT * FROM runs WHERE id=?').get(id);
  const pick=id=>db.prepare('SELECT * FROM leases WHERE id=?').get(id);
  const expire=()=>db.prepare("UPDATE leases SET state='expired' WHERE state='leased' AND expiry<=?").run(now());
  function authorize(device,id){
    const l=pick(id),r=l&&get(l.run);
    if(!l||l.device!==device)fail('NOT_OWNER','Fusion lease is unavailable for this device');
    if(l.state==='accepted')return {l,r,m:decode(l.manifest)};
    if(l.state!=='leased'||l.expiry<=now())fail('LEASE_EXPIRED','Fusion lease expired');
    if(r.status!=='RUNNING')fail('PAUSED','Fusion training is paused or stopped');
    return {l,r,m:decode(l.manifest)};
  }
  const mark=(id,status,error=null)=>db.prepare('UPDATE runs SET status=?,failure=? WHERE id=?').run(status,error,id);
  return {
    list(){
      return db.prepare('SELECT * FROM runs ORDER BY created DESC LIMIT 50').all().map(r=>({id:r.id,expert:r.expert,status:r.status,created:r.created,
        checkpoint:r.checkpoint,failure:r.failure,devices:decode(r.config).devices,
        leases:db.prepare('SELECT slot,device,state,expiry,progress FROM leases WHERE run=? ORDER BY rowid DESC LIMIT 12').all(r.id)
          .map(l=>({...l,progress:l.progress?decode(l.progress):null}))}));
    },
    start({expertId,rows,validation,devices=[],quorum=1,modelDigest,backend,modelVariants=[],maxLength,group='lan'}){
      if(!isHex64(modelDigest)||!Number.isInteger(maxLength)||maxLength<2||maxLength>8192||![1,2,3].includes(quorum)||
        !Array.isArray(devices)||devices.length&&devices.length!==quorum||new Set(devices).size!==devices.length)
        fail('INVALID_SCHEMA','invalid Fusion run configuration');
      let expert=registry.get(expertId);
      if(expert.base.backbone_sha256!==modelDigest||!['CREATED','READY'].includes(expert.status))fail('MODEL_UNVERIFIED','invalid base or expert state');
      const per=expert.training.local_steps*expert.training.grad_accum;
      if(!Array.isArray(rows)||rows.length<quorum*per||!Array.isArray(validation)||!validation.length)fail('DATASET_REQUIRED','not enough Train and Validation data for this run');
      if(expert.status==='CREATED'){
        registry.change(expertId,'CREATED','PROVISIONING');
        registry.checkpoint(expertId,initial(expert));
        expert=registry.change(expertId,'PROVISIONING','READY');
      }
      const id=randomUUID();
      const tasks=Array.from({length:quorum},(_,i)=>{
        const shard=rows.slice(i*per,(i+1)*per).map(r=>({input_ids:r.input_ids,target_mask:r.target_mask}));
        if(shard.some(r=>!Array.isArray(r.input_ids)||r.input_ids.length<2||r.input_ids.length>maxLength||!Array.isArray(r.target_mask)||!r.target_mask.slice(1).some(Boolean)))
          fail('DATASET_INVALID','invalid Fusion training rows');
        const tokens=shard.reduce((n,r)=>n+r.target_mask.slice(1).filter(Boolean).length,0);
        const train=putArtifact(registry.cas,'train',Buffer.from(canonicalJSON({split:'train',rows:shard})),expert.dataset_sha256);
        return {slot:i,train,tokens};
      });
      const validationBytes=Buffer.from(canonicalJSON({split:'validation',rows:validation.map(r=>({input_ids:r.input_ids,target_mask:r.target_mask}))}));
      if(validationBytes.length>16*1024**2)fail('TOO_LARGE','Fusion validation shard is too large');
      if(!['cuda','mlx','torch-cpu-test'].includes(backend)||!Array.isArray(modelVariants)||modelVariants.some(v=>!isHex64(v.digest)||!['cuda','mlx','torch-cpu-test'].includes(v.backend)))
        fail('MODEL_UNVERIFIED','invalid Fusion model variants');
      const config={devices,tasks,group,modelDigest,backend,modelVariants,maxLength,validation:registry.cas.put(validationBytes),parent:expert.checkpoint.hash};
      const weight=putArtifact(registry.cas,'expert',registry.cas.get(config.parent),config.parent);
      config.weight=weight;
      tx(()=>{
        if(db.prepare("SELECT id FROM runs WHERE expert=? AND status IN ('RUNNING','PAUSED','AGGREGATING','EVALUATING')").get(expertId))fail('CONFLICT','expert already has an active run');
        db.prepare("INSERT INTO runs VALUES (?,?,?,'RUNNING',?,NULL,NULL)").run(id,expertId,canonicalJSON(config),now());
        registry.change(expertId,'READY','TRAINING');
      });
      return {id,status:'RUNNING'};
    },
    claim(device,worker){
      if(worker?.consent!==true||!['cuda','mlx','torch-cpu-test'].includes(worker.backend)||!isHex64(worker.model_sha256)||
        !Number.isSafeInteger(worker.available_bytes)||worker.available_bytes<0)return {task:null};
      return tx(()=>{
        expire();
        const prior=db.prepare("SELECT manifest,expiry FROM leases WHERE device=? AND state='leased'").get(device);
        if(prior){
          const {format,...retained}=decode(prior.manifest).manifest;
          return {task:registry.signed({...retained,expires:prior.expiry}),public_key:registry.publicKey};
        }
        for(const run of db.prepare("SELECT * FROM runs WHERE status='RUNNING' ORDER BY created LIMIT 128").all()){
          const cfg=decode(run.config),e=registry.get(run.expert);
          const compatible=(backend,digest)=>((cfg.backend??'cuda')===backend&&cfg.modelDigest===digest)||(cfg.modelVariants??[]).some(v=>v.backend===backend&&v.digest===digest);
          if(!compatible(worker.backend,worker.model_sha256)||!e.runtimes.includes(worker.backend==='cuda'?'cuda-nf4':worker.backend==='mlx'?'mlx':'torch-cpu'))continue;
          const claimed=db.prepare("SELECT slot,device FROM leases WHERE run=? AND state IN ('leased','accepted')").all(run.id);
          if(claimed.some(x=>x.device===device))continue;
          const task=cfg.tasks.find(x=>!claimed.some(l=>l.slot===x.slot)&&(!cfg.devices.length||cfg.devices[x.slot]===device));
          if(!task||worker.available_bytes<task.train.bytes+cfg.weight.bytes+e.bytes+1024**2)continue;
          if(!cfg.devices.length){
            const runtime=worker.backend==='cuda'?'cuda-nf4':worker.backend==='mlx'?'mlx':'torch-cpu';
            const busy=db.prepare("SELECT device FROM leases WHERE state='leased'").all().map(row=>row.device);
            const candidates=devices().filter(d=>!busy.includes(d.id)&&!claimed.some(l=>l.device===d.id)&&
              d.capabilities?.variants?.some(v=>compatible(d.capabilities.backend,v.files_digest))).map(d=>{
              const m=d.metrics??{},caps=d.capabilities;
              return {id:d.id,state:d.state,consent:m.fusion_opt_in===1,governor:{allowed:d.status?.eligible===true,target_pct:m.fusion_duty_pct??10},
                last_seen:now()-(d.heartbeat_age_ms??Infinity),runtime:caps.backend==='cuda'?'cuda-nf4':caps.backend==='mlx'?'mlx':'torch-cpu',group:cfg.group,
                free_ram:m.ram_available_bytes??0,free_vram:Number.isFinite(caps.memory_total_bytes)&&Number.isFinite(m.vram_used_bytes)?caps.memory_total_bytes-m.vram_used_bytes:(caps.memory_free_bytes??0),
                temp_c:m.temperature_c??0,max_temp_c:m.fusion_temp_limit??80,remaining_traffic:m.traffic_remaining??0,free_disk:m.fusion_cache_bytes??0,
                resident:m.resident_model===1?cfg.modelDigest:null,tokens_per_s:m.tokens_per_s??1,bytes_per_s:Math.max(1,m.fusion_link_bytes_s??10**6),cold_start_s:m.model_load_s??0};
            });
            const planned=scheduleExperts([{id:run.id,expert:e.id,priority:0,runtimes:[runtime],ram:2*1024**3,vram:runtime==='cuda-nf4'?1024**3:0,
              backbone:cfg.modelDigest,artifacts:[task.train,cfg.weight,{sha256:'result',bytes:e.bytes}],tokens:task.tokens}],candidates,{now:now()}).assigned[0];
            if(planned&&planned.device!==device)continue;
          }
          const id=randomUUID(),expires=now()+ttl;
          const inner=e.tensors.find(t=>t.name.endsWith('.gate.weight'))?.shape[0]??null;
          const spec={key:e.key,kind:e.kind,layers:e.layers,rank:e.rank,alpha:e.alpha,intermediate:inner,
            training_mode:e.tensors.find(t=>t.name.endsWith('.gate.weight'))?.trainable===false?'down':'full'};
          const signed=registry.signed({kind:'worker-task',id,run:run.id,expert:e.id,device,expires,parent:cfg.parent,schema:e.schema_sha256,
            model_sha256:worker.model_sha256,training:e.training,max_length:cfg.maxLength,expected_tokens:task.tokens,spec,artifacts:[cfg.weight,task.train]});
          db.prepare("INSERT INTO leases VALUES (?,?,?,?,?,'leased',?,NULL,NULL)").run(id,run.id,task.slot,device,expires,canonicalJSON(signed));
          return {task:signed,public_key:registry.publicKey};
        }
        return {task:null};
      });
    },
    renew(device,id,progress={}){
      const {m}=authorize(device,id);
      const expires=now()+ttl;
      const step=Number(progress.step??0),loss=Number(progress.loss??0),bytes=Number(progress.bytes??0);
      if(!Number.isInteger(step)||step<0||step>m.manifest.training.local_steps||!Number.isFinite(loss)||!Number.isSafeInteger(bytes)||bytes<0)
        fail('INVALID_SCHEMA','invalid Fusion progress');
      db.prepare("UPDATE leases SET expiry=?,progress=? WHERE id=? AND state='leased'").run(expires,canonicalJSON({step,loss,bytes}),id);
      return {expires};
    },
    chunk(device,id,hash){
      const {m}=authorize(device,id);
      const p=m.manifest.artifacts.flatMap(x=>x.parts).find(item=>item.sha256===hash);
      if(!p)fail('FORBIDDEN_SCOPE','part is outside the Fusion assignment');
      return registry.cas.get(hash,{maxBytes:p.bytes});
    },
    limits(device,id){
      const {l,m,r}=authorize(device,id),expert=registry.get(r.expert);
      return {tokens:m.manifest.expected_tokens,maxBytes:expert.bytes+1024**2,expires:Math.max(l.expiry,now()+ttl)};
    },
    result(device,id,{artifact,tokens},file){
      return tx(()=>{
        const {l,r,m}=authorize(device,id),manifest=m.manifest,e=registry.get(r.expert);
        if(l.result){
          const prior=decode(l.result);
          if(prior.sha256!==artifact.sha256)fail('DUPLICATE_DIFFERENT','Fusion result has changed');
          return prior;
        }
        if(tokens!==manifest.expected_tokens||artifact.bytes>e.bytes+1024**2||e.checkpoint?.hash!==manifest.parent)fail('STALE','Fusion result no longer matches its assignment');
        const bytes=fs.readFileSync(file);
        if(sha256(bytes)!==artifact.sha256)fail('HASH_MISMATCH','Fusion result differs from its staged artifact');
        const cfg=decode(r.config),round={id:r.id,algorithm:'fedavg',expert:e.id,parent:cfg.parent,schema:e.schema_sha256,frozen:e.checkpoint.frozen};
        const result={status:'accepted',id,device,sha256:artifact.sha256,tokens,expert:e.id};
        const toUpdate=(receipt,payload)=>({id:receipt.id,device:receipt.device,tokens:receipt.tokens,round:r.id,expert:e.id,schema:round.schema,
          parent:round.parent,frozen:round.frozen,config:hashJSON({algorithm:'fedavg',config:{}}),payload,payload_sha256:receipt.sha256});
        const previous=db.prepare("SELECT result FROM leases WHERE run=? AND state='accepted'").all(r.id).map(row=>decode(row.result));
        const update=toUpdate(result,bytes),agg=receipts=>aggregateExpert({expert:e,base:registry.cas.get(round.parent),round,
          assignments:receipts.map(u=>({id:u.id,device:u.device,tokens:u.tokens,group:cfg.group})),updates:receipts});
        agg([update]);
        registry.cas.put(bytes);
        db.prepare("UPDATE leases SET state='accepted',result=? WHERE id=? AND state='leased'").run(canonicalJSON(result),id);
        if(previous.length+1===cfg.tasks.length){
          const combined=agg([...previous.map(p=>toUpdate(p,registry.cas.get(p.sha256))),update]);
          registry.change(e.id,'TRAINING','AGGREGATING');
          const final=registry.checkpoint(e.id,combined.payload,{parent:round.parent,metrics:combined.metrics});
          registry.change(e.id,'AGGREGATING','EVALUATING');
          db.prepare("UPDATE runs SET checkpoint=?,status='EVALUATING' WHERE id=?").run(final.checkpoint.hash,r.id);
        }
        return result;
      });
    },
    nextEvaluation(){
      const r=db.prepare("SELECT * FROM runs WHERE status='EVALUATING' ORDER BY created LIMIT 1").get();
      return r?{...r,config:decode(r.config),expert:registry.get(r.expert)}:null;
    },
    finishEvaluation(id,data){
      const r=get(id),expert=registry.get(r.expert);
      if(r.status!=='EVALUATING'||r.checkpoint!==expert.checkpoint?.hash)fail('STALE','Fusion evaluation checkpoint has changed');
      const evaluated=registry.assessExpert(expert.id,{version:expert.version,dataset_sha256:decode(r.config).validation,
        control_nll:data.control.nll_sum/data.control.tokens,candidate_nll:data.candidate.nll_sum/data.candidate.tokens});
      const status=evaluated.status==='VALIDATED'?'VALIDATED':'REJECTED';
      mark(id,status);
      return {status};
    },
    control(id,action){
      return tx(()=>{
        const r=get(id);
        if(!r)fail('NOT_FOUND','Fusion run not found');
        if(action==='resume'&&r.status==='PAUSED'){
          registry.change(r.expert,'PAUSED','TRAINING');mark(id,'RUNNING');return {status:'RUNNING'};
        }
        if(!['pause','stop'].includes(action)||!['PAUSED','RUNNING'].includes(r.status))fail('INVALID_TRANSITION','invalid Fusion run command');
        if(r.status==='RUNNING')registry.change(r.expert,'TRAINING','PAUSED');
        db.prepare("UPDATE leases SET state='cancelled' WHERE run=? AND state='leased'").run(id);
        if(action==='stop')registry.change(r.expert,'PAUSED','REJECTED');
        const status=action==='stop'?'STOPPED':'PAUSED';
        mark(id,status);return {status};
      });
    }
  };
}
