// Multi-device mode ("Settings → Devices"): sharing this device on the LAN, discovery, pairing,
// the node registry for distributed tasks, and the llama.cpp RPC memory pool.
// Nothing listens on the network until the user turns on "Share this device"; discovery only
// listens (UDP) while the Devices screen is used or sharing is on.
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import net from 'node:net';
import {randomUUID,randomBytes} from 'node:crypto';
import {tr} from './i18n.mjs';
import {DEFAULT_PEER_PORT,DISCOVERY_PORT,lanAddresses,broadcastAddresses,buildAnnouncement,buildProbe,parseAnnouncement,parseHostPort,isPrivateAddress,isLoopback,newPairingCode,codesEqual,newToken,tokenHash,hashesEqual,createLimiter} from './lan.mjs';
import {createRegistry,NODE_KINDS} from './nodes.mjs';
import {createPeerListener,createTunnelClient} from './tunnel.mjs';
import {ollamaProvider,openaiProvider} from './providers.mjs';
import * as llama from './llamacpp.mjs';

const PEER_HEADER='x-kvalah-token';
const OLLAMA_PATHS=new Set(['api/tags','api/show','api/ps','api/chat','api/version']);
const OPENAI_PATHS=new Set(['models','chat/completions']);
const freeLocalPort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const bool=(v,def)=>v===undefined?def:v===true;

