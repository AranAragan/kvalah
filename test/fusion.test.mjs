import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {test} from 'node:test';
import {openFusion,verifyEnvelope} from '../compute/fusion/registry.mjs';
import {aggregateExpert} from '../compute/fusion/aggregate.mjs';
import {createGrantStore,createProvisionStore,putArtifact,signAssignment} from '../compute/fusion/provision.mjs';
import {scheduleExperts} from '../compute/fusion/scheduler.mjs';
import {estimateComposition} from '../compute/fusion/lab.mjs';
import {sealFusionDataset,validateTrainShard} from '../compute/fusion/datasets.mjs';
import {createCoordinatorService} from '../compute/coordinator/service.mjs';
import {createClient} from '../compute/worker/client.mjs';
import {pairWithCoordinator} from '../compute/worker/pair.mjs';
import {newKeyPair} from '../compute/protocol/sign.mjs';
import {createIdentity,fileSecretBox} from '../compute/worker/identity.mjs';
import {createOutbox} from '../compute/worker/outbox.mjs';
import {decode,encode} from '../compute/protocol/safetensors.mjs';
import {hashJSON,sha256} from '../compute/protocol/hash.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
const digest=ch=>ch.repeat(64);
const base={revision:'fixture-1',backbone_sha256:digest('a'),tokenizer_sha256:digest('b'),architecture_sha256:digest('c'),layers:4,width:4,parameters:400};
const A='layers.1.mlp.A',B='layers.1.mlp.B';
const spec={key:'code',name:'Code',domain:'code',kind:'ffa-lora',base,layers:[1],tensors:[{name:A,shape:[1,4],dtype:'F32'},{name:B,shape:[4,1],dtype:'F32'}],
  rank:1,alpha:2,training:{optimizer:'sgd',lr:0.1,local_steps:1,grad_accum:1,clip:1},dataset_sha256:digest('d'),license:'CC0-1.0'};
const part=(value,shape)=>({shape,data:new Float32Array(4).fill(value)});
const weights=(b=0,a=1)=>encode({[A]:part(a,[1,4]),[B]:part(b,[4,1])});
const update=(b)=>encode({[B]:part(b,[4,1])});
function rootFor(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kvalah-fusion-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}
function registryFor(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kvalah-fusion-')),r=openFusion(root);
  t.after(()=>{r.close();fs.rmSync(root,{recursive:true,force:true});});
  return [r,root];
}
function initialized(r,input=spec){
  const {id}=r.create(input);
  r.change(id,'CREATED','PROVISIONING');
  r.checkpoint(id,weights());
  return r.change(id,'PROVISIONING','READY');
}
function validated(r,record){
  r.change(record.id,'READY','EVALUATING');
  return r.assessExpert(record.id,{version:record.version,dataset_sha256:digest('e'),control_nll:2,candidate_nll:1.95});
}

