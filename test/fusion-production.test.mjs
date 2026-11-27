import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {python,tinyModel,tmp} from './compute-helpers.mjs';
import {startSidecar} from '../compute/worker/sidecar.mjs';
import {createWorker} from '../compute/worker/worker.mjs';
import {createCoordinatorService} from '../compute/coordinator/service.mjs';
import {createIdentity,fileSecretBox} from '../compute/worker/identity.mjs';
import {pairWithCoordinator} from '../compute/worker/pair.mjs';
import {createClient} from '../compute/worker/client.mjs';
import {createGovernor} from '../compute/governor/governor.mjs';
import {DEFAULT_POLICY} from '../compute/governor/policy.mjs';
import {openFusion} from '../compute/fusion/registry.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {detectBase,buildExpert} from '../compute/fusion/builder.mjs';
import {createFusionLab} from '../compute/fusion/lab.mjs';
import {sha256} from '../compute/protocol/hash.mjs';
import {decode,encode} from '../compute/protocol/safetensors.mjs';
import {aggregateTensorFiles,checkUpdateFile,createTensorFile,verifyTensorFile} from '../compute/fusion/tensor-file.mjs';
import {createFusionQueue} from '../compute/fusion/queue.mjs';
import {indexStoredFile} from '../compute/fusion/stream.mjs';
import {fusionFootprint,fitsFusionMemory} from '../compute/fusion/admission.mjs';

const py=python(['torch','transformers','safetensors','numpy']);
const training={optimizer:'sgd',lr:.01,local_steps:2,grad_accum:1,clip:1};
const rows=[{input_ids:[1,5,7,9],target_mask:[0,0,1,1]},{input_ids:[1,6,8,9],target_mask:[0,0,0,1]}];

