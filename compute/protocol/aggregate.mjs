// FedAvg over absolute B matrices (spec §6): B_(r+1) = Σ n_i·B_i / Σ n_i with n_i = verified supervised
// target tokens. Accumulates in FP64 in deterministic order (sorted by task id), casts once to FP32 and
// copies A unchanged. Inputs are validated against the profile schema first.
import {verifyTensors,tensorSchema,onlyA} from './schema.mjs';
import {fail} from './errors.mjs';
export function fedavg(base,updates,profile,{order='sorted'}={}){
  verifyTensors(base,profile,true);
  if(!Array.isArray(updates)||!updates.length)fail('INVALID_SCHEMA','no updates to aggregate');
  // 'given' exists only to reproduce v0.1 bit-for-bit (it summed in NODES order msi, rog, mac).
  const ordered=order==='given'?[...updates]:[...updates].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  if(new Set(ordered.map(u=>u.id)).size!==ordered.length)fail('CONFLICT','duplicate update id');
  for(const u of ordered){
    if(!Number.isSafeInteger(u.weight)||u.weight<=0)fail('NO_TARGET_TOKENS','update '+u.id+' has no supervised tokens');
    verifyTensors(u.tensors,profile,false);
  }
  const total=ordered.reduce((a,u)=>a+u.weight,0),out={};
  for(const [k,v] of Object.entries(onlyA(base)))out[k]={shape:[...v.shape],data:new Float32Array(v.data)};
  for(const k of Object.keys(tensorSchema(profile,false))){
    const n=base[k].data.length,acc=new Float64Array(n);
    for(const u of ordered){const d=u.tensors[k].data,w=u.weight;for(let i=0;i<n;i++)acc[i]+=d[i]*w;}
    const res=new Float32Array(n);for(let i=0;i<n;i++)res[i]=acc[i]/total;
    out[k]={shape:[...base[k].shape],data:res};
  }
  return {tensors:verifyTensors(out,profile,true),order:ordered.map(u=>u.id),weights:ordered.map(u=>u.weight),total};
}
