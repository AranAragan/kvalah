// Kvalah Compute v0.2 — coordinator state machine (spec N01–N10, D01–D04 parts). No network, no Python:
// a deterministic JS word tokenizer stands in for the model tokenizer so the protocol is tested in isolation.
import {tmp,FIXTURE,jsTokenizer} from './compute-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {createCoordinator} from '../compute/coordinator/coordinator.mjs';
import {parseJSONL,buildDataset,prepareRows,piiFlags} from '../compute/datasets/engine.mjs';
import {newKeyPair,signBytes} from '../compute/protocol/sign.mjs';
import {decode,encode} from '../compute/protocol/safetensors.mjs';
import {onlyB,getProfile,frozenAHash} from '../compute/protocol/schema.mjs';
import {sha256,canonicalJSON} from '../compute/protocol/hash.mjs';
import {exportReport,verifyReport} from '../compute/report.mjs';

const T=getProfile('tiny-test-ffa-r4');
function clock(){let t=Date.UTC(2026,10,26,9,0,0);const f=()=>t;f.add=ms=>{t+=ms;};return f;}
async function setup({rows=null,evaluate=null}={}){
  const dir=tmp('kc-coord-'),now=clock();
  const c=createCoordinator({dir,now,evaluate});
  const {rows:parsed}=parseJSONL(fs.readFileSync(FIXTURE,'utf8'));
  const ds=await buildDataset({rows:rows||parsed,datasetId:'smoke',revision:'1',profileId:T.id,maxLength:256,tokenizer:jsTokenizer});
  c.registerDataset(ds.manifest,ds.shards);
  c.registerVariant({profile_id:T.id,variant_id:'mock',files_digest:null,provenance:'unverified'});
  return {c,dir,now,ds};
}
function enroll(c,alias='dev'){
  const kp=newKeyPair(),device_id='dev-'+createHash('sha256').update(kp.publicKey).digest('hex').slice(0,32);
  const {code}=c.createPairing();const st=c.pairStart();
  const code_mac=createHmac('sha256',createHash('sha256').update(code.replace(/[^A-Z0-9]/g,'')).digest()).update(st.challenge+'|'+kp.publicKey).digest('base64');
  const signature=signBytes(kp.privateKey,Buffer.from(['KC2-PAIR',st.challenge,code_mac,kp.publicKey,device_id].join('\n')));
  c.pairComplete({challenge:st.challenge,device_id,public_key:kp.publicKey,alias,code_mac,signature});
  c.approveDevice(device_id);
  const s=c.startSession(device_id);
  return {id:device_id,kp,session:s.session_id,caps:{backend:'mock',preflight_ok:true,variants:[{profile_id:T.id,variant_id:'mock'}]}};
}
const claim=(c,d)=>c.claim(d.id,{session_id:d.session,capabilities:d.caps});
function makeUpdate(c,task,scale=1){
  const base=decode(c.checkpoint(task.base_adapter_hash)).tensors,b=onlyB(base);
  const t=Object.fromEntries(Object.entries(b).map(([k,v])=>[k,{shape:v.shape,data:v.data.map((x,i)=>x+scale*1e-3*((i%7)-3))}]));
  return encode(t);
}
function submit(c,d,task,{bytes=makeUpdate(c,task),tokens=task.expected_supervised_tokens,steps=task.local_steps,key}={}){
  const meta={task_id:task.task_id,lease_id:task.lease_id,session_id:d.session,idempotency_key:key||sha256('k|'+task.task_id+'|'+sha256(bytes)),payload_sha256:sha256(bytes),bytes:bytes.length,update_kind:'absolute_b',
    experiment_id:task.experiment_id,run_id:task.run_id,round:task.round,base_adapter_hash:task.base_adapter_hash,schema_hash:task.schema_hash,config_hash:task.config_hash,dataset_shard_hash:task.dataset_shard_hash,model_variant_id:task.model_variant_id,
    steps,supervised_tokens:tokens};
  const st=c.declareUpdate(d.id,meta);
  if(st.state==='declared')c.putContent(d.id,st.update_id,bytes);
  return c.commitUpdate(d.id,st.update_id,{session_id:d.session});
}
const cfg=(o={})=>({preset:'smoke',name:'t',profile_id:T.id,variants:['mock'],dataset_id:'smoke@1',local_steps:2,rounds:2,...o});