test('Fusion round progression, admission and late receipts survive reopening the production queue',()=>{
  const root=tmp('fusion-rounds-'),weights=path.join(root,'delta.safetensors');
  const digest='1'.repeat(64);
  const train=Array.from({length:13},(_,i)=>({input_ids:[1,i+2],target_mask:[0,1]}));
  let clock=100,eligible=false,ram=8*2**30,registry=openFusion(root);
  const device=id=>({id,state:'active',online:true,heartbeat_age_ms:1,status:{eligible},
    capabilities:{backend:'torch-cpu-test',preflight_ok:true,variants:[{files_digest:digest}]},
    metrics:{fusion_opt_in:1,fusion_duty_pct:20,ram_available_bytes:ram,traffic_remaining:2**30,fusion_cache_bytes:2**30}});
  const makeQueue=()=>createFusionQueue(registry,{now:()=>clock,devices:()=>['a','b'].map(device),readTrain:(_id,_digest,start,n)=>train.slice(start,start+n)});
  let queue=makeQueue();
  const worker={consent:true,backend:'torch-cpu-test',model_sha256:digest,available_bytes:2**30};
  const base={revision:'fixture',backbone_sha256:digest,architecture_sha256:digest,tokenizer_sha256:digest,layers:1,width:4,parameters:10};
  const tensors=['A','B'].map(k=>({name:'layers.0.fusion.'+k,dtype:'F32',shape:k==='A'?[2,4]:[4,2]}));
  const expert=registry.create({kind:'ffa-lora',base,key:'code',name:'Code',domain:'code',layers:[0],rank:2,alpha:4,tensors,
    license:'CC0-1.0',dataset_sha256:'a'.repeat(64),training:{...training,local_steps:1}});
  const config={expertId:expert.id,modelDigest:digest,backend:'torch-cpu-test',maxLength:4,validation:rows,dataset:'fixture@1',trainCount:train.length,
    quorum:2,devices:['a','b'],schedule:{rounds:5,epochs:1,tokenBudget:10}};
  const validation={control:{nll_sum:2,tokens:1},candidate:{nll_sum:3,tokens:1}};
  const extract=m=>JSON.parse(registry.cas.get(m.artifacts[1].sha256)).rows[0].input_ids[1];
  fs.writeFileSync(weights,encode({[tensors[1].name]:{shape:[4,2],data:new Float32Array(8).fill(.1)}}));
  const artifact=indexStoredFile(weights),send=(id,m)=>queue.result(id,m.id,{artifact,tokens:1},weights);
  try{
    const run=queue.start(config);
    assert.equal(queue.claim('a',worker).task,null,'manual placement must honor eligibility');
    eligible=true;ram=1;
    assert.equal(queue.claim('a',worker).task,null,'manual placement must honor memory');
    ram=8*2**30;
    const seen=[];
    for(let round=1;round<=5;round++){
      const a=queue.claim('a',worker).task.manifest,b=queue.claim('b',worker).task.manifest;
      assert.equal(a.round,round);
      seen.push(extract(a),extract(b));
      clock=a.expires+1;
      assert.throws(()=>queue.renew('a',a.id),{code:'LEASE_EXPIRED'});
      assert.equal(send('a',a).status,'accepted');
      registry.close();registry=openFusion(root);queue=makeQueue();
      assert.equal(queue.resultStatus('a',a.id).status,'accepted');
      assert.equal(send('a',a).status,'accepted');
      assert.equal(send('b',b).status,'committed');
      assert.equal(queue.resultStatus('a',a.id).status,'committed');
      assert.equal(send('a',a).checkpoint,queue.nextEvaluation().checkpoint);
      assert.equal(queue.nextEvaluation().expert.version,round+1);
      assert.equal(queue.finishEvaluation(run.id,validation).status,round===5?'REJECTED':'RUNNING');
    }
    assert.deepEqual(seen,[2,3,4,5,6,7,8,9,10,11]);
    assert.equal(queue.list()[0].plan.tokens,10);
    assert.deepEqual(queue.list()[0].next_position,{epoch:0,index:10});
    const parent=registry.get(expert.id).checkpoint.hash;
    const next=queue.start({...config,devices:[],quorum:1,schedule:{rounds:8,epochs:1,tokenBudget:1}});
    eligible=false;
    assert.equal(queue.claim('a',worker).task,null,'automatic placement must yield no lease when there are no eligible devices');
    eligible=true;
    const old=queue.claim('a',worker).task.manifest;
    assert.equal(old.parent,parent);
    assert.equal(extract(old),12);
    clock=old.expires+1;
    const replacement=queue.claim('a',worker).task.manifest;
    assert.notEqual(replacement.id,old.id);
    assert.throws(()=>send('a',old),{code:'STALE'});
    assert.equal(send('a',replacement).status,'committed');
    assert.equal(queue.finishEvaluation(next.id,validation).status,'REJECTED','stop at the token budget');
  }finally{registry.close();}
});

test('Fusion memory admission counts FFN gradients, AdamW state and temporary allocations',()=>{
  const model={base:{width:3072,layers:26,parameters:3300000000},layers:[4],bytes:324*2**20,rank:null,
    tensors:['gate','up','down'].map(name=>({name:`layers.4.fusion.${name}.weight`,shape:[9216,3072],trainable:true})),training:{optimizer:'adamw'}};
  const footprint=fusionFootprint(model,{backend:'cuda',context:256,modelLayout:{vocab:131072,intermediate:9216},observedBase:3700*2**20});
  assert.equal(footprint.weights,324*2**20);
  assert.equal(footprint.gradients,footprint.weights);
  assert.equal(footprint.optimizer,2*footprint.weights);
  assert.ok(footprint.activations>0&&footprint.temporary>footprint.weights);
  assert.equal(fitsFusionMemory(footprint,16*2**30,footprint.vram-1,0,'cuda'),false);
  assert.equal(fitsFusionMemory(footprint,16*2**30,footprint.vram-footprint.backbone,footprint.backbone,'cuda'),true);
});

