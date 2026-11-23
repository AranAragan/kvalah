// llama.cpp integration for "Pool memory": one model split across devices with the RPC backend.
// Worker: ggml-rpc-server bound to 127.0.0.1 (reached only through kvalah's authenticated tunnel).
// Host:   llama-server --rpc 127.0.0.1:<tunnel>,... serving an OpenAI-compatible API on 127.0.0.1.
import fs from 'node:fs/promises';
import {createWriteStream,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {Readable,Transform} from 'node:stream';

// Pinned build: every kvalah 0.8.x device downloads the same llama.cpp, because the RPC protocol
// must match on host and workers. Digests come from the GitHub release (verified after download).
export const LLAMA_BUILD='b12651';
const ASSETS={
  'llama-b12651-bin-win-cpu-x64.zip':'b2d794fa7587aba29f654d717ff9b73e31caeabf50a7766692903008bbe0855d',
  'llama-b12651-bin-win-vulkan-x64.zip':'e58fa9a137d8046c69334005ad6fb3e904ddc7e56f2a61ad1b844335826ef3f4',
  'llama-b12651-bin-win-cuda-12.4-x64.zip':'1a6c090f76fab41260b5b7597c6fb1add1fad2efaac692ae2673a22366220a29',
  'cudart-llama-bin-win-cuda-12.4-x64.zip':'8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
  'llama-b12651-bin-win-cpu-arm64.zip':'756a62761e476536f007c866d46fa14125f6ca32d98cee6af14685659bd9f244',
  'llama-b12651-bin-win-vulkan-arm64.zip':'430849ca03a2a891baa90091670df45f29b90c2ec445aab2ad7d830ff423303c',
  'llama-b12651-bin-macos-arm64.tar.gz':'264fd872de61679c45ad57e1e21c2a2a54e29b35734ecf3d50f24166447ab8d2',
  'llama-b12651-bin-macos-x64.tar.gz':'34c19771545479a783d3b68c446383ab703033890c052d3ff0b860a5c9f59e56',
  'llama-b12651-bin-ubuntu-x64.tar.gz':'17b242259181d5b1b1f7719aba27929700a8b0dab39bfaef1b971a992b397b38',
  'llama-b12651-bin-ubuntu-vulkan-x64.tar.gz':'0bbcf2093f15c64c8a9bf54b809c9b2c812b982992dc2fbc9b36720c1d32cf13',
  'llama-b12651-bin-ubuntu-cuda-12.8-x64.tar.gz':'cb099350c6a025e67eefaa13f2b67b2dcce53e38a0da22476e070d166ef367ea',
  'cudart-llama-b12651-bin-ubuntu-cuda-12.8-x64.tar.gz':'485df8f0b0ab30c15807d25fd23a821aeaef62a3947722c683429491a5e0d027',
  'llama-b12651-bin-ubuntu-arm64.tar.gz':'b4a8d17e16a1b42f6a1395dc5cd6967ec0d98005eb3be85b7eb893b082306ed4',
  'llama-b12651-bin-ubuntu-vulkan-arm64.tar.gz':'138f97d9d448b7a55c4b839366bba6e2ac7fba634f9160c9a4775a2051a1c7cb'
};
export const BACKENDS=['auto','cpu','vulkan','cuda','metal'];
const releaseUrl=name=>'https://github.com/ggml-org/llama.cpp/releases/download/'+LLAMA_BUILD+'/'+name;

// Archives for a platform/arch/backend. 'auto' = Metal on macOS, Vulkan elsewhere (it falls back
// to the bundled CPU backend when no Vulkan driver is present).
export function pickAssets({platform=process.platform,arch=process.arch,backend='auto'}={},assets=ASSETS){
  const b=`llama-${LLAMA_BUILD}-bin-`;
  let want=backend==='auto'?(platform==='darwin'?'metal':'vulkan'):backend;
  let names;
  if(platform==='darwin'){
    if(!['arm64','x64'].includes(arch))return null;
    names=[`${b}macos-${arch}.tar.gz`];want='metal';
  }else if(platform==='win32'){
    const a=arch==='arm64'?'arm64':arch==='x64'?'x64':null;if(!a)return null;
    if(want==='cuda'&&a==='x64')names=[`${b}win-cuda-12.4-x64.zip`,'cudart-llama-bin-win-cuda-12.4-x64.zip'];
    else if(want==='vulkan')names=[`${b}win-vulkan-${a}.zip`];
    else{names=[`${b}win-cpu-${a}.zip`];want='cpu';}
  }else if(platform==='linux'){
    const a=arch==='arm64'?'arm64':arch==='x64'?'x64':null;if(!a)return null;
    if(want==='cuda'&&a==='x64')names=[`${b}ubuntu-cuda-12.8-x64.tar.gz`,`cudart-llama-${LLAMA_BUILD}-bin-ubuntu-cuda-12.8-x64.tar.gz`];
    else if(want==='vulkan')names=[`${b}ubuntu-vulkan-${a}.tar.gz`];
    else{names=[`${b}ubuntu-${a}.tar.gz`];want='cpu';}
  }else return null;
  if(!names.every(n=>assets[n]))return null;
  return {backend:want,build:LLAMA_BUILD,files:names.map(name=>({name,url:releaseUrl(name),sha256:assets[name]}))};
}

const HOST_PORT=/^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):\d{1,5}$/;
const port=v=>{const n=Number(v);if(!Number.isInteger(n)||n<1||n>65535)throw Error('Invalid port: '+v);return String(n);};
export function rpcServerArgs({port:p,host='127.0.0.1',cache=true,threads,devices}={}){
  const args=['-H',host,'-p',port(p)];
  if(cache)args.push('-c');
  if(threads)args.push('-t',String(Math.max(1,Math.floor(threads))));
  if(devices?.length)args.push('-d',devices.join(','));
  return args;
}
// llama-server command line. Without the local GPU, only RPC devices (RPC0..N-1 in --rpc order) get layers.
export function llamaServerArgs({model,rpc=[],port:p,ctx=8192,localGpu=true,alias='pool',apiKey,gpuLayers=999,host='127.0.0.1'}){
  if(typeof model!=='string'||!model.trim())throw Error('Choose a GGUF model file');
  for(const r of rpc)if(!HOST_PORT.test(r))throw Error('Invalid RPC address: '+r);
  if(!rpc.length&&!localGpu)throw Error('Select at least one device');
  const c=Number(ctx);if(!Number.isInteger(c)||c<512||c>1048576)throw Error('Invalid context size');
  // One slot (-np 1): the whole context window goes to the single agent conversation.
  const args=['-m',model,'--host',host,'--port',port(p),'-c',String(c),'-ngl',String(gpuLayers),'-np','1','--alias',alias,'--jinja'];
  if(rpc.length)args.push('--rpc',rpc.join(','));
  if(!localGpu)args.push('--device',rpc.map((_,i)=>'RPC'+i).join(','));
  if(apiKey)args.push('--api-key',apiKey);
  return args;
}
// "  RPC0: 127.0.0.1:50152 (16002 MiB, 15000 MiB free)" lines from --list-devices.
export function parseListDevices(text){
  const out=[];
  for(const line of String(text||'').split(/\r?\n/)){
    const m=/^\s*([A-Za-z][\w-]*\d*):\s*(.*?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/.exec(line);
    if(m)out.push({name:m[1],description:m[2],totalMiB:Number(m[3]),freeMiB:Number(m[4])});
  }
  return out;
}

// GGUF models already downloaded by Ollama: manifests/<registry>/<namespace>/<model>/<tag> → blobs/sha256-<hex>.
export const ollamaModelsDir=()=>process.env.OLLAMA_MODELS||path.join(os.homedir(),'.ollama','models');
export async function ollamaGgufModels(dir=ollamaModelsDir()){
  const root=path.join(dir,'manifests'),out=[];
  async function walk(d,depth,parts){
    let entries;try{entries=await fs.readdir(d,{withFileTypes:true});}catch{return;}
    for(const e of entries){
      const full=path.join(d,e.name);
      if(e.isDirectory()&&depth<4)await walk(full,depth+1,[...parts,e.name]);
      else if(e.isFile()&&depth===3)await add(full,[...parts,e.name]);
    }
  }
  async function add(file,[registry,namespace,model,tag]){
    try{
      const st=await fs.stat(file);if(st.size>1e6)return;
      const manifest=JSON.parse(await fs.readFile(file,'utf8'));
      const layer=(manifest.layers||[]).find(l=>l.mediaType==='application/vnd.ollama.image.model');
      if(!layer||!/^sha256:[a-f0-9]{64}$/.test(layer.digest))return;
      const blob=path.join(dir,'blobs',layer.digest.replace(':','-'));
      const fh=await fs.open(blob,'r');let magic;
      try{const buf=Buffer.alloc(4);await fh.read(buf,0,4,0);magic=buf.toString('latin1');}finally{await fh.close();}
      if(magic!=='GGUF')return;
      const name=(registry==='registry.ollama.ai'?(namespace==='library'?'':namespace+'/'):registry+'/'+namespace+'/')+model+':'+tag;
      out.push({name,path:blob,size:layer.size||(await fs.stat(blob)).size});
    }catch{}
  }
  await walk(root,0,[]);
  return out.sort((a,b)=>a.name.localeCompare(b.name));
}

const EXE=process.platform==='win32'?'.exe':'';
export const RPC_NAMES=['ggml-rpc-server'+EXE,'rpc-server'+EXE];
export const SERVER_NAMES=['llama-server'+EXE];
export async function findBinary(dir,names,depth=3){
  let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{return null;}
  for(const name of names){const hit=entries.find(e=>e.isFile()&&e.name===name);if(hit)return path.join(dir,hit.name);}
  if(depth>0)for(const e of entries)if(e.isDirectory()){const found=await findBinary(path.join(dir,e.name),names,depth-1);if(found)return found;}
  return null;
}
async function sha256(file){const h=createHash('sha256');await pipeline(createReadStream(file),h);return h.digest('hex');}
function extract(archive,dest){
  // bsdtar (Windows 10+, macOS) handles zip and tar.gz; GNU tar on Linux handles the .tar.gz assets.
  const tar=process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe'):'tar';
  return new Promise((resolve,reject)=>{
    const child=spawn(tar,['-xf',archive,'-C',dest],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let err='';child.stderr.on('data',c=>err+=c);
    child.on('error',reject);
    child.on('exit',code=>code===0?resolve():reject(Error('extract failed: '+err.slice(0,300))));
  });
}
// Downloads, verifies and unpacks the pinned build into <root>/<build>-<backend>. Returns binary paths.
export async function install({root,backend='auto',onProgress=()=>{},fetchImpl=fetch,signal}){
  const plan=pickAssets({backend});
  if(!plan)throw Error('No prebuilt llama.cpp for '+process.platform+'/'+process.arch+'. Set the folder of your own build instead.');
  const dest=path.join(root,plan.build+'-'+plan.backend),tmp=dest+'.part';
  await fs.rm(tmp,{recursive:true,force:true});await fs.mkdir(tmp,{recursive:true});
  let received=0,expected=0;
  try{
    for(const file of plan.files){
      const r=await fetchImpl(file.url,{signal,redirect:'follow'});
      if(!r.ok||!r.body)throw Error('download failed ('+r.status+'): '+file.name);
      expected+=Number(r.headers.get('content-length'))||0;
      const archive=path.join(tmp,file.name);
      const counter=new Transform({transform(chunk,_e,cb){received+=chunk.length;onProgress({received,expected,file:file.name});cb(null,chunk);}});
      await pipeline(Readable.fromWeb(r.body),counter,createWriteStream(archive));
      const digest=await sha256(archive);
      if(digest!==file.sha256)throw Error('checksum mismatch for '+file.name);
      await extract(archive,tmp);await fs.rm(archive);
    }
    await fs.rm(dest,{recursive:true,force:true});await fs.rename(tmp,dest);
  }catch(e){await fs.rm(tmp,{recursive:true,force:true}).catch(()=>{});throw e;}
  return locate(dest,{build:plan.build,backend:plan.backend});
}
export async function locate(dir,meta={}){
  const rpcServer=await findBinary(dir,RPC_NAMES),llamaServer=await findBinary(dir,SERVER_NAMES);
  if(!rpcServer&&!llamaServer)return null;
  return {dir,rpcServer,llamaServer,...meta};
}
// Previously installed build (if any) below root.
export async function installed(root){
  let entries;try{entries=await fs.readdir(root,{withFileTypes:true});}catch{return null;}
  for(const e of entries.filter(e=>e.isDirectory()&&e.name.startsWith(LLAMA_BUILD+'-')&&!e.name.endsWith('.part'))){
    const found=await locate(path.join(root,e.name),{build:LLAMA_BUILD,backend:e.name.slice(LLAMA_BUILD.length+1)});
    if(found)return found;
  }
  return null;
}

// A child process with a bounded log tail and a state the UI can show.
export function managedProcess(file,args,{cwd=path.dirname(file),env=process.env,onExit=()=>{},onLine=()=>{}}={}){
  const lines=[];
  const push=chunk=>{for(const l of String(chunk).split(/\r?\n/)){if(!l.trim())continue;lines.push(l.slice(0,500));onLine(l);if(lines.length>200)lines.shift();}};
  // Libraries ship next to the binaries.
  const libEnv=process.platform==='linux'?{LD_LIBRARY_PATH:[path.dirname(file),env.LD_LIBRARY_PATH].filter(Boolean).join(':')}:{};
  const child=spawn(file,args,{cwd,env:{...env,...libEnv},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const state={pid:child.pid,running:true,exitCode:null,error:''};
  child.stdout.on('data',push);child.stderr.on('data',push);
  child.on('error',e=>{state.running=false;state.error=e.message;onExit(state);});
  child.on('exit',code=>{state.running=false;state.exitCode=code;onExit(state);});
  return {
    state,child,
    log:(n=40)=>lines.slice(-n),
    stop(){if(!state.running)return;try{if(process.platform==='win32')spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>child.kill());else child.kill('SIGTERM');}catch{}},
    kill(){try{child.kill('SIGKILL');}catch{}}
  };
}
// Runs `llama-server --rpc ... --list-devices` to read free memory of every device (also a connectivity check).
export function listDevices(llamaServer,rpc=[],{timeoutMs=20000}={}){
  return new Promise(resolve=>{
    const args=['--list-devices'];if(rpc.length)args.unshift('--rpc',rpc.join(','));
    const libEnv=process.platform==='linux'?{LD_LIBRARY_PATH:[path.dirname(llamaServer),process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')}:{};
    const child=spawn(llamaServer,args,{cwd:path.dirname(llamaServer),env:{...process.env,...libEnv},windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>out+=c);
    const timer=setTimeout(()=>{try{child.kill();}catch{}},timeoutMs);
    child.on('error',e=>{clearTimeout(timer);resolve({devices:[],error:e.message});});
    child.on('exit',()=>{clearTimeout(timer);resolve({devices:parseListDevices(out),output:out.slice(-2000)});});
  });
}