test('Fusion registry pins tensor shape and frozen A, exports signed versions and gates publication and rollback',t=>{
  const [r]=registryFor(t);
  const first=initialized(r);
  assert.throws(()=>r.change(first.id,'CREATED','PROVISIONING'),{code:'CONFLICT'});
  r.change(first.id,'READY','TRAINING');
  assert.throws(()=>r.checkpoint(first.id,weights(1,2),{parent:first.checkpoint.hash}),/frozen/);
  assert.throws(()=>r.checkpoint(first.id,weights(NaN),{parent:first.checkpoint.hash}),{code:'NONFINITE'});
  assert.throws(()=>r.checkpoint(first.id,weights(1),{parent:digest('a')}),/stale/);
  const stored=r.checkpoint(first.id,weights(1),{parent:first.checkpoint.hash});
  assert.equal(stored.version,2);
  assert.equal(r.get(first.id,1).checkpoint.hash,first.checkpoint.hash);
  r.change(first.id,'TRAINING','EVALUATING');
  assert.throws(()=>r.change(first.id,'EVALUATING','VALIDATED'),/Validation/);
  assert.throws(()=>r.assessExpert(first.id,{version:1,dataset_sha256:digest('e'),control_nll:2,candidate_nll:1.95}),/stale/);
  r.assessExpert(first.id,{version:2,dataset_sha256:digest('e'),control_nll:2,candidate_nll:1.95});
  const bundle=r.exportExpert(first.id,2);
  assert.equal(verifyEnvelope(bundle.envelope,r.publicKey).expert.checkpoint.hash,sha256(bundle.weights));
  assert.throws(()=>r.importExpert(bundle.envelope,weights(2),r.publicKey),/bundle/);
  assert.throws(()=>r.importExpert(bundle.envelope,bundle.weights,newKeyPair().publicKey),/signature/);
  const imported=r.importExpert(bundle.envelope,bundle.weights,r.publicKey);
  assert.equal(imported.checkpoint.hash,stored.checkpoint.hash);
  const input={base,experts:[{id:first.id,version:2}],loop:{start:1,end:3,passes:2}};
  assert.throws(()=>r.assemble({...input,experts:[{id:first.id,version:1}]}),/validated/);
  const model=r.assemble(input);
  assert.equal(model.envelope.manifest.stats.logical_layers,6);
  assert.throws(()=>r.publish(model.hash),/unvalidated/);
  assert.equal(r.assess(model.hash,{dataset_sha256:digest('d'),control_nll:2,candidate_nll:2.2,experts:[{key:'code',control_nll:2,candidate_nll:2}]}).assessment.passed,false);
  r.assess(model.hash,{dataset_sha256:digest('e'),control_nll:2,candidate_nll:1.95,experts:[{key:'code',control_nll:2,candidate_nll:1.95}]});
  r.publish(model.hash);
  const newExpert=validated(r,r.clone(first.id,2,{key:'language',name:'Language'}));
  const next=r.assemble({...input,experts:[...input.experts,{id:newExpert.id,version:1}]});
  assert.equal(next.envelope.manifest.experts[0].sha256,stored.checkpoint.hash);
  const metrics=['code','language'].map(key=>({key,control_nll:2,candidate_nll:1.99}));
  r.assess(next.hash,{dataset_sha256:digest('e'),control_nll:2,candidate_nll:1.95,experts:metrics});
  r.publish(next.hash);
  assert.equal(r.rollback(model.hash).hash,model.hash);
  assert.equal(r.composition(next.hash).status,'ROLLED_BACK');
  assert.equal(r.active().hash,model.hash);
});

test('Fusion round isolates versions, specialists and weighted regional contributions',t=>{
  const [r]=registryFor(t);
  const expert=initialized(r);
  const {checkpoint}=expert;
  const assignments=[{id:'a',device:'d1',tokens:2,group:'lan1'},{id:'b',device:'d2',tokens:6,group:'lan2'},{id:'c',device:'d3',tokens:12,group:'lan2'}];
  function run(algorithm,config){
    const round={id:'round1',algorithm,config,expert:expert.id,parent:checkpoint.hash,schema:expert.schema_sha256,frozen:checkpoint.frozen,min_devices:3};
    const updates=assignments.map((a,i)=>{
      const payload=update(i+1);
      return {id:a.id,device:a.device,tokens:a.tokens,round:round.id,expert:round.expert,parent:round.parent,schema:round.schema,frozen:round.frozen,
        config:hashJSON({algorithm,config}),payload,payload_sha256:sha256(payload)};
    });
    return {expert,base:weights(),round,assignments,updates};
  }
  const input=run('fedavg',{});
  const result=aggregateExpert(input);
  const tensors=decode(result.payload).tensors;
  assert.equal(tensors[B].data[0],2.5);
  assert.equal(tensors[A].data[0],1);
  assert.deepEqual(result.metrics.groups,{lan1:2,lan2:18});
  assert.throws(()=>aggregateExpert({...input,updates:[{...input.updates[0],expert:'different'},...input.updates.slice(1)]}),/assignment/);
  assert.throws(()=>aggregateExpert({...input,updates:[input.updates[0],input.updates[0],...input.updates.slice(1)]}),/assignment/);
  assert.throws(()=>aggregateExpert({...input,maxNorm:1}),/norm/);
  assert.throws(()=>aggregateExpert(run('fedprox',{})),/proximal/);
  assert.equal(decode(aggregateExpert(run('fedprox',{mu:0.1})).payload).tensors[B].data[0],2.5);
  const diloco=aggregateExpert(run('diloco',{lr:1,beta1:0.5}));
  assert.equal(decode(diloco.payload).tensors[B].data[0],3.75);
  assert.equal(diloco.state.moments[B][0],-2.5);
  for(const method of ['fedavgm','fedadam','fedyogi'])assert.ok(Number.isFinite(decode(aggregateExpert(run(method,{})).payload).tensors[B].data[0]));
});

