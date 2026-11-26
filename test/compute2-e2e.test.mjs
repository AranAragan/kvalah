// Kvalah Compute v0.2 — end-to-end over real HTTPS with pinned TLS and signed requests: one coordinator
// service + three independent worker agents, each with its own identity, outbox, governor and Python
// sidecar. Backends: 'mock' (needs numpy + safetensors) and 'torch-cpu-test' on a tiny random model (needs
// torch + transformers). These are logical devices on one machine: they prove the protocol, not hardware.
import {python,skipNoPy,tmp,tinyModel,FIXTURE,jsTokenizer} from './compute-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createCoordinatorService} from '../compute/coordinator/service.mjs';
import {createWorker} from '../compute/worker/worker.mjs';
import {createIdentity,fileSecretBox} from '../compute/worker/identity.mjs';
import {pairWithCoordinator} from '../compute/worker/pair.mjs';
import {createClient} from '../compute/worker/client.mjs';
import {createGovernor} from '../compute/governor/governor.mjs';
import {DEFAULT_POLICY} from '../compute/governor/policy.mjs';
import {startSidecar} from '../compute/worker/sidecar.mjs';
import {parseJSONL,buildDataset} from '../compute/datasets/engine.mjs';
import {verifyReport} from '../compute/report.mjs';
import {decode} from '../compute/protocol/safetensors.mjs';
import {frozenAHash,getProfile} from '../compute/protocol/schema.mjs';
const PROFILE='tiny-test-ffa-r4';
const waitFor=async(fn,ms=60000,step=100)=>{const t=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-t>ms)throw Error('timeout waiting');await new Promise(r=>setTimeout(r,step));}};
async function makeWorker(svc,{name,backend,model_dir='',wrapSidecar,files_digest=null,wrapClient}){
  const dir=tmp('kc-w-'+name+'-'),identity=await createIdentity(path.join(dir,'id'),fileSecretBox);
  const link=await pairWithCoordinator({pairing:svc.createPairing().pairing,identity,alias:name});
  assert.equal(link.device_state,'pending');
  svc.coord.approveDevice(identity.device_id);
  const g=createGovernor({stateDir:dir,policy:{...DEFAULT_POLICY,profile:'full',gpu_target_pct:100,cpu_target_pct:50,only_idle:false,only_ac:false,pause_on_games:false}});
  g.setEnabled(true);g.setSensors({on_battery:false,game:false});
  // Logical devices share the same host. Give their governor a deterministic RAM sample.
  g.setSensors({ram_free_bytes:8*2**30});
  const ram=setInterval(()=>g.setSensors({ram_free_bytes:8*2**30}),5000);ram.unref();
  const states=[];
  const newWorker=()=>createWorker({stateDir:dir,identity,link,governor:g,pauseHoldMs:3000,
    runtime:{python:python(),backend,model_dir,profile_id:PROFILE,variant_id:backend==='mock'?'mock':'cpu-test'},
    capabilities:()=>({backend,preflight_ok:true,runtime_version:'test',variants:[{profile_id:PROFILE,variant_id:backend==='mock'?'mock':'cpu-test',files_digest}]}),
    makeClient:wrapClient?opts=>wrapClient(createClient(opts)):createClient,
    startSidecar:wrapSidecar?o=>wrapSidecar(startSidecar(o)):startSidecar,onState:s=>states.push(s.state+(s.reason?':'+s.reason:''))});
  return {w:newWorker(),newWorker,g,identity,link,states,dir,async stop(){clearInterval(ram);await this.w.stop();}};
}
test('E2E mock: 3 workers × Smoke 2 rounds over HTTPS; manual pause; outbox survives worker restart and coordinator outage',{skip:skipNoPy(),timeout:180000},async()=>{
  const svc=createCoordinatorService({dir:tmp('kc-svc-'),evaluator:()=>({python:python(),backend:'mock'})});
  const info=await svc.start({bindIp:'127.0.0.1',port:0});
  assert.match(info.endpoint,/^https:\/\/127\.0\.0\.1:\d+$/);assert.match(info.fingerprint,/^[0-9A-F:]{95}$/);
  const {rows}=parseJSONL(fs.readFileSync(FIXTURE,'utf8'));
  const ds=await buildDataset({rows,datasetId:'smoke',revision:'1',profileId:PROFILE,maxLength:256,tokenizer:jsTokenizer});
  svc.coord.registerDataset(ds.manifest,ds.shards);
  let outage=null,trained=0;
  const dropped=new Set(),puts=new Map();
  function dropOnce(stage){
    return client=>Object.create(client,{
      post:{value:async (route,...args)=>{
        const result=await client.post(route,...args);
        const target=route==='/v2/updates'?'declare':route.endsWith('/commit')?'commit':null;
        if(stage===target&&!dropped.has(stage)){dropped.add(stage);throw Object.assign(Error('simulated lost reply'),{code:'UNAVAILABLE'});}
        return result;
      }},
      put:{value:async (route,...args)=>{
        const result=await client.put(route,...args);
        if(stage==='put'){
          puts.set(route,(puts.get(route)||0)+1);
          if(!dropped.has(stage)){dropped.add(stage);throw Object.assign(Error('simulated lost reply'),{code:'UNAVAILABLE'});}
        }
        return result;
      }}
    });
  }
  const A=await makeWorker(svc,{name:'a',backend:'mock',wrapClient:dropOnce('declare')});
  const B=await makeWorker(svc,{name:'b',backend:'mock',wrapClient:dropOnce('put')});
  // Worker C: when its first training finishes, the coordinator goes away before the upload.
  const C=await makeWorker(svc,{name:'c',backend:'mock',wrapClient:dropOnce('commit'),wrapSidecar:sc=>({...sc,call(cmd,a){const c=sc.call(cmd,a);if(cmd!=='train')return c;
    trained++;if(outage)return c;
    return {...c,promise:c.promise.then(async r=>{outage=svc.stop();await outage;return r;})};}})});
  // Wrong fingerprint is refused before any request is sent.
  const bad=createClient({endpoint:info.endpoint,fingerprint:'AA:'.repeat(31)+'AA',identity:A.identity});
  await assert.rejects(bad.get('/v2/health/live',{signed:false}),e=>e.code==='UNAUTHORIZED');
  const e=svc.coord.createExperiment({preset:'smoke',name:'e2e-mock',profile_id:PROFILE,variants:['mock'],dataset_id:'smoke@1',local_steps:2});
  svc.coord.startExperiment(e.id);
  for(const x of [A,B,C])x.w.start();
  await waitFor(()=>outage);await outage;
  await waitFor(()=>C.w.state.outbox===1,30000);
  assert.equal(C.w.state.outbox,1,'finished update waits in the durable outbox');
  await C.w.stop();
  C.w=C.newWorker();
  await svc.start({bindIp:'127.0.0.1',port:Number(new URL(info.endpoint).port)});
  C.w.start();
  // Manual pause on A for a while: it must report PAUSED:manual_pause and do no work.
  A.g.setManualPause(true);await waitFor(()=>A.states.includes('PAUSED:manual_pause'),30000);A.g.setManualPause(false);
  await waitFor(()=>svc.coord.status(e.id).state==='COMPLETED',150000,250);
  const st=svc.coord.status(e.id);assert.equal(st.committed_rounds,2);
  await waitFor(()=>C.w.state.outbox===0,20000);
  assert.equal(C.w.state.outbox,0);
  assert.deepEqual([...dropped].sort(),['commit','declare','put']);
  assert.deepEqual([...puts.values()],[1,1],'an uploaded payload is not transmitted again after its reply is lost');
  assert.equal(trained,2,'worker restarted from the saved update without training it again');
  const rounds=svc.coord.rounds(e.id);for(const r of rounds.filter(x=>x.state==='COMMITTED'))assert.equal(new Set(r.accepted.map(a=>a.device_id)).size,3);
  assert.equal(frozenAHash(decode(svc.coord.checkpoint(svc.coord.latestCheckpoint(e.id).hash)).tensors),st.frozen_a_hash);
  for(const x of [A,B,C])await x.stop();
  // Revocation: a revoked device's next request is refused.
  svc.coord.revokeDevice(A.identity.device_id);
  const cl=createClient({endpoint:A.link.endpoint,fingerprint:A.link.fingerprint,identity:A.identity});
  await assert.rejects(cl.post('/v2/devices/session',{}),err=>err.code==='REVOKED'&&err.status===403);
  // Replay of a signed request is refused (nonce table).
  await svc.close();
});
test('E2E torch-cpu-test: tiny model, central tokenization, 3 workers, trusted evaluation, PEFT export, verify-report',{skip:skipNoPy(['torch','transformers','tokenizers','safetensors']),timeout:600000},async()=>{
  const model=tinyModel(),py=python(['torch','transformers']);
  const rt={python:py,backend:'torch-cpu-test',model_dir:model,variant_id:'cpu-test'};
  const svc=createCoordinatorService({dir:tmp('kc-svc-'),evaluator:()=>rt});
  await svc.start({bindIp:'127.0.0.1',port:0});
  const verified=await svc.verifyModel({python:py,model_dir:model});
  assert.match(verified.files_digest,/^[0-9a-f]{64}$/);
  await svc.registerModel({profile_id:PROFILE,variant_id:'cpu-test',model:verified});
  const imp=await svc.importDataset({fixture:true,dataset_id:'smoke-tiny',revision:'1',profile_id:PROFILE,max_length:256,runtime:rt});
  assert.equal(imp.manifest.status,'SMOKE_ONLY');assert.equal(imp.manifest.synthetic,true);assert.ok(imp.manifest.split_counts.train>0&&imp.manifest.split_counts.validation>0);
  const ws=[];for(const n of ['msi','rog','mac'])ws.push(await makeWorker(svc,{name:n,backend:'torch-cpu-test',model_dir:model,files_digest:verified.files_digest}));
  const e=svc.coord.createExperiment({preset:'smoke',name:'e2e-tiny',profile_id:PROFILE,variants:['cpu-test'],dataset_id:imp.id,local_steps:2,optimizer:{name:'adamw',lr:1e-3}});
  svc.coord.startExperiment(e.id);
  for(const x of ws)x.w.start();
  const evs=[];svc.coord.onEvent(ev=>evs.push(ev.code));
  await waitFor(()=>svc.coord.status(e.id).state==='COMPLETED',300000,500).catch(err=>{throw Error(err.message+' events='+evs.slice(-30).join(',')+' states='+ws.map(x=>x.states.slice(-5).join('>')).join(' | '));});
  for(const x of ws)await x.stop();
  const st=await waitFor(()=>{const s=svc.coord.status(e.id);return s.eval?.rounds?.[2]&&s.eval?.rounds?.[0]?s:null;},120000,500);
  assert.equal(st.eval.rounds[0].status,'DONE');assert.ok(Number.isFinite(st.eval.rounds[0].nll)&&Number.isFinite(st.eval.rounds[2].nll));
  assert.ok(st.eval.gate&&typeof st.eval.gate.passed==='boolean','gate computed (pass or fail is a measurement, not asserted)');
  for(const x of ws)assert.ok(x.w.state.metrics.tasks_accepted>=2&&x.w.state.metrics.optimizer_steps>=4);
  // PEFT export of the final checkpoint and a reload check through the sidecar.
  const d=tmp('kc-peft-');const ck=svc.coord.latestCheckpoint(e.id);fs.writeFileSync(path.join(d,'final.safetensors'),svc.coord.checkpoint(ck.hash));
  const sc=startSidecar({python:py,threads:2});
  const peft=await sc.call('export_peft',{adapter_path:path.join(d,'final.safetensors'),out_dir:path.join(d,'peft'),profile:getProfile(PROFILE),meta:{base_model:model}}).promise;
  await sc.stop();
  assert.ok(fs.existsSync(path.join(d,'peft','adapter_model.safetensors'))&&fs.existsSync(path.join(d,'peft','adapter_config.json')),JSON.stringify(peft));
  const rep=svc.exportReport({experiment_id:e.id,out:path.join(d,'report.zip'),include_weights:true});
  const v=verifyReport(rep.path);assert.equal(v.ok,true,JSON.stringify(v.problems));
  await svc.close();
});
