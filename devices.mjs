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
import {DEFAULT_PEER_PORT,DISCOVERY_PORT,linkRank,lanAddresses,broadcastAddresses,buildAnnouncement,buildProbe,parseAnnouncement,parseHostPort,isPrivateAddress,isLoopback,newPairingCode,codesEqual,newToken,tokenHash,hashesEqual,createLimiter} from './lan.mjs';
import {createRegistry,NODE_KINDS} from './nodes.mjs';
import {createPeerListener,createTunnelClient} from './tunnel.mjs';
import {ollamaProvider,openaiProvider} from './providers.mjs';
import * as llama from './llamacpp.mjs';
import {interfaceTypes} from './netif.mjs';
import {createActivity} from './activity.mjs';

const PEER_HEADER='x-kvalah-token';
const OLLAMA_PATHS=new Set(['api/tags','api/show','api/ps','api/chat','api/version']);
const OPENAI_PATHS=new Set(['models','chat/completions']);
const STALL_WARN_MS=Number(process.env.KVALAH_POOL_STALL_WARN_MS)||180000,STALL_STOP_MS=Number(process.env.KVALAH_POOL_STALL_STOP_MS)||600000;
const deviceKindLocal=name=>llama.deviceKind(name)!=='rpc';
const freeLocalPort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const bool=(v,def)=>v===undefined?def:v===true;
const median=list=>{const s=[...list].sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:null;};
// Links slower than this make the pool crawl (each token crosses every link several times).
const SLOW_RTT_MS=4,SLOW_MBPS=40;

