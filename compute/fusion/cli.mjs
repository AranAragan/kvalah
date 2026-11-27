import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openFusion} from './registry.mjs';
import {aggregateExpert} from './aggregate.mjs';
import {putArtifact,putArtifactFile,createGrantStore,signAssignment,createProvisionStore,createStreamingProvisionStore,validateAssignment} from './provision.mjs';
import {estimateComposition} from './lab.mjs';
import {sealFusionDataset,validateTrainShard} from './datasets.mjs';
import {hashJSON,sha256} from '../protocol/hash.mjs';
import {createClient} from '../worker/client.mjs';
import {loadIdentity,fileSecretBox} from '../worker/identity.mjs';
import {createOutbox} from '../worker/outbox.mjs';

const [command,dir,...args]=process.argv.slice(2);
const help='node compute/fusion/cli.mjs <command> <fusion-state-dir> [arguments]';
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const writeJson=(file,v)=>fs.writeFileSync(file,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const save=(file,b)=>fs.writeFileSync(file,b,{flag:'wx'});

async function receiveAssignment(root,opts,{train=false}={}){
  if(opts.consent!==true||!opts.identityDir||!opts.publicKey||!Number.isSafeInteger(opts.maxTrafficBytes)||opts.maxTrafficBytes<1||
    !Number.isSafeInteger(opts.cacheBytes)||opts.cacheBytes<1)throw Error('existing device identity, pinned Fusion signing key, local consent and explicit budgets required');
  const identity=await loadIdentity(opts.identityDir,fileSecretBox);
  if(!identity)throw Error('device must already be paired and approved in Compute');
  const output=train?null:path.resolve(opts.output);
  if(output&&fs.existsSync(output))throw Error('output directory already exists');
  if(train&&(!path.isAbsolute(opts.python??'')||!Number.isSafeInteger(opts.cpu_wall_limit_ms)||opts.cpu_wall_limit_ms<1000||opts.cpu_wall_limit_ms>120000))
    throw Error('a trusted local Python and an explicit reference CPU wall-clock budget are required');
  let traffic=0;
  const client=createClient({endpoint:opts.endpoint,fingerprint:opts.fingerprint,identity,onTraffic:bytes=>{traffic+=bytes;}});
  try{
    await client.syncTime();
    const {envelope}=await client.get('/v2/fusion/assignment');
    const manifest=validateAssignment(envelope,{device:identity.device_id,publicKey:opts.publicKey});
    const scope=hashJSON([opts.publicKey,opts.endpoint,opts.fingerprint,identity.device_id]);
    const outbox=train?createOutbox(path.join(root,'fusion-outbox')):null;
    let entry=outbox?.all().find(r=>r.scope===scope&&r.task.task_id===manifest.id);
    if(train&&!manifest.job)throw Error('assignment grants downloads only');
    if(entry?.state==='accepted')return {assignment:manifest.id,receipt:entry.result,cached_result:true,traffic};
    const budget=()=>opts.maxTrafficBytes-traffic;
    if(train&&!entry&&os.freemem()<2*1024**3)throw Error('not enough free RAM for reference training');
    const fetchPart=async(m,part,{signal,maxBytes})=>(await client.get(`/v2/fusion/parts/${m.id}/${part.sha256}`,{
      signal,payload:true,json:false,maxPayload:maxBytes
    })).bytes;
    if(manifest.artifacts.some(a=>a.stream)){
      if(train)throw Error('use the production Worker for streamed training assignments');
      const cache=createStreamingProvisionStore({root:path.join(root,'stream-cache'),quotaBytes:opts.cacheBytes});
      const response=await cache.provision(envelope,{publicKey:opts.publicKey,device:identity.device_id,consented:true,permit:budget,fetchCoordinator:fetchPart});
      fs.mkdirSync(output,{recursive:true});
      for(const item of response.items){
        const destination=path.join(output,item.sha256);
        if(!fs.existsSync(destination))fs.copyFileSync(item.file,destination,fs.constants.COPYFILE_EXCL);
      }
      writeJson(path.join(output,'assignment.json'),envelope);
      return {...response,items:response.items.map(({file,...item})=>item),traffic};
    }
    const cache=createProvisionStore({root:path.join(root,'provision'),quotaBytes:opts.cacheBytes});
    if(!entry){
      const response=await cache.provision(envelope,{publicKey:opts.publicKey,device:identity.device_id,consented:true,
        permit:budget,fetchCoordinator:fetchPart});
      const work=train?fs.mkdtempSync(path.join(root,'reference-')):output;
      try{
        if(!train)fs.mkdirSync(work,{recursive:true});
        for(const item of response.items){const file=path.join(work,item.sha256);if(!fs.existsSync(file))save(file,item.bytes);}
        if(!train){
          writeJson(path.join(work,'assignment.json'),envelope);
          return {assignment:response.assignment,expert:response.expert,artifacts:response.items.map(({kind,sha256})=>({kind,sha256})),traffic};
        }
        writeJson(path.join(work,'job.json'),{artifacts:Object.fromEntries(response.items.map(a=>[a.kind,a.sha256])),training:manifest.job.training,
          expert:manifest.job.spec});
        const candidate=path.join(work,'candidate.safetensors');
        const pythonPath=fileURLToPath(new URL('../python',import.meta.url));
        const executed=spawnSync(opts.python,['-m','kvalah_compute.fusion_job',work,candidate],{
          env:{...process.env,PYTHONPATH:pythonPath,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',CUDA_VISIBLE_DEVICES:'',PYTHONDONTWRITEBYTECODE:'1'},
          timeout:Math.min(opts.cpu_wall_limit_ms,Math.max(1,manifest.expires-Date.now())),encoding:'utf8',maxBuffer:64*1024,windowsHide:true
        });
        if(executed.status!==0)throw Error(executed.error?.message??executed.stderr.trim().slice(-512));
        const stats=JSON.parse(executed.stdout),weights=fs.readFileSync(candidate);
        if(stats.sha256!==sha256(weights)||stats.tokens!==manifest.job.tokens||weights.length>64*1024)throw Error('reference result failed checksum, size or token verification');
        entry=outbox.put({task_id:manifest.id,lease_id:manifest.id},weights,{tokens:stats.tokens,seconds:stats.seconds,last_nll:stats.last_nll},{scope});
      }finally{if(train){
        // Only remove our three kinds of locally created transient files. The signed grant cannot
        // control the directory name or the resolved root.
        for(const file of fs.readdirSync(work))fs.unlinkSync(path.join(work,file));
        fs.rmdirSync(work);
      }}
    }
    const weights=outbox.bytes(entry.key),receipt=await client.put(`/v2/fusion/results/${manifest.id}?sha256=${entry.payload_sha256}&tokens=${entry.meta.tokens}`,weights,{payload:true,maxPayload:budget()});
    if(receipt.sha256!==entry.payload_sha256||receipt.id!==manifest.id||receipt.status!=='accepted')throw Error('result acknowledgement does not match the outbox');
    outbox.update(entry.key,{state:'accepted',result:receipt,closed_at:Date.now()});
    return {assignment:manifest.id,receipt,training:entry.meta,traffic};
  }finally{client.close();}
}

async function main(){
  if(!command||!dir)throw Error(help);
  if(command==='worker-receive')return receiveAssignment(dir,readJson(args[0]));
  if(command==='worker-train-reference')return receiveAssignment(dir,readJson(args[0]),{train:true});
  if(command==='estimate')return estimateComposition(readJson(args[0]));
  if(command==='grants-disable'){
    fs.rmSync(path.join(dir,'serve-grants'),{force:true});
    return {enabled:false};
  }
  if(command==='seal-dataset'){
    const input=readJson(args[0]);
    const dataset=sealFusionDataset(input,input);
    fs.mkdirSync(dir,{recursive:false});
    for(const [split,bytes] of Object.entries(dataset.files))save(path.join(dir,`${split}.json`),bytes);
    save(path.join(dir,'manifest.json'),dataset.manifest);
    return {sha256:dataset.sha256};
  }
  const registry=openFusion(dir);
  try{
    if(command==='ls')return {experts:registry.list(),models:registry.compositions(),active:registry.active()?.hash??null,publicKey:registry.publicKey};
    if(command==='create')return registry.create(readJson(args[0]));
    if(command==='clone')return registry.clone(args[0],Number(args[1]),readJson(args[2]));
    if(command==='transition')return registry.change(...args);
    if(command==='checkpoint')return registry.checkpoint(args[0],fs.readFileSync(args[1]),{parent:args[2]||null});
    if(command==='assess-expert')return registry.assessExpert(args[0],readJson(args[1]));
    if(command==='compose')return registry.assemble(readJson(args[0]));
    if(command==='assess')return registry.assess(args[0],readJson(args[1]));
    if(command==='publish')return registry.publish(args[0]);
    if(command==='rollback')return registry.rollback(args[0]);
    if(command==='export-composition-parameters'){
      const {envelope,artifacts}=registry.exportCompositionParameters(args[0]);
      fs.mkdirSync(args[1]);
      for(const [kind,bytes] of Object.entries(artifacts))save(path.join(args[1],kind+'.safetensors'),bytes);
      writeJson(path.join(args[1],'manifest.json'),envelope);
      return {directory:args[1],sha256:hashJSON(envelope.manifest),artifacts:Object.keys(artifacts)};
    }
    if(command==='import-composition-parameters'){
      const manifest=path.join(args[0],'manifest.json');
      if(fs.statSync(manifest).size>1024**2)throw Error('composition parameter manifest exceeds its size limit');
      const envelope=readJson(manifest),artifacts={};
      for(const kind of ['router','loop']){
        if(!envelope.manifest?.[kind]?.sha256)continue;
        const file=path.join(args[0],kind+'.safetensors'),info=fs.lstatSync(file);
        if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024**2)throw Error('invalid composition parameter file');
        artifacts[kind]=fs.readFileSync(file);
      }
      return registry.importCompositionParameters(envelope,artifacts,args[1]);
    }
    if(command==='export-expert'){
      const artifact=registry.exportExpert(args[0],Number(args[1]));
      fs.mkdirSync(args[2]);
      const weights=path.join(args[2],'weights.safetensors');
      if(artifact.weight_file)fs.copyFileSync(artifact.weight_file,weights,fs.constants.COPYFILE_EXCL);
      else save(weights,artifact.weights);
      writeJson(path.join(args[2],'manifest.json'),artifact.envelope);
      return {directory:args[2],sha256:artifact.envelope.manifest.expert.checkpoint.hash};
    }
    if(command==='import-expert'){
      const envelope=readJson(path.join(args[0],'manifest.json')),weights=path.join(args[0],'weights.safetensors');
      if(envelope.manifest?.expert?.storage==='file')return registry.importExpertFile(envelope,weights,args[1]);
      if(fs.statSync(weights).size>65*1024**2)throw Error('large expert bundles require the signed file storage profile');
      return registry.importExpert(envelope,fs.readFileSync(weights),args[1]);
    }
    if(command==='grants-enable'){
      save(path.join(dir,'serve-grants'),'1\n');
      return {enabled:true,restart_coordinator:true};
    }
    if(command==='grant'){
      const {device,expert,ttl,items,datasetManifest,cpuReference,streamQuotaBytes}=readJson(args[0]);
      const current=registry.get(expert);
      if(!current.checkpoint)throw Error('expert has no checkpoint');
      const layout=registry.weightLayout(current.checkpoint.hash);
      const records=[layout?{...layout,kind:'expert',stream:true,source:current.checkpoint.hash}:
        putArtifact(registry.cas,'expert',registry.cas.get(current.checkpoint.hash),current.checkpoint.hash)];
      const manifest=fs.readFileSync(datasetManifest);
      let referenceJob=null;
      for(const {kind,file,source,stream,expectedHash} of items){
        if(kind==='expert')throw Error('the expert is provided from its registry checkpoint');
        if(stream){
          if(cpuReference||kind==='train')throw Error('streamed Train data needs a sharded dataset manifest');
          records.push(await putArtifactFile(registry.cas,kind,file,source,{quotaBytes:streamQuotaBytes,expectedHash}));
          continue;
        }
        if(fs.statSync(file).size>64*1024*1024)throw Error('enable explicit streaming for large artifacts');
        const bytes=fs.readFileSync(file);
        if(kind==='train'){
          validateTrainShard(manifest,bytes,current.dataset_sha256);
          if(cpuReference){
            const {rows}=JSON.parse(bytes.toString('utf8'));
            const calls=current.training.local_steps*current.training.grad_accum;
            const tokens=Array.from({length:calls},(_,i)=>rows[i%rows.length].target_mask.slice(1).filter(Boolean).length).reduce((a,b)=>a+b,0);
            referenceJob={tokens};
          }
        }
        records.push(putArtifact(registry.cas,kind,bytes,source));
      }
      if(cpuReference&&!referenceJob)throw Error('reference job requires a Train shard');
      const envelope=signAssignment(registry,{device,expert:current,artifacts:records,ttl,referenceJob});
      return {id:createGrantStore(registry,path.join(dir,'grants')).grant(envelope),publicKey:registry.publicKey};
    }
    if(command==='revoke-grant'){
      createGrantStore(registry,path.join(dir,'grants')).revoke(args[0]);
      return {revoked:true};
    }
    if(command==='aggregate'){
      const input=readJson(args[0]);
      const expert=registry.get(input.round.expert);
      const updates=input.updates.map(({file,...meta})=>({...meta,payload:fs.readFileSync(file)}));
      const result=aggregateExpert({expert,base:registry.cas.get(expert.checkpoint.hash),round:input.round,assignments:input.assignments,updates,previousState:input.previousState});
      save(args[1],result.payload);
      writeJson(args[1]+'.json',{metrics:result.metrics,state:JSON.parse(JSON.stringify(result.state,(_k,v)=>v instanceof Float64Array?Array.from(v):v))});
      return {sha256:sha256(result.payload),...result.metrics};
    }
    throw Error(help);
  }finally{registry.close();}
}
main().then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(error.code||'ERROR',error.message);process.exitCode=1;});