test('T12: distinct runs can reference the same initial and committed checkpoint bytes',async()=>{
  const {c}=await setup(),device=enroll(c);
  try{
    const runs=['First','Second'].map(name=>c.createExperiment(cfg({name,rounds:1,quorum:{mode:'all',target:1}})));
    const checkpoints=[];
    for(const run of runs){
      c.startExperiment(run.id);
      assert.equal(c.latestCheckpoint(run.id).round_idx,0);
      submit(c,device,claim(c,device).task);
      const checkpoint=c.latestCheckpoint(run.id);
      assert.equal(checkpoint.round_idx,1);
      checkpoints.push(checkpoint.hash);
    }
    assert.equal(checkpoints[0],checkpoints[1]);
  }finally{c.close();}
});

test('T16/T23: registry edits do not change an existing run and the event tail keeps the newest entries',async()=>{
  const {c,now}=await setup(),device=enroll(c);
  const digest='1'.repeat(64);
  try{
    c.registerVariant({profile_id:T.id,variant_id:'mock',files_digest:digest});
    const experiment=c.createExperiment(cfg());
    c.registerVariant({profile_id:T.id,variant_id:'mock',files_digest:'2'.repeat(64)});
    c.startExperiment(experiment.id);
    assert.equal(claim(c,device).task,null);
    device.caps.variants[0].files_digest=digest;
    assert.equal(claim(c,device).task.model_files_digest,digest);
    const event=c.db.prepare("insert into events(ts,severity,code) values(?,'info',?)");
    c.db.exec('begin');
    for(let i=0;i<1010;i++)event.run(now(),'test.'+i);
    c.db.exec('commit');
    assert.equal(c.latestEvents(5).at(-1).code,'test.1009');
    assert.equal(c.events(0,5).some(e=>e.code==='test.1009'),false);
  }finally{c.close();}
});