test('disk FedAvg keeps canonical frozen tensors and rejects duplicate, non-finite or off-schema updates',()=>{
  const root=tmp('fusion-disk-numeric-');
  const A={name:'layers.0.fusion.A',shape:[2,4],dtype:'F32',trainable:false};
  const B={name:'layers.0.fusion.B',shape:[4,2],dtype:'F32',trainable:true};
  const [base,one,two,result]=['base','one','two','result'].map(n=>path.join(root,n+'.safetensors'));
  try{
    createTensorFile(base,[A,B],(k,v)=>v.fill(k===A.name?1:0));
    createTensorFile(one,[B],(_k,v)=>v.fill(1));
    createTensorFile(two,[B],(_k,v)=>v.fill(3));
    const first={id:'one',device:'one',tokens:1,file:one},second={id:'two',device:'two',tokens:3,file:two};
    const opts={base,output:result,schema:[A,B],minDevices:2,updates:[first,second]};
    const r=aggregateTensorFiles(opts);
    assert.equal(r.frozen,verifyTensorFile(base,[A,B]).frozen);
    assert.equal(r.frozen,sha256(encode({[A.name]:{shape:A.shape,data:new Float32Array(8).fill(1)}})));
    assert.deepEqual([...decode(fs.readFileSync(result)).tensors[B.name].data],new Array(8).fill(2.5));
    assert.throws(()=>aggregateTensorFiles({...opts,updates:[first,{...second,device:'one'}]}),{code:'CONFLICT'});
    assert.throws(()=>checkUpdateFile(base,one,[A,B],1),{code:'UPDATE_NORM_LIMIT'});
    const fd=fs.openSync(one,'r+');
    try{const bad=Buffer.alloc(4);bad.writeFloatLE(Infinity);fs.writeSync(fd,bad,0,4,fs.fstatSync(fd).size-4);}finally{fs.closeSync(fd);}
    assert.throws(()=>checkUpdateFile(base,one,[A,B]),{code:'NONFINITE'});
    assert.throws(()=>checkUpdateFile(base,two,[A,{...B,shape:[8,1]}]),{code:'INVALID_TENSOR'});
  }finally{for(const file of fs.readdirSync(root))fs.unlinkSync(path.join(root,file));fs.rmdirSync(root);}
});

