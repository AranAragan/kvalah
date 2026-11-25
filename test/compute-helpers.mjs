// Shared helpers for Kvalah Compute tests. Python-backed tests need KVALAH_COMPUTE_PYTHON pointing at an
// interpreter with numpy + safetensors (+ torch/transformers/tokenizers for tokenizer and CPU tests); they
// are skipped (and reported as skipped) otherwise. Nothing here downloads models.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
process.env.KVALAH_COMPUTE_TEST='1';
export const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
export const PY_ROOT=path.join(ROOT,'compute','python');
export const FIXTURE=path.join(ROOT,'compute','fixtures','smoke-sft-v1.jsonl');
const cache=new Map();
export function python(mods=['numpy','safetensors']){
  const py=process.env.KVALAH_COMPUTE_PYTHON;if(!py)return null;
  const k=mods.join(',');if(cache.has(k))return cache.get(k);
  const r=spawnSync(py,['-c',mods.map(m=>`import ${m}`).join(';')||'pass'],{encoding:'utf8'});
  const ok=r.status===0?py:null;cache.set(k,ok);return ok;
}
export const skipNoPy=(mods)=>python(mods)?false:'KVALAH_COMPUTE_PYTHON with '+(mods||['numpy','safetensors']).join(', ')+' not available';
export const tmp=(p='kc-')=>fs.mkdtempSync(path.join(os.tmpdir(),p));
let tinyDir=null;
// Tiny random Mistral + word-level tokenizer built from the fixture (seconds on CPU, no download).
export function tinyModel(){
  if(tinyDir)return tinyDir;
  const py=python(['torch','transformers','tokenizers']);if(!py)return null;
  const d=path.join(os.tmpdir(),'kvalah-compute-tiny-v1');
  if(!fs.existsSync(path.join(d,'model.safetensors'))){
    const r=spawnSync(py,[path.join(PY_ROOT,'tests','tiny.py'),d,FIXTURE],{encoding:'utf8',env:{...process.env,PYTHONPATH:PY_ROOT}});
    if(r.status!==0)throw Error('tiny model build failed: '+r.stderr.slice(-800));
  }
  return tinyDir=d;
}
export const v01Zip=()=>{const z=process.env.KVALAH_V01_ZIP;return z&&fs.existsSync(z)?z:null;};

// Word tokenizer: assistant words + EOS are targets (same contract as the Python prefix method).
export async function jsTokenizer(rows,maxLength){
  const vocab=new Map(),id=w=>{if(!vocab.has(w))vocab.set(w,vocab.size+10);return vocab.get(w);};
  const out=[],excluded=[];
  for(const r of rows){
    const ids=[1],mask=[0];
    for(const m of r.messages){const ws=m.content.split(/\s+/).filter(Boolean);for(const w of ws){ids.push(id(w));mask.push(m.role==='assistant'?1:0);}if(m.role==='assistant'){ids.push(2);mask.push(1);}}
    if(ids.length>maxLength){excluded.push({id:r.id,reason:'too_long'});continue;}
    out.push({id:r.id,input_ids:ids,target_mask:mask});
  }
  return {rows:out,excluded,tokenizer_hash:'f'.repeat(64),chat_template_hash:'e'.repeat(64)};
}