test('D01–D04 dataset engine: validation, exact dedup, PII/secret filters, licence, group-aware split, masks',async()=>{
  const {rows,rejected}=parseJSONL(fs.readFileSync(FIXTURE,'utf8')+'\n{"id":"x"}\nnot json\n');
  assert.equal(rows.length,34);assert.deepEqual(rejected.map(r=>r.reason).sort(),['bad_messages','invalid_json']);
  const extra=[
    {id:'pii1',license:'CC0-1.0',messages:[{role:'user',content:'mail me at john.doe@example.com'},{role:'assistant',content:'ok'}]},
    {id:'sec1',license:'CC0-1.0',messages:[{role:'user',content:'key ghp_abcdefghijklmnopqrstuvwxyz0123456789'},{role:'assistant',content:'ok'}]},
    {id:'lic1',license:'Proprietary',messages:[{role:'user',content:'hello there'},{role:'assistant',content:'general kenobi'}]},
    {id:'nolic',messages:[{role:'user',content:'hello'},{role:'assistant',content:'hi'}]},
    {id:'g1',license:'CC0-1.0',group_id:'G',messages:[{role:'user',content:'group question one alpha'},{role:'assistant',content:'answer one'}]},
    {id:'g2',license:'CC0-1.0',group_id:'G',messages:[{role:'user',content:'group question two beta'},{role:'assistant',content:'answer two'}]}];
  const prep=prepareRows([...rows,...extra],{seed:1});
  const reason=id=>prep.excluded.find(e=>e.id===id)?.reason||'';
  assert.match(reason('pii1'),/pii_or_secret:email/);assert.match(reason('sec1'),/pii_or_secret/);
  assert.equal(reason('lic1'),'license_not_allowed');assert.equal(reason('nolic'),'license_missing');
  assert.ok(prep.excluded.some(e=>/exact_duplicate/.test(e.reason)),'fixture contains one exact duplicate on purpose');
  const where=id=>Object.entries(prep.splits).find(([,l])=>l.some(r=>r.id===id))?.[0];
  assert.equal(where('g1'),where('g2'),'rows of one group never straddle splits');
  assert.deepEqual(piiFlags('card 4111 1111 1111 1111'),['card']);assert.deepEqual(piiFlags('order 1234 5678 9012 3456'),[]);
  const a=await buildDataset({rows,datasetId:'smoke',revision:'1',profileId:T.id,maxLength:256,tokenizer:jsTokenizer});
  const b=await buildDataset({rows,datasetId:'smoke',revision:'1',profileId:T.id,maxLength:256,tokenizer:jsTokenizer});
  assert.deepEqual(a.manifest,b.manifest,'deterministic');
  assert.equal(a.manifest.status,'SMOKE_ONLY');assert.equal(a.manifest.synthetic,true);
  const total=Object.values(a.manifest.split_counts).reduce((x,y)=>x+y,0);assert.equal(total,33);
  const bad=await buildDataset({rows,datasetId:'smoke',revision:'1',profileId:T.id,maxLength:256,tokenizer:async(r,m)=>{const t=await jsTokenizer(r,m);t.rows[0].target_mask[0]=1;return t;}});
  assert.ok((bad.manifest.excluded_by_reason.mask_invalid||0)>=1,'mask with target at position 0 is excluded');
});

test('dialogue group links are transitive across removed duplicates, and registration rejects a forged split',async()=>{
  const row=(id,group_id,content)=>({id,group_id,license:'CC0-1.0',messages:[{role:'user',content},{role:'assistant',content:'answer'}]});
  const rows=[row('a','a','algebra diagonal matrix'),row('b','b','historic sailing knots'),row('c','c','mineral crystal structure'),
    row('ab','b','algebra diagonal matrix'),row('bc','c','historic sailing knots')];
  const prep=prepareRows(rows,{seed:17,ratios:{test:0.2,validation:0.3}});
  assert.equal(prep.stats.exact_duplicates,2);
  assert.deepEqual(Object.values(prep.splits).filter(x=>x.length).map(x=>x.map(r=>r.id)),[['a','b','c']]);
  assert.equal(new Set(Object.values(prep.splits).flat().map(r=>r._group)).size,1);
  const {c,ds}=await setup();
  try{
    const manifest=structuredClone(ds.manifest),shards={...ds.shards};
    const train=JSON.parse(shards[manifest.shards.train[0].sha256]);
    const test=JSON.parse(shards[manifest.shards.test[0].sha256]);
    test.rows[0].group_digest=train.rows[0].group_digest;
    const altered=Buffer.from(canonicalJSON(test)),hash=sha256(altered);
    shards[hash]=altered;manifest.shards.test[0].sha256=hash;
    assert.throws(()=>c.registerDataset(manifest,shards),{code:'DATASET_SPLIT_OVERLAP'});
  }finally{c.close();}
});