test('detected architecture drives the builder and the live sidecar trains, evaluates and reuses a local backbone',{
  skip:!py,timeout:120000
},async t=>{
  const model=tinyModel(),root=tmp('fusion-worker-');
  const events=[];
  const sc=startSidecar({python:py,threads:1,extraEnv:{KVALAH_COMPUTE_TEST:'1',CUDA_VISIBLE_DEVICES:''},onEvent:e=>{
    events.push(e);
    if(e.type==='permit_request')sc.send({cmd:'permit',id:e.id});
  }});
  try{
    const verified=await sc.call('verify_model',{model_dir:model}).promise;
    const detected=detectBase({model_dir:model,files_digest:verified.files_digest,architecture_ok:true,variant_id:'cpu-test'});
    assert.equal(detected.layers,2);
    assert.equal(detected.width,64);
    assert.ok(detected.parameters>0);
    const dataset={id:'verified@1',license:'CC0-1.0',group_audited:true,manifest_hash:'a'.repeat(64),tokenizer_hash:detected.tokenizer_sha256};
    const input={model_id:detected.id,dataset_id:dataset.id,key:'code',name:'Code',kind:'ffa-lora',domain:'code',layers:[0],rank:4,alpha:8,training};
    const lab=createFusionLab(path.join(root,'lab'),{inputs:()=>({model:detected,datasets:[dataset]})});
    try{
      assert.equal((await lab.handle('GET','state',{})).builder.model.vocab,detected.vocab);
      await assert.rejects(lab.handle('POST','estimate',{model_id:'not-installed'}),{code:'MODEL_REQUIRED'});
      const estimate=await lab.handle('POST','estimate',{model_id:detected.id,count:1,intermediate:32,layers:[0,1],loop:{start:0,end:1,passes:2}});
      assert.equal(estimate.logical_layers,3);
      const e=await lab.handle('POST','expert/create',input);
      assert.deepEqual(e.tensors.map(s=>[s.shape,s.trainable]),[[[4,64],false],[[64,4],true]]);
      await assert.rejects(lab.handle('POST','expert/create',{...input,dataset_id:'wrong'}),{code:'DATASET_REQUIRED'});
      assert.throws(()=>buildExpert(input,detected,{...dataset,tokenizer_hash:'b'.repeat(64)}),{code:'MODEL_UNVERIFIED'});
    }finally{lab.close();}

    const makeArtifact=(name,value)=>{
      const file=path.join(root,name),bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));
      fs.writeFileSync(file,bytes);
      return {file,hash:sha256(bytes)};
    };
    const train=makeArtifact('train.json',{split:'train',rows});
    const validation=makeArtifact('validation.json',{split:'validation',rows});
    for(const kind of ['ffa-lora','lora','ffn']){
      const e=buildExpert({...input,kind,intermediate:32},detected,dataset);
      const values=Object.fromEntries(e.tensors.map(s=>[s.name,{shape:s.shape,data:Float32Array.from({length:s.shape.reduce((a,b)=>a*b,1)},(_,i)=>
        s.name.endsWith('.B')||s.name.endsWith('down.weight')?0:((i%11)-5)/100)}]));
      const ck=makeArtifact(`${kind}.safetensors`,encode(values)),result=path.join(root,`${kind}.out.safetensors`);
      const spec={key:e.key,kind,layers:e.layers,rank:e.rank,alpha:e.alpha,intermediate:32};
      const args={backend:'torch-cpu-test',model_files_digest:verified.files_digest,expert:spec,checkpoint_sha256:ck.hash,max_length:32,
        rows_sha256:train.hash,training,expected_supervised_tokens:3,retain_model:true,
        paths:{model_dir:model,rows:train.file,checkpoint:ck.file,result}};
      const trained=await sc.call('fusion_train',args).promise;
      assert.equal(trained.model_cache_hit,kind!=='ffa-lora');
      assert.equal(trained.supervised_tokens,3);
      assert.equal(trained.frozen_unchanged,true);
      const data=decode(fs.readFileSync(result)).tensors;
      assert.deepEqual(Object.keys(data).sort(),e.tensors.filter(t=>t.trainable!==false).map(t=>t.name).sort());
      assert.ok(Object.entries(data).some(([k,v])=>v.data.some((x,i)=>x!==values[k].data[i])));
      const composed=makeArtifact(`${kind}.trained.safetensors`,encode({...values,...data}));
      const assessed=await sc.call('fusion_evaluate',{...args,checkpoint_sha256:composed.hash,rows_sha256:validation.hash,
        paths:{...args.paths,checkpoint:composed.file,rows:validation.file}}).promise;
      assert.equal(assessed.control.tokens,3);
      assert.equal(assessed.candidate.tokens,3);
      assert.ok(Number.isFinite(assessed.candidate.nll_sum));
      if(kind==='ffn'){
        const composed={backend:'torch-cpu-test',model_files_digest:verified.files_digest,experts:[{spec,checkpoint:ck.file,sha256:ck.hash,
          validation:validation.file,validation_sha256:validation.hash}],router:{mode:'uniform',top_k:1},loop:{start:0,end:2,passes:2},max_length:96,
          paths:{model_dir:model}};
        const comparison=await sc.call('fusion_compare',composed).promise;
        assert.equal(comparison.tokens,3);
        assert.ok(Number.isFinite(comparison.candidate_nll));
        const generated=await sc.call('fusion_generate',{...composed,prompt:'What is 2 + 2?',max_new_tokens:2}).promise;
        assert.equal(typeof generated.text,'string');
        assert.ok(generated.generated_tokens<=2);
      }
    }
    assert.equal(events.filter(e=>e.type==='step').length,6);
    assert.deepEqual(await sc.call('release_model').promise,{resident:false});
  }finally{await sc.stop(4000);}
});

