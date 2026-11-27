import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {hashJSON,isHex64,sha256} from '../protocol/hash.mjs';
import {fail} from '../protocol/errors.mjs';

const headerLimit=4*1024**2;
const logicalTypes=new Map([['BF16',2],['F16',2],['F32',4],['F64',8]]);
const textPrefix=/^(?:(?:model\.)?language_model\.|model\.layers\.|model\.embed_tokens\.|model\.norm\.|lm_head\.)/;

function readExact(fd,buffer,offset){
  if(fs.readSync(fd,buffer,0,buffer.length,offset)!==buffer.length)fail('MODEL_UNVERIFIED','truncated safetensors header');
}

function countWeights(file,tensorNames){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<10)fail('MODEL_UNVERIFIED','invalid weight shard');
  const fd=fs.openSync(file,'r');
  try{
    const length=Buffer.alloc(8);readExact(fd,length,0);
    const bytes=Number(length.readBigUInt64LE());
    if(!Number.isSafeInteger(bytes)||bytes<2||bytes>headerLimit||bytes+8>stat.size)fail('MODEL_UNVERIFIED','unsupported safetensors header');
    const hdr=Buffer.alloc(bytes);readExact(fd,hdr,8);
    const data=JSON.parse(hdr.toString('utf8'));
    if(!data||Array.isArray(data)||typeof data!=='object')fail('MODEL_UNVERIFIED','invalid weight header');
    let count=0,text=0;
    const ranges=[];
    for(const [name,t] of Object.entries(data)){
      if(name==='__metadata__')continue;
      if(!t||tensorNames.has(name)||!Array.isArray(t.shape)||!t.shape.every(n=>Number.isSafeInteger(n)&&n>0)||
         !logicalTypes.has(t.dtype)||!Array.isArray(t.data_offsets)||t.data_offsets.length!==2)fail('MODEL_UNVERIFIED','builder needs dense floating-point weight shapes');
      const [start,end]=t.data_offsets,n=t.shape.reduce((a,b)=>a*b,1);
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end-start!==n*logicalTypes.get(t.dtype)||end>stat.size-bytes-8)
        fail('MODEL_UNVERIFIED','weight shape and offsets disagree');
      ranges.push([start,end]);tensorNames.add(name);count+=n;
      if(textPrefix.test(name))text+=n;
    }
    let end=0;
    for(const range of ranges.sort((a,b)=>a[0]-b[0])){
      if(range[0]!==end)fail('MODEL_UNVERIFIED','invalid weight storage layout');
      end=range[1];
    }
    if(end!==stat.size-bytes-8)fail('MODEL_UNVERIFIED','unexpected data after weight tensors');
    return {count,text};
  }finally{fs.closeSync(fd);}
}

export function detectBase(model){
  if(!model?.architecture_ok||!isHex64(model.files_digest)||!path.isAbsolute(model.model_dir??''))return null;
  const root=fs.realpathSync(model.model_dir);
  const resolveFile=name=>{
    const resolved=path.join(root,name);
    if(!/^[\w.-]+$/.test(name)||path.dirname(resolved)!==root||!fs.lstatSync(resolved).isFile()||fs.realpathSync(resolved)!==resolved)
      fail('MODEL_UNVERIFIED','invalid model file');
    return resolved;
  };
  const configFile=resolveFile('config.json');
  if(fs.statSync(configFile).size>1024**2)fail('MODEL_UNVERIFIED','oversized model configuration');
  const cfg=JSON.parse(fs.readFileSync(configFile,'utf8')),text=cfg.text_config??cfg;
  const arch={layers:text.num_hidden_layers,width:text.hidden_size,intermediate:text.intermediate_size,
    vocab:text.vocab_size,context:text.max_position_embeddings,kv_width:text.num_key_value_heads*(text.head_dim??text.hidden_size/text.num_attention_heads)};
  if(Object.values(arch).some(n=>!Number.isSafeInteger(n)||n<1)||arch.layers>1024||arch.width>32768)fail('MODEL_UNVERIFIED','model does not describe a supported text architecture');
  const tensorNames=new Set();
  const files=fs.readdirSync(root).filter(name=>/^[\w.-]+\.safetensors$/.test(name)).sort();
  if(!files.length||files.length>128)fail('MODEL_UNVERIFIED','weight shards are missing or excessive');
  const counts=files.reduce((total,name)=>{
    const p=countWeights(resolveFile(name),tensorNames);
    return {count:total.count+p.count,text:total.text+p.text};
  },{count:0,text:0});
  // Match central Compute tokenization fingerprint for identically configured tokenizer files.
  const tokenizerNames=['tokenizer.json','tokenizer_config.json','special_tokens_map.json','chat_template.jinja','chat_template.json','tekken.json','tokenizer.model'];
  const tokenizer=createHash('sha256');
  const tokenizerFiles=tokenizerNames.filter(name=>fs.existsSync(path.join(root,name)));
  for(const name of tokenizerFiles){
    const file=resolveFile(name);
    if(fs.statSync(file).size>64*1024**2)fail('MODEL_UNVERIFIED','oversized tokenizer file');
    tokenizer.update(name+'\0');tokenizer.update(Buffer.from(sha256(fs.readFileSync(file)),'hex'));
  }
  if(!tokenizerFiles.length)fail('MODEL_UNVERIFIED','model tokenizer is missing');
  return {...arch,id:model.files_digest,title:cfg.architectures?.[0]??text.model_type,parameters:counts.count,text_parameters:counts.text||null,
    source_revision:model.provenance==='verified'?model.pinned?.source_revision??null:null,variant_id:model.variant_id,provenance:model.provenance??'unverified',
    architecture_sha256:hashJSON({type:text.model_type,...arch}),tokenizer_sha256:tokenizer.digest('hex')};
}

