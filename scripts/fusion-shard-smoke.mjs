import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {aggregateTensorFiles,createTensorFile,verifyTensorFile} from '../compute/fusion/tensor-file.mjs';
import {hashFile,indexStoredFile} from '../compute/fusion/stream.mjs';

const [output,mode='small']=process.argv.slice(2);
if(!output||!['small','full'].includes(mode))throw Error('node scripts/fusion-shard-smoke.mjs <results.json> [small|full]');
const root=fs.realpathSync(os.tmpdir()),folder=fs.mkdtempSync(path.join(root,'fusion-file-agg-'));
assert.equal(path.dirname(folder),root);
const start=performance.now(),width=mode==='full'?3072:64,inner=mode==='full'?9216:128;
const schema=[{name:'layers.0.fusion.gate.weight',shape:[inner,width],dtype:'F32',trainable:false},
  {name:'layers.0.fusion.up.weight',shape:[inner,width],dtype:'F32',trainable:false},
  {name:'layers.0.fusion.down.weight',shape:[width,inner],dtype:'F32',trainable:true}];
const targets=schema.filter(t=>t.trainable);
const [base,a,b,expected,result]=['base','a','b','expected','result'].map(n=>path.join(folder,n+'.safetensors'));
try{
  const value=(name)=>name.endsWith('down.weight')?0:.00025;
  createTensorFile(base,schema,(name,block)=>block.fill(value(name)));
  createTensorFile(a,targets,(_name,block)=>block.fill(.001));
  createTensorFile(b,targets,(_name,block)=>block.fill(.003));
  createTensorFile(expected,schema,(name,block)=>block.fill(name.endsWith('down.weight')?
    (Math.fround(.001)+3*Math.fround(.003))/4:value(name)));
  const prior=verifyTensorFile(base,schema),loadMs=performance.now()-start;
  const memoryBefore=process.memoryUsage();
  const at=performance.now();
  const actual=aggregateTensorFiles({base,schema,output:result,minDevices:2,updates:[{id:'b',device:'b',tokens:3,file:b},{id:'a',device:'a',tokens:1,file:a}]});
  const memoryAfter=process.memoryUsage(),wallMs=performance.now()-at;
  assert.equal(actual.sha256,hashFile(expected));
  assert.equal(actual.frozen,prior.frozen);
  assert.equal(actual.tokens,4);
  const indexed=indexStoredFile(result);
  assert.equal(indexed.sha256,actual.sha256);
  fs.writeFileSync(output,JSON.stringify({classification:'MEASURED',shape:[width,inner],"tensor_payload_bytes":width*inner*3*4,
    artifact_bytes:indexed.bytes,chunks:indexed.parts.length,exact_expected_sha256:actual.sha256,frozen_sha256:actual.frozen,
    reducer_ms:Math.round(wallMs),setup_ms:Math.round(loadMs),rss_before_bytes:memoryBefore.rss,rss_after_bytes:memoryAfter.rss,
    memory_scope:'process samples immediately before and after the bounded file reducer'},null,2)+'\n',{flag:'wx'});
}finally{fs.rmSync(folder,{recursive:true,force:true});}