test('empty Fusion cache resumes by verified chunk, falls back from a corrupt peer and requires consent',async t=>{
  const [r,root]=registryFor(t);
  const expert=initialized(r);
  const training=Buffer.concat([Buffer.alloc(262144,1),Buffer.alloc(262144,2),Buffer.alloc(1024,3)]);
  const descriptors=[putArtifact(r.cas,'expert',weights(),'fixture-1'),putArtifact(r.cas,'train',training,'CC0 fixture',262144)];
  const env=signAssignment(r,{device:'dev-test',expert,artifacts:descriptors});
  const registry=createGrantStore(r,path.join(root,'grants'));
  registry.grant(env);
  assert.throws(()=>registry.chunk('dev-test','wrong',descriptors[1].parts[0].sha256),{code:'FORBIDDEN_SCOPE'});
  let seen=[],interrupted=true;
  const config={device:'dev-test',publicKey:r.publicKey,consented:true,allowPeerDownload:true,permit:()=>1024**3,
    peers:[async()=>Buffer.from('corrupted')],fetchCoordinator:async(m,p)=>{
      seen.push(p.sha256);
      if(interrupted&&p.sha256===descriptors[1].parts[1].sha256)throw Error('network failed');
      return registry.chunk('dev-test',m.id,p.sha256);
    }};
  const reopen=()=>createProvisionStore({root:path.join(root,'worker'),quotaBytes:256*1024*1024});
  await assert.rejects(reopen().provision(env,{...config,consented:false}),/consent/);
  await assert.rejects(reopen().provision(env,{...config,device:'other'}),/another device/);
  await assert.rejects(reopen().provision(env,config),/network failed/);
  interrupted=false;seen=[];
  const result=await reopen().provision(env,config);
  assert.deepEqual(seen,descriptors[1].parts.slice(1).map(p=>p.sha256));
  assert.deepEqual(result.items.find(a=>a.kind==='train').bytes,training);
  await reopen().provision(env,{...config,permit:()=>0,fetchCoordinator:()=>assert.fail('warm cache contacted coordinator')});
  registry.revoke('dev-test');
  assert.throws(()=>registry.manifest('dev-test'),{code:'NOT_FOUND'});
});

test('registered HTTPS device receives only its current Fusion grant',async t=>{
  const root=rootFor(t),state=path.join(root,'fusion'),r=openFusion(state);
  const service=createCoordinatorService({dir:path.join(root,'coordinator')});
  let client;
  try{
    fs.writeFileSync(path.join(state,'serve-grants'),'1\n');
    const lab=await service.start({bindIp:'127.0.0.1',port:0});
    const {coord}=service;
    const kp=newKeyPair(),device='dev-'+'a'.repeat(32);
    const identity={device_id:device,private_key:kp.privateKey,public_key:kp.publicKey};
    await pairWithCoordinator({pairing:service.createPairing().pairing,identity,alias:'Fusion test'});
    client=createClient({endpoint:lab.endpoint,fingerprint:lab.fingerprint,identity});
    await client.syncTime();
    await assert.rejects(client.get('/v2/fusion/assignment'),{code:'PENDING_APPROVAL'});
    coord.approveDevice(device);
    const e=initialized(r),parts=[putArtifact(r.cas,'expert',weights(),'reference'),putArtifact(r.cas,'train',Buffer.from('public test shard'),'CC0')];
    const grant=signAssignment(r,{device,expert:e,artifacts:parts});
    const store=createGrantStore(r,path.join(state,'grants'));store.grant(grant);
    const manifest=await client.get('/v2/fusion/assignment');
    assert.equal(verifyEnvelope(manifest.envelope,r.publicKey).id,grant.manifest.id);
    const {bytes}=await client.get(`/v2/fusion/parts/${grant.manifest.id}/${parts[1].parts[0].sha256}`,{json:false});
    assert.equal(bytes.toString(),'public test shard');
    await assert.rejects(client.get(`/v2/fusion/parts/${grant.manifest.id}/${digest('f')}`,{json:false}),{code:'FORBIDDEN_SCOPE'});
    store.revoke(device);
    await assert.rejects(client.get('/v2/fusion/assignment'),{code:'NOT_FOUND'});
    fs.rmSync(path.join(state,'serve-grants'));
    await assert.rejects(client.get('/v2/fusion/assignment'),{code:'FORBIDDEN_SCOPE'});
  }finally{client?.close();await service.close();r.close();}
});

