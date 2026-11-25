// Read-only import of the v0.1 experiment archive (spec §9.4): safe ZIP parsing (Windows separators
// normalised, traversal and bombs rejected), schema checks, exact reconstruction of both aggregations, and
// explicit "unverified" markers for what v0.1 could not prove. Nothing here resumes v0.1 as a v0.2 run.
import fs from 'node:fs';
import {readZip} from './zip.mjs';
import {decode} from './protocol/safetensors.mjs';
import {getProfile,verifyTensors,frozenAHash,sameA,bytesEqual} from './protocol/schema.mjs';
import {fedavg} from './protocol/aggregate.mjs';
import {sha256} from './protocol/hash.mjs';
// v0.1 weights: supervised tokens per node = Σ(len(ids)-1) of its three texts; NODES order msi, rog, mac.
export const V01={nodes:['msi','rog','mac'],weights:{msi:41,rog:38,mac:38}};
export function importLegacy(zipPath){
  const entries=readZip(fs.readFileSync(zipPath));
  const p=getProfile('ministral3b-ffa-r8-v1');
  const get=n=>{const b=entries.get(n);if(!b)throw Error('missing '+n+' in archive');return b;};
  const rounds=[...entries.keys()].filter(n=>/^round-\d+\.safetensors$/.test(n)).map(n=>+n.match(/\d+/)[0]).sort((a,b)=>a-b);
  const ckpt=rounds.map(r=>({round:r,bytes:get(`round-${r}.safetensors`).length,sha256:sha256(get(`round-${r}.safetensors`)),tensors:verifyTensors(decode(get(`round-${r}.safetensors`)).tensors,p,true)}));
  const results=[];
  for(let r=0;r+1<ckpt.length;r++){
    const ups=V01.nodes.map(n=>{const b=get(`update-${r}-${n}.safetensors`);return {id:n,weight:V01.weights[n],bytes:b.length,sha256:sha256(b),tensors:verifyTensors(decode(b).tensors,p,false)};});
    const {tensors}=fedavg(ckpt[r].tensors,ups,p,{order:'given'});
    let mismatched=0;for(const k of Object.keys(tensors)){const a=tensors[k].data,b=ckpt[r+1].tensors[k].data;if(!bytesEqual(a,b))for(let i=0;i<a.length;i++)if(a[i]!==b[i])mismatched++;}
    const sorted=fedavg(ckpt[r].tensors,ups,p).tensors;let sortedMismatch=0;for(const k of Object.keys(sorted)){const a=sorted[k].data,b=ckpt[r+1].tensors[k].data;for(let i=0;i<a.length;i++)if(a[i]!==b[i])sortedMismatch++;}
    results.push({round:r,parent_sha256:ckpt[r].sha256,result_sha256:ckpt[r+1].sha256,updates:ups.map(u=>({node:u.id,weight:u.weight,sha256:u.sha256,bytes:u.bytes})),
      bitwise_equal:mismatched===0,mismatched_values:mismatched,A_unchanged:sameA(ckpt[r].tensors,ckpt[r+1].tensors),
      note_sorted_order_mismatched_values:sortedMismatch});
  }
  const fa=ckpt.map(c=>frozenAHash(c.tensors));
  return {kind:'kvalah-compute-v0.1-legacy-import',read_only:true,
    checkpoints:ckpt.map(c=>({round:c.round,sha256:c.sha256,bytes:c.bytes})),frozen_A_hash:fa[0],frozen_A_constant:fa.every(h=>h===fa[0]),
    aggregation:results,verified_all:results.every(r=>r.bitwise_equal&&r.A_unchanged),
    legacy_unverified_identity:true,legacy_unverified_model_revision:true,manifest_present:entries.has('manifest.json'),
    notes:['v0.1 used one shared bearer token for all nodes; the first rog update is not physically attributable.',
      'Model revisions were not recorded in v0.1; CUDA (BF16 source, NF4) and MLX (community 4-bit) variants are not byte-identical models.',
      'Held-out loss 4.240202 → 4.241287 (+0.0256%) is the recorded v0.1 result: no quality improvement.']};
}
