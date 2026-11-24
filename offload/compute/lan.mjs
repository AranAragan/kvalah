import os from 'node:os';
// LAN cluster integration: reuses the kvalah desktop's device list (Settings → Devices) read-only from
// <dataDir>/devices.json and kvalah's node registry, so offload jobs can be scheduled on paired kvalah
// machines or bare Ollama/OpenAI-compatible servers on the LAN. Opt-in (KVALAH_LAN=1).
// The provider construction mirrors kvalah devices.mjs (peer proxy at <url>/peer/llm, token header).
// v0.3 (SEC-03) — sending source code to another machine requires, per node:
//   * explicit consent: the node's id or name is listed in KVALAH_LAN_ALLOW (nothing is allowed by default);
//   * a private/loopback/link-local address (literal or every DNS answer), re-checked on every request;
//   * https with certificate verification (Node's default CA store / NODE_EXTRA_CA_CERTS), or an explicit
//     plaintext opt-in KVALAH_LAN_ALLOW_PLAINTEXT=1 for a trusted wired LAN / authenticated tunnel;
//   * no redirects (a 3xx is an error, the token never leaves for another origin), same-origin requests only;
//   * a 401/403 marks the node offline at once (revoked pairing) and the job fails over;
//   * local-only (default): cloud-backed models of local servers (":cloud"/"-cloud", Ollama remote_host) are hidden
//     and refused (KVALAH_ALLOW_CLOUD_MODELS=1 to allow).
// LAN always uses the lite providers with this guarded fetch, in both standalone and overlay mode, so the
// guarantees do not depend on the upstream providers.mjs. Tokens/API keys are never logged or listed.
import {readFile} from 'node:fs/promises';
import {lookup as dnsLookup} from 'node:dns/promises';
import {pinnedFetch} from './netpolicy.mjs';
import net from 'node:net';
import path from 'node:path';
import {ollamaProvider as liteOllama,openaiProvider as liteOpenai,isCloudModel} from './providers-lite.mjs';
export const PEER_HEADER='x-kvalah-token';

export function isPrivateAddress(ip){
  ip=String(ip).replace(/^\[|\]$/g,'').toLowerCase();
  const m4=ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if(m4){const [a,b]=[+m4[1],+m4[2]];
    return a===10||a===127||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===169&&b===254)||(a===100&&b>=64&&b<=127);}
  if(net.isIPv6(ip))return ip==='::1'||/^f[cd][0-9a-f]{2}:/.test(ip)||/^fe[89ab][0-9a-f]:/.test(ip);
  return false;
}
const splitList=v=>String(v||'').split(/[,;\n]/).map(x=>x.trim()).filter(Boolean);
export function lanPolicyFromEnv(env=process.env){
  return {allow:new Set(splitList(env.KVALAH_LAN_ALLOW)),plaintext:env.KVALAH_LAN_ALLOW_PLAINTEXT==='1',localOnly:env.KVALAH_ALLOW_CLOUD_MODELS!=='1'};
}
class LanRefused extends Error{constructor(m){super(m);this.name='LanRefused';}}

