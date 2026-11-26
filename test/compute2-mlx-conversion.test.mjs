import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {tmp,FIXTURE,jsTokenizer} from './compute-helpers.mjs';
import {verifyLocalConversion,researchProvenance} from '../compute/mlx-conversion.mjs';
import {PINNED} from '../compute/registry.mjs';
import {createCoordinator} from '../compute/coordinator/coordinator.mjs';
import {parseJSONL,buildDataset} from '../compute/datasets/engine.mjs';
import {getProfile,targetNames} from '../compute/protocol/schema.mjs';
import {hashJSON,sha256} from '../compute/protocol/hash.mjs';

const profile_id='ministral3b-ffa-r8-v1',variant_id='mlx-4bit';
const pin=PINNED[profile_id]['cuda-nf4'];
const quant={group_size:64,bits:4};
const baseConfig={dtype:'bfloat16',model_type:'mistral3',architectures:['Mistral3ForConditionalGeneration'],
  text_config:{model_type:'ministral3',hidden_size:3072,num_hidden_layers:26,num_attention_heads:32,num_key_value_heads:8,head_dim:128,vocab_size:131072,intermediate_size:9216}};
function json(dir,name,data){
  const b=Buffer.from(JSON.stringify(data,null,2)+'\n');fs.writeFileSync(path.join(dir,name),b);
  return {path:name,size:b.length,sha256:sha256(b)};
}
function outputWeights(folder){
  const p=getProfile(profile_id),descriptors={};
  let offset=0;
  for(const target of targetNames(p)){
    const [input,output]=p.targets[target.split('.').at(-1)];
    for(const part of ['weight','scales','biases']){
      const packed=part==='weight',dtype=packed?'U32':'BF16',shape=[output,input/(packed?8:64)];
      const end=offset+shape[0]*shape[1]*(packed?4:2);
      descriptors['language_model.model.'+target+'.'+part]={dtype,shape,data_offsets:[offset,end]};
      offset=end;
    }
  }
  const meta=Buffer.from(JSON.stringify(descriptors)),len=Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(meta.length));
  const name='model.safetensors',header=Buffer.concat([len,meta]),file=path.join(folder,name),size=header.length+offset;
  fs.writeFileSync(file,header);fs.truncateSync(file,size);
  const zeros=Buffer.alloc(2**20),h=createHash('sha256').update(header);
  for(let n=offset;n>0;n-=zeros.length)h.update(zeros.subarray(0,Math.min(n,zeros.length)));
  return {file:{path:name,size,sha256:h.digest('hex')},weightNames:Object.keys(descriptors).filter(k=>k.endsWith('.weight'))};
}

