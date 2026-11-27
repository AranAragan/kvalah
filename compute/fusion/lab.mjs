import path from 'node:path';
import {openFusion,validateBase,normalizeExpert,compositionStats} from './registry.mjs';
import {fail} from '../protocol/errors.mjs';
import {buildExpert} from './builder.mjs';

export function estimateComposition({base,experts=[],loop={},top_k=1,context=256,kv_width=null}){
  base=validateBase(base);
  const repeated={start:loop.start??0,end:loop.end??0,passes:loop.passes??1};
  if(!Array.isArray(experts)||experts.length>4096||![1,2,4].includes(top_k)||!Number.isInteger(context)||context<1||context>1048576||
    ![1,2,3,4].includes(repeated.passes)||![repeated.start,repeated.end].every(Number.isInteger)||repeated.start<0||repeated.end>base.layers||
    repeated.end<repeated.start||(repeated.passes>1&&repeated.end===repeated.start)||
    (kv_width!==null&&(!Number.isInteger(kv_width)||kv_width<1||kv_width>base.width*8)))fail('INVALID_SCHEMA','invalid architecture estimate');
  // Planning can represent full FFN shapes above the current transport cap without allocating tensors.
  const specs=experts.map((e,id)=>{
    if(e.kind!=='ffn')return {...normalizeExpert({...e,base}),id};
    if(!Number.isInteger(e.intermediate)||e.intermediate<1||e.intermediate>131072||!Array.isArray(e.layers)||!e.layers.length||
      !e.layers.every(i=>Number.isInteger(i)&&i>=0&&i<base.layers))fail('INVALID_SCHEMA','invalid FFN estimate');
    const width=base.width,inner=e.intermediate;
    const tensors=[...new Set(e.layers)].flatMap(i=>[
      {name:`layers.${i}.gate`,shape:[inner,width],trainable:e.training!=='down'},
      {name:`layers.${i}.up`,shape:[inner,width],trainable:e.training!=='down'},
      {name:`layers.${i}.down`,shape:[width,inner],trainable:true}
    ]);
    return {id,tensors};
  });
  const counts=compositionStats(base,specs,repeated,top_k);
  return {...counts,classification:'ESTIMATED',fp16_checkpoint_bytes:2*counts.parameters,
    gradient_bytes:counts.fp32_trainable_bytes,hidden_state_bytes:2*base.width*context,
    fp16_kv_bytes:kv_width===null?null:4*kv_width*context*counts.logical_layers};
}

export function createFusionLab(root,{inputs=()=>({model:null,datasets:[]})}={}){
  let registry;
  const open=()=>registry??=openFusion(path.resolve(root));
  function state(){
    return {experts:open().list(),models:open().compositions(),active:open().active()?.hash??null,public_key:open().publicKey};
  }
  return {
    close:()=>registry?.close(),
    async handle(method,route,input){
      if(method==='GET'&&route==='state')return {...state(),builder:await inputs()};
      if(method!=='POST')fail('NOT_FOUND','unknown Fusion operation');
      if(route==='estimate'||route==='expert/create'){
        const {model,datasets}=await inputs();
        if(!model||model.id!==input.model_id)fail('MODEL_REQUIRED','select the detected model');
        if(route==='expert/create')return open().create(buildExpert(input,model,datasets.find(d=>d.id===input.dataset_id)));
        const context=input.context??Math.min(model.context,256),count=input.count??0;
        if(!Number.isInteger(count)||count<0||count>4096)fail('INVALID_SCHEMA','invalid number of FFN modules');
        if(context>model.context)fail('INVALID_SCHEMA','context exceeds the detected model limit');
        const base={revision:model.source_revision??('local-'+model.id.slice(0,12)),backbone_sha256:model.id,tokenizer_sha256:model.tokenizer_sha256,
          architecture_sha256:model.architecture_sha256,layers:model.layers,width:model.width,parameters:model.parameters};
        return estimateComposition({base,experts:Array.from({length:count},()=>({kind:'ffn',intermediate:input.intermediate,layers:input.layers})),
          top_k:input.top_k,loop:input.loop,context,kv_width:model.kv_width});
      }
      if(route==='expert/clone')return open().clone(input.id,input.version,input);
      if(route==='expert/archive')return open().change(input.id,input.from,'ARCHIVED');
      if(route==='models/assemble')return open().assemble(input);
      if(route==='models/publish')return open().publish(input.hash);
      if(route==='models/rollback')return open().rollback(input.hash);
      fail('NOT_FOUND','unknown Fusion operation');
    }
  };
}