export async function createLan({dataDir,createRegistry,ollamaProvider:_o,openaiProvider:_a,intervalMs=30000,fetchImpl=pinnedFetch,env=process.env,lookup=(h)=>dnsLookup(h,{all:true,verbatim:true})}){
  const file=path.join(dataDir,'devices.json');
  const pol=lanPolicyFromEnv(env);
  const off=error=>({registry:null,error,nodes:()=>[],capacity:()=>0,stop(){}});
  let state;try{state=JSON.parse(await readFile(file,'utf8'));}catch(e){return off(`cannot read ${file}: ${e.code||e.message}`);}
  if(!pol.allow.size)return off('no node is allowed to receive workspace data: list node ids or names in KVALAH_LAN_ALLOW');
  let registry;
  // per-node guarded fetch: origin pinned to the node URL, address/scheme checked before every request
  function guard(node){
    const origin=new URL(node.url).origin;
    const fail=(msg)=>{const live=registry?.get(node.id);if(live){live.status.online=false;live.status.error=msg;}return new LanRefused(msg);};
    return async(url,opt={})=>{
      const u=new URL(url);
      if(u.origin!==origin)throw fail('cross-origin request refused');
      if(u.protocol==='http:'&&!pol.plaintext)throw fail('plaintext http refused (use https or set KVALAH_LAN_ALLOW_PLAINTEXT=1 for a trusted network)');
      if(u.protocol!=='https:'&&u.protocol!=='http:')throw fail('unsupported scheme');
      if(u.username||u.password)throw fail('credentials in URL refused');
      const host=u.hostname.replace(/^\[|\]$/g,'');
      let addrs;try{addrs=net.isIP(host)?[{address:host}]:await lookup(host);}catch(e){throw fail('cannot resolve '+host);}
      if(!addrs?.length||addrs.some(a=>!isPrivateAddress(a.address)))throw fail('non-private address refused ('+host+')');
      const r=await fetchImpl(url,{...opt,redirect:'manual'},{address:addrs[0].address});   // v0.4 SEC-03: connect to the checked address
      if(r.status>=300&&r.status<400){r.body?.cancel?.().catch?.(()=>{});throw fail('redirect refused (HTTP '+r.status+')');}
      if(r.status===401||r.status===403){r.body?.cancel?.().catch?.(()=>{});throw fail('token rejected (HTTP '+r.status+'): pairing revoked?');}
      return r;
    };
  }
  function providerFor(node){
    const f=guard(node),localOnly=pol.localOnly;
    if(node.kind==='kvalah'){
      const headers={[PEER_HEADER]:node.token};const base=node.url+'/peer/llm';
      const p=node.backend==='openai'?liteOpenai(base,'',{headers,fetchImpl:f,localOnly}):liteOllama(base,{headers,label:node.name,fetchImpl:f,localOnly});
      p.probe=async()=>{const r=await f(node.url+'/peer/info',{headers,signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('HTTP '+r.status);const info=await r.json();
        return {models:(info.models||[]).filter(m=>!(localOnly&&isCloudModel(m))),backend:info.backend,info:{name:info.name,version:info.version,backend:info.backend,context:Number.isFinite(info.context)?info.context:undefined}};};
      return p;
    }
    if(node.kind==='openai')return liteOpenai(node.url,node.apiKey,{fetchImpl:f,localOnly});
    return liteOllama(node.url,{label:node.name,fetchImpl:f,localOnly});
  }
  const all=(state.nodes||[]).filter(n=>n&&n.enabled!==false&&n.tasks!==false);
  const allowed=all.filter(n=>pol.allow.has(n.id)||pol.allow.has(n.name));
  registry=createRegistry({providerFor});
  registry.load(allowed);
  await registry.checkAll();
  const timer=setInterval(()=>registry.checkAll().catch(()=>{}),intervalMs);timer.unref?.();
  return {registry,error:null,skipped:all.length-allowed.length,
    nodes:()=>registry.publicList().map(n=>({id:n.id,name:n.name,kind:n.kind,url:n.url,online:n.status.online,error:n.status.error||null,models:n.status.models.slice(0,20),inflight:n.status.inflight,maxParallel:n.maxParallel,ewmaMs:n.status.ewmaMs,ok:n.status.ok,failed:n.status.failed})),
    // context limits reported by peers (/peer/info "context") or set per node in devices.json ("context")
    nodeContexts:()=>registry.list().filter(n=>n.status.online).map(n=>Number(n.status.info?.context||state.nodes.find(x=>x.id===n.id)?.context)).filter(x=>Number.isFinite(x)&&x>0),
    capacity:(model)=>registry.list().filter(n=>registry.available(n,model)).reduce((c,n)=>c+n.maxParallel,0),
    stop(){clearInterval(timer);}};
}
// Default kvalah desktop data dir (Electron userData/data) per platform; KVALAH_DATA_DIR / LOCAL_CODEX_DATA override.
// v0.4: never relative — with HOME unset the old '' home put the data dir (service token!) under the current directory.
export function defaultDataDir(env=process.env,platform=process.platform,home=env.HOME||env.USERPROFILE||os.homedir()||os.tmpdir()){
  if(env.KVALAH_DATA_DIR)return env.KVALAH_DATA_DIR;if(env.LOCAL_CODEX_DATA)return env.LOCAL_CODEX_DATA;
  if(platform==='win32')return path.join(env.APPDATA||path.join(home,'AppData','Roaming'),'kvalah','data');
  if(platform==='darwin')return path.join(home,'Library','Application Support','kvalah','data');
  return path.join(env.XDG_CONFIG_HOME||path.join(home,'.config'),'kvalah','data');
}