test('production Compute Worker requests signed Fusion leases, resumes upload and runs trusted Validation after aggregation',{
  skip:!py,timeout:120000
},async()=>{
  const model=tinyModel(),root=tmp('fusion-coordinator-'),fusion=path.join(root,'fusion');
  const rt={python:py,backend:'torch-cpu-test',model_dir:model,variant_id:'cpu-test',threads:1};
  const svc=createCoordinatorService({dir:path.join(root,'coordinator'),evaluator:()=>rt,tickMs:100});
  const reg=openFusion(fusion),workers=[],failures=[];
  let lost=false,outage=false;
  try{
    const verified=await svc.verifyModel({python:py,model_dir:model});
    rt.files_digest=verified.files_digest;
    const detected=detectBase({...rt,architecture_ok:true});
    const data=await svc.importDataset({fixture:true,dataset_id:'fusion-auto',revision:'1',profile_id:'tiny-test-ffa-r4',max_length:96,runtime:rt});
    const dataset=svc.coord.listDatasets().find(d=>d.id===data.id);
    const e=reg.create({...buildExpert({model_id:detected.id,key:'math',name:'Math',kind:'ffa-lora',domain:'math',layers:[0],rank:4,alpha:8,training},detected,dataset),storage:'file'});
    const {port}=await svc.start({bindIp:'127.0.0.1',port:0});
    for(const alias of ['a','b']){
      const local=path.join(root,'worker-'+alias),identity=await createIdentity(path.join(local,'id'),fileSecretBox);
      const link=await pairWithCoordinator({pairing:svc.createPairing().pairing,identity,alias});
      svc.coord.approveDevice(identity.device_id);
      const governor=createGovernor({stateDir:local,policy:{...DEFAULT_POLICY,profile:'full',gpu_target_pct:100,cpu_target_pct:10,
        only_idle:false,only_ac:false,pause_on_games:false,fusion_training:true}});
      governor.setEnabled(true);governor.setSensors({ram_free_bytes:8*2**30});
      const sensor=setInterval(()=>governor.setSensors({ram_free_bytes:8*2**30}),5000);sensor.unref();
      const w=createWorker({stateDir:local,identity,link,governor,runtime:{...rt,profile_id:'tiny-test-ffa-r4'},
        capabilities:()=>({backend:rt.backend,preflight_ok:true,runtime_version:'test',variants:[{profile_id:'tiny-test-ffa-r4',variant_id:'cpu-test',files_digest:rt.files_digest}]}),
        startSidecar:o=>startSidecar({...o,threads:1}),onEvent:e=>{if(e.code==='worker.error')failures.push(e);},
        makeClient:opts=>{
          const c=createClient(opts);
          return Object.create(c,{post:{value:async(route,...args)=>{
            if(route.endsWith('/upload/begin')&&!outage){
              outage=true;
              await svc.stop();
              try{await assert.rejects(c.post(route,...args));}
              finally{await svc.start({bindIp:'127.0.0.1',port});}
              throw Object.assign(Error('coordinator stopped before upload'),{code:'UNAVAILABLE'});
            }
            const result=await c.post(route,...args);
            if(route.endsWith('/upload/complete')&&!lost){lost=true;throw Object.assign(Error('lost receipt'),{code:'UNAVAILABLE'});}
            return result;
          }}});
        }});
      workers.push({w,sensor,id:identity.device_id});
    }
    const plan=svc.startFusion({expert_id:e.id,dataset_id:data.id,model_sha256:rt.files_digest,devices:[],quorum:2,share_train:true});
    assert.ok(plan.id);
    svc.controlFusion(plan.id,'pause');
    assert.equal(svc.fusionRuns()[0].status,'PAUSED');
    svc.controlFusion(plan.id,'resume');
    for(const {w} of workers)w.start();
    const until=Date.now()+65000;
    while(Date.now()<until&&(!['VALIDATED','REJECTED'].includes(svc.fusionRuns()[0].status)||workers.some(({w})=>w.state.metrics.tasks_accepted!==1)))await delay(250);
    const [run]=svc.fusionRuns(),ready=reg.get(e.id);
    assert.ok(['VALIDATED','REJECTED'].includes(run.status),JSON.stringify({run,failures:failures.slice(0,4),states:workers.map(x=>x.w.state.state)}));
    assert.ok(ready.checkpoint.assessment);
    assert.equal(ready.version,2);
    assert.ok(reg.weightLayout(ready.checkpoint.hash));
    const exported=reg.exportExpert(ready.id,2);
    assert.equal(reg.importExpertFile(exported.envelope,exported.weight_file,reg.publicKey).checkpoint.hash,ready.checkpoint.hash);
    assert.equal(ready.checkpoint.frozen,reg.get(e.id,1).checkpoint.frozen);
    assert.equal(run.leases.filter(l=>l.state==='committed').length,2);
    assert.equal(new Set(run.leases.filter(l=>l.state==='committed').map(l=>l.device)).size,2);
    assert.equal(lost,true);
    assert.equal(outage,true);
    for(const {w} of workers)assert.equal(w.state.metrics.optimizer_steps,2);
    assert.ok(workers.some(({w})=>w.outbox.all().some(entry=>entry.state==='committed')));
  }finally{
    for(const {w,sensor} of workers){clearInterval(sensor);await w.stop();}
    await svc.close();reg.close();
  }
});

