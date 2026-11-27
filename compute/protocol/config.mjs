// Experiment configuration: validation, presets (Smoke / Pilot / Research) and the immutable config hash.
import {fail} from './errors.mjs';
import {hashJSON,isHex64} from './hash.mjs';
import {getProfile} from './schema.mjs';
export const PRESETS={
  smoke:{rounds:2,local_steps:3,quorum:{mode:'all',min:3,target:3},round_deadline_s:600,lease_ttl_s:120,eval:{initial:true,final:true,every:0}},
  pilot:{rounds:5,local_steps:10,quorum:{mode:'fault_tolerant',min:2,target:3},round_deadline_s:600,lease_ttl_s:120,eval:{initial:true,final:true,every:5}},
  research:{rounds:100,local_steps:10,quorum:{mode:'fault_tolerant',min:2,target:3},round_deadline_s:900,lease_ttl_s:120,eval:{initial:true,final:true,every:5}}
};
const int=(v,lo,hi,name)=>{if(!Number.isSafeInteger(v)||v<lo||v>hi)fail('INVALID_SCHEMA',`${name} must be an integer in [${lo}, ${hi}]`);return v;};
const num=(v,lo,hi,name)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<lo||v>hi)fail('INVALID_SCHEMA',`${name} must be a number in [${lo}, ${hi}]`);return v;};
export function normalizeConfig(input){
  if(!input||typeof input!=='object')fail('INVALID_SCHEMA','config must be an object');
  const preset=PRESETS[input.preset]?input.preset:fail('INVALID_SCHEMA','preset must be smoke, pilot or research');
  const base=PRESETS[preset];
  const name=String(input.name||'').trim().slice(0,80);if(!name)fail('INVALID_SCHEMA','experiment name is required');
  const profile=getProfile(input.profile_id);
  const variants=Array.isArray(input.variants)&&input.variants.length?input.variants.map(String):Object.keys(profile.variants);
  for(const v of variants)if(!profile.variants[v])fail('INVALID_SCHEMA','unknown variant '+v.slice(0,40));
  const opt=input.optimizer||{};
  const optName=opt.name===undefined?'sgd':opt.name;
  if(!['sgd','adamw'].includes(optName))fail('INVALID_SCHEMA','optimizer must be sgd or adamw');
  const optimizer={name:optName,lr:num(opt.lr??(optName==='sgd'?1e-3:1e-4),1e-7,1e-1,'lr'),clip_norm:num(opt.clip_norm??1.0,0.01,100,'clip_norm'),reset:'per_round'};
  if(optName==='adamw')Object.assign(optimizer,{beta1:num(opt.beta1??0.9,0,0.9999,'beta1'),beta2:num(opt.beta2??0.999,0,0.99999,'beta2'),eps:num(opt.eps??1e-8,1e-12,1e-3,'eps'),weight_decay:num(opt.weight_decay??0,0,1,'weight_decay')});
  const q=input.quorum||base.quorum;
  const experimentalModes=['minimum','deadline','adaptive'];
  if(experimentalModes.includes(q.mode)&&input.experimental_quorum!==true)fail('INVALID_SCHEMA','experimental quorum requires explicit opt-in');
  const quorum={mode:experimentalModes.includes(q.mode)||q.mode==='fault_tolerant'?q.mode:'all',target:int(q.target??3,1,32,'quorum.target'),min:0};
  quorum.min=quorum.mode==='all'?quorum.target:int(q.min??Math.max(1,quorum.target-1),1,quorum.target,'quorum.min');
  if(experimentalModes.includes(quorum.mode)){
    if(quorum.min<2)fail('INVALID_SCHEMA','experimental quorum needs at least two independent participants');
    quorum.min_tokens=int(q.min_tokens,1,100000000,'quorum.min_tokens');
  }
  const cfg={
    protocol_version:'2.0',task_type:'ffa_lora_sft',update_kind:'absolute_b',
    name,preset,profile_id:profile.id,variants,dataset_id:String(input.dataset_id||''),
    seed:int(input.seed??20261126,0,2**31-1,'seed'),
    rounds:int(input.rounds??base.rounds,1,100,'rounds'),
    local_steps:int(input.local_steps??base.local_steps,1,200,'local_steps'),
    batch_size:int(input.batch_size??1,1,1,'batch_size (v0.2 supports 1)'),
    grad_accum:int(input.grad_accum??1,1,16,'grad_accum'),
    max_length:[256,512].includes(input.max_length??256)?(input.max_length??256):fail('INVALID_SCHEMA','max_length must be 256 or 512'),
    optimizer,quorum,
    lease_ttl_s:int(input.lease_ttl_s??base.lease_ttl_s,30,900,'lease_ttl_s'),
    round_deadline_s:int(input.round_deadline_s??base.round_deadline_s,60,86400,'round_deadline_s'),
    eval:{initial:input.eval?.initial??base.eval.initial,final:input.eval?.final??base.eval.final,every:int(input.eval?.every??base.eval.every,0,100,'eval.every')},
    research_confirmed:input.research_confirmed===true
  };
  if(!cfg.dataset_id)fail('DATASET_REQUIRED','choose an approved dataset');
  cfg.reuse_accepted_updates=input.reuse_accepted_updates!==false;
  if(input.adaptive_scheduler===true){
    const steps=input.slot_steps;
    if(!Array.isArray(steps)||steps.length!==quorum.target)fail('INVALID_SCHEMA','adaptive scheduler needs one slot_steps entry per participant');
    cfg.slot_steps=steps.map(s=>int(s,1,200,'slot_steps'));
    if(cfg.slot_steps.reduce((sum,s)=>sum+s,0)!==cfg.local_steps*quorum.target)
      fail('INVALID_SCHEMA','adaptive scheduler must preserve the configured example budget');
    cfg.adaptive_scheduler=true;
  }
  if(input.initial_checkpoint!=null){
    const c=input.initial_checkpoint;
    if(typeof c.experiment_id!=='string'||!/^exp-[a-f0-9]{12}$/.test(c.experiment_id)||!isHex64(c.sha256)){
      fail('INVALID_SCHEMA','initial checkpoint requires a source experiment and a SHA-256');
    }
    cfg.initial_checkpoint={experiment_id:c.experiment_id,sha256:c.sha256};
  }
  if(input.target_device_ids!==undefined){
    const ids=input.target_device_ids;
    if(!Array.isArray(ids)||ids.length!==quorum.target||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^dev-[a-f0-9]{32}$/.test(id))){
      fail('INVALID_SCHEMA','target devices must be distinct enrolled identities');
    }
    cfg.target_device_ids=[...ids].sort();
  }
  if(cfg.preset==='smoke'&&cfg.rounds>3)fail('INVALID_SCHEMA','smoke profile is limited to 3 rounds');
  if(cfg.rounds>10&&!cfg.research_confirmed)fail('INVALID_SCHEMA','more than 10 rounds needs a completed pilot and explicit research confirmation');
  if(cfg.max_length===512&&!input.memory_checked)fail('INVALID_SCHEMA','max_length 512 needs a memory preflight first (start a new run)');
  if(cfg.lease_ttl_s>=cfg.round_deadline_s)fail('INVALID_SCHEMA','lease TTL must be shorter than the round deadline');
  return cfg;
}
export const configHash=cfg=>hashJSON(cfg);
export const optimizerHash=cfg=>hashJSON(cfg.optimizer);
