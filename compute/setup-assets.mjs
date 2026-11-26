import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {ComputeError} from './protocol/errors.mjs';
import {hashJSON} from './protocol/hash.mjs';
import {PINNED} from './registry.mjs';

const trustedHosts=new Set(['huggingface.co','files.pythonhosted.org','download.pytorch.org','download-r2.pytorch.org']);
const allowedModel=/^(?:[a-z0-9_-]+\.safetensors|model\.safetensors\.index\.json|(?:config|generation_config|tokenizer|tokenizer_config|processor_config|preprocessor_config|special_tokens_map|added_tokens|vocab|tekken|chat_template)\.json|tokenizer\.model|merges\.txt|chat_template\.jinja)$/i;
const safeName=/^[a-z0-9][a-z0-9_.+!-]{0,219}$/i;

async function fetchTrusted(url,options){
  let next=new URL(url);
  for(let hop=0;hop<5;hop++){
    const host=next.hostname;
    if(next.protocol!=='https:'||next.username||next.password||(next.port&&next.port!=='443')||
      !(trustedHosts.has(host)||host.endsWith('.xethub.hf.co')||host.endsWith('.huggingface.co'))){
      throw new ComputeError('FORBIDDEN_SCOPE','untrusted artifact host');
    }
    const res=await fetch(next,{...options,redirect:'manual'});
    if(![301,302,303,307,308].includes(res.status))return res;
    const location=res.headers.get('location');
    await res.body?.cancel().catch(()=>{});
    if(!location)break;
    next=new URL(location,next);
  }
  throw new ComputeError('UNAVAILABLE','artifact redirect failed');
}