test('scheduled Router and Loop stages restore parameters after restart, validate and export a signed composition',{
  skip:!py,timeout:150000
},async()=>{
  const model=tinyModel(),root=tmp('fusion-compose-'),dir=path.join(root,'coordinator'),reg=openFusion(path.join(root,'fusion'));
  const rt={python:py,backend:'torch-cpu-test',model_dir:model,variant_id:'cpu-test',threads:1,extraEnv:{KVALAH_COMPUTE_TEST:'1',CUDA_VISIBLE_DEVICES:''}};
  let canRun=true;
  const failures=[];
  const service=()=>createCoordinatorService({dir,evaluator:()=>rt,tickMs:200,canRunHeavy:()=>({run:canRun}),log:l=>failures.push(l)});
  let svc=service();
  const wait=async predicate=>{
    for(let tries=0;tries<600;tries++){
      const job=svc.compositionRuns()[0];
      if(predicate(job))return job;
      assert.notEqual(job?.state,'FAILED',JSON.stringify({job,failures:failures.slice(-8)}));
      await delay(150);
    }
    assert.fail(JSON.stringify({jobs:svc.compositionRuns(),failures:failures.slice(-8)}));
  };
  try{
    rt.files_digest=(await svc.verifyModel({python:py,model_dir:model})).files_digest;
    const detected=detectBase({...rt,architecture_ok:true});
    const data=await svc.importDataset({fixture:true,dataset_id:'fusion-comp',revision:'1',profile_id:'tiny-test-ffa-r4',max_length:96,runtime:rt});
    const ds=svc.coord.listDatasets().find(x=>x.id===data.id);
    const experts=['code','math'].map((key,i)=>{
      const e=reg.create(buildExpert({model_id:detected.id,key,name:key,kind:'ffa-lora',domain:key,layers:[0],rank:4,alpha:8,training},detected,ds));
      reg.change(e.id,'CREATED','PROVISIONING');
      const tensors=Object.fromEntries(e.tensors.map(t=>[t.name,{shape:t.shape,
        data:Float32Array.from({length:t.shape[0]*t.shape[1]},(_,j)=>.01*((j*(i+1)+i)%13-6))}]));
      const v=reg.checkpoint(e.id,encode(tensors));
      reg.change(e.id,'PROVISIONING','READY');reg.change(e.id,'READY','EVALUATING');
      reg.assessExpert(e.id,{version:v.version,dataset_sha256:'c'.repeat(64),control_nll:2,candidate_nll:1.5});
      return {id:e.id,version:v.version};
    });
    canRun=false;
    await svc.start({bindIp:'127.0.0.1',port:0});
    const job=await svc.evaluateComposition({experts,router_mode:'token',top_k:1,fit_loop:true,loop:{start:0,end:2,passes:2},steps:4});
    svc.controlComposition(job.id,'pause');
    assert.equal(svc.compositionRuns()[0].state,'PAUSED');
    svc.controlComposition(job.id,'resume');
    canRun=true;
    const trained=await wait(job=>job?.stages[0].state==='DONE');
    const router=trained.stages[0].result.sha256;
    assert.equal(trained.stages[0].result.steps,4);
    assert.ok(trained.stages[0].result.max_gradient_norm>0);
    canRun=false;
    await svc.close();svc=service();
    await svc.start({bindIp:'127.0.0.1',port:0});
    assert.equal(svc.compositionRuns()[0].stages[0].result.sha256,router);
    canRun=true;
    const finished=await wait(job=>job?.state==='DONE');
    const gates=finished.stages[1].result.sha256;
    assert.ok(finished.stages[1].result.max_gradient_norm>0);
    assert.equal(finished.stages[1].result.steps,4);
    const composition=reg.composition(finished.candidate);
    assert.equal(composition.envelope.manifest.router.sha256,router);
    assert.equal(composition.envelope.manifest.loop.sha256,gates);
    assert.ok(Number.isFinite(composition.assessment.candidate_nll));
    const bundle=reg.exportCompositionParameters(composition.hash);
    const imported=reg.importCompositionParameters(bundle.envelope,bundle.artifacts,reg.publicKey);
    assert.equal(imported.hash,composition.hash);
    assert.throws(()=>reg.importCompositionParameters(bundle.envelope,{...bundle.artifacts,router:Buffer.from('corrupt')},reg.publicKey),{code:'INVALID_SCHEMA'});
    const sc=startSidecar({python:py,threads:1,extraEnv:rt.extraEnv,onEvent:e=>{
      if(e.type==='permit_request')sc.send({cmd:'permit',id:e.id});
    }});
    try{
      for(const [name,bytes] of Object.entries(bundle.artifacts))fs.writeFileSync(path.join(root,name+'.safetensors'),bytes);
      const args={backend:rt.backend,paths:{model_dir:model},model_files_digest:rt.files_digest,
        experts:experts.map(ref=>{
          const e=reg.get(ref.id,ref.version);
          return {spec:{key:e.key,kind:e.kind,layers:e.layers,rank:e.rank,alpha:e.alpha},sha256:e.checkpoint.hash,checkpoint:reg.weightFile(e.checkpoint.hash)};
        }),router:composition.envelope.manifest.router,loop:composition.envelope.manifest.loop,
        router_weights:{file:path.join(root,'router.safetensors'),sha256:router},loop_weights:{file:path.join(root,'loop.safetensors'),sha256:gates},
        prompt:'What is 2 + 2?',max_new_tokens:5,max_length:96};
      const cached=await sc.call('fusion_generate',args).promise;
      const uncached=await sc.call('fusion_generate',{...args,use_cache:false}).promise;
      assert.deepEqual(cached,{...uncached,kv_cache:true});
      assert.ok(cached.generated_tokens>0);
      await assert.rejects(sc.call('fusion_generate',{...args,loop_weights:{...args.loop_weights,sha256:'a'.repeat(64)}}).promise,{code:'HASH_MISMATCH'});
      const ten=Array.from({length:10},(_,i)=>({...args.experts[i%2],spec:{...args.experts[i%2].spec,key:`expert_${i}`}}));
      const scaled=await sc.call('fusion_generate',{...args,experts:ten,router:{mode:'uniform',top_k:1},loop:{start:0,end:0,passes:1},
        router_weights:null,loop_weights:null,max_new_tokens:1}).promise;
      assert.equal(scaled.generated_tokens,1);
    }finally{await sc.stop(4000);}
  }finally{await svc.close();reg.close();}
});
