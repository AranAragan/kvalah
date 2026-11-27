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

const py=python(['torch','transformers','safetensors','numpy']);
const training={optimizer:'sgd',lr:.01,local_steps:2,grad_accum:1,clip:1};
const rows=[{input_ids:[1,5,7,9],target_mask:[0,0,1,1]},{input_ids:[1,6,8,9],target_mask:[0,0,0,1]}];

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
  let lost=false;
  try{
    const verified=await svc.verifyModel({python:py,model_dir:model});
    rt.files_digest=verified.files_digest;
    const detected=detectBase({...rt,architecture_ok:true});
    const data=await svc.importDataset({fixture:true,dataset_id:'fusion-auto',revision:'1',profile_id:'tiny-test-ffa-r4',max_length:96,runtime:rt});
    const dataset=svc.coord.listDatasets().find(d=>d.id===data.id);
    const e=reg.create(buildExpert({model_id:detected.id,key:'math',name:'Math',kind:'ffa-lora',domain:'math',layers:[0],rank:4,alpha:8,training},detected,dataset));
    await svc.start({bindIp:'127.0.0.1',port:0});
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
    assert.equal(ready.checkpoint.frozen,reg.get(e.id,1).checkpoint.frozen);
    assert.equal(run.leases.filter(l=>l.state==='accepted').length,2);
    assert.equal(new Set(run.leases.filter(l=>l.state==='accepted').map(l=>l.device)).size,2);
    assert.equal(lost,true);
    for(const {w} of workers)assert.equal(w.state.metrics.optimizer_steps,2);
  }finally{
    for(const {w,sensor} of workers){clearInterval(sensor);await w.stop();}
    await svc.close();reg.close();
  }
});