export async function createDevices({dataDir,version,getLocalBackend,localModels,onPoolStopped=()=>{},log=()=>{}}){
  const file=path.join(dataDir,'devices.json');
  const llamaRoot=path.join(dataDir,'llama.cpp');
  let state={};
  try{state=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
  state.id=typeof state.id==='string'&&/^[a-zA-Z0-9-]{8,64}$/.test(state.id)?state.id:randomUUID();
  state.name=String(state.name||os.hostname()||'kvalah').slice(0,64);
  state.share={enabled:false,port:DEFAULT_PEER_PORT,tasks:true,rpc:false,rpcIgpu:false,code:newPairingCode(),hosts:[],...state.share};
  state.tasks={enabled:false,localParallel:1,...state.tasks};
  state.pool={workers:[],localGpu:true,model:'',ollamaModel:'',ctx:8192,skipIgpu:true,...state.pool};
  state.llama={path:'',backend:'auto',...state.llama};
  let saving=Promise.resolve();
  const save=()=>{const text=JSON.stringify({...state,nodes:registry.serialize()},null,1);saving=saving.catch(()=>{}).then(async()=>{const tmp=file+'.tmp';await fs.writeFile(tmp,text,{mode:0o600});await fs.rename(tmp,file);});return saving;};

  // ---------- node registry (distributed tasks) ----------
  function providerFor(node){
    if(node.kind==='kvalah'){
      const headers={[PEER_HEADER]:node.token};
      const base=node.url+'/peer/llm';
      const p=node.backend==='openai'?openaiProvider(base,'',{headers}):ollamaProvider(base,{headers,label:node.name});
      // Health check with failover: the fastest link (Thunderbolt > Ethernet > Wi-Fi) that answers wins.
      p.probe=async()=>{
        const links=linksOf(node);let lastError=null;
        for(let i=0;i<links.length;i++){
          const link=links[i],last=i===links.length-1;
          let r;
          try{r=await fetch(link.url+'/peer/info',{headers,signal:AbortSignal.timeout(last?8000:2500)});}catch(e){lastError=e;continue;}
          if(r.status===401)throw Error(tr('dev.err.unpaired'));
          if(!r.ok){lastError=Error('HTTP '+r.status);continue;}
          const info=await r.json();
          followLinks(node,link,info.links);
          return {models:info.models||[],backend:info.backend,info};
        }
        throw lastError||Error('unreachable');
      };
      return p;
    }
    if(node.kind==='openai')return openaiProvider(node.url,node.apiKey);
    return ollamaProvider(node.url,{label:node.name});
  }
  const registry=createRegistry({providerFor});
  // Every address a paired device can be reached at, fastest link type first, the current one first
  // among equals.
  function linksOf(node){
    const list=[...(node.links||[])];
    if(!list.some(l=>l.url===node.url))list.push({url:node.url,type:node.link||'other'});
    return list.sort((a,b)=>linkRank(a.type)-linkRank(b.type)||(a.url===node.url?-1:b.url===node.url?1:0));
  }
  // Remember the device's own list of addresses (from /peer/info or its announcement) and switch to the
  // link that just answered.
  function followLinks(node,used,announced){
    const port=Number(new URL(used.url).port)||DEFAULT_PEER_PORT;
    const links=Array.isArray(announced)?announced.filter(l=>l&&typeof l.address==='string'&&net.isIPv4(l.address)&&isPrivateAddress(l.address)).map(l=>({url:'http://'+l.address+':'+port,type:l.type})):node.links;
    const type=(links.find(l=>l.url===used.url)||used).type||'other';
    const changed=node.url!==used.url||node.link!==type||JSON.stringify(links)!==JSON.stringify(node.links||[]);
    if(changed){try{registry.update(node.id,{url:used.url,link:type,links:[...links,...(links.some(l=>l.url===used.url)?[]:[{url:used.url,type}])]});save();}catch{}}
  }
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
      share:{tasks:state.share.tasks,rpc:state.share.rpc},links:listenLinks(),backend:backend.provider==='openai'?'openai':'ollama',models:state.share.tasks?await cachedModels():[],
      rpc:{running:!!rpcProc?.state.running,build:installedLlama?.build||null,devices:rpcDevices.filter(d=>d.lent).map(({name,description,totalMiB,freeMiB})=>({name,description,totalMiB,freeMiB}))},
      // Lets a host warn that this worker's GPUs are already used by its own pool.
      pool:{running:['starting','loading','running'].includes(pool.state)}};
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
      if(route==='/peer/activity'&&req.method==='GET')return peerJson(res,200,activitySnapshot());
      if(route==='/peer/ping'&&req.method==='GET')return peerJson(res,200,{t:Date.now()});
      if(route==='/peer/speedtest'&&req.method==='GET'){
        // Bandwidth test for the host: N zero bytes (max 64 MB).
        let left=Math.min(64*2**20,Math.max(0,Number(url.searchParams.get('bytes'))||0));
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':String(left),'Cache-Control':'no-store'});
        const chunk=Buffer.alloc(256*1024);
        const pump=()=>{while(left>0){const n=Math.min(left,chunk.length);left-=n;proxyBytes.up+=n;if(!res.write(n===chunk.length?chunk:chunk.subarray(0,n)))return res.once('drain',pump);}res.end();};
        return pump();
      }
      if(route==='/peer/unpair'&&req.method==='POST'){state.share.hosts=state.share.hosts.filter(h=>h!==host);await save();return peerJson(res,200,{ok:true});}
      if(route.startsWith('/peer/llm/')){
        if(!state.share.tasks)return peerJson(res,403,{error:'task sharing is off on this device'});
        return proxyLlm(req,res,route.slice('/peer/llm/'.length)+url.search,host);
      }
      peerJson(res,404,{error:'not found'});
    }catch(e){if(!res.headersSent)peerJson(res,400,{error:e.message});else res.destroy();}
  });
  peerHttp.requestTimeout=0;peerHttp.headersTimeout=20000;
  // Requests served for other devices right now (by host name), and their traffic, for the indicator.
  const serving=new Map(),proxyBytes={up:0,down:0};
  function proxyLlm(req,res,rest,host={name:'?'}){
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
    serving.set(host.name,(serving.get(host.name)||0)+1);
    let done=false;const finish=()=>{if(done)return;done=true;const n=(serving.get(host.name)||1)-1;if(n>0)serving.set(host.name,n);else serving.delete(host.name);};
    req.on('data',c=>{proxyBytes.down+=c.length;});
    const up=lib.request(target,{method:req.method,headers},r=>{res.writeHead(r.statusCode,{'Content-Type':r.headers['content-type']||'application/json','Cache-Control':'no-store'});
      // A streamed line with content is about one generated token.
      r.on('data',c=>{proxyBytes.up+=c.length;const text=c.toString('utf8');const n=(text.match(/"content":"[^"]|"thinking":"[^"]|"reasoning_content":"[^"]/g)||[]).length;if(n)meter.addTokens(n);});
      r.on('end',finish);r.pipe(res);});
    up.on('error',e=>{if(!res.headersSent)peerJson(res,502,{error:'local model server unreachable: '+e.message});else res.destroy();});
    res.on('close',()=>{finish();up.destroy();});
    req.pipe(up);
  }

  // ---------- sharing: LAN listener + rpc-server ----------
  let listener=null,shareError='',rpcProc=null,rpcPort=null,rpcError='',installedLlama=null,rpcDevices=[];
  const tunnels=new Set(),tunnelBytes={up:0,down:0};
  const myLinks=()=>lanAddresses(os.networkInterfaces(),interfaceTypes()).map(a=>({address:a.address,type:a.type,name:a.name}));
  // Addresses this device really accepts peers on, with their link type.
  const listenLinks=()=>listener?myLinks().filter(l=>listener.listening.some(x=>x.address===l.address)).map(({address,type})=>({address,type})):[];
  const bindAddresses=()=>process.env.KVALAH_PEER_BIND?process.env.KVALAH_PEER_BIND.split(',').map(s=>s.trim()).filter(Boolean):lanAddresses(os.networkInterfaces()).map(a=>a.address);
  async function startListener(){
    stopListener();
    const addresses=bindAddresses();
    if(!addresses.length){shareError=tr('dev.err.noLan');return;}
    const l=createPeerListener({addresses,port:state.share.port,httpServer:peerHttp,
      authorizeTunnel:(token)=>{const h=findHost(token);if(h){h.lastSeen=Date.now();return h.name;}return null;},
      tunnelTarget:()=>rpcProc?.state.running&&rpcPort?{host:'127.0.0.1',port:rpcPort}:null,
      onTunnel:({host,socket})=>{const t={host,since:Date.now(),socket};tunnels.add(t);socket.on('close',()=>{tunnelBytes.up+=socket.bytesWritten||0;tunnelBytes.down+=socket.bytesRead||0;tunnels.delete(t);});}});
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
    // Lend the discrete GPU(s) only: an integrated GPU next to them (e.g. AMD Radeon 610M) is slow
    // shared memory and slows every token of the pool. Macs have a single GPU, nothing to choose.
    rpcDevices=[];let lend;
    if(l.llamaServer&&process.platform!=='darwin'){
      try{
        const listed=(await llama.listDevices(l.llamaServer,[],{timeoutMs:15000})).devices;
        const {keep,skipped}=llama.strongGpus(listed,{skipIntegrated:!state.share.rpcIgpu});
        rpcDevices=listed.filter(d=>llama.deviceKind(d.name)==='gpu').map(d=>({...d,lent:keep.includes(d),integrated:llama.isIntegratedGpu(d.description)}));
        if(skipped.length&&keep.length)lend=keep.map(d=>d.name);
      }catch{}
    }
    rpcProc=llama.managedProcess(l.rpcServer,llama.rpcServerArgs({port:rpcPort,cache:true,devices:lend}),{onExit:s=>{if(rpcProc?.state===s&&!stopping)rpcError=s.error||('ggml-rpc-server exited ('+s.exitCode+')');}});
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
      // One device can be heard on several interfaces (Thunderbolt and Wi-Fi): keep every address.
      const prev=discovered.get(msg.id);
      const links=msg.links.length?msg.links:[{address:msg.address,type:'other'}];
      const type=(links.find(l=>l.address===msg.address)||{}).type||'other';
      const heard=new Map((prev?.heard||[]).map(h=>[h.address,h]));heard.set(msg.address,{address:msg.address,type,at:Date.now()});
      const best=[...heard.values()].filter(h=>Date.now()-h.at<35000).sort((a,b)=>linkRank(a.type)-linkRank(b.type))[0];
      discovered.set(msg.id,{...msg,address:best.address,link:best.type,heard:[...heard.values()],lastSeen:Date.now()});
      // A paired device that moved (DHCP) or gained a faster link (a Thunderbolt cable) is followed.
      const node=registry.get(msg.id);
      if(node?.kind==='kvalah'){
        const urls=links.map(l=>({url:'http://'+l.address+':'+msg.port,type:l.type}));
        const bestUrl='http://'+best.address+':'+msg.port;
        const current=linksOf(node).find(l=>l.url===node.url);
        if(JSON.stringify(urls)!==JSON.stringify(node.links||[])||(!current||linkRank(best.type)<linkRank(current.type))&&node.url!==bestUrl){
          registry.update(node.id,{links:urls,...(!current||linkRank(best.type)<linkRank(current.type)?{url:bestUrl,link:best.type}:{})});save();
        }
      }
    });
    s.bind(discoveryPort,()=>{try{s.setBroadcast(true);}catch{}});
    socket=s;
    announceTimer=setInterval(()=>{
      // A cable plugged in later (Thunderbolt Bridge) brings a new address: listen there too.
      if(listener&&!process.env.KVALAH_PEER_BIND)listener.add(bindAddresses()).catch(()=>{});
      announce();for(const [id,d] of discovered)if(Date.now()-d.lastSeen>35000)discovered.delete(id);
    },10000);announceTimer.unref?.();
  }
  const selfAnnouncement=()=>buildAnnouncement({id:state.id,name:state.name,port:state.share.port,version,platform:process.platform,modes:{tasks:state.share.tasks,rpc:state.share.rpc&&!!rpcProc?.state.running},links:listenLinks()});
  function broadcast(buf){if(!socket)return;for(const a of process.env.KVALAH_DISCOVERY_TARGET?[process.env.KVALAH_DISCOVERY_TARGET]:broadcastAddresses(os.networkInterfaces(),interfaceTypes()))socket.send(buf,discoveryPort,a,()=>{});}
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
    const links=(Array.isArray(d.links)?d.links:[]).filter(l=>net.isIPv4(String(l?.address))&&isPrivateAddress(l.address)).map(l=>({url:'http://'+l.address+':'+port,type:l.type}));
    const link=(links.find(l=>l.url==='http://'+urlHost+':'+port)||{}).type||'';
    const node=registry.add({id:d.id,name:d.name||host,kind:'kvalah',url:'http://'+urlHost+':'+port,token:data.token,backend:d.backend,tasks:true,memory:!!d.share?.rpc,links,link});
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
  // Ollama's own address (Settings → Ollama URL), never the active provider's: the chat may use an
  // OpenAI-compatible server (e.g. the pool itself on :8080) while the models live in Ollama.
  const ollamaUrl=()=>String(getLocalBackend?.()?.ollamaUrl||process.env.OLLAMA_URL||'http://127.0.0.1:11434').replace(/\/+$/,'');
  // Models for "From Ollama": the manifest store on disk (works without Ollama running), plus models the
  // Ollama API knows that the scan missed (e.g. OLLAMA_MODELS set only for the Ollama service).
  async function listGguf(){
    const dir=llama.ollamaModelsDir(),url=ollamaUrl();
    const models=await llama.ollamaGgufModels(dir);
    const ollama={url,reachable:false,error:'',count:0};
    let names=[];
    try{
      const r=await fetch(url+'/api/tags',{signal:AbortSignal.timeout(3000)});
      if(!r.ok)throw Error('HTTP '+r.status);
      names=((await r.json())?.models||[]).map(m=>String(m.name||m.model||'')).filter(Boolean);
      ollama.reachable=true;ollama.count=names.length;
    }catch(e){ollama.error=String(e?.cause?.code||e?.message||e).slice(0,200);}
    const known=new Set(models.map(m=>m.name)),norm=n=>n.includes(':')?n:n+':latest';
    const scanned=new Set([dir]);
    for(const name of names.slice(0,100)){
      if(known.has(norm(name)))continue;
      try{
        const r=await llama.resolveOllamaModel(name,{dir,ollamaUrl:url});
        const other=path.dirname(path.dirname(r.path));
        if(!scanned.has(other)){
          scanned.add(other);
          for(const m of await llama.ollamaGgufModels(other))if(!known.has(m.name)){known.add(m.name);models.push({...m,source:'api'});}
        }
        if(!known.has(norm(name))){known.add(norm(name));models.push({name:norm(name),path:r.path,size:r.size,source:'api'});}
      }catch{}
    }
    models.sort((a,b)=>a.name.localeCompare(b.name));
    return {models,dir,blobs:path.join(dir,'blobs'),ollama};
  }
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
    const dir=llama.ollamaModelsDir();
    try{return (await llama.resolveOllamaModel(ollamaModel,{dir,ollamaUrl:ollamaUrl()})).path;}
    catch(e){throw Error(tr('dev.err.ollamaModelNotFound',{name:ollamaModel,paths:(e.tried||[]).join('\n')||dir,dir:path.join(dir,'blobs')}));}
  }
  async function startPool(input){
    if(['starting','loading','running'].includes(pool.state))throw Error(tr('dev.err.poolRunning'));
    const workers=[...new Set((Array.isArray(input.workers)?input.workers:[]).map(String))];
    const localGpu=input.localGpu!==false,ctx=Number(input.ctx)||8192,skipIgpu=input.skipIgpu!==false;
    const file=String(input.model||'').trim().replace(/^"(.*)"$/,'$1'),ollamaModel=String(input.ollamaModel||'').trim();
    state.pool={workers,localGpu,model:file,ollamaModel,ctx,skipIgpu};await save();
    if(!workers.length&&!localGpu)throw Error(tr('dev.err.selectDevice'));
    const model=await resolvePoolModel(file,ollamaModel);
    const l=await resolveLlama();
    if(!l?.llamaServer)throw Error(tr('dev.err.llamaMissing'));
    pool={state:'starting',error:'',warnings:[],devices:[],port:null,apiKey:null,proc:null,tunnels:[],startedAt:Date.now()};
    try{
      const rpc=[],names=[],remote=[];
      for(const id of workers){
        let node=registry.get(id);
        if(!node||node.kind!=='kvalah')throw Error(tr('dev.err.unreachable',{name:id}));
        let peer;
        try{peer=(await providerFor(node).probe()).info;}catch(e){throw Error(tr('dev.err.unreachable',{name:node.name})+' ('+e.message+')');}
        node=registry.get(id); // the probe may have switched to a faster link
        remote.push(peer.rpc?.devices||[]);
        if(!peer.rpc?.running)throw Error(tr('dev.err.rpcNotRunning',{name:node.name}));
        if(peer.rpc.build&&l.build&&peer.rpc.build!==l.build)throw Error(tr('dev.err.buildMismatch',{name:node.name,build:peer.rpc.build}));
        if(!peer.rpc.build||!l.build)pool.warnings.push(tr('dev.warn.customBuild',{name:node.name}));
        const u=new URL(node.url);
        const t=createTunnelClient({host:u.hostname.replace(/^\[|\]$/g,''),port:Number(u.port),token:node.token});
        const p=await t.listen();pool.tunnels.push({t,name:node.name,id,link:node.link||'other',url:node.url});
        rpc.push('127.0.0.1:'+p);names.push(node.name);
        // Link quality decides the speed of the pool: measure it once per start (about 4 MB).
        const m=await measureLink(node,{bytes:4*2**20}).catch(()=>null);
        if(node.link==='wifi')pool.warnings.push(tr('dev.warn.wifi',{name:node.name}));
        else if(m&&(m.rttMs>SLOW_RTT_MS||m.mbps<SLOW_MBPS))pool.warnings.push(tr('dev.warn.slowLink',{name:node.name,ms:m.rttMs,mbps:m.mbps}));
      }
      if(ctx>16384&&workers.length)pool.warnings.push(tr('dev.warn.bigCtx',{ctx}));
      // Memory per device, and a connectivity check of every tunnel before loading the model.
      const probeResult=await llama.listDevices(l.llamaServer,rpc);
      // A worker lends one RPCn device per GPU, described by its endpoint (127.0.0.1:port of its tunnel).
      const rpcSeen=probeResult.devices.filter(d=>/^RPC\d+$/.test(d.name));
      const reached=rpc.filter(e=>rpcSeen.some(d=>d.description===e)).length;
      if(rpcSeen.length<rpc.length||reached&&reached<rpc.length){const failed=pool.tunnels.find(x=>x.t.stats.lastError);const missing=rpc.findIndex(e=>!rpcSeen.some(d=>d.description===e));throw Error(tr('dev.err.unreachable',{name:failed?.name||names[missing>=0?missing:rpcSeen.length]||'?'})+(failed?' ('+failed.t.stats.lastError+')':''));}
      // This computer's GPUs: skip a slow integrated one next to a discrete GPU.
      const local=probeResult.devices.filter(d=>llama.deviceKind(d.name)==='gpu');
      const {keep,skipped}=llama.strongGpus(local,{skipIntegrated:skipIgpu});
      const skippedNames=localGpu&&keep.length?skipped.map(d=>d.name):[];
      for(const d of probeResult.devices.filter(x=>skippedNames.includes(x.name)))pool.warnings.push(tr('dev.warn.igpuSkipped',{gpu:d.description||d.name}));
      const deviceList=skippedNames.length?[...keep.map(d=>d.name),...rpcSeen.map(d=>d.name)]:null;
      pool.devices=llama.poolDeviceRows(probeResult.devices,{names,endpoints:rpc,remote,selfName:state.name,localGpu,skipped:skippedNames});
      for(const row of pool.devices)if(row.worker>=0)row.link=pool.tunnels[row.worker]?.link||'other';
      // This computer's GPU was asked for but llama.cpp sees none (e.g. no Metal on a Mac, CPU-only build).
      if(localGpu&&l.archMismatch)pool.warnings.push(tr('dev.warn.llamaArch',{arch:l.arch,native:llama.nativeArch()}));
      if(localGpu&&!pool.devices.some(d=>d.local&&d.kind==='gpu')){
        const seen=probeResult.devices.filter(d=>deviceKindLocal(d.name)).map(d=>d.name+(d.description?' ('+d.description+')':'')).join(', ')||'—';
        pool.warnings.push(process.platform==='darwin'?tr('dev.warn.noMetal',{devices:seen}):tr('dev.warn.noLocalGpu',{devices:seen}));
        log('warn','pool: no local GPU in --list-devices: '+String(probeResult.output||'').slice(-800));
      }
      pool.probe=String(probeResult.output||'').slice(-2000);
      if(localGpu&&!pool.devices.some(d=>d.local&&d.kind==='gpu'))log('warn','llama-server --list-devices: '+pool.probe.split('\n').filter(x=>/metal|mtl|device|fail|error|blas/i.test(x)).slice(-12).join(' | ').slice(0,1500));
      pool.port=await freeLocalPort();pool.apiKey=randomBytes(24).toString('hex');
      const args=llama.llamaServerArgs({model,rpc,port:pool.port,ctx,localGpu,alias:'pool',apiKey:pool.apiKey,devices:deviceList});
      pool.state='loading';
      const proc=llama.managedProcess(l.llamaServer,args,{onLine:line=>{if(/ggml_metal|metal|vulkan|cuda|failed|error|unable|abort/i.test(line))log('warn','llama-server: '+line.slice(0,300));},onExit:s=>{if(pool.proc===proc&&pool.state!=='stopped'){pool.state='error';{const lines=proc.log(200);const log=llama.explainServerLog(lines)||s.error||('exit code '+s.exitCode);pool.error=tr('dev.err.poolExited',{log})+(lines.some(l=>/unknown model architecture/i.test(l))?'\n\n'+tr('dev.err.unsupportedArch',{build:l.build||'(custom)'}):'');}closeTunnels();onPoolStopped(poolBaseSaved);}}});
      pool.proc=proc;const poolBaseSaved=poolBase();
      waitReady(proc).catch(()=>{});
    }catch(e){closeTunnels();pool.state='error';pool.error=e.message;throw e;}
  }
  async function waitReady(proc){
    // Loading prints progress and uploads tensors to the workers. No progress for 3 minutes: a warning;
    // for 10 minutes: stop with an error instead of loading forever.
    let lastLines=-1,lastBytes=-1,since=Date.now(),warned=false;
    while(pool.proc===proc&&proc.state.running){
      const bytes=pool.tunnels.reduce((n,x)=>n+(x.t.stats.bytesUp||0)+(x.t.stats.bytesDown||0),0);
      if(proc.state.lines!==lastLines||bytes!==lastBytes){lastLines=proc.state.lines;lastBytes=bytes;since=Date.now();}
      const idle=Date.now()-since;
      if(!warned&&idle>STALL_WARN_MS){warned=true;pool.warnings.push(tr('dev.warn.stalled',{min:Math.max(1,Math.round(STALL_WARN_MS/60000)),log:proc.log(4).join('\n')||'—'}));log('warn','pool: no progress');}
      if(idle>STALL_STOP_MS){
        const msg=tr('dev.err.loadStalled',{min:Math.max(1,Math.round(STALL_STOP_MS/60000)),log:llama.explainServerLog(proc.log(200))||'—'});
        log('error','pool: stopped after no progress');
        const base=poolBase();pool.proc=null;proc.stop();closeTunnels();pool.state='error';pool.error=msg;pool.port=null;pool.apiKey=null;onPoolStopped(base);return;
      }
      try{const r=await fetch('http://127.0.0.1:'+pool.port+'/health',{signal:AbortSignal.timeout(3000)});if(r.ok){pool.ctx=await actualContext();pool.state='running';return;}}catch{}
      await sleep(1000);
    }
  }
  // llama-server caps the context at the model's training length; the agent must use the real value.
  async function actualContext(){
    try{const r=await fetch('http://127.0.0.1:'+pool.port+'/props',{headers:{Authorization:'Bearer '+pool.apiKey},signal:AbortSignal.timeout(3000)});
      const n=(await r.json())?.default_generation_settings?.n_ctx;return Number.isInteger(n)&&n>0?n:null;}catch{return null;}
  }
  function closeTunnels(){for(const x of pool.tunnels){poolBytes.up+=x.t.stats.bytesUp||0;poolBytes.down+=x.t.stats.bytesDown||0;x.t.close();}pool.tunnels=[];}

  // ---------- link quality and live activity ----------
  const poolBytes={up:0,down:0};
  // Round trip (median of 5 pings) and download speed of the link to a paired device.
  async function measureLink(node,{bytes=8*2**20}={}){
    const headers={[PEER_HEADER]:node.token},rtts=[];
    for(let i=0;i<5;i++){const t0=performance.now();const r=await fetch(node.url+'/peer/ping',{headers,signal:AbortSignal.timeout(3000)});await r.arrayBuffer();if(!r.ok)throw Error('HTTP '+r.status);rtts.push(performance.now()-t0);}
    const t0=performance.now();
    const r=await fetch(node.url+'/peer/speedtest?bytes='+bytes,{headers,signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw Error('HTTP '+r.status);
    const got=(await r.arrayBuffer()).byteLength,sec=(performance.now()-t0)/1000;
    const link={rttMs:Math.round(median(rtts)*10)/10,mbps:Math.round(got/2**20/Math.max(sec,0.001)),at:Date.now(),link:node.link||'other'};
    const n=registry.get(node.id);if(n)n.status.link=link;
    return link;
  }
  const meter=createActivity();
  let uiSeen=0,pollTimer=null;
  const peerActivity=new Map();
  // Paired devices' live stats (token-authenticated /peer/activity), only while someone looks.
  function pollPeers(){
    if(Date.now()-uiSeen>5000){clearInterval(pollTimer);pollTimer=null;return;}
    const inPool=new Set(pool.tunnels.map(x=>x.id));
    for(const n of registry.list()){
      if(n.kind!=='kvalah'||!n.enabled||!n.token)continue;
      if(!inPool.has(n.id)&&!(state.tasks.enabled&&n.tasks&&n.status.online))continue;
      fetch(n.url+'/peer/activity',{headers:{[PEER_HEADER]:n.token},signal:AbortSignal.timeout(1800)})
        .then(r=>r.ok?r.json():null).then(a=>{if(a)peerActivity.set(n.id,{...a,seen:Date.now()});}).catch(()=>{});
    }
  }
  function touchUi(){uiSeen=Date.now();if(!pollTimer){pollTimer=setInterval(pollPeers,2000);pollTimer.unref?.();pollPeers();}}
  function roles(){
    const out=[];
    if(['starting','loading','running'].includes(pool.state))out.push({kind:'host',state:pool.state,devices:pool.tunnels.length});
    const lentTo=[...new Set([...tunnels].map(t=>t.host))];
    if(lentTo.length)out.push({kind:'memory',hosts:lentTo});
    if(serving.size)out.push({kind:'tasks',hosts:[...serving.keys()],n:[...serving.values()].reduce((a,b)=>a+b,0)});
    const inflight=registry.list().reduce((n,x)=>n+(x.status.inflight||0),0);
    if(inflight)out.push({kind:'distributing',n:inflight});
    return out;
  }
  function activitySnapshot(){
    let up=poolBytes.up+tunnelBytes.up+proxyBytes.up,down=poolBytes.down+tunnelBytes.down+proxyBytes.down;
    for(const x of pool.tunnels){up+=x.t.stats.bytesUp||0;down+=x.t.stats.bytesDown||0;}
    for(const t of tunnels){up+=t.socket?.bytesWritten||0;down+=t.socket?.bytesRead||0;}
    return {name:state.name,roles:roles(),...meter.sample({bytesUp:up,bytesDown:down})};
  }
  function peersActivity(){
    const out={};
    for(const [id,a] of peerActivity)if(Date.now()-a.seen<8000)out[id]={roles:a.roles,cpu:a.cpu,ram:a.ram,gpus:a.gpus,net:a.net,tps:a.tps};
    return out;
  }
  function stopPool(){
    const base=poolBase();
    pool.state='stopped';pool.proc?.stop();pool.proc=null;closeTunnels();pool.port=null;pool.apiKey=null;pool.ctx=null;pool.devices=[];
    onPoolStopped(base);
  }

  // ---------- public API (/api/devices/*, local UI only) ----------
  async function snapshot(){
    if(!installedLlama&&install.state!=='downloading')await resolveLlama();
    return {
      self:{id:state.id,name:state.name,version,platform:process.platform,arch:process.arch,nativeArch:llama.nativeArch(),translated:llama.runningTranslated()},
      share:{enabled:state.share.enabled,port:state.share.port,tasks:state.share.tasks,rpc:state.share.rpc,code:state.share.code,
        addresses:(()=>{const types=Object.fromEntries(myLinks().map(l=>[l.address,l]));return (listener?listener.listening.map(a=>({address:a.address,port:a.port})):bindAddresses().map(a=>({address:a,port:state.share.port}))).map(a=>({...a,type:types[a.address]?.type||'other',iface:types[a.address]?.name||''})).sort((x,y)=>linkRank(x.type)-linkRank(y.type));})(),
        rpcIgpu:!!state.share.rpcIgpu,
        listening:!!listener,error:shareError,hosts:state.share.hosts.map(({hash,...h})=>h),tunnels:[...tunnels].map(t=>({host:t.host,since:t.since}))},
      rpc:{running:!!rpcProc?.state.running,error:rpcError,log:rpcProc?rpcProc.log(8):[],devices:rpcDevices},
      llama:{build:llama.LLAMA_BUILD,installed:installedLlama?{build:installedLlama.build,backend:installedLlama.backend,dir:installedLlama.dir,rpcServer:!!installedLlama.rpcServer,llamaServer:!!installedLlama.llamaServer,arch:installedLlama.arch||null,archMismatch:!!installedLlama.archMismatch}:null,
        path:state.llama.path,backend:state.llama.backend,supported:!!llama.pickAssets({}),install},
      discovered:discoveredList(),discoveryError,
      nodes:registry.publicList(),activity:peersActivity(),
      tasks:{...state.tasks},
      pool:{...state.pool,state:pool.state,error:pool.error,warnings:pool.warnings,devices:pool.devices,actualCtx:pool.ctx||null,baseUrl:pool.state==='running'?poolBase():null,
        tunnels:pool.tunnels.map(x=>({name:x.name,id:x.id,link:x.link,...x.t.stats})),log:pool.proc?pool.proc.log(12):[],probe:pool.probe||'',startedAt:pool.startedAt}
    };
  }
  async function handle(route,method,b={}){
    if(route===''&&method==='GET'){ensureDiscovery();touchUi();return snapshot();}
    if(route==='/activity'&&method==='GET'){touchUi();return {...activitySnapshot(),peers:peersActivity(),pool:{state:pool.state,devices:pool.tunnels.map(x=>({id:x.id,name:x.name,link:x.link}))}};}
    if(route==='/measure'&&method==='POST'){
      const ids=Array.isArray(b.ids)&&b.ids.length?b.ids.map(String):registry.list().filter(n=>n.kind==='kvalah'&&n.enabled&&n.token).map(n=>n.id);
      await Promise.all(ids.map(async id=>{const n=registry.get(id);if(!n||n.kind!=='kvalah')return;try{await providerFor(n).probe();await measureLink(registry.get(id));}catch(e){n.status.link={error:String(e.message||e).slice(0,200),at:Date.now()};}}));
      return snapshot();
    }
    if(route==='/share'&&method==='POST'){
      if(b.name!==undefined){const n=String(b.name).replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,64);if(n)state.name=n;}
      if(b.port!==undefined){const p=Number(b.port);if(!Number.isInteger(p)||p<1024||p>65535)throw Error(tr('dev.err.badPort'));if(p!==state.share.port){state.share.port=p;stopListener();}}
      state.share.enabled=bool(b.enabled,state.share.enabled);state.share.tasks=bool(b.tasks,state.share.tasks);state.share.rpc=bool(b.rpc,state.share.rpc);
      const igpu=bool(b.rpcIgpu,state.share.rpcIgpu);const restartRpc=igpu!==!!state.share.rpcIgpu;state.share.rpcIgpu=igpu;
      await save();if(restartRpc&&rpcProc)stopRpc();await applyShare();return snapshot();
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
    if(route==='/gguf'&&method==='GET')return listGguf();
    if(route==='/gguf/resolve'&&method==='POST'){
      const name=String(b.name||'').trim();if(!name)throw Error(tr('dev.err.modelMissing'));
      const dir=llama.ollamaModelsDir();
      try{const r=await llama.resolveOllamaModel(name,{dir,ollamaUrl:ollamaUrl()});return {name,path:r.path,size:r.size,source:r.source};}
      catch(e){throw Error(tr('dev.err.ollamaModelNotFound',{name,paths:(e.tried||[]).join('\n')||dir,dir:path.join(dir,'blobs')}));}
    }
    if(route==='/pool/start'&&method==='POST'){await startPool(b);return snapshot();}
    if(route==='/pool/stop'&&method==='POST'){stopPool();return snapshot();}
    throw Error('Not found');
  }

  // Repair: an Intel llama.cpp on Apple Silicon (installed by kvalah's Intel build under Rosetta) has no
  // Metal, so the Mac's GPU was never used. Re-download the native build once, in the background.
  if(process.platform==='darwin'&&!state.llama.path)resolveLlama().then(l=>{
    if(l?.archMismatch&&llama.pickAssets({backend:state.llama.backend||'auto'})){log('info','llama.cpp '+l.arch+' on '+llama.nativeArch()+': re-downloading the native build');return startInstall(state.llama.backend||'auto');}
  }).catch(()=>{});
  if(state.share.enabled)applyShare().catch(e=>{shareError=e.message;});
  scheduleHealth();
  return {
    handle,registry,
    get tasks(){return state.tasks;},
    tasksEnabled:()=>state.tasks.enabled===true,
    addTokens:n=>meter.addTokens(n),
    pool:()=>({state:pool.state,baseUrl:pool.state==='running'?poolBase():null,apiKey:pool.apiKey,ctx:pool.ctx||state.pool.ctx}),
    shutdown(){clearInterval(healthTimer);clearInterval(pollTimer);clearInterval(announceTimer);try{socket?.close();}catch{}socket=null;stopListener();stopRpc();if(pool.proc){pool.proc.stop();}closeTunnels();},
    id:state.id
  };
}
export {NODE_KINDS};
