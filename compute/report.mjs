// Experiment report archive (spec §7.3 / §14): redacted manifest, config, model/dataset manifests, rounds,
// accepted/excluded updates, evaluations, events and a SHA-256 list of every file. With weights included,
// verifyReport() independently recomputes every committed round's FedAvg from parent + accepted updates
// and checks the frozen A and the lineage.
import fs from 'node:fs';
import {writeZip,readZip} from './zip.mjs';
import {sha256,canonicalJSON} from './protocol/hash.mjs';
import {decode,encode} from './protocol/safetensors.mjs';
import {fedavg} from './protocol/aggregate.mjs';
import {getProfile,frozenAHash,verifyTensors} from './protocol/schema.mjs';
const REDACT=/(secret|token|password|private|key_material|endpoint)/i;
const redact=v=>JSON.parse(JSON.stringify(v,(k,x)=>REDACT.test(k)&&typeof x==='string'?'[redacted]':x));
export function exportReport(coord,{experiment_id,out,include_weights=false,include_aliases=false,app_version=null}){
  const st=coord.status(experiment_id),rounds=coord.rounds(experiment_id);
  const devices=coord.listDevices(),label=new Map();
  devices.forEach((d,i)=>label.set(d.id,include_aliases?d.alias:`device-${i+1}`));
  const ds=coord.datasetManifest(st.config.dataset_id);
  const entries=[];const add=(name,obj)=>entries.push([name,Buffer.isBuffer(obj)?obj:Buffer.from(JSON.stringify(redact(obj),null,2))]);
  add('experiment.json',{id:st.id,run_id:st.run_id,name:st.name,state:st.state,config:st.config,config_hash:st.config_hash,initial_hash:st.initial_hash,frozen_a_hash:st.frozen_a_hash,
    committed_rounds:st.committed_rounds,target_rounds:st.target_rounds,created_at:st.created_at,started_at:st.started_at,finished_at:st.finished_at,blocker:st.blocker,project_id:coord.projectId,app_version});
  add('dataset-manifest.json',ds);
  add('model-variants.json',(st.model_snapshot||[]).map(v=>({profile_id:st.config.profile_id,...v})));
  add('devices.json',devices.map(d=>({label:label.get(d.id),device_id:d.id,state:d.state,key_fingerprint:d.key_fingerprint,backend:d.capabilities?.backend||null,precision:d.capabilities?.precision||null,
    memory_total_bytes:d.capabilities?.memory_total_bytes||null,unified_memory:!!d.capabilities?.unified_memory,runtime_version:d.runtime_version,accepted_count:d.accepted_count,metrics:d.metrics})));
  add('rounds.json',rounds.map(r=>({...r,accepted:(r.accepted||[]).map(a=>({update_id:a.update_id,task_id:a.task_id,payload_sha:a.payload_sha,weight:a.weight,device:label.get(a.device_id)||'unknown'})),updates:r.updates.map(u=>({update_id:u.update_id,task_id:u.task_id,device:label.get(u.device_id)||'unknown',state:u.state,reason:u.reason,payload_sha256:u.payload_sha,norm:u.norm,delta_norm:u.delta_norm,meta:u.meta}))})));
  add('evaluation.json',st.eval||{status:'NOT RUN'});
  const evs=[];let after=0;for(;;){const b=coord.events(after,1000);if(!b.length)break;for(const e of b)if(!e.experiment_id||e.experiment_id===experiment_id)evs.push({seq:e.seq,ts:e.ts,severity:e.severity,code:e.code,device:e.device_id?label.get(e.device_id)||'unknown':null,task:e.task_id||null,details:e.details});after=b.at(-1).seq;}
  add('events.json',evs);
  if(include_weights){
    const need=new Set([st.initial_hash]);for(const r of rounds){if(r.parent_hash)need.add(r.parent_hash);if(r.checkpoint_hash)need.add(r.checkpoint_hash);for(const a of r.accepted||[])need.add(a.payload_sha);}
    for(const h of need)if(h&&coord.cas.has(h))entries.push([`weights/${h}.safetensors`,coord.cas.get(h)]);
  }
  add('README.json',{format:'kvalah-compute-report/1',includes_weights:include_weights,aliases:include_aliases?'included':'replaced by device-N labels',
    note:'Engineering report. A Smoke run on a synthetic fixture proves only that the pipeline works, not model quality.'});
  const sums=entries.map(([n,b])=>`${sha256(b)}  ${n}`).join('\n')+'\n';
  entries.push(['SHA256SUMS',Buffer.from(sums)]);
  const zip=writeZip(entries);fs.writeFileSync(out,zip);
  return {path:out,bytes:zip.length,sha256:sha256(zip),files:entries.length,includes_weights:include_weights};
}
export function verifyReport(file){
  const files=readZip(fs.readFileSync(file),{maxTotal:2*2**30});
  const problems=[],checks=[];
  const sums=files.get('SHA256SUMS')?.toString('utf8');if(!sums)return {ok:false,problems:['SHA256SUMS missing']};
  for(const line of sums.trim().split('\n')){const [h,n]=line.split(/\s{2}/);const b=files.get(n);if(!b)problems.push('missing '+n);else if(sha256(b)!==h)problems.push('hash mismatch '+n);}
  checks.push({check:'file hashes',ok:!problems.length});
  const J=n=>JSON.parse(files.get(n).toString('utf8'));
  const exp=J('experiment.json'),rounds=J('rounds.json'),p=getProfile(exp.config.profile_id);
  const w=h=>files.get(`weights/${h}.safetensors`);
  // Lineage: round k parent = round k-1 committed checkpoint, round 0 parent = initial.
  const committed=rounds.filter(r=>r.state==='COMMITTED').sort((a,b)=>a.idx-b.idx);
  let prev=exp.initial_hash,lineageOk=true;
  const source=exp.config.initial_checkpoint;
  if(source&&((prev!==null&&source.sha256!==prev)||!Number.isSafeInteger(source.source_round)||source.source_round<1||
    !Number.isSafeInteger(source.row_offset)||source.row_offset<1||source.experiment_id===exp.id))lineageOk=false;
  for(const r of committed){if(r.parent_hash!==prev)lineageOk=false;prev=r.checkpoint_hash;}
  checks.push({check:'lineage',ok:lineageOk});if(!lineageOk)problems.push('lineage broken');
  if(w(exp.initial_hash)){
    let aOk=frozenAHash(verifyTensors(decode(w(exp.initial_hash)).tensors,p,true))===exp.frozen_a_hash,aggOk=true;
    if(!aOk)problems.push('initial checkpoint frozen A differs');
    for(const r of committed){
      const base=decode(w(r.parent_hash)).tensors;
      const ups=(r.accepted||[]).map(a=>({id:a.task_id,weight:a.weight,tensors:verifyTensors(decode(w(a.payload_sha)).tensors,p,false)}));
      const res=fedavg(base,ups,p);
      const bytes=encode(res.tensors,{kind:'kvalah-ffa-adapter',profile:p.id,round:String(r.idx+1)});
      if(sha256(bytes)!==r.checkpoint_hash){aggOk=false;problems.push(`round ${r.idx}: recomputed aggregation differs`);}
      if(frozenAHash(res.tensors)!==exp.frozen_a_hash){aOk=false;problems.push(`round ${r.idx}: A changed`);}
    }
    checks.push({check:'aggregation recomputed bitwise',ok:aggOk},{check:'frozen A unchanged',ok:aOk});
  }else checks.push({check:'aggregation recomputed bitwise',ok:null,note:'weights not included in this report'});
  return {ok:problems.length===0,experiment:exp.id,run_id:exp.run_id,committed_rounds:committed.length,checks,problems};
}