test('Test evaluation uses the final committed checkpoint, stays separate from Validation, and retries after a policy pause',async()=>{
  let blocked=true,tests=0;
  const {c,ds}=await setup({evaluate:async ({split,hash,round,checkpoint})=>{
    assert.equal(sha256(checkpoint),hash);
    if(split==='test'){tests++;return blocked?{status:'NOT RUN',reason:'governor paused evaluation'}:{status:'DONE',nll:0.25};}
    assert.equal(split,'validation');
    return {status:'DONE',nll:round===0?2:2.1};
  }});
  try{
    const device=enroll(c),e=c.createExperiment(cfg({rounds:1,quorum:{mode:'all',target:1}}));
    assert.throws(()=>c.evaluateTest(e.id),{code:'INVALID_TRANSITION'});
    c.startExperiment(e.id);
    const task=claim(c,device).task;
    for(const s of ds.manifest.shards.test)assert.throws(()=>c.artifactFor(device.id,s.sha256),{code:'FORBIDDEN_SCOPE'});
    submit(c,device,task);
    const held=c.evaluateTest(e.id);
    assert.equal(c.evaluateTest(e.id),held,'concurrent local requests share one evaluator job');
    assert.equal((await held).status,'NOT RUN');
    blocked=false;
    const result=await c.evaluateTest(e.id);
    assert.equal(result.split,'test');assert.equal(result.round,1);
    assert.equal(result.checkpoint,c.latestCheckpoint(e.id).hash);
    assert.equal(result.test_groups_sha256,ds.manifest.group_audit.fingerprints.test);
    assert.equal((await c.evaluateTest(e.id)).nll,0.25);
    assert.equal(tests,2,'a successful final Test result is reused');
    const ev=c.status(e.id).eval;
    assert.equal(ev.gate.passed,false,'an improved Test NLL cannot pass the Validation gate');
    assert.equal(ev.rounds[1].nll,2.1);assert.equal(ev.test.nll,0.25);
  }finally{c.close();}
});

