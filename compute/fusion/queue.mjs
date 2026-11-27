import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {canonicalJSON,hashJSON,isHex64,sha256} from '../protocol/hash.mjs';
import {fail} from '../protocol/errors.mjs';
import {encode} from '../protocol/safetensors.mjs';
import {aggregateExpert} from './aggregate.mjs';
import {putArtifact} from './provision.mjs';
import {scheduleExperts} from './scheduler.mjs';
import {aggregateTensorFiles,checkUpdateFile,createTensorFile} from './tensor-file.mjs';
import {hashFile} from './stream.mjs';
import {planRound,trainingPlan} from './round-plan.mjs';
import {fitsFusionMemory,fusionFootprint} from './admission.mjs';

const ttl=2*60*1000;
const decode=x=>JSON.parse(x);

function initializer(expert){
  let seed=Number.parseInt(hashJSON(expert.id).slice(0,8),16)>>>0;
  function sample(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32-.5;}
  const scale=new Map(expert.tensors.map(t=>[t.name,2/Math.sqrt(t.shape.at(-1))]));
  return (name,data)=>{
    if(name.endsWith('.B')||name.endsWith('.down.weight'))return;
    const s=scale.get(name);
    for(let i=0;i<data.length;i++)data[i]=sample()*s;
  };
}

function withTemporaryFile(fn){
  const root=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(root,'fusion-reduction-'));
  try{return fn(path.join(dir,'candidate.safetensors'));}
  finally{if(path.dirname(dir)===root)fs.rmSync(dir,{recursive:true,force:true});}
}

