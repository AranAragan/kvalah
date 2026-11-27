import {fail} from '../protocol/errors.mjs';
import {canonicalJSON} from '../protocol/hash.mjs';
import {putArtifact} from './provision.mjs';

const MAX_SHARD=16*1024**2;
const positive=(n,max)=>Number.isSafeInteger(n)&&n>0&&n<=max;

export function trainingPlan({rounds=1,epochs=1,tokenBudget=Number.MAX_SAFE_INTEGER,sampling='sequential'}={}){
  if(!positive(rounds,10000)||!positive(epochs,1000)||!positive(tokenBudget,Number.MAX_SAFE_INTEGER)||sampling!=='sequential')
    fail('INVALID_SCHEMA','invalid Fusion round, epoch, token budget or sampling policy');
  return {rounds,epochs,tokenBudget,sampling};
}

// A round uses equally many complete local optimizer steps on each worker. A too-short
// epoch tail is dropped explicitly. No round mixes records from different epochs.
export function planRound({plan,position,trainCount,quorum,maxLength,expert,read,cas}){
  const {local_steps,grad_accum}=expert.training;
  const stride=quorum*grad_accum;
  let {epoch,index}=position;
  if(trainCount-index<stride){epoch++;index=0;}
  if(epoch>=plan.endEpoch||trainCount<stride||plan.tokens>=plan.tokenBudget)return null;
  const rowsPerWorker=Math.max(grad_accum,Math.floor(1024**2/(maxLength*8)));
  const stepLimit=Math.min(local_steps,Math.floor(rowsPerWorker/grad_accum),Math.floor((trainCount-index)/stride),Math.floor((plan.tokenBudget-plan.tokens)/stride));
  if(!stepLimit)return null;
  const rows=read(index,stepLimit*stride);
  if(!Array.isArray(rows)||rows.length!==stepLimit*stride)fail('DATASET_INVALID','Fusion Train manifest row count changed');
  const tokens=rows.map(r=>{
    if(!Array.isArray(r.input_ids)||r.input_ids.length<2||r.input_ids.length>maxLength||!Array.isArray(r.target_mask)||
      r.input_ids.length!==r.target_mask.length||r.target_mask[0]||!r.target_mask.every(v=>v===0||v===1||typeof v==='boolean'))
      fail('DATASET_INVALID','invalid Fusion training row');
    const n=r.target_mask.slice(1).filter(Boolean).length;
    if(!n)fail('DATASET_INVALID','Fusion Train row does not contain supervised tokens');
    return n;
  });
  let used=0,steps=0;
  for(;steps<stepLimit;steps++){
    const start=steps*stride,n=tokens.slice(start,start+stride).reduce((a,b)=>a+b,0);
    if(used+n>plan.tokenBudget-plan.tokens)break;
    used+=n;
  }
  if(!steps)return null;
  const per=steps*grad_accum;
  const tasks=Array.from({length:quorum},(_,slot)=>{
    const start=slot*per;
    const shard=rows.slice(start,start+per).map(r=>({input_ids:r.input_ids,target_mask:r.target_mask}));
    const data=Buffer.from(canonicalJSON({split:'train',rows:shard}));
    if(data.length>MAX_SHARD)fail('TOO_LARGE','Fusion Train shard is too large');
    return {slot,tokens:tokens.slice(start,start+per).reduce((a,b)=>a+b,0),steps,
      train:putArtifact(cas,'train',data,expert.dataset_sha256)};
  });
  const end=index+steps*stride;
  const next=end===trainCount?{epoch:epoch+1,index:0}:{epoch,index:end};
  return {position:{epoch,index},next,tasks,tokens:used};
}