test('continuation restores the committed global adapter, frozen A, and next scheduled rows',async()=>{
  const {c,dir}=await setup(),d=enroll(c);
  const base=cfg({rounds:2,seed:21,quorum:{mode:'all',target:1},eval:{initial:false,final:false}});
  try{
    const parent=c.createExperiment(base);
    const started=c.startExperiment(parent.id);
    const first=claim(c,d).task;
    submit(c,d,first);
    const saved=c.status(parent.id).checkpoint,next=claim(c,d).task;
    c.cancelExperiment(parent.id);
    const initial_checkpoint={experiment_id:parent.id,sha256:saved.sha256},input={...base,rounds:1,initial_checkpoint};
    assert.throws(()=>c.dryRun({...input,seed:base.seed+1}),{code:'CHECKPOINT_INCOMPATIBLE'});
    assert.throws(()=>c.dryRun({...input,initial_checkpoint:{...initial_checkpoint,sha256:started.initial_hash}}),{code:'CHECKPOINT_INCOMPATIBLE'});
    c.registerVariant({profile_id:T.id,variant_id:'mock',files_digest:'9'.repeat(64)});
    assert.throws(()=>c.dryRun(input),{code:'CHECKPOINT_INCOMPATIBLE'});
    c.registerVariant({profile_id:T.id,variant_id:'mock',files_digest:null});
    const resumed=c.createExperiment({...input,initial_checkpoint:{...initial_checkpoint,row_offset:0}});
    assert.equal(resumed.initial_adapter_sha256,saved.sha256);
    assert.equal(resumed.config.initial_checkpoint.row_offset,base.local_steps);
    assert.equal(c.startExperiment(resumed.id).frozen_a_hash,started.frozen_a_hash);
    assert.equal(c.latestCheckpoint(resumed.id).hash,saved.sha256);
    const task=claim(c,d).task;
    assert.equal(task.base_adapter_hash,saved.sha256);
    assert.deepEqual(task.row_ids,next.row_ids);
    submit(c,d,task);
    assert.equal(c.status(resumed.id).state,'COMPLETED');
    assert.equal(c.status(parent.id).state,'CANCELLED');
    const chain=c.dryRun({...input,initial_checkpoint:{experiment_id:resumed.id,sha256:c.latestCheckpoint(resumed.id).hash}});
    assert.equal(chain.config.initial_checkpoint.row_offset,2*base.local_steps);
    const out=path.join(dir,'continued.zip');
    exportReport(c,{experiment_id:resumed.id,out,include_weights:true});
    assert.equal(verifyReport(out).ok,true);
  }finally{c.close();}
});
test('N01 duplicate alias: two installations stay distinct devices; re-pair with a different key is a conflict',async()=>{
  const {c}=await setup();const a=enroll(c,'Laptop'),b=enroll(c,'Laptop');
  const list=c.listDevices();assert.equal(list.length,2);assert.notEqual(a.id,b.id);assert.ok(list.every(d=>d.duplicate_alias));
  const {code}=c.createPairing();const st=c.pairStart(),kp=newKeyPair();
  const code_mac=createHmac('sha256',createHash('sha256').update(code.replace(/[^A-Z0-9]/g,'')).digest()).update(st.challenge+'|'+kp.publicKey).digest('base64');
  assert.throws(()=>c.pairComplete({challenge:st.challenge,device_id:a.id,public_key:kp.publicKey,alias:'x',code_mac,signature:signBytes(kp.privateKey,Buffer.from(['KC2-PAIR',st.challenge,code_mac,kp.publicKey,a.id].join('\n')))}),e=>e.code==='CONFLICT');
});
test('pairing: wrong code counts attempts and burns the code after 5; codes expire after 10 min; pending cannot claim',async()=>{
  const {c,now}=await setup();
  c.createPairing();const kp=newKeyPair(),id='dev-'+'a'.repeat(32);
  for(let i=0;i<5;i++){const st=c.pairStart();const mac=createHmac('sha256',Buffer.alloc(32)).update(st.challenge).digest('base64');
    assert.throws(()=>c.pairComplete({challenge:st.challenge,device_id:id,public_key:kp.publicKey,alias:'x',code_mac:mac,signature:signBytes(kp.privateKey,Buffer.from(['KC2-PAIR',st.challenge,mac,kp.publicKey,id].join('\n')))}),e=>e.code==='UNAUTHORIZED'||e.code==='PAIRING_EXPIRED');}
  const st=c.pairStart();assert.throws(()=>c.pairComplete({challenge:st.challenge,device_id:id,public_key:kp.publicKey,alias:'x',code_mac:'x',signature:signBytes(kp.privateKey,Buffer.from(['KC2-PAIR',st.challenge,'x',kp.publicKey,id].join('\n')))}),e=>e.code==='PAIRING_EXPIRED');
  const {code}=c.createPairing();now.add(11*60e3);const st2=c.pairStart();
  const mac=createHmac('sha256',createHash('sha256').update(code.replace(/-/g,'')).digest()).update(st2.challenge+'|'+kp.publicKey).digest('base64');
  assert.throws(()=>c.pairComplete({challenge:st2.challenge,device_id:id,public_key:kp.publicKey,alias:'x',code_mac:mac,signature:signBytes(kp.privateKey,Buffer.from(['KC2-PAIR',st2.challenge,mac,kp.publicKey,id].join('\n')))}),e=>e.code==='PAIRING_EXPIRED');
  assert.throws(()=>c.authDevice(id),e=>e.code==='UNAUTHORIZED');
});
test('N02 worker A cannot touch worker B task (403, no mutation); artifacts are scoped',async()=>{
  const {c}=await setup();const A=enroll(c,'a'),B=enroll(c,'b');enroll(c,'c');
  const e=c.createExperiment(cfg());c.startExperiment(e.id);
  const tb=claim(c,B).task;assert.ok(tb);
  const before=JSON.stringify(c.status(e.id).round.slots);
  for(const fn of [()=>c.renew(A.id,tb.task_id,{lease_id:tb.lease_id,session_id:A.session}),()=>c.abandon(A.id,tb.task_id,{lease_id:tb.lease_id,session_id:A.session}),
    ()=>c.progress(A.id,tb.task_id,{lease_id:tb.lease_id,session_id:A.session,step:1}),()=>submit(c,A,tb)])assert.throws(fn,err=>err.code==='NOT_OWNER'&&err.status===403);
  assert.equal(JSON.stringify(c.status(e.id).round.slots),before);
  assert.throws(()=>c.artifactFor(A.id,tb.dataset_shard_hash),err=>err.code==='FORBIDDEN_SCOPE');
  assert.ok(c.artifactFor(B.id,tb.dataset_shard_hash).length>0);
  const vshard=c.datasetManifest('smoke@1').shards.validation[0].sha256;assert.throws(()=>c.artifactFor(B.id,vshard),err=>err.code==='FORBIDDEN_SCOPE');
});
test('N03/N04 replay returns the stored ack; same key with other payload and stale lease are rejected',async()=>{
  const {c}=await setup();const A=enroll(c,'a');enroll(c,'b');enroll(c,'c');
  const e=c.createExperiment(cfg());c.startExperiment(e.id);
  const t=claim(c,A).task,bytes=makeUpdate(c,t),key=sha256('fixed'+t.task_id);
  const r1=submit(c,A,t,{bytes,key});assert.equal(r1.state,'accepted');
  const r2=submit(c,A,t,{bytes,key});assert.equal(r2.state,'accepted');assert.equal(r2.update_id,r1.update_id);
  assert.throws(()=>submit(c,A,t,{bytes:makeUpdate(c,t,2),key}),err=>err.code==='DUPLICATE_DIFFERENT'&&err.status===409);
  assert.throws(()=>submit(c,A,t,{bytes:makeUpdate(c,t,3)}),err=>err.code==='DUPLICATE_DIFFERENT');
  assert.equal(c.status(e.id).round.accepted,1,'no double counting');
  assert.throws(()=>c.renew(A.id,t.task_id,{lease_id:'lease-wrong',session_id:A.session}),err=>err.code==='STALE');
});
test('worker-reported token count or step count that disagrees with the assignment is rejected',async()=>{
  const {c}=await setup();const A=enroll(c,'a');enroll(c,'b');enroll(c,'c');
  const e=c.createExperiment(cfg());c.startExperiment(e.id);const t=claim(c,A).task;
  assert.throws(()=>submit(c,A,t,{tokens:t.expected_supervised_tokens+1}),err=>err.code==='TOKEN_MISMATCH');
  const again=c.claim(A.id,{session_id:A.session,capabilities:A.caps});assert.equal(again.task.task_id,t.task_id,'the device keeps its own lease (no second slot) and may resubmit a correct result');
  assert.equal(c.status(e.id).round.accepted,0);
  assert.equal(submit(c,A,t).state,'rejected','same idempotency key returns the stored rejection');
  assert.equal(submit(c,A,t,{key:sha256('retry'+t.task_id)}).state,'accepted');
});
test('N05 concurrent final uploads: exactly one aggregation and one checkpoint per round',async()=>{
  const {c}=await setup();const ds=[enroll(c,'a'),enroll(c,'b'),enroll(c,'c')];
  const e=c.createExperiment(cfg());c.startExperiment(e.id);
  const tasks=ds.map(d=>claim(c,d).task);
  await Promise.all(tasks.map((t,i)=>Promise.resolve().then(()=>submit(c,ds[i],t))));
  const rs=c.rounds(e.id);assert.equal(rs.filter(r=>r.idx===0&&r.state==='COMMITTED').length,1);
  assert.equal(c.db.prepare('select count(*) n from checkpoints where experiment_id=? and round_idx=1').get(e.id).n,1);
  assert.equal(c.status(e.id).round.idx,1);
});
test('N06 fault-tolerant quorum: 2 of 3 commit at the deadline; the third update is quarantined as late',async()=>{
  const {c,now}=await setup();const ds=[enroll(c,'a'),enroll(c,'b'),enroll(c,'c')];
  const e=c.createExperiment(cfg({preset:'pilot',rounds:2,quorum:{mode:'fault_tolerant',min:2,target:3}}));c.startExperiment(e.id);
  const tasks=ds.map(d=>claim(c,d).task);submit(c,ds[0],tasks[0]);submit(c,ds[1],tasks[1]);
  now.add(601e3);c.tick();
  const r0=c.rounds(e.id).find(r=>r.idx===0);assert.equal(r0.state,'COMMITTED');assert.equal(r0.accepted.length,2);assert.equal(r0.excluded.length,1);
  assert.throws(()=>submit(c,ds[2],tasks[2]),err=>['LEASE_EXPIRED','STALE'].includes(err.code));
  const late=c.db.prepare('select state from updates where task_id=?').get(tasks[2].task_id);assert.equal(late.state,'quarantined');
  assert.equal(c.status(e.id).round.idx,1);
});
test('N07 below quorum at the deadline → BLOCKED with blocker; retry is a new attempt from the same parent',async()=>{
  const {c,now}=await setup();const ds=[enroll(c,'a'),enroll(c,'b'),enroll(c,'c')];
  const e=c.createExperiment(cfg({preset:'pilot',rounds:2,quorum:{mode:'fault_tolerant',min:2,target:3}}));const st=c.startExperiment(e.id);
  const t=claim(c,ds[0]).task;submit(c,ds[0],t);
  now.add(601e3);c.tick();
  const s=c.status(e.id);assert.equal(s.state,'BLOCKED');assert.equal(s.blocker.reason,'below_quorum_at_deadline');assert.equal(s.blocker.accepted,1);
  assert.equal(c.db.prepare('select count(*) n from checkpoints where experiment_id=?').get(e.id).n,1,'nothing partial committed');
  const r=c.resumeExperiment(e.id);assert.equal(r.state,'RUNNING');assert.equal(r.round.idx,0);assert.equal(r.round.attempt,2);assert.equal(r.round.parent_hash,st.initial_hash);
  const ts=ds.map(d=>claim(c,d).task);assert.ok(ts.every(Boolean));ts.forEach((x,i)=>submit(c,ds[i],x));
  assert.equal(c.rounds(e.id).find(x=>x.idx===0&&x.attempt===2).state,'COMMITTED');
});
test('N08 lease expiry reopens the slot for an eligible device; revoked device loses its lease',async()=>{
  const {c,now}=await setup();const ds=[enroll(c,'a'),enroll(c,'b'),enroll(c,'c'),enroll(c,'d')];
  const e=c.createExperiment(cfg());c.startExperiment(e.id);
  const t0=claim(c,ds[0]).task;claim(c,ds[1]);claim(c,ds[2]);
  assert.equal(claim(c,ds[3]).task,null);
  now.add(121e3);c.tick();
  const t3=claim(c,ds[3]).task;assert.ok(t3,'expired slot handed to the spare device');assert.notEqual(t3.task_id,t0.task_id);
  c.revokeDevice(ds[3].id);assert.throws(()=>submit(c,ds[3],t3),err=>err.code==='REVOKED');
  assert.throws(()=>claim(c,ds[3]),err=>err.code==='REVOKED');
});
test('N09 coordinator crash between seal and commit recovers deterministically on restart',async()=>{
  const {c,dir,now}=await setup();const ds=[enroll(c,'a'),enroll(c,'b'),enroll(c,'c')];
  const e=c.createExperiment(cfg());c.startExperiment(e.id);
  const ts=ds.map(d=>claim(c,d).task);ts.forEach((t,i)=>submit(c,ds[i],t,{bytes:makeUpdate(c,t,i+1)}));
  const H=c.rounds(e.id).find(r=>r.idx===0).checkpoint_hash;assert.ok(H);
  // Rewind the durable state to "sealed, not yet aggregated" (what a crash inside aggregation leaves behind).
  c.db.exec(`delete from checkpoints where experiment_id='${e.id}' and round_idx=1;
    delete from tasks where assignment_id in (select id from assignments where experiment_id='${e.id}' and round_idx=1);
    delete from assignments where experiment_id='${e.id}' and round_idx=1; delete from rounds where experiment_id='${e.id}' and idx=1;
    update rounds set state='SEALING',checkpoint_hash=null,committed_at=null where experiment_id='${e.id}' and idx=0;
    update experiments set current_round=0 where id='${e.id}';`);
  c.close();
  const c2=createCoordinator({dir,now});
  const r=c2.rounds(e.id).find(x=>x.idx===0);
  assert.equal(r.state,'COMMITTED','recover() finished the sealed round');assert.equal(r.checkpoint_hash,H,'bit-identical result after recovery');
  assert.equal(c2.status(e.id).round.idx,1);
  assert.ok(c2.events(0,1000).some(x=>x.code==='recovery.aggregate'));
  c2.close();
  // A corrupt CAS object is detected on boot.
  const f=path.join(dir,'cas',H.slice(0,2),H);if(fs.existsSync(f)){fs.writeFileSync(f,'junk');const c3=createCoordinator({dir,now});assert.ok(c3.events(0,1000).some(x=>x.code==='recovery.corruption'));c3.close();}
});
test('N10 cancel never promotes an unfinished round; finish-after-round completes cleanly',async()=>{
  const {c}=await setup();const ds=[enroll(c,'a'),enroll(c,'b'),enroll(c,'c')];
  const e=c.createExperiment(cfg());c.startExperiment(e.id);
  const ts=ds.map(d=>claim(c,d).task);submit(c,ds[0],ts[0]);
  c.cancelExperiment(e.id);
  assert.equal(c.status(e.id).state,'CANCELLED');assert.equal(c.db.prepare('select count(*) n from checkpoints where experiment_id=?').get(e.id).n,1);
  assert.throws(()=>submit(c,ds[1],ts[1]),err=>['STALE','LEASE_EXPIRED'].includes(err.code));
  const e2=c.createExperiment(cfg({rounds:3}));c.startExperiment(e2.id);c.finishAfterRound(e2.id);
  const t2=ds.map(d=>claim(c,d).task);t2.forEach((t,i)=>submit(c,ds[i],t));
  assert.equal(c.status(e2.id).state,'COMPLETED');assert.equal(c.status(e2.id).committed_rounds,1);
});
test('full Smoke run (3 workers × 2 rounds) + report export and independent verify-report',async()=>{
  const {c,dir}=await setup();const ds=[enroll(c,'a'),enroll(c,'b'),enroll(c,'c')];
  const e=c.createExperiment(cfg());const st=c.startExperiment(e.id);
  for(let r=0;r<2;r++){const ts=ds.map(d=>claim(c,d).task);assert.ok(ts.every(t=>t&&t.round===r));ts.forEach((t,i)=>submit(c,ds[i],t,{bytes:makeUpdate(c,t,i+1)}));}
  const s=c.status(e.id);assert.equal(s.state,'COMPLETED');assert.equal(s.committed_rounds,2);
  const last=c.latestCheckpoint(e.id);assert.equal(frozenAHash(decode(c.checkpoint(last.hash)).tensors),st.frozen_a_hash);
  const out=path.join(dir,'report.zip');exportReport(c,{experiment_id:e.id,out,include_weights:true});
  const v=verifyReport(out);assert.equal(v.ok,true,JSON.stringify(v.problems));assert.equal(v.committed_rounds,2);
  assert.ok(v.checks.find(x=>x.check==='aggregation recomputed bitwise').ok);
  // Tamper: flip one byte of a checkpoint inside the archive → verification fails.
  const z=fs.readFileSync(out);const i=z.indexOf(Buffer.from('weights/'+last.hash));const t=Buffer.from(z);t[i+200]^=1;fs.writeFileSync(out+'.bad',t);
  assert.throws(()=>verifyReport(out+'.bad'));
  const rep=JSON.parse(fs.readFileSync(out).toString('latin1').includes('device-1')?'true':'false');assert.equal(rep,true,'aliases replaced by labels');
});
