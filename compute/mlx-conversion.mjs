import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {hashJSON,sha256,isHex64} from './protocol/hash.mjs';
import {getProfile,schemaHash,targetNames} from './protocol/schema.mjs';
import {fail} from './protocol/errors.mjs';
import {PINNED,officialMlxSource} from './registry.mjs';

const VARIANT='mlx-4bit';
const PROFILE='ministral3b-ffa-r8-v1';
const PIN=PINNED[PROFILE]['cuda-nf4'];
const MAX_FILES=1024, MAX_JSON=8*2**20;
const verifiedImports=new WeakSet();
const invalid=message=>fail('CONVERSION_INVALID',message);
const order=(a,b)=>a<b?-1:a>b?1:0;
const documentation=name=>name.endsWith('.md')||name==='LICENSE'||name==='NOTICE';
const modelData=name=>/\.(json|safetensors|model|tiktoken|txt|jinja|md)$/.test(name)||documentation(name);
const safeName=name=>typeof name==='string'&&name.length<=512&&name.split('/').every(p=>
  /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(p)&&!p.endsWith('.')&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
const quantization=q=>q?.bits===4&&q?.group_size===64&&(q.mode??'affine')==='affine';

function manifestFiles(list){
  if(!Array.isArray(list)||!list.length||list.length>MAX_FILES)invalid('invalid manifest file list');
  const files=new Map(), names=new Set();
  for(const f of list){
    if(!safeName(f?.path)||!Number.isSafeInteger(f.size)||f.size<0||!isHex64(f.sha256)||names.has(f.path.toLowerCase()))invalid('invalid or duplicate manifest file');
    files.set(f.path,{path:f.path,size:f.size,sha256:f.sha256});
    names.add(f.path.toLowerCase());
  }
  return files;
}

async function directory(input){
  if(typeof input!=='string'||!path.isAbsolute(input)||!(await fs.lstat(input)).isDirectory())invalid('choose an absolute model directory');
  return fs.realpath(input);
}

async function inventory(root){
  const names=[], aliases=new Set();
  async function visit(relative,depth){
    if(depth>16)invalid('model directory nesting exceeds the limit');
    const entries=(await fs.readdir(path.join(root,relative),{withFileTypes:true})).sort((a,b)=>order(a.name,b.name));
    const dirs=[];
    for(const e of entries){
      if(e.isSymbolicLink())invalid('linked model files and directories are refused');
      if(e.name.startsWith('.'))continue; // Same inventory as the sidecar and convert_mlx.py; allows the HF cache.
      const name=relative+e.name;
      if(!safeName(name)||aliases.has(name.toLowerCase())||aliases.size>=MAX_FILES)invalid('invalid, duplicate or excessive model paths');
      aliases.add(name.toLowerCase());
      if(e.isFile())names.push(name);
      else if(e.isDirectory())dirs.push(name);
      else invalid('expected a regular model file');
    }
    for(const d of dirs)await visit(d+'/',depth+1);
  }
  await visit('',0);
  return names;
}

async function openRegular(file,check){
  const before=await fs.lstat(file);
  if(!before.isFile()||path.relative(file,await fs.realpath(file))!=='')invalid('linked or non-regular file refused');
  const fd=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const stat=await fd.stat();
    const same=s=>s.isFile()&&s.dev===stat.dev&&s.ino===stat.ino&&s.size===stat.size&&s.mtimeMs===stat.mtimeMs&&s.ctimeMs===stat.ctimeMs;
    if(!same(before))invalid('file changed during verification');
    const result=await check(fd,stat.size);
    if(!same(await fd.stat())||!same(await fs.lstat(file)))invalid('file changed during verification');
    return result;
  }finally{await fd.close();}
}

const readJSON=bytes=>{try{return JSON.parse(bytes.toString('utf8'));}catch{invalid('invalid JSON in conversion files');}};
async function smallFile(file){
  return openRegular(file,async(fd,size)=>{
    if(size>MAX_JSON)invalid('conversion metadata exceeds the size limit');
    return fd.readFile();
  });
}