test('local MLX import checks publisher files, output bytes, FFA-LoRA layout and Research provenance',async t=>{
  const dir=tmp('kc-mlx-proof-'),source_dir=path.join(dir,'bf16'),output_dir=path.join(dir,'mlx');
  const manifest_file=path.join(dir,'model.provenance.json');
  fs.mkdirSync(source_dir);fs.mkdirSync(output_dir);
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  // Synthetic bytes and independent Hub metadata. This test never treats zeros as actual official weights.
  const {file,weightNames}=outputWeights(output_dir);
  const bfConfig=json(source_dir,'config.json',baseConfig);
  const bfIndex=json(source_dir,'model.safetensors.index.json',{weight_map:Object.fromEntries(weightNames.map(name=>[name,'model.safetensors']))});
  const bfFile={path:'model.safetensors',size:4,sha256:sha256('bf16')};
  fs.writeFileSync(path.join(source_dir,bfFile.path),'bf16');
  const outConfig=json(output_dir,'config.json',{...baseConfig,quantization:quant});
  const tokenizer=json(output_dir,'tokenizer_config.json',{tokenizer_class:'PreTrainedTokenizerFast'});
  const m={source_repo:pin.source_repo,source_revision:pin.source_revision,source_files:[bfConfig,bfFile,bfIndex],
    output_files:[file,tokenizer,outConfig],quantization:quant,command:['/private/user/python','-m','mlx_vlm.convert'],
    versions:{mlx:'0.30.0'},status:'local conversion recorded; not a signed attestation'};
  const metadata={id:m.source_repo,sha:m.source_revision,siblings:m.source_files.map(f=>{
    const bytes=fs.readFileSync(path.join(source_dir,f.path));
    return {rfilename:f.path,size:f.size,
      ...(f===bfFile?{lfs:{sha256:f.sha256}}:{blobId:createHash('sha1').update('blob '+f.size+'\0').update(bytes).digest('hex')})};
  })};
  const args={profile_id,manifest_file,source_dir,output_dir,reviewed:true};
  const save=m=>fs.writeFileSync(manifest_file,JSON.stringify(m,null,2));
  const verify=(patch={},opts={})=>verifyLocalConversion({...args,...patch},{getSource:async()=>metadata,now:()=>123,...opts});
  const invalid={code:'CONVERSION_INVALID'};
  save(m);
  await assert.rejects(verify({reviewed:false}),invalid);
  await assert.rejects(verify({profile_id:'tiny-test-ffa-r4'}),invalid);
  await assert.rejects(verify({}, {getSource:async()=>{throw Error('offline');}}),{code:'CONVERSION_SOURCE_UNAVAILABLE'});
  await assert.rejects(verify({}, {getSource:async()=>({...metadata,sha:'0'.repeat(40)})}),invalid);
  save({...m,source_revision:'0'.repeat(40)});
  await assert.rejects(verify(),invalid);
  save({...m,output_files:[...m.output_files,{...file,path:'../model.safetensors'}]});
  await assert.rejects(verify(),invalid);
  save({...m,output_files:[...m.output_files,{...file,path:'MODEL.safetensors'}]});
  await assert.rejects(verify(),invalid);
  save({...m,source_files:[bfConfig,bfIndex]});
  await assert.rejects(verify(),invalid);
  save(m);
  fs.renameSync(path.join(source_dir,bfFile.path),path.join(dir,'missing'));
  await assert.rejects(verify(),invalid);
  fs.renameSync(path.join(dir,'missing'),path.join(source_dir,bfFile.path));
  fs.writeFileSync(path.join(source_dir,bfFile.path),'evil');
  await assert.rejects(verify(),/SHA-256 mismatch/);
  save({...m,source_files:[bfConfig,{...bfFile,sha256:sha256('evil')},bfIndex]});
  await assert.rejects(verify(),/official LFS SHA-256 mismatch/);
  fs.writeFileSync(path.join(source_dir,bfFile.path),'bf16');
  save(m);
  await assert.rejects(verify({}, {getSource:async()=>({...metadata,siblings:metadata.siblings.map(f=>f.blobId?{...f,blobId:'a'.repeat(40)}:f)})}),/Git blob mismatch/);
  for(const [config,error] of [
    [{...baseConfig,quantization:{...quant,bits:8}},/4-bit/],
    [{...baseConfig,text_config:{...baseConfig.text_config,num_hidden_layers:25},quantization:quant},/architecture/],
    [{...baseConfig,quantization:quant,model_file:'/tmp/untrusted.py'},/custom model/],
  ]){
    const bad=json(output_dir,'config.json',config);
    save({...m,output_files:[file,tokenizer,bad]});
    await assert.rejects(verify(),error);
  }
  const actual=json(output_dir,'config.json',{...baseConfig,quantization:quant});
  assert.deepEqual(actual,outConfig);
  save(m);
  fs.writeFileSync(path.join(output_dir,'untracked.py'),'ignored');
  await assert.rejects(verify(),/output inventory/);
  fs.unlinkSync(path.join(output_dir,'untracked.py'));
  save({...m,output_files:[file,{...tokenizer,sha256:'0'.repeat(64)},outConfig]});
  await assert.rejects(verify(),/metadata SHA-256 mismatch/);
  save(m);
  const proof=await verify();
  const expected=hashJSON([outConfig,file,tokenizer]);
  assert.equal(proof.files_digest,expected,'digest uses the sidecar file order and canonical encoding');
  assert.equal(proof.source.status,'official_revision_verified');
  assert.equal(proof.conversion.status,'local_attestation');
  assert.equal(proof.conversion.publisher_signed,false);
  assert.ok(!JSON.stringify(proof).includes('/private/user'));

  // Alter one packed target descriptor, keeping the layout and checksums internally consistent.
  const weightFile=path.join(output_dir,file.path),fd=fs.openSync(weightFile,'r+'),length=Buffer.alloc(8);
  fs.readSync(fd,length,0,8,0);
  const header=Buffer.alloc(Number(length.readBigUInt64LE()));
  fs.readSync(fd,header,0,header.length,8);
  const altered=Buffer.from(header.toString().replace('"dtype":"U32"','"dtype":"F32"'));
  fs.writeSync(fd,altered,0,altered.length,8);fs.closeSync(fd);
  await assert.rejects(verify(),/SHA-256 mismatch: model.safetensors/);
  const updated=createHash('sha256');
  for await(const chunk of fs.createReadStream(weightFile))updated.update(chunk);
  save({...m,output_files:[{...file,sha256:updated.digest('hex')},tokenizer,outConfig]});
  await assert.rejects(verify(),/FFA-LoRA tensor/);

  const c=createCoordinator({dir:path.join(dir,'lab')});
  try{
    const rows=parseJSONL(fs.readFileSync(FIXTURE,'utf8')).rows.map(r=>({...r,quality_flags:[]}));
    const ds=await buildDataset({rows,datasetId:'pilot',revision:'1',profileId:profile_id,maxLength:256,tokenizer:jsTokenizer});
    const {id:dataset_id}=c.registerDataset(ds.manifest,ds.shards);
    const input={profile_id,variants:[variant_id],dataset_id,name:'test',rounds:1};
    const registration={profile_id,variant_id,files_digest:expected};
    c.registerVariant({...registration,provenance:'verified',manifest:{local_conversion:proof}});
    assert.equal(c.variants()[0].provenance,'unverified');
    assert.equal(c.variants()[0].manifest.local_conversion,undefined);
    assert.throws(()=>c.registerVariant({...registration,conversion:structuredClone(proof)}),{code:'MODEL_UNVERIFIED'});
    const research={...input,preset:'research',research_confirmed:true};
    assert.throws(()=>c.createExperiment(research),{code:'MODEL_UNVERIFIED'});
    c.registerVariant({...registration,conversion:proof});
    assert.ok(researchProvenance(c.variants()[0]));
    assert.throws(()=>c.createExperiment({...research,research_confirmed:false}),{code:'MODEL_UNVERIFIED'});
    assert.throws(()=>c.createExperiment(research),{code:'INVALID_TRANSITION'},'completed pilot still required');
    const pilot=c.createExperiment({...input,preset:'pilot'});
    c.db.prepare("update experiments set state='COMPLETED' where id=?").run(pilot.id);
    const run=c.createExperiment(research);
    const snapshot=c.status(run.id).model_snapshot;
    assert.equal(snapshot[0].provenance,'locally_attested');
    assert.deepEqual(snapshot[0].manifest.local_conversion,proof);
    c.registerVariant(registration);
    assert.equal(c.variants()[0].provenance,'locally_attested','a matching worker advertisement preserves attestation');
    c.registerVariant({...registration,files_digest:'2'.repeat(64)});
    assert.equal(c.variants()[0].provenance,'unverified');
    assert.deepEqual(c.status(run.id).model_snapshot,snapshot);
    assert.throws(()=>c.createExperiment(research),{code:'MODEL_UNVERIFIED'});
  }finally{c.close();}
});
