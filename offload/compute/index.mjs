// Composition root: builds the whole offload stack from environment-style config.
import os from 'node:os';
import path from 'node:path';
import {loadKvalah} from './bridge.mjs';
import {createOffload,KINDS,STRATEGIES} from './offload.mjs';
import {createFileReader} from './files.mjs';
import {createDeterministic,OPS} from './deterministic/index.mjs';
import {createDeterministicPool} from './deterministic/pool.mjs';
import {createTokenCounter,detectContext,effectiveContext,llamaCppTokenizer} from './tokens.mjs';
import {createCache} from './cache.mjs';
import {detectModelDigest} from './tokens.mjs';
import {createStats} from './stats.mjs';
import {pricingFromEnv} from './cost.mjs';
import {createRouter} from './router.mjs';
import {createLan,defaultDataDir} from './lan.mjs';
import {startDashboard} from './dashboard.mjs';
import {createPerfModel,perfScheduler} from './perf.mjs';
import {createPolicy,policyFromEnv} from './policy.mjs';
export {KINDS,STRATEGIES,OPS};
export const VERSION='0.4.0';
const int=(v,d,min,max)=>{const n=Number.parseInt(v??'',10);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):d;};
export function defaultCacheDir(env=process.env){
  if(env.KVALAH_CACHE_DIR)return env.KVALAH_CACHE_DIR;
  const home=os.homedir();
  if(process.platform==='win32')return path.join(env.LOCALAPPDATA||path.join(home,'AppData','Local'),'kvalah-offload','cache');
  if(process.platform==='darwin')return path.join(home,'Library','Caches','kvalah-offload');
  return path.join(env.XDG_CACHE_HOME||path.join(home,'.cache'),'kvalah-offload');
}
export function parseConfig(env=process.env){
  const model=env.KVALAH_MODEL;if(!model)throw Error('Set KVALAH_MODEL to an installed local model');
  const provider=env.KVALAH_PROVIDER||'ollama';if(!['ollama','openai'].includes(provider))throw Error('KVALAH_PROVIDER must be "ollama" or "openai"');
  const url=new URL(env.KVALAH_LOCAL_URL||(provider==='ollama'?'http://127.0.0.1:11434':'http://127.0.0.1:1234/v1'));
  if(!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.protocol!=='http:'||url.username||url.password||url.search||url.hash)
    throw Error('KVALAH_LOCAL_URL: only explicitly local http://127.0.0.1 / localhost / [::1] endpoints are supported (use KVALAH_LAN=1 for other machines)');
  if(/(-|:)cloud$/i.test(model)&&env.KVALAH_ALLOW_CLOUD_MODELS!=='1')throw Error('KVALAH_MODEL '+model+' is a cloud-backed model: source would leave this machine. Set KVALAH_ALLOW_CLOUD_MODELS=1 to allow it explicitly');
  const cacheOff=env.KVALAH_CACHE==='off';
  return {model,provider,url:url.href,workspace:env.KVALAH_WORKSPACE||null,
    maxParallel:int(env.KVALAH_MAX_PARALLEL,1,1,16),timeoutMs:int(env.KVALAH_TIMEOUT_MS,90000,1000,1800000),queueTimeoutMs:int(env.KVALAH_QUEUE_TIMEOUT_MS,120000,1000,3600000),
    maxTokens:int(env.KVALAH_MAX_TOKENS,2048,128,32768),ctxTokens:int(env.KVALAH_CONTEXT,16384,2048,1048576),maxChunks:int(env.KVALAH_MAX_CHUNKS,24,1,512),
    secretPolicy:env.KVALAH_SECRET_POLICY==='block'?'block':'redact',structured:env.KVALAH_STRUCTURED!=='0',
    cacheDir:cacheOff?null:defaultCacheDir(env),cacheTtlMs:int(env.KVALAH_CACHE_TTL_HOURS,168,1,24*365)*3600*1000,cacheMaxBytes:int(env.KVALAH_CACHE_MAX_MB,64,1,10240)*1024*1024,
    lan:env.KVALAH_LAN==='1',dataDir:defaultDataDir(env),dashboard:env.KVALAH_DASHBOARD==='1',dashboardPort:int(env.KVALAH_DASHBOARD_PORT,0,0,65535),
    pricing:pricingFromEnv(env),minSavingsUsd:Number(env.KVALAH_ROUTER_MIN_SAVINGS_USD)||0,
    routerMinTokens:int(env.KVALAH_ROUTER_MIN_TOKENS,2000,0,1000000),cacheDisk:env.KVALAH_CACHE_DISK!=='0',cacheSensitive:env.KVALAH_CACHE_SENSITIVE==='1',
    requestDeadlineMs:int(env.KVALAH_REQUEST_DEADLINE_MS,900000,1000,86400000),maxPendingCalls:int(env.KVALAH_MAX_PENDING_CALLS,64,1,4096)};
}
export async function createKvalahOffload({env=process.env,provider:providerOverride=null,log:rawLog=()=>{}}={}){
  const cfg=parseConfig(env);
  const policy=createPolicy(policyFromEnv(env));
  const log=m=>rawLog(policy.text(String(m)));
  const k=await loadKvalah(env);
  const provider=providerOverride||(cfg.provider==='ollama'?k.ollamaProvider(cfg.url):k.openaiProvider(cfg.url));
  // context window discovery (best effort, short timeout)
  let dt;const detected=providerOverride?{}:await Promise.race([detectContext(provider,cfg.model),new Promise(r=>{dt=setTimeout(()=>r({}),4000);dt.unref?.();})]).finally(()=>clearTimeout(dt));
  let lan=null;
  if(cfg.lan){lan=await createLan({dataDir:cfg.dataDir,createRegistry:k.createRegistry,env});if(lan.error)log('LAN disabled: '+lan.error);}
  // CTX-01: plan by the smallest context known among allowed LAN nodes
  const ctxTokens=effectiveContext({configured:cfg.ctxTokens,detected,providerKind:provider.kind,nodeContexts:lan?.nodeContexts?.()||[]});
  const counter=createTokenCounter({exact:cfg.provider==='openai'&&!providerOverride?llamaCppTokenizer(cfg.url):null});
  // SCHED-01: devices are compared by measured speed (KVALAH_SCHED_PERF=0 → v0.3 scoring by last-job wall time)
  const perf=env.KVALAH_SCHED_PERF==='0'?null:createPerfModel({refPromptTokens:int(env.KVALAH_SCHED_REF_PROMPT,1000,1,1e6),refOutputTokens:int(env.KVALAH_SCHED_REF_OUTPUT,200,1,1e5)});
  const schedOpts={registry:lan?.registry||null,local:{provider,model:cfg.model,maxParallel:cfg.maxParallel},maxAttempts:lan?.registry?3:1};
  const scheduler=perf?perfScheduler(k.createScheduler,{...schedOpts,perf}):k.createScheduler(schedOpts);
  const devicePerf=()=>{
    const rows=[{id:'local',name:'local',inflight:scheduler.localState?.inflight??null,capacity:cfg.maxParallel,context:ctxTokens,info:null}];
    if(lan?.registry)for(const n of lan.registry.list())rows.push({id:n.id,name:n.name,inflight:n.status.inflight,capacity:n.maxParallel,online:n.status.online,
      context:Number(n.status.info?.context)||Number(n.context)||null,info:n.status.info||null});
    return rows.map(r=>{const v=perf?perf.view(r.id):{samples:0,genTokensPerSec:null,promptTokensPerSec:null,ttftMs:null,refJobMs:null};
      // kvalah /peer/info reports lent GPU devices as rpc.devices[{freeMiB,totalMiB}]; nothing is guessed otherwise
      const gpus=Array.isArray(r.info?.rpc?.devices)&&r.info.rpc.devices.length?r.info.rpc.devices:null;
      const vf=gpus?gpus.reduce((a,g)=>a+Number(g.freeMiB)*1048576,0):Number(r.info?.vramFree),vt=gpus?gpus.reduce((a,g)=>a+Number(g.totalMiB)*1048576,0):Number(r.info?.vramTotal);
      return {id:r.id,name:r.name,online:r.online??null,...v,context:r.context,plannedContext:ctxTokens,inflight:r.inflight,capacity:r.capacity,load:r.capacity?+((r.inflight||0)/r.capacity).toFixed(2):null,
        vramFreeBytes:Number.isFinite(vf)?vf:null,vramTotalBytes:Number.isFinite(vt)?vt:null,vramSource:Number.isFinite(vf)?'device report':'not reported by backend (Ollama has no free-VRAM API)'};});
  };
  const readFiles=cfg.workspace?createFileReader({root:cfg.workspace}):null;
  const cache=createCache({dir:cfg.cacheDir&&cfg.cacheDisk?path.join(cfg.cacheDir,'results'):null,ttlMs:cfg.cacheTtlMs,maxBytes:cfg.cacheMaxBytes});
  const modelDigest=providerOverride?null:await detectModelDigest(provider,cfg.model);
  const stats=createStats({file:cfg.cacheDir?path.join(cfg.cacheDir,'stats.json'):null});await stats.load();
  const measured=await loadMeasured(env.KVALAH_BENCH_RESULTS);   // v0.4 BENCH-06
  const engine=createOffload({provider,model:cfg.model,scheduler,perf,devicePerf,readFiles,counter,cache,stats,pricing:cfg.pricing,measured,ctxTokens,maxTokens:cfg.maxTokens,
    timeoutMs:cfg.timeoutMs,queueTimeoutMs:cfg.queueTimeoutMs,maxChunks:cfg.maxChunks,structured:cfg.structured,secretPolicy:cfg.secretPolicy,policy,requestDeadlineMs:cfg.requestDeadlineMs,maxPendingCalls:cfg.maxPendingCalls,
    modelDigest,cacheSensitive:cfg.cacheSensitive,cacheScope:()=>lan?.registry?lan.nodes().filter(n=>n.online).map(n=>n.id+':'+n.models.join(',')).sort().join('|'):null});
  // CPU-01: deterministic ops in a worker thread (KVALAH_DET_WORKER=0 → in-process, for debugging only)
  const det=!readFiles?null:env.KVALAH_DET_WORKER==='0'?createDeterministic({reader:readFiles}):createDeterministicPool({reader:readFiles,timeoutMs:int(env.KVALAH_DET_TIMEOUT_MS,20000,100,600000),memoryMb:int(env.KVALAH_DET_MEMORY_MB,256,32,8192)});
  let hc=null;const health=async()=>{if(hc&&Date.now()-hc.at<10000)return hc.v;let v;try{v=await provider.health();}catch(e){v={online:false,error:e.message};}
    if(!v.online&&lan?.capacity(cfg.model))v={online:true,via:'lan'};hc={at:Date.now(),v};return v;};
  const router=createRouter({engine,det,counter,pricing:cfg.pricing,stats,health,capacity:()=>cfg.maxParallel+(lan?.capacity(cfg.model)||0),minSavingsUsd:cfg.minSavingsUsd,minTokens:cfg.routerMinTokens});
  let dashboard=null;const computeRunning=new Map();let stateExtra=null;
  const showPaths=env.KVALAH_DASHBOARD_SHOW_PATHS==='1';
  // UI-01: operator actions (dashboard / GUI over the service)
  function cancel(id){id=String(id);if(engine.cancel(id))return true;const c=computeRunning.get(id);if(!c)return false;c.abort(Object.assign(Error('Cancelled by the operator (dashboard)'),{name:'AbortError'}));return true;}
  async function clearCache(){const ws=readFiles?await readFiles.resolveRoot():null;await cache.clear(ws?{workspace:ws}:{});return {cleared:true,workspace:!!ws};}
  async function compute(args,{signal}={}){
    if(!det)throw Error('kvalah_compute needs KVALAH_WORKSPACE (read-only workspace root)');
    const {op,...rest}=args||{};const started=Date.now();const entry={id:Math.random().toString(36).slice(2,10),at:started,tool:'kvalah_compute',level:1,op,status:'running',cancellable:true};engine.log(entry);
    const opCtl=new AbortController();computeRunning.set(entry.id,opCtl);const sig=signal?AbortSignal.any([signal,opCtl.signal]):opCtl.signal;
    try{sig.throwIfAborted();const r=policy.output(await det.run(op,rest,{signal:sig}));Object.assign(entry,{status:'done',ms:Date.now()-started});return r;}
    catch(e){const safe=policy.error(e);Object.assign(entry,{status:sig.aborted?'cancelled':'failed',ms:Date.now()-started,error:safe.message});throw safe;}
    finally{computeRunning.delete(entry.id);entry.cancellable=false;}
  }
  async function auto(args,{signal}={}){
    const t={goal:args.goal,paths:args.paths,context:args.context,query:args.query,kind:args.kind,prefer:args.prefer,contextAlreadyLoaded:!!args.contextAlreadyLoaded,alreadyRead:args.alreadyRead};
    if(typeof t.goal!=='string'||!t.goal.trim()||t.goal.length>4000)throw Error('goal must be 1–4000 characters');
    const route=await router.decide(t,{signal});
    if(route.level===1)return {route,...await compute({op:route.op,...route.args},{signal})};
    if(route.level===3){engine.declined();engine.log({id:Math.random().toString(36).slice(2,10),at:Date.now(),tool:'kvalah_auto',level:3,kind:route.kind,status:'declined',ms:0});return {route,level:3,advice:route.advice};}
    const r=await engine.delegate({kind:route.kind,instruction:t.goal,...(t.paths?{paths:t.paths}:{}),...(t.context?{context:t.context}:{}),...(t.query?{query:t.query}:{})},{signal,tool:'kvalah_auto'});
    return {route,...r};
  }
  async function status(){
    const s=await engine.status();
    return policy.output({...s,version:VERSION,kvalah:{mode:k.mode,home:k.home},context:{...s.context,detected,configured:cfg.ctxTokens},deterministic:det?{enabled:true,ops:OPS}:{enabled:false},
      cache:cache.stats(),pricing:cfg.pricing,lan:cfg.lan?{enabled:!!lan?.registry,error:lan?.error||null,nodes:lan?.nodes()||[]}:{enabled:false},dashboard:dashboard?{url:`http://127.0.0.1:${dashboard.port}/`,token:'printed to the server log only'}:null});
  }
  async function state(){const metrics=engine.metrics();const extra=stateExtra?stateExtra():{};const perfRows=metrics.devicePerf||[];
    return policy.output({model:cfg.model,provider:provider.kind,ctxTokens,mode:k.mode,pricing:cfg.pricing,metrics,
    tasks:engine.tasks().map(t=>{const {paths,...rest}=t;return showPaths?t:rest;}),
    limits:{maxParallel:cfg.maxParallel,ctxTokens,maxTokens:cfg.maxTokens,maxPendingCalls:cfg.maxPendingCalls,timeoutMs:cfg.timeoutMs,queueTimeoutMs:cfg.queueTimeoutMs,requestDeadlineMs:cfg.requestDeadlineMs,maxChunks:cfg.maxChunks,
      deterministic:det?.stats?.()??null},
    queue:{pending:metrics.pending??0,pendingCalls:metrics.pendingCalls??null,maxPending:engine.maxPending??null},
    cost:{kind:'estimated',estimated:metrics.savings??null,measured:metrics.measured?.available?metrics.measured:null,measuredStatus:metrics.measured??null,note:'estimated = token heuristics; measured = bench/ paired analysis only (KVALAH_BENCH_RESULTS)'},
    cache:cache.stats(),...extra,
    // v0.4 UI-02: active agents (service clients), errors and cancelled operations, device load and measured speed
    agents:(extra.service?.clients||[]).map(c=>({client:c.client,priority:c.priority??null,scope:c.scope??null,pending:c.pending??null,leases:c.leases??null})),
    errors:{failed:metrics.failed??0,cancelled:metrics.cancelled??0,queueTimeouts:metrics.queueTimeouts??0,execTimeouts:metrics.execTimeouts??0,rejected:metrics.rejected??0,
      service:extra.service?{failed:extra.service.failed??0,cancelled:extra.service.cancelled??0,rejected:extra.service.rejected??0,queueTimeouts:extra.service.queueTimeouts??0,protocolErrors:extra.service.protocolErrors??0}:null},
    nodes:[{name:'local',online:(await health()).online,inflight:scheduler.localState?.inflight??0,maxParallel:cfg.maxParallel,ewmaMs:scheduler.localState?.ewmaMs??null},...(lan?.nodes()||[])].map(n=>{const p=perfRows.find(r=>r.name===n.name||r.id===n.id)||{};
      return {...n,load:n.maxParallel?+((n.inflight||0)/n.maxParallel).toFixed(2):null,genTokensPerSec:p.genTokensPerSec??null,ttftMs:p.ttftMs??null,samples:p.samples??0,vramFreeBytes:p.vramFreeBytes??null};}),stats:stats.all()});}
  if(cfg.dashboard){dashboard=await startDashboard({getState:state,port:cfg.dashboardPort,actions:{cancel,clearCache},policy});log('dashboard: '+dashboard.url);}
  return {cfg,policy,engine,det,router,lan,compute,auto,status,state,cancel,clearCache,setStateExtra(fn){stateExtra=fn;},get dashboard(){return dashboard;},
    async close(){lan?.stop();await det?.close?.();await stats.flush();await dashboard?.close();}};
}

// v0.4 BENCH-06: "measured" savings exist only as the output of `node bench/paired.mjs analyze --json` over real,
// measured usage records. Anything else (no file, mock/estimated records, unreadable file) → available:false.
export async function loadMeasured(file){
  if(!file)return {available:false,reason:'no paired benchmark results (set KVALAH_BENCH_RESULTS to the JSON written by bench/paired.mjs analyze --json)'};
  let a;try{a=JSON.parse(await (await import('node:fs/promises')).readFile(file,'utf8'));}catch(e){return {available:false,reason:'benchmark results unreadable: '+(e.code||'invalid JSON')};}
  if(!a||a.measured!==true)return {available:false,reason:'benchmark results are not measured (mock or estimated usage)'};
  const g=a.gates||{};
  return {available:true,verdict:a.verdict??'n/a',savingsPct:g.savings?.savingsPct??null,basis:g.savings?.basis??null,qualityPct:g.quality?.qualityPct??null,
    delegationPct:g.delegation?.successPct??null,pairs:a.completeness?.pairs??null,scenarios:a.completeness?.completeScenarios??null,records:a.records??null,
    source:String(file).split(/[\\/]/).pop()};
}