export async function createDevices({dataDir,version,getLocalBackend,localModels,onPoolStopped=()=>{},log=()=>{}}){
  const file=path.join(dataDir,'devices.json');
  const llamaRoot=path.join(dataDir,'llama.cpp');
  let state={};
  try{state=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
  state.id=typeof state.id==='string'&&/^[a-zA-Z0-9-]{8,64}$/.test(state.id)?state.id:randomUUID();
  state.name=String(state.name||os.hostname()||'kvalah').slice(0,64);
  state.share={enabled:false,port:DEFAULT_PEER_PORT,tasks:true,rpc:false,code:newPairingCode(),hosts:[],...state.share};
  state.tasks={enabled:false,localParallel:1,...state.tasks};
  state.pool={workers:[],localGpu:true,model:'',ollamaModel:'',ctx:8192,...state.pool};
  state.llama={path:'',backend:'auto',...state.llama};
  let saving=Promise.resolve();
  const save=()=>{const text=JSON.stringify({...state,nodes:registry.serialize()},null,1);saving=saving.catch(()=>{}).then(async()=>{const tmp=file+'.tmp';await fs.writeFile(tmp,text,{mode:0o600});await fs.rename(tmp,file);});return saving;};

  // ---------- node registry (distributed tasks) ----------
  function providerFor(node){
    if(node.kind==='kvalah'){
      const headers={[PEER_HEADER]:node.token};
      const base=node.url+'/peer/llm';
      const p=node.backend==='openai'?openaiProvider(base,'',{headers}):ollamaProvider(base,{headers,label:node.name});
      p.probe=async()=>{
        const r=await fetch(node.url+'/peer/info',{headers,signal:AbortSignal.timeout(8000)});
        if(r.status===401)throw Error(tr('dev.err.unpaired'));
        if(!r.ok)throw Error('HTTP '+r.status);
        const info=await r.json();
        return {models:info.models||[],backend:info.backend,info};
      };
      return p;
    }
    if(node.kind==='openai')return openaiProvider(node.url,node.apiKey);
    return ollamaProvider(node.url,{label:node.name});
  }
  const registry=createRegistry({providerFor});
  registry.load(state.nodes);delete state.nodes;
  let healthTimer=null;
  function scheduleHealth(){
    clearInterval(healthTimer);healthTimer=null;
    if(registry.list().some(n=>n.enabled)){healthTimer=setInterval(()=>registry.checkAll().catch(()=>{}),20000);healthTimer.unref?.();registry.checkAll().catch(()=>{});}
  }

  // ---------- local model info for peers ----------
  let modelCache={at:0,list:[]};
  async function cachedModels(){if(Date.now()-modelCache.at<10000)return modelCache.list;try{modelCache={at:Date.now(),list:(await localModels()).map(m=>m.name)};}catch{modelCache={at:Date.now(),list:[]};}return modelCache.list;}
  async function info(){
    const backend=getLocalBackend();
    return {app:'kvalah',id:state.id,name:state.name,version,platform:process.platform,arch:process.arch,cpus:os.cpus().length,totalMem:os.totalmem(),freeMem:os.freemem(),
      share:{tasks:state.share.tasks,rpc:state.share.rpc},backend:backend.provider==='openai'?'openai':'ollama',models:state.share.tasks?await cachedModels():[],
      rpc:{running:!!rpcProc?.state.running,build:installedLlama?.build||null}};
  }

  // ---------- peer HTTP API (served on the shared LAN port) ----------
  const limiter=createLimiter();
  const findHost=token=>{if(typeof token!=='string'||token.length!==64)return null;const h=tokenHash(token);return state.share.hosts.find(x=>hashesEqual(x.hash,h))||null;};
  const peerJson=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  async function readBody(req,max=1e6){let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>max)throw Error('too large');chunks.push(c);}return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}
  const peerHttp=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://peer'),route=url.pathname,remote=String(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
      if(route==='/peer/pair'&&req.method==='POST'){
        if(limiter.blocked(remote))return peerJson(res,429,{error:'too many attempts, try again later'});
        const b=await readBody(req,4096);
        if(!codesEqual(b.code,state.share.code)){limiter.fail(remote);return peerJson(res,403,{error:'invalid pairing code'});}
        limiter.reset(remote);
        const token=newToken(),hostId=typeof b.id==='string'&&/^[a-zA-Z0-9-]{8,64}$/.test(b.id)?b.id:randomUUID();
        state.share.hosts=state.share.hosts.filter(h=>h.id!==hostId);
        state.share.hosts.push({id:hostId,name:String(b.name||remote).replace(/[\u0000-\u001f<>]/g,'').slice(0,64),hash:tokenHash(token),address:remote,created:Date.now(),lastSeen:Date.now()});
        await save();log('paired with '+remote);
        return peerJson(res,200,{token,device:await info()});
      }
      const host=findHost(req.headers[PEER_HEADER]);
      if(!host)return peerJson(res,401,{error:'unauthorized'});
      host.lastSeen=Date.now();host.address=remote;
      if(route==='/peer/info'&&req.method==='GET')return peerJson(res,200,await info());
      if(route==='/peer/unpair'&&req.method==='POST'){state.share.hosts=state.share.hosts.filter(h=>h!==host);await save();return peerJson(res,200,{ok:true});}
      if(route.startsWith('/peer/llm/')){
        if(!state.share.tasks)return peerJson(res,403,{error:'task sharing is off on this device'});
        return proxyLlm(req,res,route.slice('/peer/llm/'.length)+url.search);
      }
      peerJson(res,404,{error:'not found'});
    }catch(e){if(!res.headersSent)peerJson(res,400,{error:e.message});else res.destroy();}
  });
  peerHttp.requestTimeout=0;peerHttp.headersTimeout=20000;
  function proxyLlm(req,res,rest){
    const b=getLocalBackend(),pathOnly=rest.split('?')[0];
    let target,headers={'Content-Type':req.headers['content-type']||'application/json'};
    if(b.provider==='openai'){
      if(!OPENAI_PATHS.has(pathOnly))return peerJson(res,404,{error:'not allowed'});
      const base=new URL(b.baseUrl.replace(/\/+$/,'')+'/');
      // A cloud API key is never lent to other devices: only local servers are shared.
      if(!isLoopback(base.hostname.replace(/^\[|\]$/g,''))&&base.hostname!=='localhost')return peerJson(res,403,{error:'only local model servers are shared'});
      target=new URL(rest,base);if(b.apiKey)headers.Authorization='Bearer '+b.apiKey;
    }else{
      if(!OLLAMA_PATHS.has(pathOnly))return peerJson(res,404,{error:'not allowed'});
      target=new URL(rest,b.ollamaUrl.replace(/\/+$/,'')+'/');
    }
    const lib=target.protocol==='https:'?https:http;
    const up=lib.request(target,{method:req.method,headers},r=>{res.writeHead(r.statusCode,{'Content-Type':r.headers['content-type']||'application/json','Cache-Control':'no-store'});r.pipe(res);});
    up.on('error',e=>{if(!res.headersSent)peerJson(res,502,{error:'local model server unreachable: '+e.message});else res.destroy();});
    res.on('close',()=>up.destroy());
    req.pipe(up);
  }

  // ---------- sharing: LAN listener + rpc-server ----------
  let listener=null,shareError='',rpcProc=null,rpcPort=null,rpcError='',installedLlama=null;
  const tunnels=new Set();
  const bindAddresses=()=>process.env.KVALAH_PEER_BIND?process.env.KVALAH_PEER_BIND.split(',').map(s=>s.trim()).filter(Boolean):lanAddresses(os.networkInterfaces()).map(a=>a.address);
  async function startListener(){
    stopListener();
    const addresses=bindAddresses();
    if(!addresses.length){shareError=tr('dev.err.noLan');return;}
    const l=createPeerListener({addresses,port:state.share.port,httpServer:peerHttp,
      authorizeTunnel:(token)=>{const h=findHost(token);if(h){h.lastSeen=Date.now();return h.name;}return null;},
      tunnelTarget:()=>rpcProc?.state.running&&rpcPort?{host:'127.0.0.1',port:rpcPort}:null,
      onTunnel:({host,socket})=>{const t={host,since:Date.now()};tunnels.add(t);socket.on('close',()=>tunnels.delete(t));}});
    try{const r=await l.start();listener=l;shareError=r.errors.length?r.errors.join('; '):'';}
    catch(e){shareError=/EADDRINUSE/.test(e.message)?tr('dev.err.portBusy',{port:state.share.port}):e.message;}
  }
  function stopListener(){listener?.close();listener=null;}
  async function resolveLlama(){
    if(state.llama.path){const found=await llama.locate(state.llama.path,{build:null,backend:'custom'});installedLlama=found;return found;}
    installedLlama=await llama.installed(llamaRoot);return installedLlama;
  }
  async function startRpc(){
    stopRpc();rpcError='';
    const l=await resolveLlama();
    if(!l?.rpcServer){rpcError=tr('dev.err.llamaMissing');return;}
    rpcPort=await freeLocalPort();
    rpcProc=llama.managedProcess(l.rpcServer,llama.rpcServerArgs({port:rpcPort,cache:true}),{onExit:s=>{if(rpcProc?.state===s&&!stopping)rpcError=s.error||('ggml-rpc-server exited ('+s.exitCode+')');}});
  }
  let stopping=false;
  function stopRpc(){if(rpcProc){stopping=true;rpcProc.stop();stopping=false;}rpcProc=null;rpcPort=null;}
  async function applyShare(){
    if(state.share.enabled){if(!listener)await startListener();ensureDiscovery();announce();}
    else{stopListener();shareError='';}
    if(state.share.enabled&&state.share.rpc){if(!rpcProc?.state.running)await startRpc();}
    else stopRpc();
  }

  // ---------- discovery (UDP broadcast) ----------
  const discovered=new Map();let socket=null,announceTimer=null,discoveryError='';
  const discoveryPort=Number(process.env.KVALAH_DISCOVERY_PORT)||DISCOVERY_PORT;
  function ensureDiscovery(){
    if(socket)return;
    const s=dgram.createSocket({type:'udp4',reuseAddr:true});
    s.on('error',e=>{discoveryError=e.message;try{s.close();}catch{};if(socket===s)socket=null;});
    s.on('message',(buf,rinfo)=>{
      const msg=parseAnnouncement(buf,rinfo,state.id);if(!msg)return;
      if(msg.type==='probe'){if(state.share.enabled&&listener)s.send(selfAnnouncement(),msg.replyPort,msg.address);return;}
      discovered.set(msg.id,{...msg,lastSeen:Date.now()});
      // A paired device that moved to another address (DHCP) is followed automatically.
      const node=registry.get(msg.id);
      if(node?.kind==='kvalah'){const url='http://'+msg.address+':'+msg.port;if(node.url!==url){registry.update(node.id,{url});save();}}
    });
    s.bind(discoveryPort,()=>{try{s.setBroadcast(true);}catch{}});
    socket=s;
    announceTimer=setInterval(()=>{announce();for(const [id,d] of discovered)if(Date.now()-d.lastSeen>35000)discovered.delete(id);},10000);announceTimer.unref?.();
  }
  const selfAnnouncement=()=>buildAnnouncement({id:state.id,name:state.name,port:state.share.port,version,platform:process.platform,modes:{tasks:state.share.tasks,rpc:state.share.rpc&&!!rpcProc?.state.running}});
  function broadcast(buf){if(!socket)return;for(const a of process.env.KVALAH_DISCOVERY_TARGET?[process.env.KVALAH_DISCOVERY_TARGET]:broadcastAddresses(os.networkInterfaces()))socket.send(buf,discoveryPort,a,()=>{});}
  function announce(){if(state.share.enabled&&listener)broadcast(selfAnnouncement());}
  async function probe(wait=1200){ensureDiscovery();broadcast(buildProbe(state.id));await sleep(wait);return discoveredList();}
  const discoveredList=()=>[...discovered.values()].map(d=>({...d,paired:!!registry.get(d.id)})).sort((a,b)=>a.name.localeCompare(b.name));

  // ---------- pairing (host side) ----------
  async function lanHost(host){
    if(net.isIP(host))return host;
    const r=await dns.lookup(host);return r.address;
  }
  async function pair({address,code}){
    const {host,port}=parseHostPort(address);
    const ip=await lanHost(host);
    if(!isPrivateAddress(ip))throw Error(tr('dev.err.notPrivate'));
    const urlHost=net.isIPv6(ip)?'['+ip+']':ip;
    let r;
    try{r=await fetch('http://'+urlHost+':'+port+'/peer/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,id:state.id,name:state.name}),signal:AbortSignal.timeout(10000)});}
    catch(e){throw Error(tr('dev.err.pairFailed',{error:e.cause?.code||e.message}));}
    const data=await r.json().catch(()=>({}));
    if(r.status===403)throw Error(tr('dev.err.badCode'));
    if(r.status===429)throw Error(tr('dev.err.tooManyAttempts'));
    if(!r.ok||!data.token)throw Error(tr('dev.err.pairFailed',{error:data.error||('HTTP '+r.status)}));
    const d=data.device||{};
    const node=registry.add({id:d.id,name:d.name||host,kind:'kvalah',url:'http://'+urlHost+':'+port,token:data.token,backend:d.backend,tasks:true,memory:!!d.share?.rpc});
    await save();await registry.check(node.id);scheduleHealth();
    return node.id;
  }
  async function addEndpoint({kind,url,apiKey,name}){
    if(!['ollama','openai'].includes(kind))throw Error('Unknown device type');
    let u=String(url||'').trim();if(!/^https?:\/\//i.test(u))u='http://'+u;
    const parsed=new URL(u);
    if(kind==='ollama'&&!parsed.port&&parsed.protocol==='http:')parsed.port='11434';
    const node=registry.add({kind,url:parsed.toString().replace(/\/+$/,''),apiKey:apiKey||'',name:name||parsed.hostname,tasks:true});
    await save();await registry.check(node.id);scheduleHealth();
    return node.id;
  }

  // ---------- llama.cpp install ----------
  let install={state:'idle',received:0,expected:0,error:''};
  async function startInstall(backend){
    if(install.state==='downloading')return;
    if(!llama.BACKENDS.includes(backend))throw Error('Unknown backend');
    state.llama.backend=backend;await save();
    install={state:'downloading',received:0,expected:0,error:'',backend};
    llama.install({root:llamaRoot,backend,onProgress:p=>{install.received=p.received;install.expected=p.expected;}})
      .then(async r=>{install={state:'done',received:install.received,expected:install.expected,error:''};state.llama.path='';await save();installedLlama=r;if(state.share.enabled&&state.share.rpc)await startRpc();})
      .catch(e=>{install={state:'error',received:0,expected:0,error:e.message};});
  }

  // ---------- memory pool (host side) ----------
  let pool={state:'stopped',error:'',warnings:[],devices:[],port:null,apiKey:null,proc:null,tunnels:[],startedAt:null};
  const poolBase=()=>pool.port?'http://127.0.0.1:'+pool.port+'/v1':null;
  // The GGUF file for the pool: a file the user picked, or the blob behind an Ollama model name.
  async function resolvePoolModel(file,ollamaModel){
    if(file){
      if(!path.isAbsolute(file))throw Error(tr('dev.err.modelNotAbsolute',{path:file}));
      let st;try{st=await fs.stat(file);}catch{}
      if(!st?.isFile())throw Error(tr('dev.err.modelNotFound',{path:file}));
      if(!(await llama.isGguf(file)))throw Error(tr('dev.err.modelNotGguf',{path:file}));
      return file;
    }
    if(!ollamaModel)throw Error(tr('dev.err.modelMissing'));
    const backend=getLocalBackend?.()||{};
    const dir=llama.ollamaModelsDir();
    try{return (await llama.resolveOllamaModel(ollamaModel,{dir,ollamaUrl:backend.ollamaUrl||process.env.OLLAMA_URL||'http://127.0.0.1:11434'})).path;}
    catch(e){throw Error(tr('dev.err.ollamaModelNotFound',{name:ollamaModel,paths:(e.tried||[]).join('\n')||dir,dir:path.join(dir,'blobs')}));}
  }
  async function startPool(input){
    if(['starting','loading','running'].includes(pool.state))throw Error(tr('dev.err.poolRunning'));
    const workers=[...new Set((Array.isArray(input.workers)?input.workers:[]).map(String))];
    const localGpu=input.localGpu!==false,ctx=Number(input.ctx)||8192;
    const file=String(input.model||'').trim().replace(/^"(.*)"$/,'$1'),ollamaModel=String(input.ollamaModel||'').trim();
    state.pool={workers,localGpu,model:file,ollamaModel:file?'':ollamaModel,ctx};await save();
    if(!workers.length&&!localGpu)throw Error(tr('dev.err.selectDevice'));
    const model=await resolvePoolModel(file,ollamaModel);
    const l=await resolveLlama();
    if(!l?.llamaServer)throw Error(tr('dev.err.llamaMissing'));
    pool={state:'starting',error:'',warnings:[],devices:[],port:null,apiKey:null,proc:null,tunnels:[],startedAt:Date.now()};
    try{
      const rpc=[],names=[];
      for(const id of workers){
        const node=registry.get(id);
        if(!node||node.kind!=='kvalah')throw Error(tr('dev.err.unreachable',{name:id}));
        let peer;
        try{peer=(await providerFor(node).probe()).info;}catch(e){throw Error(tr('dev.err.unreachable',{name:node.name})+' ('+e.message+')');}
        if(!peer.rpc?.running)throw Error(tr('dev.err.rpcNotRunning',{name:node.name}));
        if(peer.rpc.build&&l.build&&peer.rpc.build!==l.build)throw Error(tr('dev.err.buildMismatch',{name:node.name,build:peer.rpc.build}));
        if(!peer.rpc.build||!l.build)pool.warnings.push(tr('dev.warn.customBuild',{name:node.name}));
        const u=new URL(node.url);
        const t=createTunnelClient({host:u.hostname.replace(/^\[|\]$/g,''),port:Number(u.port),token:node.token});
        const p=await t.listen();pool.tunnels.push({t,name:node.name,id});
        rpc.push('127.0.0.1:'+p);names.push(node.name);
      }
      // Memory per device, and a connectivity check of every tunnel before loading the model.
      const probeResult=await llama.listDevices(l.llamaServer,rpc);
      const rpcDevices=probeResult.devices.filter(d=>/^RPC\d+$/.test(d.name));
      if(rpcDevices.length<rpc.length){const failed=pool.tunnels.find(x=>x.t.stats.lastError);throw Error(tr('dev.err.unreachable',{name:failed?.name||names[rpcDevices.length]||'?'})+(failed?' ('+failed.t.stats.lastError+')':''));}
      pool.devices=probeResult.devices.map(d=>{const m=/^RPC(\d+)$/.exec(d.name);return {device:d.name,name:m?names[Number(m[1])]:state.name,local:!m,used:m?true:localGpu&&!/^CPU/i.test(d.name),totalMiB:d.totalMiB,freeMiB:d.freeMiB};});
      pool.port=await freeLocalPort();pool.apiKey=randomBytes(24).toString('hex');
      const args=llama.llamaServerArgs({model,rpc,port:pool.port,ctx,localGpu,alias:'pool',apiKey:pool.apiKey});
      pool.state='loading';
      const proc=llama.managedProcess(l.llamaServer,args,{onExit:s=>{if(pool.proc===proc&&pool.state!=='stopped'){pool.state='error';{const lines=proc.log(200);const log=llama.explainServerLog(lines)||s.error||('exit code '+s.exitCode);pool.error=tr('dev.err.poolExited',{log})+(lines.some(l=>/unknown model architecture/i.test(l))?'\n\n'+tr('dev.err.unsupportedArch',{build:l.build||'(custom)'}):'');}closeTunnels();onPoolStopped(poolBaseSaved);}}});
      pool.proc=proc;const poolBaseSaved=poolBase();
      waitReady(proc).catch(()=>{});
    }catch(e){closeTunnels();pool.state='error';pool.error=e.message;throw e;}
  }
  async function waitReady(proc){
    const deadline=Date.now()+20*60*1000;
    while(pool.proc===proc&&proc.state.running&&Date.now()<deadline){
      try{const r=await fetch('http://127.0.0.1:'+pool.port+'/health',{signal:AbortSignal.timeout(3000)});if(r.ok){pool.ctx=await actualContext();pool.state='running';return;}}catch{}
      await sleep(1000);
    }
  }
  // llama-server caps the context at the model's training length; the agent must use the real value.
  async function actualContext(){
    try{const r=await fetch('http://127.0.0.1:'+pool.port+'/props',{headers:{Authorization:'Bearer '+pool.apiKey},signal:AbortSignal.timeout(3000)});
      const n=(await r.json())?.default_generation_settings?.n_ctx;return Number.isInteger(n)&&n>0?n:null;}catch{return null;}
  }
  function closeTunnels(){for(const x of pool.tunnels)x.t.close();pool.tunnels=[];}
  function stopPool(){
    const base=poolBase();
    pool.state='stopped';pool.proc?.stop();pool.proc=null;closeTunnels();pool.port=null;pool.apiKey=null;pool.ctx=null;pool.devices=[];
    onPoolStopped(base);
  }

  // ---------- public API (/api/devices/*, local UI only) ----------
  async function snapshot(){
    if(!installedLlama&&install.state!=='downloading')await resolveLlama();
    return {
      self:{id:state.id,name:state.name,version,platform:process.platform,arch:process.arch},
      share:{enabled:state.share.enabled,port:state.share.port,tasks:state.share.tasks,rpc:state.share.rpc,code:state.share.code,
        addresses:(listener?listener.listening.map(a=>({address:a.address,port:a.port})):bindAddresses().map(a=>({address:a,port:state.share.port}))),
        listening:!!listener,error:shareError,hosts:state.share.hosts.map(({hash,...h})=>h),tunnels:[...tunnels].map(t=>({host:t.host,since:t.since}))},
      rpc:{running:!!rpcProc?.state.running,error:rpcError,log:rpcProc?rpcProc.log(8):[]},
      llama:{build:llama.LLAMA_BUILD,installed:installedLlama?{build:installedLlama.build,backend:installedLlama.backend,dir:installedLlama.dir,rpcServer:!!installedLlama.rpcServer,llamaServer:!!installedLlama.llamaServer}:null,
        path:state.llama.path,backend:state.llama.backend,supported:!!llama.pickAssets({}),install},
      discovered:discoveredList(),discoveryError,
      nodes:registry.publicList(),
      tasks:{...state.tasks},
      pool:{...state.pool,state:pool.state,error:pool.error,warnings:pool.warnings,devices:pool.devices,actualCtx:pool.ctx||null,baseUrl:pool.state==='running'?poolBase():null,
        tunnels:pool.tunnels.map(x=>({name:x.name,...x.t.stats})),log:pool.proc?pool.proc.log(12):[],startedAt:pool.startedAt}
    };
  }
  async function handle(route,method,b={}){
    if(route===''&&method==='GET'){ensureDiscovery();return snapshot();}
    if(route==='/share'&&method==='POST'){
      if(b.name!==undefined){const n=String(b.name).replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,64);if(n)state.name=n;}
      if(b.port!==undefined){const p=Number(b.port);if(!Number.isInteger(p)||p<1024||p>65535)throw Error(tr('dev.err.badPort'));if(p!==state.share.port){state.share.port=p;stopListener();}}
      state.share.enabled=bool(b.enabled,state.share.enabled);state.share.tasks=bool(b.tasks,state.share.tasks);state.share.rpc=bool(b.rpc,state.share.rpc);
      await save();await applyShare();return snapshot();
    }
    if(route==='/code'&&method==='POST'){state.share.code=newPairingCode();await save();return snapshot();}
    if(route==='/hosts/revoke'&&method==='POST'){state.share.hosts=state.share.hosts.filter(h=>h.id!==b.id);await save();return snapshot();}
    if(route==='/discover'&&method==='POST'){await probe();return snapshot();}
    if(route==='/pair'&&method==='POST'){await pair(b);return snapshot();}
    if(route==='/add'&&method==='POST'){await addEndpoint(b);return snapshot();}
    if(route==='/node'&&method==='POST'){
      const patch={};for(const k of ['enabled','tasks','memory'])if(b[k]!==undefined)patch[k]=b[k]===true;
      for(const k of ['model','name'])if(typeof b[k]==='string')patch[k]=b[k];
      if(b.maxParallel!==undefined)patch.maxParallel=b.maxParallel;
      registry.update(String(b.id),patch);await save();scheduleHealth();return snapshot();
    }
    if(route==='/remove'&&method==='POST'){
      const node=registry.get(String(b.id));
      if(node?.kind==='kvalah'&&node.token)fetch(node.url+'/peer/unpair',{method:'POST',headers:{[PEER_HEADER]:node.token},signal:AbortSignal.timeout(3000)}).catch(()=>{});
      registry.remove(String(b.id));state.pool.workers=state.pool.workers.filter(w=>w!==b.id);await save();scheduleHealth();return snapshot();
    }
    if(route==='/check'&&method==='POST'){await registry.checkAll();return snapshot();}
    if(route==='/tasks'&&method==='POST'){
      state.tasks.enabled=bool(b.enabled,state.tasks.enabled);
      if(b.localParallel!==undefined)state.tasks.localParallel=Math.min(4,Math.max(0,Math.round(Number(b.localParallel))||0));
      await save();return snapshot();
    }
    if(route==='/llama/install'&&method==='POST'){await startInstall(String(b.backend||state.llama.backend||'auto'));return snapshot();}
    if(route==='/llama/path'&&method==='POST'){
      const p=String(b.path||'').trim();
      if(p){if(!path.isAbsolute(p))throw Error(tr('dev.err.llamaPath'));const found=await llama.locate(p);if(!found)throw Error(tr('dev.err.llamaPath'));}
      state.llama.path=p;await save();await resolveLlama();if(state.share.enabled&&state.share.rpc)await startRpc();return snapshot();
    }
    if(route==='/gguf'&&method==='GET'){const dir=llama.ollamaModelsDir();return {models:await llama.ollamaGgufModels(dir),dir,blobs:path.join(dir,'blobs')};}
    if(route==='/pool/start'&&method==='POST'){await startPool(b);return snapshot();}
    if(route==='/pool/stop'&&method==='POST'){stopPool();return snapshot();}
    throw Error('Not found');
  }

  if(state.share.enabled)applyShare().catch(e=>{shareError=e.message;});
  scheduleHealth();
  return {
    handle,registry,
    get tasks(){return state.tasks;},
    tasksEnabled:()=>state.tasks.enabled===true,
    pool:()=>({state:pool.state,baseUrl:pool.state==='running'?poolBase():null,apiKey:pool.apiKey,ctx:pool.ctx||state.pool.ctx}),
    shutdown(){clearInterval(healthTimer);clearInterval(announceTimer);try{socket?.close();}catch{}socket=null;stopListener();stopRpc();if(pool.proc){pool.proc.stop();}closeTunnels();},
    id:state.id
  };
}
export {NODE_KINDS};
