import fs from 'node:fs';
import path from 'node:path';
import {openFusion} from './registry.mjs';
import {aggregateExpert} from './aggregate.mjs';
import {putArtifact,createGrantStore,signAssignment,createProvisionStore} from './provision.mjs';
import {estimateComposition} from './lab.mjs';
import {sealFusionDataset,validateTrainShard} from './datasets.mjs';
import {sha256} from '../protocol/hash.mjs';
import {createClient} from '../worker/client.mjs';
import {loadIdentity,fileSecretBox} from '../worker/identity.mjs';

const [command,dir,...args]=process.argv.slice(2);
const help='node compute/fusion/cli.mjs <command> <fusion-state-dir> [arguments]';
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const writeJson=(file,v)=>fs.writeFileSync(file,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const save=(file,b)=>fs.writeFileSync(file,b,{flag:'wx'});

async function receiveAssignment(root,opts){
  if(!opts.consent||!opts.identityDir||!opts.publicKey||!opts.maxTrafficBytes||!opts.cacheBytes)throw Error('existing device identity, pinned Fusion signing key, local consent and explicit budgets required');
  const identity=await loadIdentity(opts.identityDir,fileSecretBox);
  if(!identity)throw Error('device must already be paired and approved in Compute');
  const output=path.resolve(opts.output);
  if(fs.existsSync(output))throw Error('output directory already exists');
  let traffic=0;
  const client=createClient({endpoint:opts.endpoint,fingerprint:opts.fingerprint,identity,onTraffic:bytes=>{traffic+=bytes;}});
  try{
    await client.syncTime();
    const {envelope}=await client.get('/v2/fusion/assignment');
    const cache=createProvisionStore({root:path.join(root,'provision'),quotaBytes:opts.cacheBytes});
    const response=await cache.provision(envelope,{publicKey:opts.publicKey,device:identity.device_id,consented:true,
      permit:()=>opts.maxTrafficBytes-traffic,fetchCoordinator:async(m,part,{signal,maxBytes})=>(await client.get(`/v2/fusion/parts/${m.id}/${part.sha256}`,{
        signal,payload:true,json:false,maxPayload:maxBytes
      })).bytes});
    fs.mkdirSync(output,{recursive:true});
    for(const item of response.items)save(path.join(output,item.sha256),item.bytes);
    writeJson(path.join(output,'assignment.json'),envelope);
    return {assignment:response.assignment,expert:response.expert,artifacts:response.items.map(({kind,sha256})=>({kind,sha256})),traffic};
  }finally{client.close();}
}

async function main(){
  if(!command||!dir)throw Error(help);
  if(command==='worker-receive')return receiveAssignment(dir,readJson(args[0]));
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
    if(command==='export-expert'){
      const artifact=registry.exportExpert(args[0],Number(args[1]));
      fs.mkdirSync(args[2]);
      save(path.join(args[2],'weights.safetensors'),artifact.weights);
      writeJson(path.join(args[2],'manifest.json'),artifact.envelope);
      return {directory:args[2],sha256:sha256(artifact.weights)};
    }
    if(command==='import-expert')return registry.importExpert(readJson(path.join(args[0],'manifest.json')),
      fs.readFileSync(path.join(args[0],'weights.safetensors')),args[1]);
    if(command==='grants-enable'){
      save(path.join(dir,'serve-grants'),'1\n');
      return {enabled:true,restart_coordinator:true};
    }
    if(command==='grant'){
      const {device,expert,ttl,items,datasetManifest}=readJson(args[0]);
      const current=registry.get(expert);
      const records=[putArtifact(registry.cas,'expert',registry.cas.get(current.checkpoint.hash),current.checkpoint.hash)];
      const manifest=fs.readFileSync(datasetManifest);
      for(const {kind,file,source} of items){
        if(kind==='expert')throw Error('the expert is provided from its registry checkpoint');
        if(fs.statSync(file).size>64*1024*1024)throw Error('artifact requires chunks under 64 MiB');
        const bytes=fs.readFileSync(file);
        if(kind==='train')validateTrainShard(manifest,bytes,current.dataset_sha256);
        records.push(putArtifact(registry.cas,kind,bytes,source));
      }
      const envelope=signAssignment(registry,{device,expert:current,artifacts:records,ttl});
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