test('Fusion sizing and scheduler keep loop depth separate from unique weights and honor resource admission',()=>{
  const architecture={base:{...base,layers:26,width:3072,parameters:3e9},experts:[{kind:'ffn',intermediate:9216,layers:[3]}],kv_width:1024};
  const plain=estimateComposition(architecture),looped=estimateComposition({...architecture,loop:{start:2,end:10,passes:4}});
  assert.equal(plain.parameters,3e9+84934656+3072);
  assert.equal(looped.parameters-plain.parameters,3);
  assert.equal(looped.logical_layers,50);
  const now=1000;
  const d={state:'approved',consent:true,governor:{allowed:true,target_pct:10},last_seen:now,free_ram:1e9,free_vram:1e9,
    free_disk:1e9,remaining_traffic:100,temp_c:45,max_temp_c:80,runtime:'torch-cpu',tokens_per_s:10000,bytes_per_s:10};
  const task={id:'job1',expert:'code',runtimes:['torch-cpu'],ram:20,vram:0,artifacts:[{sha256:digest('d'),bytes:80}],tokens:2000,priority:1};
  const out=scheduleExperts([task,{...task,id:'job2',device:'denied'}],[{...d,id:'slow'},{...d,id:'cached',cache:[digest('d')]},{...d,id:'denied',consent:false}],{now});
  assert.equal(out.assigned[0].device,'cached');
  assert.equal(out.pending[0].task,'job2');
});

test('Fusion dataset manifest enforces group isolation and distributes only approved Train bytes',()=>{
  const row=(id,group)=>({id,group,input_ids:[1,3,4],target_mask:[false,false,true]});
  const input={name:'fixture',revision:'one',license:'CC0-1.0',source:'local synthetic tokens',preprocessing:'deterministic',redistribution:true,
    samples:{train:[row('a','g1')],validation:[row('b','g2')],test:[row('c','g3')]}};
  const tokenizer={context:3,vocab:16};
  const sealed=sealFusionDataset(input,tokenizer);
  assert.equal(validateTrainShard(sealed.manifest,sealed.files.train,sealed.sha256).tokens,1);
  assert.throws(()=>validateTrainShard(sealed.manifest,sealed.files.test,sealed.sha256),{code:'DATASET_INVALID'});
  assert.throws(()=>sealFusionDataset({...input,redistribution:false},tokenizer),{code:'DATASET_INVALID'});
  assert.throws(()=>sealFusionDataset({...input,samples:{...input.samples,test:[row('c','g1')]}},tokenizer),{code:'DATASET_SPLIT_OVERLAP'});
});

