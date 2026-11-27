import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createCAS} from '../coordinator/cas.mjs';
import {decode,encode} from '../protocol/safetensors.mjs';
import {canonicalJSON,hashJSON,isHex64,sha256} from '../protocol/hash.mjs';
import {newKeyPair,signJSON,verifyJSON} from '../protocol/sign.mjs';
import {fail} from '../protocol/errors.mjs';

export const FORMAT='kvalah-expert-fusion/v1';
export const MAX_EXPERT_BYTES=64*1024*1024;
const ENTITY=/^[a-z][a-z0-9_]{0,47}$/;
const TENSOR=/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const unsafeKeys=new Set(['constructor','prototype','__proto__']);
const migrations={
  CREATED:['PROVISIONING','ARCHIVED'], PROVISIONING:['READY','PAUSED','REJECTED'], READY:['TRAINING','EVALUATING','ARCHIVED'],
  TRAINING:['PAUSED','AGGREGATING','EVALUATING','REJECTED'], PAUSED:['PROVISIONING','TRAINING','REJECTED','ARCHIVED'],
  AGGREGATING:['READY','EVALUATING','REJECTED'], EVALUATING:['VALIDATED','REJECTED'], VALIDATED:['INTEGRATING','EVALUATING','ARCHIVED'],
  INTEGRATING:['PUBLISHED','REJECTED','VALIDATED'], PUBLISHED:['ARCHIVED'], REJECTED:['ARCHIVED'], ARCHIVED:[]
};
const positive=(n,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>0&&n<=max;
const validName=(key,pattern=ENTITY)=>typeof key==='string'&&pattern.test(key)&&!key.split('.').some(part=>unsafeKeys.has(part));
const requireCondition=(value,message)=>{if(!value)fail('INVALID_SCHEMA',message);};

export function validateBase(base){
  requireCondition(base&&typeof base.revision==='string'&&/^[\w.-]{1,128}$/.test(base.revision),'missing pinned base revision');
  for(const k of ['backbone_sha256','tokenizer_sha256','architecture_sha256'])requireCondition(isHex64(base[k]),'invalid '+k);
  requireCondition(positive(base.layers,1024)&&positive(base.width,32768)&&positive(base.parameters),'invalid base dimensions');
  return {revision:base.revision,backbone_sha256:base.backbone_sha256,tokenizer_sha256:base.tokenizer_sha256,
    architecture_sha256:base.architecture_sha256,layers:base.layers,width:base.width,parameters:base.parameters};
}

export function validateTensors(bytes,schema){
  const {tensors}=decode(bytes,{maxBytes:MAX_EXPERT_BYTES});
  requireCondition(Object.keys(tensors).length===schema.length,'tensor count does not match expert schema');
  for(const {name,shape} of schema){
    const tensor=tensors[name];
    requireCondition(Object.hasOwn(tensors,name)&&tensor.shape.length===shape.length&&tensor.shape.every((d,i)=>d===shape[i]),'expert tensor shape mismatch');
    for(const value of tensor.data)if(!Number.isFinite(value))fail('NONFINITE','non-finite expert weight');
  }
  return tensors;
}

export function normalizeExpert(input){
  requireCondition(input&&validName(input.key)&&typeof input.name==='string'&&input.name.trim()&&input.name.length<=80,'invalid expert name');
  requireCondition(['ffa-lora','lora','ffn'].includes(input.kind),'unknown expert kind');
  requireCondition(typeof input.domain==='string'&&input.domain.trim()&&input.domain.length<=80,'invalid domain');
  const base=validateBase(input.base);
  requireCondition(Array.isArray(input.layers)&&input.layers.length&&input.layers.every(i=>Number.isInteger(i)&&i>=0&&i<base.layers),'invalid expert placement');
  const layers=[...new Set(input.layers)].sort((a,b)=>a-b);
  requireCondition(Array.isArray(input.tensors)&&input.tensors.length&&input.tensors.length<=8192,'missing tensor schema');
  let size=0;
  const tensors=input.tensors.map(t=>{
    requireCondition(t&&validName(t.name,TENSOR)&&t.name.length<=256&&t.dtype==='F32'&&Array.isArray(t.shape)&&t.shape.length>0&&t.shape.length<=4&&t.shape.every(n=>positive(n,65536)),'invalid tensor schema');
    const layer=/^(?:blocks|layers)\.(\d+)\./.exec(t.name);
    requireCondition(layer&&layers.includes(Number(layer[1])),'tensor is outside declared layers');
    size+=t.shape.reduce((a,b)=>a*b,1)*4;
    const frozen=input.kind==='ffa-lora'&&t.name.endsWith('.A');
    return {name:t.name,shape:t.shape,dtype:'F32',trainable:!frozen&&t.trainable!==false};
  }).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  requireCondition(size<=MAX_EXPERT_BYTES&&new Set(tensors.map(t=>t.name)).size===tensors.length&&tensors.some(t=>t.trainable),'expert exceeds tensor limits or has duplicate/no trainable weights');
  if(input.kind.endsWith('lora')){
    requireCondition(positive(input.rank,512)&&Number.isFinite(input.alpha)&&input.alpha>0&&input.alpha<=1024,'invalid LoRA scale');
    const names=new Map(tensors.map(t=>[t.name,t]));
    for(const {name,shape,trainable} of tensors){
      const tag=name.at(-1),partner=names.get(name.slice(0,-1)+(tag==='A'?'B':'A'));
      requireCondition(/\.[AB]$/.test(name)&&shape.length===2&&shape[tag==='A'?0:1]===input.rank&&partner&&
        (tag==='A'?trainable===(input.kind==='lora'):trainable),'incomplete or incompatible LoRA schema');
    }
  }
  requireCondition(typeof input.license==='string'&&input.license.trim()&&input.license.length<=120,'dataset/expert license required');
  requireCondition(isHex64(input.dataset_sha256),'the expert must pin a dataset manifest');
  const runtimes=input.runtimes??['torch-cpu'];
  requireCondition(Array.isArray(runtimes)&&runtimes.length&&runtimes.every(s=>['torch-cpu','cuda-nf4','mlx'].includes(s)),'unsupported runtime');
  const training=input.training??{};
  requireCondition(['sgd','adamw'].includes(training.optimizer)&&Number.isFinite(training.lr)&&training.lr>0&&training.lr<=1&&
    positive(training.local_steps,10000)&&positive(training.grad_accum,1024)&&Number.isFinite(training.clip)&&training.clip>0,'invalid training config');
  return {key:input.key,name:input.name.trim(),domain:input.domain.trim(),kind:input.kind,base,layers,tensors,
    license:input.license.trim(),dataset_sha256:input.dataset_sha256,runtimes:[...new Set(runtimes)].sort(),
    quantization:String(input.quantization??'fp32').slice(0,32),rank:input.kind==='ffn'?null:input.rank,alpha:input.kind==='ffn'?null:input.alpha,
    training:{optimizer:training.optimizer,lr:training.lr,local_steps:training.local_steps,grad_accum:training.grad_accum,clip:training.clip},
    parameters:size/4,bytes:size,schema_sha256:hashJSON(tensors)};
}

export function verifyEnvelope(envelope, trustedKey){
  requireCondition(envelope?.manifest?.format===FORMAT&&verifyJSON(trustedKey,envelope.manifest,envelope.signature),'invalid Fusion manifest signature');
  return envelope.manifest;
}

export function compositionStats(base, experts, loop, topK){
  const expertSizes=Array.from({length:base.layers},()=>[]);
  let trainable=0,parameters=base.parameters;
  for(const expert of experts){
    for(const t of expert.tensors){
      const n=t.shape.reduce((a,b)=>a*b,1),layer=Number(t.name.split('.')[1]);
      trainable+=t.trainable?n:0;parameters+=n;
      const list=expertSizes[layer];
      const existing=list.find(item=>item.id===expert.id);
      if(existing)existing.n+=n;else list.push({id:expert.id,n});
    }
  }
  const loopGates=loop.passes-1;
  const routerWeights=expertSizes.reduce((sum,list)=>sum+list.length*base.width,0);
  const additionalActive=expertSizes.reduce((sum,list)=>sum+list.sort((a,b)=>b.n-a.n).slice(0,topK).reduce((n,x)=>n+x.n,0),0);
  const overhead=routerWeights+loopGates;
  return {parameters:parameters+overhead,trainable:trainable+overhead,active_upper_bound:base.parameters+overhead+additionalActive,
    logical_layers:base.layers+(loop.end-loop.start)*(loop.passes-1),
    fp32_trainable_bytes:(trainable+overhead)*4,adamw_state_bytes:(trainable+overhead)*8};
}

export function openFusion(root){
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const cas=createCAS(path.join(root,'artifacts'));
  const db=new DatabaseSync(path.join(root,'fusion.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS experts(id TEXT PRIMARY KEY,spec TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS checkpoints(expert TEXT NOT NULL REFERENCES experts(id),version INTEGER NOT NULL,hash TEXT NOT NULL,
      frozen TEXT NOT NULL,parent TEXT,metrics TEXT,created INTEGER NOT NULL,PRIMARY KEY(expert,version));
    CREATE TABLE IF NOT EXISTS expert_validation(expert TEXT NOT NULL,version INTEGER NOT NULL,metrics TEXT NOT NULL,passed INTEGER NOT NULL,
      PRIMARY KEY(expert,version),FOREIGN KEY(expert,version) REFERENCES checkpoints(expert,version));
    CREATE TABLE IF NOT EXISTS expert_events(id INTEGER PRIMARY KEY,expert TEXT NOT NULL, status TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS compositions(hash TEXT PRIMARY KEY,envelope TEXT NOT NULL,status TEXT NOT NULL,parent TEXT,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS assessments(hash TEXT PRIMARY KEY REFERENCES compositions(hash),metrics TEXT NOT NULL,passed INTEGER NOT NULL);`);
  let transactionDepth=0;
  function txn(fn){
    const savepoint=transactionDepth?`fusion_nested_${transactionDepth}`:null;
    db.exec(savepoint?`SAVEPOINT ${savepoint}`:'BEGIN IMMEDIATE');
    transactionDepth++;
    try{const value=fn();db.exec(savepoint?`RELEASE ${savepoint}`:'COMMIT');return value;}
    catch(e){db.exec(savepoint?`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`:'ROLLBACK');throw e;}
    finally{transactionDepth--;}
  }
  const getSetting=k=>db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
  const setting=(k,v)=>db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,v);
  const keys=txn(()=>{
    const stored=getSetting('signing');
    if(stored)return JSON.parse(stored);
    const pair=newKeyPair();setting('signing',JSON.stringify(pair));return pair;
  });
  function signed(body){
    const manifest={format:FORMAT,...body};
    return {manifest,signature:signJSON(keys.privateKey,manifest)};
  }
  function get(id,version){
    const row=db.prepare('SELECT * FROM experts WHERE id=?').get(id);
    if(!row)fail('NOT_FOUND','expert not found');
    const checkpoint=db.prepare('SELECT * FROM checkpoints WHERE expert=? AND version=?').get(id,version??row.version);
    if(version!==undefined&&!checkpoint)fail('NOT_FOUND','expert version not found');
    const assessment=checkpoint&&db.prepare('SELECT metrics,passed FROM expert_validation WHERE expert=? AND version=?').get(id,checkpoint.version);
    return {...JSON.parse(row.spec),id:row.id,status:row.status,version:checkpoint?.version??0,checkpoint:checkpoint&&{
      hash:checkpoint.hash,parent:checkpoint.parent,frozen:checkpoint.frozen,metrics:JSON.parse(checkpoint.metrics??'null'),
      assessment:assessment?{...JSON.parse(assessment.metrics),passed:!!assessment.passed}:null}};
  }
  function change(id,from,to){
    if(!Object.hasOwn(migrations,from)||!migrations[from].includes(to))fail('CONFLICT',`invalid expert transition ${from} → ${to}`);
    const res=db.prepare('UPDATE experts SET status=? WHERE id=? AND status=?').run(to,id,from);
    if(res.changes!==1)fail('CONFLICT','expert status changed');
    db.prepare('INSERT INTO expert_events(expert,status,created) VALUES (?,?,?)').run(id,to,Date.now());
  }
  function version(id,expert,bytes,expected,metrics){
    const tensors=validateTensors(bytes,expert.tensors);
    const frozen=sha256(encode(Object.fromEntries(expert.tensors.filter(t=>!t.trainable).map(t=>[t.name,tensors[t.name]]))));
    if(expert.checkpoint&&expert.checkpoint.frozen!==frozen)fail('CONFLICT','frozen expert tensors changed');
    if((expert.checkpoint?.hash??null)!==expected)fail('CONFLICT','stale expert checkpoint');
    const hash=cas.put(bytes),number=expert.version+1;
    db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?)').run(id,number,hash,frozen,expected,metrics?canonicalJSON(metrics):null,Date.now());
    db.prepare('UPDATE experts SET version=? WHERE id=?').run(number,id);
    return get(id);
  }
  function composition(hash){
    const row=db.prepare('SELECT * FROM compositions WHERE hash=?').get(hash);
    if(!row)fail('NOT_FOUND','composition not found');
    const assessment=db.prepare('SELECT metrics,passed FROM assessments WHERE hash=?').get(hash);
    return {hash,status:row.status,parent:row.parent,envelope:JSON.parse(row.envelope),assessment:assessment&&{...JSON.parse(assessment.metrics),passed:!!assessment.passed}};
  }
  return {
    close:()=>db.close(), db,transaction:txn, publicKey:keys.publicKey, cas, get, change:(id,from,to)=>txn(()=>{
      if(['VALIDATED','INTEGRATING','PUBLISHED'].includes(to))fail('CONFLICT','expert acceptance requires a pinned Validation result');
      change(id,from,to);return get(id);
    }),
    list:()=>db.prepare('SELECT id FROM experts ORDER BY rowid').all().map(({id})=>get(id)),
    create(input){
      const spec=normalizeExpert(input),id=randomUUID();
      return txn(()=>{
        db.prepare('INSERT INTO experts VALUES (?,?,?,0)').run(id,canonicalJSON(spec),'CREATED');
        db.prepare('INSERT INTO expert_events(expert,status,created) VALUES (?,?,?)').run(id,'CREATED',Date.now());
        return get(id);
      });
    },
    clone(id,sourceVersion,{key,name}){
      return txn(()=>{
        const original=get(id,sourceVersion),newId=randomUUID();
        const spec=normalizeExpert({...original,key,name});
        db.prepare('INSERT INTO experts VALUES (?,?,?,0)').run(newId,canonicalJSON(spec),'CREATED');
        db.prepare('INSERT INTO expert_events(expert,status,created) VALUES (?,?,?)').run(newId,'CREATED',Date.now());
        if(!original.checkpoint)return get(newId);
        change(newId,'CREATED','PROVISIONING');
        version(newId,get(newId),cas.get(original.checkpoint.hash),null,null);
        change(newId,'PROVISIONING','READY');
        return get(newId);
      });
    },
    checkpoint(id,bytes,{parent=null,metrics=null}={}){
      return txn(()=>{
        const expert=get(id);
        if(!['PROVISIONING','TRAINING','AGGREGATING'].includes(expert.status))fail('CONFLICT','checkpoint cannot be written in this expert state');
        return version(id,expert,bytes,parent,metrics);
      });
    },
    assessExpert(id,{version:expected,dataset_sha256,control_nll,candidate_nll}){
      requireCondition(isHex64(dataset_sha256)&&Number.isFinite(control_nll)&&control_nll>0&&Number.isFinite(candidate_nll)&&candidate_nll>0,
        'invalid expert Validation assessment');
      return txn(()=>{
        const expert=get(id);
        if(expert.status!=='EVALUATING'||expected!==expert.version||!expert.checkpoint)fail('CONFLICT','expert Validation refers to a stale checkpoint');
        requireCondition(dataset_sha256!==expert.dataset_sha256,'training manifest cannot be used as Validation');
        const passed=candidate_nll<=control_nll*0.99;
        db.prepare('INSERT INTO expert_validation VALUES (?,?,?,?) ON CONFLICT(expert,version) DO UPDATE SET metrics=excluded.metrics,passed=excluded.passed')
          .run(id,expected,canonicalJSON({dataset_sha256,control_nll,candidate_nll}),Number(passed));
        change(id,'EVALUATING',passed?'VALIDATED':'REJECTED');
        return get(id);
      });
    },
    exportExpert(id,v){
      const e=get(id,v);
      if(!e.checkpoint)fail('CONFLICT','expert has no trained or initialized checkpoint');
      return {envelope:signed({kind:'expert',expert:e}),weights:cas.get(e.checkpoint.hash)};
    },
    importExpert(envelope,weights,trustedKey){
      const m=verifyEnvelope(envelope,trustedKey);
      requireCondition(m.kind==='expert'&&sha256(weights)===m.expert?.checkpoint?.hash,'invalid expert bundle');
      const spec=normalizeExpert(m.expert),id=randomUUID();
      return txn(()=>{
        db.prepare('INSERT INTO experts VALUES (?,?,?,0)').run(id,canonicalJSON(spec),'CREATED');
        change(id,'CREATED','PROVISIONING');
        version(id,get(id),weights,null,null);
        change(id,'PROVISIONING','READY');
        return get(id);
      });
    },
    assemble({base,experts,loop={},router={}}){
      base=validateBase(base);
      const roles=Array.isArray(experts)&&experts.length<=4096;
      requireCondition(roles,'invalid expert list');
      const modelLoop={start:loop.start??0,end:loop.end??0,passes:loop.passes??1};
      requireCondition(positive(modelLoop.passes,4)&&[modelLoop.start,modelLoop.end].every(x=>Number.isInteger(x)&&x>=0&&x<=base.layers)&&
        modelLoop.end>=modelLoop.start&&(modelLoop.passes===1||modelLoop.end>modelLoop.start),'invalid loop layout');
      const topK=router.top_k??1,mode=router.mode??'token';
      requireCondition([1,2,4].includes(topK)&&['static','domain','request','token','domain-informed','uniform','random'].includes(mode),'invalid router config');
      requireCondition(router.sha256===undefined||isHex64(router.sha256)&&cas.has(router.sha256),'unknown router weights');
      return txn(()=>{
        const parent=getSetting('active')??null;
        const records=experts.map(ref=>get(ref.id,ref.version));
        requireCondition(records.every(e=>e.checkpoint?.assessment?.passed&&['VALIDATED','INTEGRATING','PUBLISHED'].includes(e.status)&&hashJSON(base)===hashJSON(e.base)),'expert requires a validated matching checkpoint');
        requireCondition(new Set(records.map(e=>e.key)).size===records.length,'duplicate expert key');
        const refs=records.map(e=>({id:e.id,key:e.key,version:e.version,sha256:e.checkpoint.hash,schema_sha256:e.schema_sha256,
          kind:e.kind,layers:e.layers,rank:e.rank,alpha:e.alpha}));
        const env=signed({kind:'composition',parent,base,experts:refs,router:{mode,top_k:topK,sha256:router.sha256??null},
          loop:modelLoop,stats:compositionStats(base,records,modelLoop,mode==='uniform'?records.length:topK)});
        const hash=hashJSON(env.manifest);
        db.prepare('INSERT OR IGNORE INTO compositions VALUES (?,?,?,?,?)').run(hash,canonicalJSON(env),'CANDIDATE',parent,Date.now());
        return composition(hash);
      });
    },
    composition, active:()=>{const h=getSetting('active');return h?composition(h):null;},
    compositions:()=>db.prepare('SELECT hash FROM compositions ORDER BY created DESC').all().map(({hash})=>composition(hash)),
    assess(hash,{dataset_sha256,control_nll,candidate_nll,experts=[]}){
      requireCondition(isHex64(dataset_sha256)&&Number.isFinite(control_nll)&&control_nll>0&&Number.isFinite(candidate_nll)&&candidate_nll>0&&
        Array.isArray(experts)&&experts.every(e=>validName(e.key)&&Number.isFinite(e.control_nll)&&e.control_nll>0&&Number.isFinite(e.candidate_nll)&&e.candidate_nll>0),'invalid Validation assessment');
      return txn(()=>{
        const record=composition(hash);
        if(record.status!=='CANDIDATE')fail('CONFLICT','only candidates can be assessed');
        const keys=new Set(experts.map(e=>e.key));
        requireCondition(experts.length===keys.size&&record.envelope.manifest.experts.length===keys.size&&record.envelope.manifest.experts.every(e=>keys.has(e.key)),'missing per-expert Validation result');
        const passed=candidate_nll<=control_nll*1.01&&experts.every(e=>e.candidate_nll<=e.control_nll*1.01);
        db.prepare('INSERT OR REPLACE INTO assessments VALUES (?,?,?)').run(hash,canonicalJSON({dataset_sha256,control_nll,candidate_nll,experts}),Number(passed));
        if(passed)db.prepare("UPDATE compositions SET status='VALIDATED' WHERE hash=?").run(hash);
        return composition(hash);
      });
    },
    publish(hash){
      return txn(()=>{
        const x=composition(hash);
        if(x.status!=='VALIDATED'||x.parent!==(getSetting('active')??null))fail('CONFLICT','composition is unvalidated or based on an outdated active version');
        for(const ref of x.envelope.manifest.experts){
          const expert=get(ref.id,ref.version);
          if(expert.status==='VALIDATED')change(ref.id,'VALIDATED','INTEGRATING');
          if(['VALIDATED','INTEGRATING'].includes(expert.status))change(ref.id,'INTEGRATING','PUBLISHED');
          else if(expert.status!=='PUBLISHED')fail('CONFLICT','expert is unavailable');
        }
        db.prepare("UPDATE compositions SET status='PUBLISHED' WHERE hash=?").run(hash);setting('active',hash);
        return composition(hash);
      });
    },
    rollback(hash){
      return txn(()=>{
        const active=getSetting('active'),target=composition(hash);
        if(target.status!=='PUBLISHED'||!active||active===hash)fail('CONFLICT','rollback requires a previous published version');
        let ancestor=composition(active).parent;
        while(ancestor&&ancestor!==hash)ancestor=composition(ancestor).parent;
        if(!ancestor)fail('CONFLICT','rollback requires an ancestor of the active version');
        db.prepare("UPDATE compositions SET status='ROLLED_BACK' WHERE hash=?").run(active);setting('active',hash);
        return target;
      });
    },
    signed
  };
}
