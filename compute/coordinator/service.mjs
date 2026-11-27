// Coordinator service: owns the coordinator state machine, the HTTPS server, the periodic tick, the
// trusted evaluator and administrator operations (dataset import, model registration, pairing, reports).
// Used by the desktop compute host and by the headless CLI. Admin methods are only reachable in-process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createCoordinator} from './coordinator.mjs';
import {createApi} from './api.mjs';
import {coordinatorCertificate} from './tls.mjs';
import {pairingString} from '../worker/client.mjs';
import {startSidecar as defaultSidecar} from '../worker/sidecar.mjs';
import {parseJSONL,buildDataset} from '../datasets/engine.mjs';
import {getProfile} from '../protocol/schema.mjs';
import {fail,ComputeError} from '../protocol/errors.mjs';
import {hashJSON,sha256} from '../protocol/hash.mjs';
import {exportReport} from '../report.mjs';
import {PINNED,verifyAgainstHub} from '../registry.mjs';
import {researchProvenance,verifyLocalConversion} from '../mlx-conversion.mjs';
import {MAX_FILE_EXPERT_BYTES,openFusion} from '../fusion/registry.mjs';
import {createGrantStore} from '../fusion/provision.mjs';
import {createFusionQueue} from '../fusion/queue.mjs';
import {createDiskUploads} from '../fusion/upload.mjs';
import {detectBase} from '../fusion/builder.mjs';
import {compositionJobs} from '../fusion/composition-jobs.mjs';
export const DEFAULT_PORT=8765;
export const FIXTURE=fileURLToPath(new URL('../fixtures/smoke-sft-v1.jsonl',import.meta.url));
const isPrivateV4=ip=>/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(ip);
export function lanAddresses(){
  const out=[];
  for(const [name,list] of Object.entries(os.networkInterfaces()))for(const a of list||[])if(a.family==='IPv4'&&!a.internal)out.push({interface:name,address:a.address,private:isPrivateV4(a.address)});
  return out;
}
export function createCoordinatorService({dir,startSidecar=defaultSidecar,evaluator=()=>null,canRunHeavy=()=>({run:true}),log=()=>{},now=Date.now,tickMs=1000,
  fusionQuotaBytes=12*1024**3}){
  fs.mkdirSync(dir,{recursive:true});
  let server=null,timer=null,bind=null,cert=null,evalBusy=false,closed=false,fusionRegistry=null,fusionQueue=null,fusionJobs=null,fusionUploads=null,fusionEvalBusy=false,fusionRetryAt=0;
  let compositionTask=null,compositionRetryAt=0;
  const fusionDir=path.join(dir,'..','fusion');
  function managed(){
    if(fusionQueue)return fusionQueue;
    fusionRegistry??=openFusion(fusionDir);
    fusionQueue=createFusionQueue(fusionRegistry,{now,devices:()=>coord.listDevices(),readTrain:(id,digest,offset,count)=>{
      const m=coord.datasetManifest(id);
      if(hashJSON(m)!==digest||!m.group_audit)fail('DATASET_INVALID','pinned Fusion Train manifest has changed');
      return readDatasetSplit(m,'train',offset,count);
    }});
    fusionJobs=compositionJobs(fusionRegistry,now);
    return fusionQueue;
  }
  function workUploads(){
    return fusionUploads??=createDiskUploads(path.join(fusionDir,'uploads'),{quotaBytes:fusionQuotaBytes,maxArtifact:MAX_FILE_EXPERT_BYTES+1024**2,
      now,authorize:(...args)=>managed().limits(...args),seal:(...args)=>managed().result(...args)});
  }
  const work=path.join(dir,'work');fs.mkdirSync(work,{recursive:true});
  async function withSidecar(rt,fn,{heavy=false,allowed=()=>true}={}){
    if(!rt?.python)fail('RUNTIME_REQUIRED','configure a Python compute runtime on this coordinator first');
    const sc=startSidecar({python:rt.python,threads:rt.threads??Math.max(1,Math.floor((os.availableParallelism?.()||2)/4)),extraEnv:rt.extraEnv,onLog:l=>log('[sidecar] '+l),
      onEvent:event=>{
        if(event.type!=='permit_request')return;
        const g=heavy?canRunHeavy():{run:true};
        const active=allowed()&&!closed;
        sc.send({cmd:g.run&&active?'permit':'stop',id:event.id,reason:active?g.reason:'operation stopped'});
      }});
    try{return await fn(sc);}finally{await sc.stop(10000).catch(()=>sc.kill());}
  }
  // Trusted evaluation on the coordinator's own runtime (spec §7.2). Waits for the governor (never competes
  // with the local AI or a game), and is NOT RUN when no runtime/model is configured.
  async function evaluate({experiment,checkpoint,modelSnapshot,split='validation'}){
    if(split!=='validation'&&split!=='test')fail('INVALID_SCHEMA','unsupported evaluation split');
    const rt=evaluator();
    if(!rt?.python||(!rt.model_dir&&rt.backend!=='mock'))return {status:'NOT RUN',reason:'no trusted evaluator runtime/model configured'};
    const p=getProfile(experiment.profile_id);
    const variant=modelSnapshot?.find(v=>v.variant_id===rt.variant_id);
    if(!p.test_only&&(!variant?.files_digest||variant.files_digest!==rt.files_digest))return {status:'NOT RUN',reason:'trusted evaluator model does not match the experiment snapshot'};
    for(let waited=0;evalBusy&&!closed&&waited<30;waited++)await new Promise(r=>setTimeout(r,1000));
    if(closed||evalBusy||fusionEvalBusy)return {status:'NOT RUN',reason:'evaluator is unavailable'};
    const decision=canRunHeavy();
    if(!decision.run)return {status:'NOT RUN',reason:'governor paused evaluation: '+decision.reason};
    evalBusy=true;
    try{
      const m=coord.datasetManifest(experiment.dataset_id);
      const rows=[];for(const s of m.shards[split]||[])rows.push(...JSON.parse(coord.cas.get(s.sha256).toString('utf8')).rows);
      if(!rows.length)return {status:'NOT RUN',reason:'dataset has no '+split+' rows'};
      const d=fs.mkdtempSync(path.join(work,'eval-'));
      try{
        fs.writeFileSync(path.join(d,'adapter.safetensors'),checkpoint);fs.writeFileSync(path.join(d,'rows.json'),JSON.stringify({rows}));
        const t0=now();
        const r=await withSidecar(rt,sc=>sc.call('evaluate',{adapter_path:path.join(d,'adapter.safetensors'),rows_path:path.join(d,'rows.json'),model_dir:rt.model_dir||'',backend:rt.backend,
          model_files_digest:variant?.files_digest,task:{layers:p.layers,targets:p.targets,rank:p.rank,alpha:p.alpha,profile:p.id,max_length:experiment.max_length}}).promise,{heavy:true});
        return {...r,status:'DONE',split,backend:rt.backend,variant_id:rt.variant_id||null,provenance:variant?.provenance||null,eval_ms:now()-t0};
      }finally{fs.rmSync(d,{recursive:true,force:true});}
    }finally{evalBusy=false;}
  }
  const coord=createCoordinator({dir,now,evaluate,log});
  async function runFusionEvaluation(){
    if(!fusionQueue||fusionEvalBusy||evalBusy||closed||now()<fusionRetryAt||!canRunHeavy().run)return;
    const item=fusionQueue.nextEvaluation(),rt=evaluator();
    if(!item||!rt?.python||rt.files_digest!==item.config.modelDigest)return;
    fusionEvalBusy=true;
    const d=fs.mkdtempSync(path.join(work,'fusion-eval-'));
    try{
      const ck=path.join(d,'candidate.safetensors'),rows=path.join(d,'validation.json'),e=item.expert;
      fs.copyFileSync(fusionRegistry.weightFile(item.checkpoint),ck);fs.writeFileSync(rows,fusionRegistry.cas.get(item.config.validation));
      const spec={key:e.key,kind:e.kind,layers:e.layers,rank:e.rank,alpha:e.alpha,
        intermediate:e.tensors.find(t=>t.name.endsWith('.gate.weight'))?.shape[0]??null,
        training_mode:e.tensors.find(t=>t.name.endsWith('.gate.weight'))?.trainable===false?'down':'full'};
      const result=await withSidecar(rt,sc=>sc.call('fusion_evaluate',{backend:rt.backend,model_files_digest:rt.files_digest,expert:spec,
        checkpoint_sha256:item.checkpoint,rows_sha256:item.config.validation,max_length:item.config.maxLength,
        paths:{model_dir:rt.model_dir,rows,checkpoint:ck}}).promise,{heavy:true,allowed:()=>Boolean(server)&&fusionQueue.evaluating(item.id)});
      if(!closed&&fusionQueue.evaluating(item.id)){
        const completed=fusionQueue.finishEvaluation(item.id,result);
        if(completed.status==='VALIDATED')queueExpertExpansion(fusionRegistry.get(e.id));
      }
    }catch(e){fusionRetryAt=now()+15000;log('Fusion evaluation: '+e.message);}
    finally{fs.rmSync(d,{recursive:true,force:true});fusionEvalBusy=false;}
  }
  async function start({bindIp,port=DEFAULT_PORT,allowPublic=false}){
    if(server)return info();
    const addrs=lanAddresses().map(a=>a.address).concat(['127.0.0.1']);
    if(!addrs.includes(bindIp))fail('INVALID_SCHEMA','choose one of this computer\'s addresses: '+addrs.join(', '));
    if(!isPrivateV4(bindIp)&&!allowPublic)fail('FORBIDDEN_SCOPE','the coordinator binds to private LAN addresses only');
    cert=coordinatorCertificate(path.join(dir,'tls'),[...new Set([bindIp,'127.0.0.1'])]);
    const grantMarker=path.join(fusionDir,'serve-grants');
    let fusion=null;
    // Artifact serving is separately enabled by the local administrator and private-LAN only.
    if(isPrivateV4(bindIp)&&fs.existsSync(grantMarker)){
      fusionRegistry??=openFusion(fusionDir);
      const grants=createGrantStore(fusionRegistry,path.join(fusionDir,'grants'));
      const check=()=>{if(!fs.existsSync(grantMarker))fail('FORBIDDEN_SCOPE','Fusion grants are disabled');};
      fusion={manifest(dev){check();return grants.manifest(dev);},chunk(dev,id,hash){check();return grants.chunk(dev,id,hash);},
        result(dev,id,hash,tokens,bytes){check();return grants.result(dev,id,hash,tokens,bytes);}};
    }
    const fusionWork=isPrivateV4(bindIp)?{
      claim:(dev,b)=>fs.existsSync(path.join(fusionDir,'production-work'))?managed().claim(dev,b):{task:null},
      renew:(...args)=>managed().renew(...args),chunk:(...args)=>managed().chunk(...args),
      status:(...args)=>managed().resultStatus(...args),
      begin:(...args)=>workUploads().begin(...args),put:(...args)=>workUploads().put(...args),complete:(...args)=>workUploads().complete(...args)
    }:null;
    if(fusionWork&&fs.existsSync(path.join(fusionDir,'production-work')))managed();
    const srv=createApi(coord,{cert:cert.cert,key:cert.key,now,log,fusion,fusionWork});
    await new Promise((resolve,reject)=>{srv.once('error',reject);srv.listen(port,bindIp,()=>{srv.off('error',reject);resolve();});}).catch(e=>{
      fail('UNAVAILABLE',e.code==='EADDRINUSE'?`port ${port} is already in use on ${bindIp}`:'cannot listen: '+e.message);});
    server=srv;bind={ip:bindIp,port:srv.address().port};
    timer=setInterval(()=>{try{
      coord.tick();
      void runFusionEvaluation().catch(e=>log('Fusion evaluation: '+e.message));
      if(!compositionTask&&!fusionEvalBusy){
        compositionTask=runCompositionJob().catch(e=>log('Fusion composition: '+e.message)).finally(()=>{compositionTask=null;});
      }
    }catch(e){log('tick error '+e.message);}},tickMs);timer.unref?.();
    coord.db.prepare('insert into audit_log(ts,actor,action,details) values(?,?,?,?)').run(now(),'admin','coordinator.start',JSON.stringify(bind));
    return info();
  }
  async function stop(){
    clearInterval(timer);timer=null;
    if(server){
      const active=server;
      await new Promise(resolve=>{active.close(resolve);active.closeAllConnections();});
      if(server===active)server=null;
    }
    return info();
  }
  const endpoint=()=>bind?`https://${bind.ip}:${bind.port}`:null;
  function info(){return {running:!!server,endpoint:endpoint(),fingerprint:cert?.fingerprint||null,project_id:coord.projectId,addresses:lanAddresses(),bind_ip:bind?.ip||null,port:bind?.port||DEFAULT_PORT};}
  function createPairing(o={}){
    if(!server)fail('UNAVAILABLE','start the coordinator first');
    const p=coord.createPairing(o);
    return {...p,pairing:pairingString({endpoint:endpoint(),fingerprint:cert.fingerprint,code:p.code})};
  }
  async function verifyModel({python,model_dir,backend,extraEnv}){
    return withSidecar({python,extraEnv},sc=>sc.call('verify_model',{model_dir}).promise);
  }
  async function registerModel({profile_id,variant_id,model:verified,provenance_check}){
    const pin=PINNED[profile_id]?.[variant_id]||null;
    const prov=provenance_check?.verified===true&&pin&&provenance_check.repo===pin.source_repo&&provenance_check.revision===pin.source_revision&&variant_id!=='mlx-4bit'?'verified':'unverified';
    return coord.registerVariant({profile_id,variant_id,files_digest:verified?.files_digest||null,provenance:prov,
      manifest:{pinned:pin,architecture:verified?.architecture||null,architecture_fingerprint:verified?.architecture_fingerprint||null,total_bytes:verified?.total_bytes||null,quantization:verified?.quantization||null,provenance_check:provenance_check||null}});
  }
  async function checkProvenance({profile_id,variant_id,model,model_dir}){
    const pin=PINNED[profile_id]?.[variant_id];if(!pin)fail('NOT_FOUND','no pinned source revision for this variant');
    return verifyAgainstHub({repo:pin.source_repo,revision:pin.source_revision,files:model.files,modelDir:model_dir});
  }
  let importingConversion=false;
  async function importMlxConversion(input){
    if(importingConversion)fail('CONFLICT','a local conversion verification is already in progress');
    const checkResources=phase=>{
      if(closed)fail('STOPPED','coordinator stopped');
      const decision=canRunHeavy(phase);
      if(!decision.run)fail('PAUSED','the resource policy paused conversion verification: '+decision.reason);
    };
    importingConversion=true;
    try{
      let proof;
      try{proof=await verifyLocalConversion(input,{now,checkResources});}
      catch(err){if(err instanceof ComputeError)throw err;fail('CONVERSION_INVALID','could not read the local conversion files');}
      checkResources();
      const {profile_id,variant_id,files_digest}=proof;
      const result=coord.registerVariant({profile_id,variant_id,files_digest,conversion:proof,
        manifest:{architecture:proof.conversion.architecture,quantization:proof.conversion.quantization}});
      return {...result,files_digest,source:proof.source.status,conversion:proof.conversion.status};
    }finally{importingConversion=false;}
  }
  // Dataset import: validation → dedup → PII/secret/licence filters → group-aware split → tokenization with
  // the coordinator's pinned tokenizer → mask validation → immutable shards + manifest.
  async function importDataset({file,fixture=false,dataset_id,revision='1',profile_id,max_length=256,seed=1,source,provenance,runtime}){
    const g=canRunHeavy();
    if(!g.run)fail('PAUSED','the resource policy does not allow tokenization now: '+g.reason);
    if(!fixture&&(typeof file!=='string'||!path.isAbsolute(file)||!fs.existsSync(file)))fail('NOT_FOUND','choose an existing JSONL file');
    // Default id: the fixture name, or the file name reduced to the allowed alphabet.
    dataset_id=String(dataset_id||(fixture?'smoke-sft-v1':path.basename(file).replace(/\.jsonl?$/i,'').toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^[^a-z0-9]+/,'').slice(0,64)||'dataset'));
    const text=fs.readFileSync(fixture?FIXTURE:file,'utf8');
    const {rows,rejected}=parseJSONL(text);
    const p=getProfile(profile_id);
    const rt=runtime||evaluator();
    if(!rt?.python)fail('RUNTIME_REQUIRED','tokenization needs the coordinator Python runtime and the model tokenizer');
    if(!rt.model_dir)fail('MODEL_REQUIRED','choose the local model folder (its tokenizer is used for all rows)');
    const d=fs.mkdtempSync(path.join(work,'tok-'));
    try{
      const built=await withSidecar(rt,async sc=>buildDataset({rows,datasetId:dataset_id,revision,profileId:p.id,maxLength:max_length,seed,source:fixture?'Kvalah synthetic smoke fixture (CC0-1.0)':source,provenance:fixture?'bundled synthetic fixture compute/fixtures/smoke-sft-v1.jsonl':provenance,
        tokenizer:async(list,ml)=>{const inp=path.join(d,'in.json'),out=path.join(d,'out.json');fs.writeFileSync(inp,JSON.stringify({rows:list}));
          await sc.call('tokenize',{rows_path:inp,out_path:out,model_dir:rt.model_dir,max_length:ml}).promise;return JSON.parse(fs.readFileSync(out,'utf8'));}}),{heavy:true});
      const reg=coord.registerDataset(built.manifest,built.shards);
      return {id:reg.id,manifest:built.manifest,rejected_lines:rejected,excluded:built.excluded.slice(0,200)};
    }finally{fs.rmSync(d,{recursive:true,force:true});}
  }
  function readDatasetSplit(manifest,split,offset,count){
    const rows=[];
    for(const shard of manifest.shards[split]??[]){
      if(offset>=shard.rows){offset-=shard.rows;continue;}
      const data=JSON.parse(coord.cas.get(shard.sha256,{maxBytes:16*1024**2}).toString('utf8'));
      rows.push(...data.rows.slice(offset,offset+count-rows.length));
      offset=0;
      if(rows.length>=count)break;
    }
    return rows;
  }
  function startFusion(input){
    if(!info().running||!isPrivateV4(bind.ip))fail('UNAVAILABLE','start a private Compute coordinator first');
    if(input.share_train!==true)fail('CONSENT_REQUIRED','confirm that Train rows may be sent to registered devices');
    const rt=evaluator();
    if(!rt?.files_digest||rt.files_digest!==input.model_sha256)fail('MODEL_UNVERIFIED','trusted evaluator model differs from Fusion assignment');
    const datasets=coord.listDatasets(),dataset=datasets.find(d=>d.id===input.dataset_id);
    if(!dataset?.group_audited||!dataset.license)fail('DATASET_REQUIRED','registered audited Train and Validation are required');
    const queue=managed(),expert=fusionRegistry.get(input.expert_id);
    if(dataset.manifest_hash!==expert.dataset_sha256)fail('DATASET_INVALID','dataset was not pinned to this expert');
    if(!Array.isArray(input.devices)||input.devices.some(id=>!coord.listDevices().some(d=>d.id===id&&d.state==='active')))
      fail('NOT_FOUND','assigned Fusion device is not approved');
    const m=coord.datasetManifest(dataset.id);
    const model=detectBase({...rt,architecture_ok:true});
    const modelLayout={parameters:model.parameters,textParameters:model.text_parameters??model.parameters,vocab:model.vocab,intermediate:model.intermediate};
    const variants=coord.variants().filter(v=>v.variant_id==='mlx-4bit'&&researchProvenance(v)&&v.manifest.local_conversion.source.revision===expert.base.revision)
      .map(v=>({backend:'mlx',digest:v.files_digest}));
    const result=queue.start({expertId:expert.id,dataset:dataset.id,trainCount:m.split_counts.train,
      validation:readDatasetSplit(m,'validation',0,4096),devices:input.devices,quorum:input.quorum,modelDigest:rt.files_digest,backend:rt.backend,modelVariants:variants,
      maxLength:m.max_length,modelLayout,schedule:{rounds:input.rounds,epochs:input.epochs,tokenBudget:input.supervised_token_budget,sampling:input.sampling}});
    fs.writeFileSync(path.join(fusionDir,'production-work'),'1\n',{mode:0o600});
    return result;
  }
  function compositionExperts(references,rt,{published=false}={}){
    if(!Array.isArray(references)||references.length<1||references.length>16||!references.every(r=>r&&Number.isSafeInteger(r.version)&&r.version>0))
      fail('INVALID_SCHEMA','choose one to sixteen expert versions');
    const experts=references.map(r=>fusionRegistry.get(r.id,r.version)),base=experts[0].base;
    if(base.backbone_sha256!==rt.files_digest||experts.some(e=>hashJSON(e.base)!==hashJSON(base)))fail('MODEL_UNVERIFIED','composition differs from the loaded backbone');
    if(experts.some(e=>!e.checkpoint?.assessment?.passed||(!published&&e.status==='ARCHIVED'))||new Set(experts.map(e=>e.key)).size!==experts.length)
      fail('INVALID_SCHEMA','composition requires distinct validated experts');
    return {experts,base};
  }
  function queueComposition(input){
    managed();
    const rt=evaluator();
    if(!info().running||!rt?.python||!['cuda','torch-cpu-test'].includes(rt.backend))fail('RUNTIME_REQUIRED','start a coordinator with a verified Torch runtime');
    const {experts,base}=compositionExperts(input.experts,rt);
    const loop=input.loop??{start:0,end:0,passes:1},routerMode=input.router_mode??'uniform',fitLoop=input.fit_loop===true;
    const topK=input.top_k??1,steps=input.steps??8,lr=input.lr??.005;
    if(!['uniform','token'].includes(routerMode)||![1,2,4].includes(topK)||!Number.isSafeInteger(steps)||steps<2||steps>128||!Number.isFinite(lr)||lr<=0||lr>.1||
      ![1,2,3,4].includes(loop.passes)||![loop.start,loop.end].every(x=>Number.isInteger(x)&&x>=0&&x<=base.layers)||
      loop.end<loop.start||(loop.passes>1&&loop.end===loop.start)||(fitLoop&&loop.passes===1))fail('INVALID_SCHEMA','invalid Router or Loop training configuration');
    if(routerMode==='token'&&!experts.some((e,i)=>experts.slice(i+1).some(other=>other.layers.some(layer=>e.layers.includes(layer)))))
      fail('INVALID_SCHEMA','learned routing requires two experts on a shared model layer');
    fs.writeFileSync(path.join(fusionDir,'production-work'),'1\n',{mode:0o600});
    return fusionJobs.add({base,experts:experts.map(e=>({id:e.id,version:e.version})),router:{mode:routerMode,top_k:topK},
      loop:{start:loop.start,end:loop.end,passes:loop.passes},fitLoop,steps,lr,parent:fusionRegistry.active()?.hash??null});
  }

  function queueExpertExpansion(expert){
    const active=fusionRegistry.active()?.envelope.manifest;
    if(!active||hashJSON(active.base)!==hashJSON(expert.base)||!['token','uniform'].includes(active.router.mode))return;
    const existing=active.experts.find(e=>e.key===expert.key);
    if(existing&&(existing.id!==expert.id||existing.version>=expert.version))return;
    const experts=[...active.experts.filter(e=>e.key!==expert.key),{id:expert.id,version:expert.version}];
    try{queueComposition({experts,router_mode:active.router.mode,top_k:active.router.top_k,loop:active.loop,fit_loop:Boolean(active.loop.sha256)});}
    catch(e){log('Fusion candidate expansion: '+e.message);}
  }

  async function runCompositionJob(){
    if(!fusionJobs||!server||closed||evalBusy||fusionEvalBusy||now()<compositionRetryAt||!canRunHeavy().run)return;
    const rt=evaluator(),item=rt?.python?fusionJobs.next(rt.files_digest):null;
    if(!item)return;
    const {run,stage}=item,id=run.id;
    fusionJobs.begin(id,stage.ordinal);
    try{
      const hashFor=name=>run.stages.find(s=>s.stage===name)?.result?.sha256;
      const router={...run.spec.router,sha256:hashFor('router')},loop={...run.spec.loop,sha256:hashFor('loop')};
      const allowed=()=>Boolean(server)&&fusionJobs.runnable(id);
      if(stage.stage==='validation'){
        if((fusionRegistry.active()?.hash??null)!==run.spec.parent)fail('STALE','published composition changed during training');
        const candidate=fusionRegistry.assemble({...run.spec,router,loop});
        const evaluated=candidate.assessment?candidate:await composedWork({hash:candidate.hash},{allowed});
        fusionJobs.finish(id,stage.ordinal,{candidate:evaluated.hash,passed:evaluated.assessment?.passed===true});
      }else{
        const fitted=await composedWork({...run.spec,router,loop},{stage:stage.stage,allowed});
        fusionJobs.finish(id,stage.ordinal,fitted);
      }
    }catch(e){
      const retry=['STOPPED','PAUSED','RUNTIME_REQUIRED','UNAVAILABLE'].includes(e.code);
      if(retry)compositionRetryAt=now()+5000;
      fusionJobs.fail(id,stage.ordinal,e.code??'ERROR',retry);
      log('Fusion '+stage.stage+': '+e.message);
    }
  }

  async function composedWork(input,{infer=false,stage=null,allowed=()=>true}={}){
    managed();
    const rt=evaluator();
    if(!rt?.python||!rt.model_dir||!['cuda','torch-cpu-test'].includes(rt.backend))fail('RUNTIME_REQUIRED','composed Fusion requires its verified Torch runtime');
    if(!canRunHeavy().run||fusionEvalBusy||evalBusy)fail('PAUSED','the local resource policy has reserved the training runtime');
    const composing=!infer&&!input.hash;
    let candidate=infer?fusionRegistry.active():composing?null:fusionRegistry.composition(input.hash);
    if(infer&&(!candidate||candidate.status!=='PUBLISHED'))fail('CONFLICT','publish a verified composition before inference');
    if(!infer&&candidate&&candidate.status!=='CANDIDATE')fail('CONFLICT','only an unevaluated candidate can be checked');
    const references=composing?input.experts:candidate.envelope.manifest.experts;
    const {experts,base}=compositionExperts(references,rt,{published:infer});
    const loop=composing?input.loop??{}:candidate.envelope.manifest.loop;
    const router=composing?input.router??{mode:'uniform',top_k:1}:candidate.envelope.manifest.router;
    if(!['uniform','token'].includes(router.mode)||(router.mode==='token'&&stage!=='router'&&!router.sha256))
      fail('ARCHITECTURE','token routing requires verified trained parameters');
    const datasets=coord.listDatasets(),groups=new Map(),byDataset=new Map();
    let context=256;
    if(!infer){
      for(const e of experts){
        if(byDataset.has(e.dataset_sha256))continue;
        const ds=datasets.find(d=>d.manifest_hash===e.dataset_sha256&&d.group_audited);
        if(!ds)fail('DATASET_REQUIRED','composition needs audited expert Validation data');
        const original=coord.datasetManifest(ds.id),selected=[];
        context=Math.max(context,original.max_length);
        for(const [split,shards] of Object.entries(original.shards)){
          for(const shard of shards){
            const {rows}=JSON.parse(coord.cas.get(shard.sha256,{maxBytes:16*1024**2}).toString('utf8'));
            for(const row of rows){
              const former=groups.get(row.group_digest);
              if(former&&former!==split)fail('DATASET_SPLIT_OVERLAP','composition dataset group crosses Train, Validation or Test');
              groups.set(row.group_digest,split);
              if(split==='validation'&&selected.length<32)selected.push({input_ids:row.input_ids,target_mask:row.target_mask});
            }
          }
        }
        if(!selected.length)fail('DATASET_REQUIRED','composition is missing Validation rows');
        const training=stage?readDatasetSplit(original,'train',0,input.steps).map(r=>({input_ids:r.input_ids,target_mask:r.target_mask})):null;
        byDataset.set(e.dataset_sha256,{validation:Buffer.from(JSON.stringify({split:'validation',rows:selected})),
          train:training?Buffer.from(JSON.stringify({split:'train',rows:training})):null});
      }
      if(composing&&!stage)candidate=fusionRegistry.assemble({base,experts:references,loop,router});
    }
    fusionEvalBusy=true;
    const d=fs.mkdtempSync(path.join(work,'fusion-composed-'));
    try{
      const specs=experts.map((e,i)=>{
        const ck=path.join(d,'expert-'+i+'.safetensors'),validation=path.join(d,'val-'+i+'.json'),train=path.join(d,'train-'+i+'.json'),sample=byDataset.get(e.dataset_sha256);
        fs.copyFileSync(fusionRegistry.weightFile(e.checkpoint.hash),ck);
        if(sample?.validation)fs.writeFileSync(validation,sample.validation);
        if(sample?.train)fs.writeFileSync(train,sample.train);
        return {checkpoint:ck,sha256:e.checkpoint.hash,validation:sample?.validation?validation:null,validation_sha256:sample?.validation?sha256(sample.validation):null,
          train:sample?.train?train:null,train_sha256:sample?.train?sha256(sample.train):null,
          spec:{key:e.key,kind:e.kind,layers:e.layers,rank:e.rank,alpha:e.alpha,intermediate:e.tensors.find(t=>t.name.endsWith('.gate.weight'))?.shape[0]??null,
            training_mode:e.tensors.find(t=>t.name.endsWith('.gate.weight'))?.trainable===false?'down':'full'}};
      });
      const weights=(key,digest)=>{
        if(!digest)return null;
        const file=path.join(d,key+'.safetensors');
        fs.writeFileSync(file,fusionRegistry.cas.get(digest,{maxBytes:64*1024**2}));
        return {file,sha256:digest};
      };
      const output=path.join(d,randomUUID()+'.safetensors');
      const result=await withSidecar(rt,sc=>sc.call(stage?'fusion_fit':infer?'fusion_generate':'fusion_compare',{backend:rt.backend,model_files_digest:rt.files_digest,
        experts:specs,paths:{model_dir:rt.model_dir},router:candidate?.envelope.manifest.router??router,loop:candidate?.envelope.manifest.loop??loop,
        router_weights:weights('router',router.sha256),loop_weights:weights('loop',loop.sha256),stage,output,steps:input.steps,lr:input.lr,
        max_length:context,prompt:infer?input.prompt:null,max_new_tokens:infer?input.max_new_tokens??32:null}).promise,{heavy:true,allowed});
      if(!allowed())fail('STOPPED','composition operation stopped');
      if(stage){
        if(fs.statSync(output).size>64*1024**2)fail('TOO_LARGE','composition parameters exceed the checkpoint limit');
        const bytes=fs.readFileSync(output);
        if(sha256(bytes)!==result.sha256)fail('HASH_MISMATCH','composition training result changed before saving');
        fusionRegistry.cas.put(bytes);
        return result;
      }
      if(infer)return {hash:candidate.hash,...result};
      return fusionRegistry.assess(candidate.hash,{dataset_sha256:hashJSON(specs.map(s=>s.validation_sha256)),...result});
    }finally{fs.rmSync(d,{recursive:true,force:true});fusionEvalBusy=false;}
  }
  return {coord,start,stop,info,createPairing,verifyModel,registerModel,checkProvenance,importMlxConversion,importDataset,evaluate,
    startFusion,fusionRuns:()=>fusionQueue?.list()??[],controlFusion:(id,action)=>managed().control(id,action),
    evaluateComposition:input=>input.router_mode==='token'||input.fit_loop===true?queueComposition(input):composedWork(input),generateFusion:input=>composedWork(input,{infer:true}),
    compositionRuns:()=>fusionJobs?.list()??[],controlComposition:(id,action)=>{managed();return fusionJobs.control(id,action);},
    exportReport:o=>exportReport(coord,o),close:async()=>{closed=true;await stop();await compositionTask;fusionRegistry?.close();coord.close();}};
}