test('three freshly paired CPU reference workers fetch their own expert, train and submit durable results',{
  skip:!process.env.KVALAH_COMPUTE_PYTHON,timeout:100000
},async t=>{
  const root=rootFor(t),state=path.join(root,'fusion'),r=openFusion(state);
  const service=createCoordinatorService({dir:path.join(root,'coordinator')});
  const run=promisify(execFile);
  try{
    const python=process.env.KVALAH_COMPUTE_PYTHON;
    await run(python,[path.join(repo,'compute','python','tests','fusion_job_fixture.py'),root],{
      cwd:repo,timeout:30000,env:{...process.env,PYTHONPATH:path.join(repo,'compute','python')}
    });
    const registry=new Map();
    fs.writeFileSync(path.join(state,'serve-grants'),'1\n');
    const lab=await service.start({bindIp:'127.0.0.1',port:0});
    const store=createGrantStore(r,path.join(state,'grants'));
    const backbone=putArtifact(r.cas,'backbone',fs.readFileSync(path.join(root,'backbone.safetensors')),'fixture-379');
    const architecture=putArtifact(r.cas,'architecture',fs.readFileSync(path.join(root,'architecture.json')),'fixture-379');
    const cli=path.join(repo,'compute','fusion','cli.mjs');
    for(const [i,key] of ['code','math','language'].entries()){
      const own=path.join(root,`worker-${key}`);
      const idDir=path.join(own,'identity');
      const identity=await createIdentity(idDir,fileSecretBox);
      await pairWithCoordinator({pairing:service.createPairing().pairing,identity,alias:`Fusion ${key}`});
      service.coord.approveDevice(identity.device_id);
      assert.equal(fs.existsSync(path.join(own,'provision')),false);
      const weights=fs.readFileSync(path.join(root,`${key}.safetensors`));
      const expertConfig=putArtifact(r.cas,'expert-config',fs.readFileSync(path.join(root,`${key}.json`)),'fixture expert config');
      const row=(n)=>({id:`row-${n}`,group:`group-${n}`,input_ids:[i+1,n+4,i+14],target_mask:[false,false,true]});
      const dataset=sealFusionDataset({name:key,revision:'fixture-379',license:'CC0-1.0',source:'local fixture',preprocessing:'fixed ids',redistribution:true,
        samples:{train:[row(0),row(1)],validation:[row(2)],test:[row(3)]}},{context:20,vocab:32});
      const train=putArtifact(r.cas,'train',dataset.files.train,dataset.sha256);
      const weightArt=putArtifact(r.cas,'expert',weights,'initial-379');
      const tensors=Object.entries(decode(weights).tensors).map(([name,value])=>({name,shape:value.shape,dtype:'F32'}));
      const e=r.create({...spec,key,name:key,domain:key,layers:[1],rank:3,alpha:6,tensors,dataset_sha256:dataset.sha256,
        training:{...spec.training,local_steps:3},base:{...base,width:16,layers:2,backbone_sha256:backbone.sha256,architecture_sha256:architecture.sha256}});
      r.change(e.id,'CREATED','PROVISIONING');
      r.checkpoint(e.id,weights);
      const loaded=r.change(e.id,'PROVISIONING','READY');
      const grant=signAssignment(r,{device:identity.device_id,expert:loaded,artifacts:[backbone,architecture,expertConfig,train,weightArt],referenceJob:{tokens:3}});
      store.grant(grant);
      const opts=path.join(own,'run.json');
      fs.writeFileSync(opts,JSON.stringify({python,identityDir:idDir,publicKey:r.publicKey,endpoint:lab.endpoint,fingerprint:lab.fingerprint,consent:true,
        cacheBytes:256*1024*1024,maxTrafficBytes:2*1024*1024,cpu_wall_limit_ms:30000}));
      const execWorker=async()=>JSON.parse((await run(process.execPath,[cli,'worker-train-reference',own,opts],{cwd:repo,timeout:45000})).stdout);
      const result=await execWorker();
      assert.equal(result.receipt.id,grant.manifest.id);
      assert.equal(result.receipt.expert,e.id);
      assert.equal(result.receipt.tokens,3);
      const value=r.cas.get(result.receipt.sha256);
      assert.ok(Object.values(decode(value).tensors).some(t=>t.data.some(v=>v!==0)));
      registry.set(e.id,result.receipt);
      if(i===0){
        const outbox=createOutbox(path.join(own,'fusion-outbox'));
        const prior=outbox.all()[0];
        outbox.update(prior.key,{state:'pending'});
        const retry=await execWorker();
        assert.deepEqual(retry.receipt,result.receipt);
        assert.equal(outbox.all().length,1);
        assert.equal(outbox.all()[0].state,'accepted');
        const round={id:'reference-round-1',algorithm:'fedavg',expert:loaded.id,parent:loaded.checkpoint.hash,schema:loaded.schema_sha256,
          frozen:loaded.checkpoint.frozen};
        const id=result.receipt.id,device=identity.device_id;
        const aggregated=aggregateExpert({expert:loaded,base:weights,round,assignments:[{id,device,tokens:3,group:'loopback'}],updates:[
          {id,device,tokens:3,round:round.id,expert:round.expert,parent:round.parent,frozen:round.frozen,schema:round.schema,
            config:hashJSON({algorithm:round.algorithm,config:{}}),payload:value,payload_sha256:result.receipt.sha256}
        ]});
        r.change(loaded.id,'READY','TRAINING');r.change(loaded.id,'TRAINING','AGGREGATING');
        const committed=r.checkpoint(loaded.id,aggregated.payload,{parent:round.parent});
        assert.equal(committed.version,2);
        assert.equal(committed.checkpoint.frozen,loaded.checkpoint.frozen);
      }
    }
    assert.equal(registry.size,3);
  }finally{await service.close();r.close();}
});

test('Fusion PyTorch gradient, cache, depth and pipeline parity', {skip:!process.env.KVALAH_COMPUTE_PYTHON},()=>{
  const result=spawnSync(process.env.KVALAH_COMPUTE_PYTHON,[path.join(repo,'compute','python','tests','check_fusion.py')],{
    cwd:repo,timeout:85000,encoding:'utf8',env:{...process.env,PYTHONPATH:path.join(repo,'compute','python')}
  });
  assert.equal(result.status,0,result.error?.message??result.stderr);
});
