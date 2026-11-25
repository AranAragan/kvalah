// Model profiles and the canonical FFA-LoRA tensor contract (spec §6).
// PyTorch layout: A[r,in], B[out,r], ΔW = (alpha/r)·B·A. MLX keeps the transposes (Aᵀ, Bᵀ); the sidecar converts.
// The tensor schema is generated from the validated architecture profile only — never from names found in an upload.
import {fail} from './errors.mjs';
import {hashJSON,sha256} from './hash.mjs';
import {encode} from './safetensors.mjs';

export const PROTOCOL_VERSION='2.0';
const PROFILES={
  'ministral3b-ffa-r8-v1':{
    id:'ministral3b-ffa-r8-v1',model_family:'Ministral-3-3B-Instruct-2512',text_only:true,
    layers:26,targets:{q_proj:[3072,4096],v_proj:[3072,1024]},rank:8,alpha:16,dropout:0,bias:'none',
    variants:{
      'cuda-nf4':{backend:'cuda',source_repo:'mistralai/Ministral-3-3B-Instruct-2512-BF16',quantization:{algorithm:'bitsandbytes-nf4',bits:4,double_quant:true}},
      'mlx-4bit':{backend:'mlx',source_repo:'mlx-community/Ministral-3-3B-Instruct-2512-4bit',quantization:{algorithm:'mlx-affine',bits:4,group_size:64}}
    },
    peft:{base_model_name_or_path:'mistralai/Ministral-3-3B-Instruct-2512-BF16',module_prefix:'base_model.model.model.language_model.',
      target_regex:'model\\.language_model\\.layers\\.\\d+\\.self_attn\\.(q_proj|v_proj)'},
    license:'Apache-2.0'
  },
  // Test-only profile: a tiny randomly initialised Mistral used by CPU integration tests. Refused unless
  // KVALAH_COMPUTE_TEST=1 so it can never be scheduled in production.
  'tiny-test-ffa-r4':{
    id:'tiny-test-ffa-r4',model_family:'tiny-mistral-test',text_only:true,test_only:true,
    layers:2,targets:{q_proj:[64,64],v_proj:[64,32]},rank:4,alpha:8,dropout:0,bias:'none',
    variants:{'cpu-test':{backend:'torch-cpu-test',source_repo:'local/tiny-mistral',quantization:{algorithm:'none',bits:32}},
              'mlx-test':{backend:'mlx',source_repo:'local/tiny-mistral',quantization:{algorithm:'none',bits:32}},
              'mock':{backend:'mock',source_repo:'none',quantization:{algorithm:'none',bits:32}}},
    peft:{base_model_name_or_path:'local/tiny-mistral',module_prefix:'base_model.model.model.',target_regex:'model\\.layers\\.\\d+\\.self_attn\\.(q_proj|v_proj)'},
    license:'MIT'
  }
};
export const testMode=()=>process.env.KVALAH_COMPUTE_TEST==='1';
export function listProfiles(){return Object.values(PROFILES).filter(p=>!p.test_only||testMode());}
export function getProfile(id){
  const p=PROFILES[id];
  if(!p)fail('INVALID_SCHEMA','unknown model profile '+String(id).slice(0,80));
  if(p.test_only&&!testMode())fail('FORBIDDEN_SCOPE','test-only profile '+id+' is disabled outside tests');
  return p;
}
export const targetNames=p=>{const out=[];for(let i=0;i<p.layers;i++)for(const t of Object.keys(p.targets).sort())out.push(`layers.${i}.self_attn.${t}`);return out;};
// key → shape. full=true: A and B (global adapter); full=false: B only (worker update, update_kind=absolute_b).
export function tensorSchema(p,full=true){
  const s={};
  for(const name of targetNames(p)){
    const [inF,outF]=p.targets[name.split('.').pop()];
    if(full)s[name+'.A']=[p.rank,inF];
    s[name+'.B']=[outF,p.rank];
  }
  return s;
}
export const schemaHash=p=>hashJSON({profile:p.id,rank:p.rank,alpha:p.alpha,schema:tensorSchema(p,true),layout:'torch:A[r,in],B[out,r];le-f32'});
export const scale=p=>p.alpha/p.rank;
export const trainableCount=p=>Object.values(tensorSchema(p,false)).reduce((a,[o,r])=>a+o*r,0);
export const frozenCount=p=>Object.entries(tensorSchema(p,true)).filter(([k])=>k.endsWith('.A')).reduce((a,[,[r,i]])=>a+r*i,0);

// Exact key set, exact shapes, finite values, no extras (M05).
export function verifyTensors(tensors,p,full){
  const s=tensorSchema(p,full),keys=Object.keys(tensors);
  const extra=keys.filter(k=>!(k in s)),missing=Object.keys(s).filter(k=>!(k in tensors));
  if(extra.length||missing.length)fail('INVALID_TENSOR','tensor keys differ from schema',{extra:extra.slice(0,5),missing:missing.slice(0,5)});
  for(const [k,shape] of Object.entries(s)){
    const t=tensors[k];
    if(t.shape.length!==2||t.shape[0]!==shape[0]||t.shape[1]!==shape[1])fail('INVALID_TENSOR','shape mismatch for '+k,{expected:shape,got:t.shape});
    const d=t.data;for(let i=0;i<d.length;i++)if(!Number.isFinite(d[i]))fail('NONFINITE','non-finite value in '+k);
  }
  return tensors;
}
export function onlyA(t){return Object.fromEntries(Object.entries(t).filter(([k])=>k.endsWith('.A')));}
export function onlyB(t){return Object.fromEntries(Object.entries(t).filter(([k])=>k.endsWith('.B')));}
// Hash of the frozen A matrices in canonical serialisation (sorted keys, LE F32, no metadata).
export const frozenAHash=t=>sha256(encode(onlyA(t)));
export const bytesEqual=(a,b)=>a.length===b.length&&Buffer.from(a.buffer,a.byteOffset,a.length*4).equals(Buffer.from(b.buffer,b.byteOffset,b.length*4));
export function sameA(x,y){const a=onlyA(x),b=onlyA(y);return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>b[k]&&bytesEqual(a[k].data,b[k].data));}