export function buildExpert(input,detected,dataset){
  if(!detected||detected.id!==input.model_id)fail('MODEL_REQUIRED','select the detected model');
  if(!dataset?.group_audited||!isHex64(dataset.tokenizer_hash)||!isHex64(dataset.manifest_hash)||!dataset.license)
    fail('DATASET_REQUIRED','select a registered dataset with audited splits');
  if(dataset.tokenizer_hash!==detected.tokenizer_sha256)fail('MODEL_UNVERIFIED','dataset tokenizer differs from the detected model');
  const {layers,width,intermediate,parameters}=detected;
  if(!['lora','ffa-lora','ffn'].includes(input.kind)||!Array.isArray(input.layers)||!input.layers.length||
    input.layers.some(i=>!Number.isInteger(i)||i<0||i>=layers))fail('INVALID_SCHEMA','select valid expert layers');
  const rank=input.rank??8,inner=input.intermediate??Math.min(intermediate,512);
  if(!Number.isInteger(rank)||rank<1||rank>Math.min(width,512)||!Number.isInteger(inner)||inner<1||inner>65536)fail('INVALID_SCHEMA','invalid expert dimensions');
  const uniqueLayers=[...new Set(input.layers)].sort((a,b)=>a-b);
  const tensors=uniqueLayers.flatMap(layer=>{
    const stem=`layers.${layer}.fusion.`;
    if(input.kind==='ffn')return [
      {name:stem+'gate.weight',shape:[inner,width],dtype:'F32',trainable:input.training_mode!=='down'},
      {name:stem+'up.weight',shape:[inner,width],dtype:'F32',trainable:input.training_mode!=='down'},
      {name:stem+'down.weight',shape:[width,inner],dtype:'F32'}
    ];
    return [{name:stem+'A',shape:[rank,width],dtype:'F32',trainable:input.kind==='lora'},
      {name:stem+'B',shape:[width,rank],dtype:'F32'}];
  });
  return {key:input.key,name:input.name,domain:input.domain,kind:input.kind,rank,alpha:input.alpha??2*rank,layers:uniqueLayers,tensors,
    base:{revision:detected.source_revision??('local-'+detected.id.slice(0,12)),backbone_sha256:detected.id,
      architecture_sha256:detected.architecture_sha256,tokenizer_sha256:dataset.tokenizer_hash,layers,width,parameters},
    dataset_sha256:dataset.manifest_hash,license:dataset.license,runtimes:detected.variant_id==='cuda-nf4'?
      (detected.source_revision?['cuda-nf4','mlx']:['cuda-nf4']):['torch-cpu'],
    quantization:detected.variant_id==='cuda-nf4'?'nf4':'fp32',
    training:input.training??{optimizer:'adamw',lr:.001,local_steps:4,grad_accum:1,clip:1}};
}
