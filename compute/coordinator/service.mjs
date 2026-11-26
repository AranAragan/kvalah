// Coordinator service: owns the coordinator state machine, the HTTPS server, the periodic tick, the
// trusted evaluator and administrator operations (dataset import, model registration, pairing, reports).
// Used by the desktop compute host and by the headless CLI. Admin methods are only reachable in-process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoordinator} from './coordinator.mjs';
import {createApi} from './api.mjs';
import {coordinatorCertificate} from './tls.mjs';
import {pairingString} from '../worker/client.mjs';
import {startSidecar as defaultSidecar} from '../worker/sidecar.mjs';
import {parseJSONL,buildDataset} from '../datasets/engine.mjs';
import {getProfile} from '../protocol/schema.mjs';
import {fail,ComputeError} from '../protocol/errors.mjs';
import {exportReport} from '../report.mjs';
import {PINNED,verifyAgainstHub} from '../registry.mjs';
import {verifyLocalConversion} from '../mlx-conversion.mjs';
export const DEFAULT_PORT=8765;
export const FIXTURE=fileURLToPath(new URL('../fixtures/smoke-sft-v1.jsonl',import.meta.url));
const isPrivateV4=ip=>/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(ip);
export function lanAddresses(){
  const out=[];
  for(const [name,list] of Object.entries(os.networkInterfaces()))for(const a of list||[])if(a.family==='IPv4'&&!a.internal)out.push({interface:name,address:a.address,private:isPrivateV4(a.address)});
  return out;
}
export function createCoordinatorService({dir,startSidecar=defaultSidecar,evaluator=()=>null,canRunHeavy=()=>({run:true}),log=()=>{},now=Date.now,tickMs=1000}){
  fs.mkdirSync(dir,{recursive:true});
  let server=null,timer=null,bind=null,cert=null,evalBusy=false,closed=false;
  const work=path.join(dir,'work');fs.mkdirSync(work,{recursive:true});
  async function withSidecar(rt,fn,{heavy=false}={}){
    if(!rt?.python)fail('RUNTIME_REQUIRED','configure a Python compute runtime on this coordinator first');
    const sc=startSidecar({python:rt.python,threads:rt.threads??Math.max(1,Math.floor((os.availableParallelism?.()||2)/4)),extraEnv:rt.extraEnv,onLog:l=>log('[sidecar] '+l),
      onEvent:event=>{
        if(event.type!=='permit_request')return;
        const g=heavy?canRunHeavy():{run:true};
        sc.send({cmd:g.run&&!closed?'permit':'stop',id:event.id,reason:closed?'coordinator stopped':g.reason});
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
    if(closed||evalBusy)return {status:'NOT RUN',reason:'evaluator is unavailable'};
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
  async function start({bindIp,port=DEFAULT_PORT,allowPublic=false}){
    if(server)return info();
    const addrs=lanAddresses().map(a=>a.address).concat(['127.0.0.1']);
    if(!addrs.includes(bindIp))fail('INVALID_SCHEMA','choose one of this computer\'s addresses: '+addrs.join(', '));
    if(!isPrivateV4(bindIp)&&!allowPublic)fail('FORBIDDEN_SCOPE','the coordinator binds to private LAN addresses only');
    cert=coordinatorCertificate(path.join(dir,'tls'),[...new Set([bindIp,'127.0.0.1'])]);
    const srv=createApi(coord,{cert:cert.cert,key:cert.key,now,log});
    await new Promise((resolve,reject)=>{srv.once('error',reject);srv.listen(port,bindIp,()=>{srv.off('error',reject);resolve();});}).catch(e=>{
      fail('UNAVAILABLE',e.code==='EADDRINUSE'?`port ${port} is already in use on ${bindIp}`:'cannot listen: '+e.message);});
    server=srv;bind={ip:bindIp,port:srv.address().port};
    timer=setInterval(()=>{try{coord.tick();}catch(e){log('tick error '+e.message);}},tickMs);timer.unref?.();
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
  return {coord,start,stop,info,createPairing,verifyModel,registerModel,checkProvenance,importMlxConversion,importDataset,evaluate,
    exportReport:o=>exportReport(coord,o),close:async()=>{closed=true;await stop();coord.close();}};
}