export async function modelAssets(profile,variant,signal){
  const pinned=PINNED[profile]?.[variant];
  if(!pinned)return null;
  const prefix='https://huggingface.co/'+pinned.source_repo;
  const url='https://huggingface.co/api/models/'+pinned.source_repo+'/tree/'+pinned.source_revision;
  const response=await fetchTrusted(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
  if([401,403].includes(response.status))throw new ComputeError('FORBIDDEN_SCOPE','model requires provider access');
  if(!response.ok)throw new ComputeError('UNAVAILABLE','model metadata is unavailable');
  const entries=await response.json();
  if(!Array.isArray(entries)||response.headers.has('link'))throw new ComputeError('MODEL_REQUIRED','model inventory is incomplete');
  const hasTransformersWeights=entries.some(f=>f.type==='file'&&(f.path==='model.safetensors'||f.path==='model.safetensors.index.json'));
  const files=entries.filter(f=>f.type==='file'&&allowedModel.test(f.path)&&(!hasTransformersWeights||f.path!=='consolidated.safetensors')).map(f=>({
    name:f.path,size:f.size,hash:f.lfs?.oid||f.oid,algorithm:f.lfs?'sha256':'git-sha1',
    url:prefix+'/resolve/'+pinned.source_revision+'/'+encodeURIComponent(f.path)
  }));
  if(!files.some(f=>f.name.endsWith('.safetensors'))||!files.some(f=>f.name==='config.json'))throw new ComputeError('MODEL_REQUIRED','model inventory does not include weights and config');
  return {kind:'model',id:hashJSON([pinned,files]),files,variant,pinned};
}

export function runtimeAssets(backend,platform,arch){
  const target=platform==='win32'&&arch==='x64'&&backend==='cuda'?'windows-cuda':
    platform==='darwin'&&arch==='arm64'&&backend==='mlx'?'macos-mlx':null;
  if(!target)return null;
  const file=fileURLToPath(new URL('./runtime/'+target+'.json',import.meta.url));
  if(!fs.existsSync(file))return null;
  const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
  return {kind:'runtime',id:hashJSON(manifest),...manifest};
}

async function checkFile(file,asset,signal){
  const info=fs.statSync(file,{throwIfNoEntry:false});
  if(!info?.isFile()||info.size!==asset.size)return false;
  const hash=createHash(asset.algorithm==='git-sha1'?'sha1':'sha256');
  if(asset.algorithm==='git-sha1')hash.update('blob '+asset.size+'\0');
  for await(const chunk of fs.createReadStream(file,{signal}))hash.update(chunk);
  return hash.digest('hex')===asset.hash;
}

function validate(asset){
  if(!safeName.test(asset.name)||asset.name.includes('..')||!Number.isSafeInteger(asset.size)||asset.size<=0||
    !((asset.algorithm==='sha256'&&/^[a-f0-9]{64}$/.test(asset.hash))||(asset.algorithm==='git-sha1'&&/^[a-f0-9]{40}$/.test(asset.hash)))){
    throw new ComputeError('INVALID_SCHEMA','invalid artifact manifest');
  }
}

export async function downloadAssets(plan,{root,governor,signal,approve,progress}){
  const keys=new Set();
  for(const asset of plan.files){
    validate(asset);
    if(keys.has(asset.name.toLowerCase()))throw new ComputeError('INVALID_SCHEMA','duplicate artifact filename');
    keys.add(asset.name.toLowerCase());
  }
  const target=path.join(root,plan.id),staging=target+'.partial';
  fs.mkdirSync(root,{recursive:true});
  if(fs.existsSync(target)){
    for(const asset of plan.files)if(!await checkFile(path.join(target,asset.name),asset,signal))throw new ComputeError('HASH_MISMATCH','a verified artifact was modified');
    return target;
  }
  const complete=new Set();
  for(const asset of plan.files){
    if(await checkFile(path.join(staging,asset.name),asset,signal))complete.add(asset.name);
    const part=path.join(staging,asset.name+'.part'),info=fs.statSync(part,{throwIfNoEntry:false});
    if(info&&(info.size>asset.size||info.size===asset.size&&!await checkFile(part,asset,signal)))fs.rmSync(part,{force:true});
  }
  const remaining=asset=>complete.has(asset.name)?0:Math.max(0,asset.size-(fs.statSync(path.join(staging,asset.name+'.part'),{throwIfNoEntry:false})?.size||0));
  const total=plan.files.reduce((sum,asset)=>sum+asset.size,0),needed=plan.files.reduce((sum,asset)=>sum+remaining(asset),0);
  const {bavail,bsize}=fs.statfsSync(root),diskBytes=needed+(plan.kind==='runtime'?total*3:0);
  if(bavail*bsize<diskBytes)throw new ComputeError('DISK_SPACE','insufficient disk space');
  if(needed&&!approve({id:plan.id,kind:plan.kind,bytes:needed,total_bytes:total,disk_bytes:diskBytes})){
    throw new ComputeError('DOWNLOAD_APPROVAL','download consent is required');
  }
  fs.mkdirSync(staging,{recursive:true});
  let done=total-needed;
  for(const asset of plan.files){
    signal.throwIfAborted();
    const file=path.join(staging,asset.name),part=file+'.part';
    if(complete.has(asset.name))continue;
    let offset=asset.size-remaining(asset);
    if(offset<asset.size){
      const decision=governor.decide({phase:'network',localAction:true});
      if(!decision.run&&!['user_active','game'].includes(decision.reason))throw new ComputeError('PAUSED','setup transfer paused',{reason:decision.reason});
      const allowance=Math.min(asset.size-offset,governor.trafficRemaining());
      if(allowance<=0)throw new ComputeError('PAUSED','daily traffic budget exhausted',{reason:'traffic_cap'});
      const end=offset+allowance-1;
      const range=offset>0||end<asset.size-1;
      const res=await fetchTrusted(asset.url,{signal:AbortSignal.any([signal,AbortSignal.timeout(1800000)]),headers:range?{Range:'bytes='+offset+'-'+end}:{}});
      if((range&&(res.status!==206||res.headers.get('content-range')!==`bytes ${offset}-${end}/${asset.size}`))||(!range&&res.status!==200)||!res.body){
        await res.body?.cancel().catch(()=>{});
        throw new ComputeError('UNAVAILABLE','artifact download failed or cannot resume safely');
      }
      let read=0,unaccounted=0;
      const guard=new Transform({transform(chunk,_encoding,callback){
        read+=chunk.length;unaccounted+=chunk.length;
        try{
          if(unaccounted>=8*1024*1024){governor.accountTraffic(unaccounted);unaccounted=0;}
          progress({bytes:Math.min(total,done+read),total_bytes:total});
          if(read>allowance)throw new ComputeError('TRAFFIC_CAP','artifact response exceeds the allowed transfer');
          callback(null,chunk);
        }catch(error){callback(error);}
      }});
      try{await pipeline(Readable.fromWeb(res.body),guard,fs.createWriteStream(part,{flags:offset?'a':'w',mode:0o600}),{signal});}
      finally{if(unaccounted)governor.accountTraffic(unaccounted);}
      if(read!==allowance)throw new ComputeError('UNAVAILABLE','artifact transfer was interrupted');
      done+=read;
      if(offset+read<asset.size)throw new ComputeError('PAUSED','daily traffic budget exhausted',{reason:'traffic_cap'});
    }
    if(!await checkFile(part,asset,signal)){
      fs.rmSync(part,{force:true});
      throw new ComputeError('HASH_MISMATCH','downloaded artifact differs from its recorded digest');
    }
    fs.renameSync(part,file);
  }
  fs.renameSync(staging,target);
  return target;
}

function execute(python,args,signal){
  return new Promise((resolve,reject)=>{
    const child=spawn(python,args,{signal,windowsHide:true,stdio:'ignore',
      env:{...process.env,PYTHONNOUSERSITE:'1',PYTHONPATH:'',PIP_CONFIG_FILE:osNull(),PIP_DISABLE_PIP_VERSION_CHECK:'1'}});
    child.once('error',reject);
    child.once('close',code=>code===0?resolve():reject(new ComputeError('RUNTIME_REQUIRED','managed runtime setup failed')));
  });
}
const osNull=()=>process.platform==='win32'?'NUL':'/dev/null';

export async function createManagedRuntime({bootstrap,wheelDir,environment,plan,signal}){
  const python=path.join(environment,...(process.platform==='win32'?['Scripts','python.exe']:['bin','python']));
  await execute(bootstrap,['-I','-c','import sys; assert sys.version_info[:2] == (3, 12)'],signal);
  if(!fs.existsSync(python))await execute(bootstrap,['-I','-m','venv',environment],signal);
  await execute(python,['-I','-m','pip','--isolated','install','--no-index','--no-deps','--force-reinstall',
    ...plan.files.map(asset=>path.join(wheelDir,asset.name))],signal);
  await execute(python,['-I','-m','pip','--isolated','check'],signal);
  return python;
}