async function checkFile(root,file,{git=false,readHeader=false,checkResources}){
  return openRegular(path.join(root,file.path),async(fd,size)=>{
    if(size!==file.size)invalid('size mismatch: '+file.path);
    const header=readHeader?await safetensorsHeader(fd,size):null;
    const sha=createHash('sha256'),blob=git?createHash('sha1').update('blob '+size+'\0'):null;
    let nextCheck=0,bytes=0;
    const stream=fd.createReadStream({start:0,autoClose:false,highWaterMark:2**20});
    for await(const chunk of stream){
      if(bytes>=nextCheck){checkResources();nextCheck=bytes+64*2**20;}
      bytes+=chunk.length;
      sha.update(chunk);blob?.update(chunk);
    }
    if(bytes!==size||sha.digest('hex')!==file.sha256)invalid('SHA-256 mismatch: '+file.path);
    return {blob:blob?.digest('hex'),header};
  });
}

async function safetensorsHeader(fd,size){
  const prefix=Buffer.alloc(8);
  if((await fd.read(prefix,0,8,0)).bytesRead!==8)invalid('invalid safetensors prefix');
  const n=prefix.readBigUInt64LE();
  if(n<2n||n>BigInt(MAX_JSON)||n>BigInt(size-8))invalid('invalid safetensors header length');
  const bytes=Buffer.alloc(Number(n));
  if((await fd.read(bytes,0,bytes.length,8)).bytesRead!==bytes.length)invalid('incomplete safetensors header');
  const header=readJSON(bytes);
  if(!header||Array.isArray(header)||typeof header!=='object')invalid('invalid safetensors header');
  const dataBytes=size-8-bytes.length;
  const widths={BOOL:1,U8:1,I8:1,I16:2,U16:2,F16:2,BF16:2,I32:4,U32:4,F32:4,I64:8,U64:8,F64:8};
  const ranges=[];
  for(const [key,t] of Object.entries(header)){
    if(key==='__metadata__')continue;
    const dims=t?.shape, offsets=t?.data_offsets, width=Object.hasOwn(widths,t?.dtype)?widths[t.dtype]:0;
    if(!width||!Array.isArray(dims)||!dims.every(n=>Number.isSafeInteger(n)&&n>=0)||
      !Array.isArray(offsets)||offsets.length!==2||!offsets.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=dataBytes)||
      offsets[1]-offsets[0]!==dims.reduce((n,d)=>n*d,width))invalid('invalid tensor descriptor: '+key.slice(0,128));
    ranges.push(offsets);
  }
  ranges.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let end=0;
  for(const [lo,hi] of ranges){if(lo!==end)invalid('invalid safetensors data layout');end=hi;}
  if(end!==dataBytes)invalid('invalid safetensors data length');
  return header;
}

async function checkedJSON(root,files,name){
  const bytes=await smallFile(path.join(root,name));
  if(sha256(bytes)!==files.get(name)?.sha256)invalid('metadata SHA-256 mismatch: '+name);
  const data=readJSON(bytes);
  if(!data||typeof data!=='object'||Array.isArray(data))invalid('expected a JSON object: '+name);
  return data;
}

function architecture(source,output,profile){
  const a=source.text_config,b=output.text_config;
  const keys=['model_type','hidden_size','num_hidden_layers','num_attention_heads','num_key_value_heads','head_dim','vocab_size','intermediate_size'];
  if(source.dtype!=='bfloat16'||source.model_type!=='mistral3'||output.model_type!==source.model_type||
    hashJSON(output.architectures??null)!==hashJSON(source.architectures??null)||a?.model_type!=='ministral3'||!b||
    keys.some(k=>a[k]!==b[k]||(k!=='model_type'&&(!Number.isSafeInteger(a[k])||a[k]<=0)))||
    b.num_hidden_layers!==profile.layers||b.hidden_size!==profile.targets.q_proj[0]||
    b.num_attention_heads*b.head_dim!==profile.targets.q_proj[1]||
    b.num_key_value_heads*b.head_dim!==profile.targets.v_proj[1]||
    ['model_type','hidden_size','intermediate_size','num_hidden_layers','num_attention_heads','head_dim','patch_size','num_channels','image_size'].some(k=>source.vision_config?.[k]!==output.vision_config?.[k])){
    invalid('model architecture does not match the pinned FFA-LoRA profile');
  }
  for(const q of [output.quantization,output.quantization_config].filter(x=>x!=null)){
    if(!quantization(q)||Object.hasOwn(q,'quant_method'))invalid('output must use 4-bit affine quantization with group size 64');
  }
  if(!quantization(output.quantization))invalid('MLX quantization configuration is missing');
  const quantDigest=q=>hashJSON({...q,mode:q.mode??'affine'});
  if(output.quantization_config&&quantDigest(output.quantization)!==quantDigest(output.quantization_config)){
    invalid('MLX quantization configurations disagree');
  }
  return {...Object.fromEntries(keys.map(k=>[k,b[k]])),outer_model_type:output.model_type};
}

