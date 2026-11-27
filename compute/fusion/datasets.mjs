import {canonicalJSON,sha256} from '../protocol/hash.mjs';
import {fail} from '../protocol/errors.mjs';

const splits=['train','validation','test'];

// For pre-tokenized, explicitly distributable research data. Group IDs must be produced by the
// trusted dataset preparation step before tokenization. They are compared across all splits.
export function sealFusionDataset({name,revision,license,source,preprocessing,redistribution,samples},{context,vocab}){
  const validText=v=>typeof v==='string'&&v.trim()&&v.length<=512;
  if(![name,revision,license,source,preprocessing].every(validText)||redistribution!==true||!samples||
    !Number.isSafeInteger(context)||context<2||context>65536||!Number.isSafeInteger(vocab)||vocab<2||vocab>2**24)
    fail('DATASET_INVALID','dataset provenance, redistribution approval and tokenizer bounds are required');
  const groups=new Map(),seenIds=new Set(),files={};
  const plan={format:'kvalah-fusion-dataset/v1',name,revision,license,source,preprocessing,redistribution,context,vocab,splits:{}};
  for(const split of splits){
    const rows=samples[split];
    if(!Array.isArray(rows)||rows.length===0)fail('DATASET_INVALID','missing '+split+' split');
    let tokens=0;
    const validated=rows.map(row=>{
      if(!row||!validText(row.id)||!validText(row.group)||!Array.isArray(row.input_ids)||row.input_ids.length<2||row.input_ids.length>context||
        !row.input_ids.every(id=>Number.isSafeInteger(id)&&id>=0&&id<vocab)||!Array.isArray(row.target_mask)||row.target_mask.length!==row.input_ids.length||
        row.target_mask[0]!==false||!row.target_mask.every(b=>typeof b==='boolean')||!row.target_mask.slice(1).some(Boolean))
        fail('DATASET_INVALID','invalid token row or assistant supervision mask');
      if(seenIds.has(row.id)||groups.has(row.group)&&groups.get(row.group)!==split)fail('DATASET_SPLIT_OVERLAP','row ID or group overlaps dataset splits');
      seenIds.add(row.id);groups.set(row.group,split);
      tokens+=row.target_mask.slice(1).filter(Boolean).length;
      return {id:row.id,group:row.group,input_ids:row.input_ids,target_mask:row.target_mask};
    });
    const file=Buffer.from(canonicalJSON({format:'kvalah-fusion-shard/v1',split,rows:validated}));
    files[split]=file;
    plan.splits[split]={sha256:sha256(file),bytes:file.length,rows:validated.length,tokens,groups:new Set(validated.map(r=>r.group)).size};
  }
  const manifest=Buffer.from(canonicalJSON(plan));
  return {manifest,files,sha256:sha256(manifest)};
}

export function validateTrainShard(manifestBytes,shard,manifestDigest){
  if(sha256(manifestBytes)!==manifestDigest)fail('HASH_MISMATCH','dataset manifest digest mismatch');
  let m;
  try{m=JSON.parse(manifestBytes.toString('utf8'));}catch{fail('DATASET_INVALID','invalid dataset manifest');}
  const expected=m?.splits?.train;
  if(m?.format!=='kvalah-fusion-dataset/v1'||m.redistribution!==true||!expected||shard.length!==expected.bytes||sha256(shard)!==expected.sha256)
    fail('DATASET_INVALID','requested shard is not the distributable Train split');
  return expected;
}