export function createFusionQueue(registry,{now=Date.now,devices=()=>[],readTrain}={}){
  const db=registry.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, expert TEXT NOT NULL, config TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL,
      checkpoint TEXT, failure TEXT);
    CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES runs(id), slot INTEGER NOT NULL, device TEXT NOT NULL,
      expiry INTEGER NOT NULL, state TEXT NOT NULL, manifest TEXT NOT NULL, progress TEXT, result TEXT, round INTEGER NOT NULL DEFAULT 1);
    CREATE UNIQUE INDEX IF NOT EXISTS active_lease_by_device ON leases(device) WHERE state='leased';
    CREATE TABLE IF NOT EXISTS train_positions (expert TEXT PRIMARY KEY REFERENCES experts(id), epoch INTEGER NOT NULL, cursor INTEGER NOT NULL);`);
  const tx=registry.transaction;
  tx(()=>{
    if(!db.prepare('PRAGMA table_info(leases)').all().some(c=>c.name==='round'))db.exec('ALTER TABLE leases ADD COLUMN round INTEGER NOT NULL DEFAULT 1');
    db.exec(`DROP INDEX IF EXISTS active_lease_by_slot;
      DROP INDEX IF EXISTS active_run_by_expert;
      CREATE UNIQUE INDEX IF NOT EXISTS fusion_lease_by_round_slot ON leases(run,round,slot) WHERE state IN ('leased','accepted','committed');
      CREATE UNIQUE INDEX active_run_by_expert ON runs(expert) WHERE status IN ('RUNNING','PAUSED','AGGREGATING','EVALUATING','PAUSED_EVALUATION');`);
  });
  const get=id=>db.prepare('SELECT * FROM runs WHERE id=?').get(id);
  const pick=id=>db.prepare('SELECT * FROM leases WHERE id=?').get(id);
  const expire=()=>db.prepare("UPDATE leases SET state='expired' WHERE state='leased' AND expiry<=?").run(now());
  function authorize(device,id,{upload=false}={}){
    const l=pick(id),r=l&&get(l.run);
    if(!l||l.device!==device)fail('NOT_OWNER','Fusion lease is unavailable for this device');
    const m=decode(l.manifest);
    if(l.result)return {l,r,m};
    if(r.status==='PAUSED')fail('PAUSED','Fusion training is paused');
    if(r.status!=='RUNNING')fail('STALE','Fusion training round is no longer open');
    if(l.state==='leased'&&l.expiry>now())return {l,r,m};
    if(upload&&['leased','expired'].includes(l.state)&&l.expiry+24*3600*1000>now()){
      const cfg=decode(r.config);
      const newer=db.prepare("SELECT id FROM leases WHERE run=? AND round=? AND (slot=? OR device=?) AND id<>? AND state IN ('leased','accepted','committed')")
        .get(r.id,l.round,l.slot,device,id);
      if(!newer&&l.round===roundOf(cfg)&&cfg.parent===m.manifest.parent)return {l,r,m};
      fail('STALE','Fusion lease was replaced or its checkpoint changed');
    }
    fail('LEASE_EXPIRED','Fusion lease expired');
  }
  const mark=(id,status,error=null)=>db.prepare('UPDATE runs SET status=?,failure=? WHERE id=?').run(status,error,id);
  const roundOf=cfg=>cfg.round??1;

  function assignRound(expert,cfg,position){
    const round=planRound({plan:cfg.plan,position,trainCount:cfg.trainCount,quorum:cfg.quorum,maxLength:cfg.maxLength,expert,
      read:(offset,count)=>readTrain(cfg.dataset,expert.dataset_sha256,offset,count),cas:registry.cas});
    if(!round)return null;
    const parent=expert.checkpoint.hash,layout=registry.weightLayout(parent);
    const weight=layout?{...layout,stream:true,kind:'expert',source:parent}:putArtifact(registry.cas,'expert',registry.cas.get(parent),parent);
    return {...cfg,...round,weight,parent};
  }

  function advanced(run,cfg,checkpoint){
    const round=roundOf(cfg);
    for(const l of db.prepare("SELECT id,result FROM leases WHERE run=? AND round=? AND state='accepted'").all(run.id,round)){
      const result={...decode(l.result),status:'committed',checkpoint:checkpoint.checkpoint.hash,version:checkpoint.version};
      db.prepare("UPDATE leases SET state='committed',result=? WHERE id=?").run(canonicalJSON(result),l.id);
    }
    if(cfg.plan){
      const plan={...cfg.plan,tokens:cfg.plan.tokens+cfg.tokens};
      db.prepare('INSERT INTO train_positions VALUES (?,?,?) ON CONFLICT(expert) DO UPDATE SET epoch=excluded.epoch,cursor=excluded.cursor')
        .run(run.expert,cfg.next.epoch,cfg.next.index);
      cfg={...cfg,plan,committedPosition:cfg.next};
    }
    registry.change(run.expert,'AGGREGATING','EVALUATING');
    db.prepare("UPDATE runs SET checkpoint=?,config=?,status='EVALUATING' WHERE id=?").run(checkpoint.checkpoint.hash,canonicalJSON(cfg),run.id);
  }

  return {
    list(){
      return db.prepare('SELECT * FROM runs ORDER BY created DESC,rowid DESC LIMIT 50').all().map(r=>{
        const cfg=decode(r.config);
        return {id:r.id,expert:r.expert,status:r.status,created:r.created,checkpoint:r.checkpoint,failure:r.failure,devices:cfg.devices,
          round:roundOf(cfg),plan:cfg.plan??null,position:cfg.position??null,next_position:cfg.next??null,committed_position:cfg.committedPosition??null,
          leases:db.prepare('SELECT round,slot,device,state,expiry,progress FROM leases WHERE run=? ORDER BY rowid DESC LIMIT 12').all(r.id)
            .map(l=>({...l,progress:l.progress?decode(l.progress):null}))};
      });
    },
    start({expertId,dataset,trainCount,validation,devices=[],quorum=1,modelDigest,backend,modelVariants=[],maxLength,modelLayout=null,group='lan',schedule}){
      if(!isHex64(modelDigest)||!Number.isInteger(maxLength)||maxLength<2||maxLength>8192||![1,2,3].includes(quorum)||
        !Array.isArray(devices)||devices.length&&devices.length!==quorum||new Set(devices).size!==devices.length)
        fail('INVALID_SCHEMA','invalid Fusion run configuration');
      const plan=trainingPlan(schedule);
      if(!Array.isArray(validation)||!validation.length||typeof dataset!=='string'||!Number.isSafeInteger(trainCount)||trainCount<quorum)
        fail('DATASET_REQUIRED','not enough Train and Validation data for this run');
      const validationBytes=Buffer.from(canonicalJSON({split:'validation',rows:validation.map(r=>({input_ids:r.input_ids,target_mask:r.target_mask}))}));
      if(validationBytes.length>16*1024**2)fail('TOO_LARGE','Fusion validation shard is too large');
      if(!['cuda','mlx','torch-cpu-test'].includes(backend)||!Array.isArray(modelVariants)||modelVariants.some(v=>!isHex64(v.digest)||!['cuda','mlx','torch-cpu-test'].includes(v.backend)))
        fail('MODEL_UNVERIFIED','invalid Fusion model variants');
      return tx(()=>{
        let expert=registry.get(expertId);
        if(expert.base.backbone_sha256!==modelDigest)fail('MODEL_UNVERIFIED','invalid Fusion backbone');
        if(!['CREATED','READY','VALIDATED','REJECTED','PUBLISHED'].includes(expert.status))fail('CONFLICT','expert already has an active run or is archived');
        if(expert.status==='CREATED'){
          registry.change(expertId,'CREATED','PROVISIONING');
          const fill=initializer(expert);
          if(expert.storage==='file')withTemporaryFile(file=>{
            createTensorFile(file,expert.tensors,fill);
            registry.checkpointFile(expertId,file);
          });
          else registry.checkpoint(expertId,encode(Object.fromEntries(expert.tensors.map(t=>{
            const data=new Float32Array(t.shape.reduce((a,b)=>a*b,1));fill(t.name,data);
            return [t.name,{shape:t.shape,data}];
          }))));
          expert=registry.change(expertId,'PROVISIONING','READY');
        }
        const id=randomUUID();
        let position=db.prepare('SELECT epoch,cursor AS "index" FROM train_positions WHERE expert=?').get(expertId);
        if(!position){
          // The previous version always trained a single prefix before committing a checkpoint.
          const legacy=db.prepare('SELECT config FROM runs WHERE expert=? AND checkpoint IS NOT NULL ORDER BY created DESC LIMIT 1').get(expertId);
          position={epoch:0,index:legacy?decode(legacy.config).tasks.length*expert.training.local_steps*expert.training.grad_accum:0};
        }
        if(trainCount-position.index<quorum*expert.training.grad_accum)position={epoch:position.epoch+1,index:0};
        const config=assignRound(expert,{devices,group,modelDigest,backend,modelVariants,maxLength,modelLayout,dataset,trainCount,quorum,round:1,committedPosition:position,
          validation:registry.cas.put(validationBytes),plan:{...plan,tokens:0,endEpoch:position.epoch+plan.epochs}},position);
        if(!config)fail('DATASET_REQUIRED','token budget or Train dataset cannot fill one complete optimizer step per device');
        db.prepare("INSERT INTO runs VALUES (?,?,?,'RUNNING',?,NULL,NULL)").run(id,expertId,canonicalJSON(config),now());
        registry.change(expertId,expert.status,'TRAINING');
        return {id,status:'RUNNING',round:1};
      });
    },
    claim(device,worker){
      if(worker?.consent!==true||!['cuda','mlx','torch-cpu-test'].includes(worker.backend)||!isHex64(worker.model_sha256)||
        !Number.isSafeInteger(worker.available_bytes)||worker.available_bytes<0)return {task:null};
      return tx(()=>{
        expire();
        const prior=db.prepare("SELECT id,run,slot,manifest,expiry FROM leases WHERE device=? AND state='leased'").get(device);
        if(prior&&decode(prior.manifest).manifest.model_sha256!==worker.model_sha256)return {task:null};
        for(const run of db.prepare("SELECT * FROM runs WHERE status='RUNNING' ORDER BY created LIMIT 128").all()){
          if(prior&&run.id!==prior.run)continue;
          const cfg=decode(run.config),e=registry.get(run.expert);
          const compatible=(backend,digest)=>((cfg.backend??'cuda')===backend&&cfg.modelDigest===digest)||(cfg.modelVariants??[]).some(v=>v.backend===backend&&v.digest===digest);
          if(!compatible(worker.backend,worker.model_sha256)||!e.runtimes.includes(worker.backend==='cuda'?'cuda-nf4':worker.backend==='mlx'?'mlx':'torch-cpu'))continue;
          const round=roundOf(cfg);
          const claimed=db.prepare("SELECT slot,device,id FROM leases WHERE run=? AND round=? AND state IN ('leased','accepted')").all(run.id,round)
            .filter(l=>l.id!==prior?.id);
          if(claimed.some(x=>x.device===device))continue;
          const task=cfg.tasks.find(x=>(!prior||x.slot===prior.slot)&&!claimed.some(l=>l.slot===x.slot)&&(!cfg.devices.length||cfg.devices[x.slot]===device));
          if(!task||worker.available_bytes<task.train.bytes+cfg.weight.bytes+e.bytes+1024**2)continue;
          let requirements;
          {
            const runtime=worker.backend==='cuda'?'cuda-nf4':worker.backend==='mlx'?'mlx':'torch-cpu';
            const busy=db.prepare("SELECT device,id FROM leases WHERE state='leased'").all().filter(row=>row.id!==prior?.id).map(row=>row.device);
            const estimates=new Map();
            const candidates=devices().filter(d=>!busy.includes(d.id)&&!claimed.some(l=>l.device===d.id)&&
              d.capabilities?.backend===worker.backend&&d.capabilities.preflight_ok===true&&d.online===true&&
              (runtime==='torch-cpu'||(d.capabilities.preflight_max_length??0)>=cfg.maxLength)&&
              d.capabilities.variants?.some(v=>compatible(d.capabilities.backend,v.files_digest)&&(d.id!==device||v.files_digest===worker.model_sha256))).map(d=>{
              const m=d.metrics??{},caps=d.capabilities;
              const footprint=fusionFootprint(e,{backend:caps.backend,context:cfg.maxLength,modelLayout:cfg.modelLayout,observedBase:caps.preflight_peak_bytes??0});
              estimates.set(d.id,footprint);
              const ram=m.ram_available_bytes??0,vram=Number.isFinite(caps.memory_total_bytes)&&Number.isFinite(m.vram_used_bytes)?
                caps.memory_total_bytes-m.vram_used_bytes:(caps.memory_free_bytes??0);
              const memory=fitsFusionMemory(footprint,ram,vram,m.fusion_resident_bytes??0,caps.backend);
              return {id:d.id,state:d.state,consent:m.fusion_opt_in===1,governor:{allowed:d.status?.eligible===true,target_pct:m.fusion_duty_pct??10},
                last_seen:now()-(d.heartbeat_age_ms??Infinity),runtime:caps.backend==='cuda'?'cuda-nf4':caps.backend==='mlx'?'mlx':'torch-cpu',group:cfg.group,
                free_ram:memory?ram:0,free_vram:vram,temp_c:m.temperature_c??(runtime==='cuda-nf4'?Infinity:0),max_temp_c:m.fusion_temp_limit??80,
                remaining_traffic:m.traffic_remaining??0,free_disk:m.fusion_cache_bytes??0,
                resident:m.resident_model===1?cfg.modelDigest:null,tokens_per_s:m.tokens_per_s??1,bytes_per_s:Math.max(1,m.fusion_link_bytes_s??10**6),cold_start_s:m.model_load_s??0};
            });
            const planned=scheduleExperts([{id:run.id,expert:e.id,priority:0,device:prior||cfg.devices.length?device:null,runtimes:[runtime],ram:1,vram:0,
              backbone:cfg.modelDigest,artifacts:[task.train,cfg.weight,{sha256:'result',bytes:e.bytes}],tokens:task.tokens}],candidates,{now:now()}).assigned[0];
            if(planned?.device!==device)continue;
            requirements=estimates.get(device);
          }
          const id=prior?.id??randomUUID(),expires=prior?.expiry??now()+ttl;
          const inner=e.tensors.find(t=>t.name.endsWith('.gate.weight'))?.shape[0]??null;
          const spec={key:e.key,kind:e.kind,layers:e.layers,rank:e.rank,alpha:e.alpha,intermediate:inner,
            training_mode:e.tensors.find(t=>t.name.endsWith('.gate.weight'))?.trainable===false?'down':'full'};
          const signed=registry.signed({kind:'worker-task',id,run:run.id,round,expert:e.id,device,expires,parent:cfg.parent,schema:e.schema_sha256,
            model_sha256:worker.model_sha256,training:{...e.training,local_steps:task.steps??e.training.local_steps},max_length:cfg.maxLength,expected_tokens:task.tokens,
            spec,requirements,artifacts:[cfg.weight,task.train]});
          if(!prior)db.prepare("INSERT INTO leases(id,run,slot,device,expiry,state,manifest,round) VALUES (?,?,?,?,?,'leased',?,?)")
            .run(id,run.id,task.slot,device,expires,canonicalJSON(signed),round);
          return {task:signed,public_key:registry.publicKey};
        }
        return {task:null};
      });
    },
    renew(device,id,progress={}){
      const {l,m}=authorize(device,id);
      if(l.state!=='leased')return {expires:l.expiry};
      const expires=now()+ttl;
      const step=Number(progress.step??0),loss=Number(progress.loss??0),bytes=Number(progress.bytes??0);
      if(!Number.isInteger(step)||step<0||step>m.manifest.training.local_steps||!Number.isFinite(loss)||!Number.isSafeInteger(bytes)||bytes<0)
        fail('INVALID_SCHEMA','invalid Fusion progress');
      db.prepare("UPDATE leases SET expiry=?,progress=? WHERE id=? AND state='leased'").run(expires,canonicalJSON({step,loss,bytes}),id);
      return {expires};
    },
    chunk(device,id,hash){
      const {m}=authorize(device,id);
      for(const artifact of m.manifest.artifacts){
        const index=artifact.parts.findIndex(p=>p.sha256===hash);
        if(index>=0)return artifact.stream?registry.weightPart(artifact.sha256,artifact,index):registry.cas.get(hash,{maxBytes:artifact.parts[index].bytes});
      }
      fail('FORBIDDEN_SCOPE','part is outside the Fusion assignment');
    },
    limits(device,id){
      const {l,m,r}=authorize(device,id,{upload:true}),expert=registry.get(r.expert);
      return {tokens:m.manifest.expected_tokens,maxBytes:expert.bytes+1024**2,expires:Math.max(l.expiry+24*3600*1000,now()+ttl)};
    },
    resultStatus(device,id){
      const l=pick(id);
      if(!l||l.device!==device)fail('NOT_OWNER','Fusion lease is unavailable for this device');
      if(l.result)return decode(l.result);
      return {id,status:l.state==='cancelled'?'cancelled':'pending'};
    },
    result(device,id,{artifact,tokens},file){
      return tx(()=>{
        const {l,r,m}=authorize(device,id,{upload:true}),manifest=m.manifest,e=registry.get(r.expert);
        if(l.result){
          const prior=decode(l.result);
          if(prior.sha256!==artifact.sha256||prior.tokens!==tokens)fail('DUPLICATE_DIFFERENT','Fusion result has changed');
          return prior;
        }
        if(tokens!==manifest.expected_tokens||artifact.bytes>e.bytes+1024**2||e.checkpoint?.hash!==manifest.parent)fail('STALE','Fusion result no longer matches its assignment');
        const cfg=decode(r.config),round={id:`${r.id}:${l.round}`,algorithm:'fedavg',expert:e.id,parent:cfg.parent,schema:e.schema_sha256,frozen:e.checkpoint.frozen};
        const result={status:'accepted',id,device,sha256:artifact.sha256,tokens,expert:e.id,round:l.round};
        const previous=db.prepare("SELECT result FROM leases WHERE run=? AND round=? AND state='accepted'").all(r.id,l.round).map(row=>decode(row.result));
        const accept=()=>db.prepare("UPDATE leases SET state='accepted',result=? WHERE id=? AND state IN ('leased','expired')").run(canonicalJSON(result),id);
        if(e.storage==='file'){
          const base=registry.weightFile(round.parent);
          if(hashFile(file,{expectedBytes:artifact.bytes})!==artifact.sha256||hashFile(base)!==round.parent)fail('HASH_MISMATCH','file-backed result or parent digest mismatch');
          checkUpdateFile(base,file,e.tensors);
          registry.stageWeight(file,artifact);
          accept();
          if(previous.length+1===cfg.tasks.length){
            withTemporaryFile(output=>{
              const updates=[...previous,result].map(x=>{
                const file=registry.weightFile(x.sha256);
                if(hashFile(file)!==x.sha256)fail('HASH_MISMATCH','accepted Fusion result is corrupt');
                return {id:x.id,device:x.device,tokens:x.tokens,file};
              });
              const reduced=aggregateTensorFiles({base,updates,output,schema:e.tensors,minDevices:cfg.tasks.length});
              if(reduced.frozen!==round.frozen)fail('FROZEN_A_CHANGED','streamed reducer changed frozen weights');
              registry.change(e.id,'TRAINING','AGGREGATING');
              const final=registry.checkpointFile(e.id,output,{parent:round.parent,metrics:{total_tokens:reduced.tokens,updates:reduced.updates}});
              advanced(r,cfg,final);
            });
          }
          return decode(pick(id).result);
        }
        const bytes=fs.readFileSync(file);
        if(sha256(bytes)!==artifact.sha256)fail('HASH_MISMATCH','Fusion result differs from its staged artifact');
        const toUpdate=(receipt,payload)=>({id:receipt.id,device:receipt.device,tokens:receipt.tokens,round:round.id,expert:e.id,schema:round.schema,
          parent:round.parent,frozen:round.frozen,config:hashJSON({algorithm:'fedavg',config:{}}),payload,payload_sha256:receipt.sha256});
        const update=toUpdate(result,bytes),agg=receipts=>aggregateExpert({expert:e,base:registry.cas.get(round.parent),round,
          assignments:receipts.map(u=>({id:u.id,device:u.device,tokens:u.tokens,group:cfg.group})),updates:receipts});
        agg([update]);
        registry.cas.put(bytes);
        accept();
        if(previous.length+1===cfg.tasks.length){
          const combined=agg([...previous.map(p=>toUpdate(p,registry.cas.get(p.sha256))),update]);
          registry.change(e.id,'TRAINING','AGGREGATING');
          const final=registry.checkpoint(e.id,combined.payload,{parent:round.parent,metrics:combined.metrics});
          advanced(r,cfg,final);
        }
        return decode(pick(id).result);
      });
    },
    nextEvaluation(){
      const r=db.prepare("SELECT * FROM runs WHERE status='EVALUATING' ORDER BY created LIMIT 1").get();
      return r?{...r,config:decode(r.config),expert:registry.get(r.expert)}:null;
    },
    evaluating:id=>get(id)?.status==='EVALUATING',
    finishEvaluation(id,data){
      return tx(()=>{
        const r=get(id),expert=registry.get(r.expert),cfg=decode(r.config);
        if(r.status!=='EVALUATING'||r.checkpoint!==expert.checkpoint?.hash)fail('STALE','Fusion evaluation checkpoint has changed');
        const evaluated=registry.assessExpert(expert.id,{version:expert.version,dataset_sha256:cfg.validation,
          control_nll:data.control.nll_sum/data.control.tokens,candidate_nll:data.candidate.nll_sum/data.candidate.tokens});
        if(cfg.plan&&cfg.round<cfg.plan.rounds){
          const next=assignRound(evaluated,{...cfg,round:cfg.round+1},cfg.next);
          if(next){
            registry.change(expert.id,evaluated.status,'TRAINING');
            db.prepare("UPDATE runs SET config=?,status='RUNNING' WHERE id=?").run(canonicalJSON(next),id);
            return {status:'RUNNING',round:next.round};
          }
        }
        mark(id,evaluated.status);
        return {status:evaluated.status};
      });
    },
    control(id,action){
      return tx(()=>{
        const r=get(id);
        if(!r)fail('NOT_FOUND','Fusion run not found');
        if(r.status==='EVALUATING'&&action==='pause'){
          mark(id,'PAUSED_EVALUATION');return {status:'PAUSED_EVALUATION'};
        }
        if(r.status==='PAUSED_EVALUATION'&&action==='resume'){
          mark(id,'EVALUATING');return {status:'EVALUATING'};
        }
        if(['EVALUATING','PAUSED_EVALUATION'].includes(r.status)&&action==='stop'){
          registry.change(r.expert,'EVALUATING','REJECTED');mark(id,'STOPPED');return {status:'STOPPED'};
        }
        if(action==='resume'&&r.status==='PAUSED'){
          registry.change(r.expert,'PAUSED','TRAINING');mark(id,'RUNNING');return {status:'RUNNING'};
        }
        if(!['pause','stop'].includes(action)||!['PAUSED','RUNNING'].includes(r.status))fail('INVALID_TRANSITION','invalid Fusion run command');
        if(r.status==='RUNNING')registry.change(r.expert,'TRAINING','PAUSED');
        db.prepare("UPDATE leases SET state='cancelled' WHERE run=? AND state='leased'").run(id);
        if(action==='stop'){
          registry.change(r.expert,'PAUSED','REJECTED');
          for(const l of db.prepare("SELECT id,result FROM leases WHERE run=? AND state='accepted'").all(id))
            db.prepare("UPDATE leases SET state='cancelled',result=? WHERE id=?").run(canonicalJSON({...decode(l.result),status:'cancelled'}),l.id);
        }
        const status=action==='stop'?'STOPPED':'PAUSED';
        mark(id,status);return {status};
      });
    }
  };
}