function checkTargets(tensors,profile,quant){
  for(const target of targetNames(profile)){
    const module='language_model.model.'+target,[input,output]=profile.targets[target.split('.').at(-1)];
    for(const name of [module,'model.'+target]){
      if(Object.hasOwn(quant,name)&&!quantization(quant[name]))invalid('incompatible quantization override: '+target);
    }
    for(const part of ['weight','scales','biases']){
      const t=tensors.get(module+'.'+part),isWeight=part==='weight',shape=[output,isWeight?input/8:input/64];
      if(!t||t.shape.length!==2||t.shape.some((n,i)=>n!==shape[i])||
        (isWeight?t.dtype!=='U32':!['F16','BF16','F32'].includes(t.dtype)))invalid('missing or incompatible FFA-LoRA tensor: '+target+'.'+part);
    }
  }
}

export async function verifyLocalConversion({profile_id,manifest_file,source_dir,output_dir,reviewed}, {getSource=officialMlxSource,now=Date.now,checkResources=()=>{}}={}){
  if(profile_id!==PROFILE||reviewed!==true)invalid('review the local conversion and confirm the supported model profile');
  checkResources();
  if(typeof manifest_file!=='string'||!path.isAbsolute(manifest_file))invalid('choose a conversion manifest file');
  const source=await directory(source_dir),output=await directory(output_dir);
  // macOS exposes some directories through aliases such as /var -> /private/var.
  // Resolve the parent only so openRegular still rejects a linked manifest file.
  const manifestPath=path.join(await fs.realpath(path.dirname(manifest_file)),path.basename(manifest_file));
  const inside=(parent,child)=>{const d=path.relative(parent,child);return d===''||(!path.isAbsolute(d)&&d!=='..'&&!d.startsWith('..'+path.sep));};
  if(inside(source,output)||inside(output,source)||inside(source,manifestPath)||inside(output,manifestPath))invalid('source, output and external manifest must be separate');
  const raw=await smallFile(manifestPath),m=readJSON(raw);
  if(m?.source_repo!==PIN.source_repo||m.source_revision!==PIN.source_revision)invalid('conversion source must be the pinned official BF16 revision');
  if(!quantization(m.quantization))invalid('manifest must declare 4-bit affine quantization with group size 64');
  const sourceFiles=manifestFiles(m.source_files),outputFiles=manifestFiles(m.output_files);
  const srcNames=await inventory(source),outNames=await inventory(output);
  if(outNames.length!==outputFiles.size||outNames.some(n=>!outputFiles.has(n)||!modelData(n)))invalid('output inventory differs from the manifest or contains unsupported files');
  if(!outNames.includes('config.json')||!outNames.some(n=>n.endsWith('.safetensors')))invalid('output requires config.json and safetensors');

  let info;
  checkResources('network');
  try{info=await getSource();}catch{fail('CONVERSION_SOURCE_UNAVAILABLE','could not verify the official source revision with Hugging Face');}
  if(info?.sha!==PIN.source_revision||String(info.id??info.modelId).toLowerCase()!==PIN.source_repo.toLowerCase()||
    !Array.isArray(info.siblings)||info.siblings.length>MAX_FILES)invalid('Hugging Face returned unexpected source metadata');
  const expected=new Map(info.siblings.filter(s=>s.rfilename!=='consolidated.safetensors'&&safeName(s.rfilename)&&modelData(s.rfilename)).map(s=>[s.rfilename,s]));
  if(!expected.has('config.json')||![...expected.keys()].some(n=>n.endsWith('.safetensors')))invalid('official source inventory is incomplete');
  const published=[];
  const srcSet=new Set(srcNames);
  for(const [name,remote] of expected){
    if(documentation(name)&&!sourceFiles.has(name)&&!srcSet.has(name))continue;
    const f=sourceFiles.get(name);
    if(!f||!srcSet.has(name)||f.size!==remote.size)invalid('missing or mismatched official source file: '+name);
    const sha=remote.lfs?.sha256??remote.lfs?.oid;
    if(remote.lfs&&(!isHex64(sha)||sha!==f.sha256))invalid('official LFS SHA-256 mismatch: '+name);
    const {blob}=await checkFile(source,f,{git:!remote.lfs,checkResources});
    if(!remote.lfs&&blob!==remote.blobId)invalid('official Git blob mismatch: '+name);
    published.push({...f,publisher_hash:remote.lfs?{kind:'lfs_sha256',value:sha}:{kind:'git_blob_sha1',value:blob}});
  }
  if(published.length!==sourceFiles.size||srcNames.some(n=>!expected.has(n)))invalid('source inventory contains files outside the pinned revision');
  const profile=getProfile(PROFILE);
  const sourceConfig=await checkedJSON(source,sourceFiles,'config.json'),outConfig=await checkedJSON(output,outputFiles,'config.json');
  const sourceIndex=(await checkedJSON(source,sourceFiles,'model.safetensors.index.json')).weight_map;
  const arch=architecture(sourceConfig,outConfig,profile);
  for(const name of ['config.json','tokenizer_config.json','processor_config.json','preprocessor_config.json']){
    if(!outputFiles.has(name))continue;
    const cfg=name==='config.json'?outConfig:await checkedJSON(output,outputFiles,name);
    if(cfg.auto_map||cfg.custom_pipelines||cfg.model_file||cfg.text_config?.auto_map||cfg.text_config?.ple_storage||
      (name==='config.json'&&(cfg.dflash_config||cfg.quantize_activations)))invalid('custom model or tokenizer code and auxiliary loaders are refused');
  }
  const tensors=new Map(),weightMap=new Map();
  for(const name of outNames){
    const weights=name.endsWith('.safetensors');
    if(weights&&(name.includes('/')||name==='consolidated.safetensors'))invalid('expected MLX weight shards in the model root');
    const {header}=await checkFile(output,outputFiles.get(name),{readHeader:weights,checkResources});
    if(header)for(const [key,t] of Object.entries(header)){
      if(key==='__metadata__')continue;
      if(tensors.has(key))invalid('duplicate tensor across output shards');
      tensors.set(key,t);weightMap.set(key,name);
    }
  }
  checkTargets(tensors,profile,outConfig.quantization);
  const languageWeights=Object.keys(sourceIndex??{}).filter(k=>k.startsWith('language_model.'));
  if(!languageWeights.length||languageWeights.some(k=>!tensors.has(k)))invalid('MLX output is missing language model tensors from the official index');
  if(outputFiles.has('model.safetensors.index.json')){
    const index=(await checkedJSON(output,outputFiles,'model.safetensors.index.json')).weight_map;
    if(!index||Object.keys(index).length!==tensors.size||[...weightMap].some(([k,v])=>index[k]!==v))invalid('safetensors shard index differs from the files');
  }
  const output_files=outNames.map(n=>outputFiles.get(n)),files_digest=hashJSON(output_files);
  const versions=Object.fromEntries(['mlx','mlx-vlm','transformers','huggingface_hub'].filter(k=>
    typeof m.versions?.[k]==='string'&&/^[a-zA-Z0-9.+_-]{1,64}$/.test(m.versions[k])).map(k=>[k,m.versions[k]]));
  const proof=Object.freeze({
    format:'kvalah-mlx-conversion/1', profile_id:PROFILE,variant_id:VARIANT,files_digest,schema_hash:schemaHash(profile),
    source:{status:'official_revision_verified',repo:PIN.source_repo,revision:PIN.source_revision,files:published.sort((a,b)=>order(a.path,b.path))},
    conversion:{status:'local_attestation',publisher_signed:false,admin_reviewed:true,verified_at:now(),manifest_sha256:sha256(raw),
      output_files,architecture:arch,quantization:{mode:'affine',bits:4,group_size:64},declared_versions:versions,
      declared_created_utc:typeof m.created_utc==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.created_utc)?m.created_utc:null}
  });
  verifiedImports.add(proof);
  return proof;
}

export const verifiedConversionImport=proof=>verifiedImports.has(proof);
export function researchProvenance(v){
  if(v.variant_id!==VARIANT)return v.provenance==='verified';
  const p=v.manifest?.local_conversion;
  return v.provenance==='locally_attested'&&p?.format==='kvalah-mlx-conversion/1'&&p.profile_id===PROFILE&&
    p.variant_id===VARIANT&&p.files_digest===v.files_digest&&p.schema_hash===schemaHash(getProfile(PROFILE))&&
    p.source?.status==='official_revision_verified'&&p.source.repo===PIN.source_repo&&p.source.revision===PIN.source_revision&&
    p.conversion?.status==='local_attestation'&&p.conversion.publisher_signed===false&&p.conversion.admin_reviewed===true&&
    Array.isArray(p.conversion.output_files)&&hashJSON(p.conversion.output_files)===v.files_digest;
}
