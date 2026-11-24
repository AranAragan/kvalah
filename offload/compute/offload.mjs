// Kvalah Compute Offload engine: Level 2 (local LLM) execution with the Smart Context Engine,
// secret redaction, output checks, cost accounting, persistent cache and request de-duplication.
import {createHash,randomUUID} from 'node:crypto';
import {createContextEngine,ContextOverflowError,TEMPLATE_OVERHEAD} from './context-engine.mjs';
import {createTokenCounter,heuristicTokens} from './tokens.mjs';
import {parseStructured,verifyFindings,injectionWarnings} from './checks.mjs';
import {createPolicy} from './policy.mjs';
import {estimateTaskCost,createLedger,pricingFromEnv,applyOverhead} from './cost.mjs';
import {createCache} from './cache.mjs';
import {createStats} from './stats.mjs';

export const KINDS=['summarize','logs','documentation','tests','review','transform'];
export const STRATEGIES=['auto','direct','map-reduce','retrieve'];
const kinds=new Set(KINDS);
const PROMPT_VERSION=4;const SCHEMA_VERSION=2;
const ALLOWED=new Set(['kind','instruction','context','paths','tailBytes','query','strategy']);
const named=(name,message)=>Object.assign(Error(message),{name});

export function createOffload({provider,model,scheduler,perf=null,devicePerf=null,measured=null,readFiles=null,counter=createTokenCounter(),cache=createCache(),stats=createStats(),
  pricing=pricingFromEnv({}),ctxTokens=16384,maxTokens=2048,timeoutMs=90000,queueTimeoutMs=120000,maxPending=8,maxChunks=24,
  temperature=0.2,think=false,structured=true,requestDeadlineMs=900000,maxPendingCalls=64,modelDigest=null,cacheSensitive=false,cacheScope=()=>null,secretPolicy='redact',policy=createPolicy({mode:secretPolicy}),now=Date.now,taskLogSize=100}){
  const metrics={requests:0,rejected:0,completed:0,failed:0,cacheHits:0,dedupedInflight:0,cancelled:0,queueTimeouts:0,execTimeouts:0,
    llmCalls:0,localInputTokens:0,localOutputTokens:0,unknownUsage:0,localBusyMs:0,fileBytesRead:0,secretsRedacted:0,injectionWarnings:0,
    findingsTotal:0,findingsVerified:0,contextOverflows:0,replans:0,queueMs:0,execMs:0};
  // MET-01: outcomes counted separately; files already credited in this session get no second baseline credit
  const running=new Map(); // task id → AbortController (UI-01)
  const outcomes={accepted:0,declined:0,failed:0,cancelled:0,warm:0,cold:0};const credited=new Set();
  const ledger=createLedger();let overhead={skillTokens:0,toolSchemaTokens:0,source:'not reported by the MCP server'};const shared=new Map();const taskLog=[];let pending=0,pendingCalls=0;
  const listeners=new Set();
  // task log entries are sanitized in place (SEC-01): paths/errors may contain secrets
  const log=(entry)=>{Object.assign(entry,policy.output({paths:entry.paths,error:entry.error}));taskLog.push(entry);while(taskLog.length>taskLogSize)taskLog.shift();for(const l of listeners)try{l(entry);}catch{}};
  const optionsKey={ctxTokens,maxTokens,temperature,think,structured,provider:provider?.kind,base:provider?.base};

  // ---- one LLM call: strict queue timeout, separate execution timeout ----
  // v0.3 (CTX-01): pre-flight every call against the window (exact count when the backend has a tokenizer)
  async function preflight({system,user,mt,format}){
    const schema=format?JSON.stringify(format):'';
    let n,exact=false;
    if(counter.exactAvailable){const v=await counter.countExact(system+'\n'+user+(schema?'\n'+schema:''));if(counter.exactAvailable){n=v;exact=true;}}
    if(!exact)n=counter.count(system)+counter.count(user)+(schema?counter.count(schema):0);
    const total=n+TEMPLATE_OVERHEAD+mt;
    if(total>ctxTokens){
      if(exact)counter.bump(system+user+schema,n);
      metrics.contextOverflows++;
      throw new ContextOverflowError(`Prompt would need ${total} tokens (${exact?'exact':'estimated'}) > context ${ctxTokens}`,{needed:total,ctxTokens,exact});
    }
    return {tokens:total,exact};
  }
  async function llm({system,user,maxTokens:mt=maxTokens,format,signal,label}){
    await preflight({system,user,mt,format});
    signal?.throwIfAborted();
    // RUN-01: one global limit on queued/running model calls across all requests (map chunks included)
    if(pendingCalls>=maxPendingCalls)throw Object.assign(Error(`Local compute overloaded (${pendingCalls} model calls pending); do this step yourself`),{name:'OverloadError',fatal:true});
    pendingCalls++;
    const queueAc=new AbortController();let qt=null;
    // the queue timer is (re)armed whenever the job waits for a slot: initially and before every retry
    const armQueue=()=>{clearTimeout(qt);qt=setTimeout(()=>queueAc.abort(named('QueueTimeoutError',`Queue timeout: local model busy for ${queueTimeoutMs}ms`)),queueTimeoutMs);};
    armQueue();const queuedAt=now();
    const schedSignal=signal?AbortSignal.any([signal,queueAc.signal]):queueAc.signal;
    let execTimeout=null;
    try{
      const r=await scheduler.run(async (p,m,node)=>{
        clearTimeout(qt);metrics.queueMs+=now()-queuedAt;
        try{
        const exec=AbortSignal.timeout(timeoutMs);
        const execSignal=signal?AbortSignal.any([signal,exec]):exec;
        const started=now();let text='',done,ttft=null;metrics.llmCalls++;
        try{
          for await(const e of p.chat({model:m,messages:[{role:'system',content:system},{role:'user',content:user}],tools:[],think,format,
            options:{context:ctxTokens,maxTokens:mt,temperature},signal:execSignal})){
            if(e.type==='content'){if(ttft==null)ttft=now()-started;text+=e.text;if(text.length>mt*12)throw Object.assign(Error('Output limit exceeded'),{fatal:true});}
            if(e.type==='tool_calls')throw Object.assign(Error('Unexpected tool call'),{fatal:true});
            if(e.type==='done')done=e;
          }
        }catch(e){if(exec.aborted&&!signal?.aborted)throw execTimeout=named('ExecTimeoutError',`Execution timeout after ${timeoutMs}ms on ${node.name||node.id}`);throw e;}
        finally{metrics.localBusyMs+=now()-started;metrics.execMs+=now()-started;}
        text=text.replace(/<think>[\s\S]*?<\/think>/g,'').trim();
        if(!done||done.reason==='length'||!text)throw Object.assign(Error(done?.reason==='length'?'Model hit maxTokens (raise KVALAH_MAX_TOKENS or narrow the task)':'Incomplete model response'),{fatal:true});
        const s=done.stats||{};
        perf?.observe(node.id,{ms:now()-started,ttftMs:ttft,promptTokens:s.promptTokens,outputTokens:s.tokens});   // SCHED-01
        if(Number.isFinite(s.promptTokens)&&Number.isFinite(s.tokens)){metrics.localInputTokens+=s.promptTokens;metrics.localOutputTokens+=s.tokens;counter.observe(system+user,s.promptTokens);}else metrics.unknownUsage++;
        return {text,model:m,node:node.name||node.id,promptTokens:s.promptTokens??null,outputTokens:s.tokens??null};
        }catch(e){if(!e?.fatal&&!signal?.aborted)armQueue();throw e;} // scheduler may retry: wait is bounded again
      },{model,signal:schedSignal,label});
      return r.value;
    }catch(e){
      if(queueAc.signal.aborted&&!signal?.aborted){metrics.queueTimeouts++;throw queueAc.signal.reason;}
      if(execTimeout){metrics.execTimeouts++;throw execTimeout;}
      throw e;
    }finally{clearTimeout(qt);pendingCalls--;}
  }
  const contextEngine=(sink)=>createContextEngine({count:t=>counter.count(t),llm:async(a)=>{const r=await llm(a);sink?.push(r);return r;},ctxTokens,maxTokens,maxChunks});

  function validate(args){
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Invalid task');
    for(const k of Object.keys(args))if(!ALLOWED.has(k))throw Error('Unknown field: '+k);
    const {kind,instruction,context='',paths,tailBytes,query,strategy='auto'}=args;
    if(!kinds.has(kind))throw Error('Invalid kind; expected one of '+KINDS.join(', '));
    if(typeof instruction!=='string'||!instruction.trim()||instruction.length>4000)throw Error('instruction must be 1–4000 characters');
    if(typeof context!=='string'||context.length>24000)throw Error('context must be ≤24000 characters');
    if(query!==undefined&&(typeof query!=='string'||query.length>500))throw Error('query must be ≤500 characters');
    if(!STRATEGIES.includes(strategy))throw Error('strategy must be one of '+STRATEGIES.join(', '));
    if(paths!==undefined&&!readFiles)throw Error('File input is disabled (set KVALAH_WORKSPACE to enable read-only paths)');
    if(tailBytes!==undefined&&!(Number.isInteger(tailBytes)&&tailBytes>0))throw Error('tailBytes must be a positive integer');
    if(!context.trim()&&!paths?.length)throw Error('Provide context or paths');
    return {kind,instruction,context,paths,tailBytes,query,strategy};
  }
  function applySecretPolicy(inputs){
    let count=0;const types=new Set();
    const out=inputs.map(i=>{
      const r=policy.input(i.text,i.path?'file '+policy.text(i.path):'context');if(!r.count)return i;
      count+=r.count;r.types.forEach(t=>types.add(t));return {...i,text:r.text};
    });
    metrics.secretsRedacted+=count;
    return {inputs:out,redacted:{count,types:[...types]}};
  }
  // ---- de-duplicated shared computation with per-subscriber cancellation ----
  function join(key,factory,signal){
    let e=shared.get(key),deduped=false;
    if(e?.ac.signal.aborted)e=null; // never join a job that is already being cancelled
    if(e)deduped=true,metrics.dedupedInflight++;
    else{
      if(pending>=maxPending)throw Error('Queue full; use primary agent');
      const ac=new AbortController();pending++;
      e={ac,subs:0,promise:null};
      e.promise=factory(ac.signal).finally(()=>{pending--;if(shared.get(key)===e)shared.delete(key);});
      e.promise.catch(()=>{});shared.set(key,e);
    }
    e.subs++;
    return new Promise((resolve,reject)=>{
      let settled=false;
      const leave=()=>{if(settled)return;settled=true;e.subs--;metrics.cancelled++;if(e.subs<=0)e.ac.abort(signal.reason??Error('Cancelled'));reject(signal.reason??Error('Cancelled'));};
      if(signal){if(signal.aborted)return leave();signal.addEventListener('abort',leave,{once:true});}
      e.promise.then(v=>{if(settled)return;settled=true;e.subs--;signal?.removeEventListener('abort',leave);resolve({value:v,deduped});},
        err=>{if(settled)return;settled=true;e.subs--;signal?.removeEventListener('abort',leave);reject(err);});
    });
  }

  async function delegate(args={},{signal:callerSignal,tool='kvalah_delegate'}={}){
    let t;try{t=validate(args);}catch(e){metrics.rejected++;throw policy.error(e);}
    // RUN-01: one deadline for the whole request (reads, queue, all map/reduce calls)
    const dl=new AbortController();const dlTimer=setTimeout(()=>dl.abort(named('DeadlineError',`Request deadline of ${requestDeadlineMs}ms exceeded`)),requestDeadlineMs);dlTimer.unref?.();
    // UI-01: an operator cancel (dashboard) counts as a caller cancel
    const op=new AbortController();const userSignal=callerSignal?AbortSignal.any([callerSignal,op.signal]):op.signal;
    const signal=AbortSignal.any([userSignal,dl.signal]);
    try{return await delegateInner(t,args,signal,tool,userSignal,op);}finally{clearTimeout(dlTimer);}
  }
  async function delegateInner(t,args,signal,tool,callerSignal,op){
    metrics.requests++;
    const id=randomUUID().slice(0,8),started=now();
    const entry={id,at:started,tool,kind:t.kind,level:2,status:'running',paths:(t.paths||[]).slice(0,5),cancellable:true};log(entry);
    running.set(id,op);
    try{
      // instruction/query also go to the model and into cache keys/logs: same policy as data (SEC-01)
      for(const k of ['instruction','query']){if(t[k]){const r=policy.input(t[k],k);if(r.count){t={...t,[k]:r.text};}}}
      signal.throwIfAborted();
      const files=t.paths?.length?await readFiles.read(t.paths,{tailBytes:t.tailBytes,signal}):[];
      metrics.fileBytesRead+=files.reduce((n,f)=>n+f.bytes,0);
      const raw=[...(t.context.trim()?[{path:null,source:'inline',text:t.context}]:[]),...files];
      const {inputs,redacted}=applySecretPolicy(raw);
      // CACHE-01: key = prompt/schema version + workspace scope + security policy + model (and revision) + node
      // capability + sampling/context/strategy + instruction/query + hashes of the exact inputs
      const workspaceScope=readFiles?await readFiles.resolveRoot():null;
      const key=createHash('sha256').update(JSON.stringify([PROMPT_VERSION,SCHEMA_VERSION,workspaceScope,policy.fingerprint,model,modelDigest,cacheScope(),optionsKey,t.kind,t.instruction,t.query||'',t.strategy,inputs.map(i=>[i.path,createHash('sha256').update(i.text).digest('hex')])])).digest('hex');
      let result=await cache.get(key),cached=!!result,deduped=false;
      signal.throwIfAborted(); // cancelled during the lookup: no result, not even a cached one
      if(cached)metrics.cacheHits++;
      else{
        const r=await join(key,async (sig)=>{
          const myCalls=[];let out,replans=0;
          // an exact-count overflow raised the counter ratio: re-plan (smaller chunks / fewer items), at most 3 times
          for(;;){try{out=await contextEngine(myCalls).run(t,inputs,{structured,signal:sig});break;}
            catch(e){if(e?.name!=='ContextOverflowError'||e.exact!==true||replans>=3||sig?.aborted)throw e;replans++;metrics.replans++;}}
          out.coverage={...out.coverage,tokenCount:counter.kind,replans,
            ...(counter.kind==='estimated'?{warnings:[...(out.coverage.warnings||[]),'token-count-estimated: no exact tokenizer for this backend; budgets use a conservative estimate (+10–20% margin)']}:{})};
          return policy.output(postProcess(t,out,inputs,myCalls)); // sanitized before it can be cached or returned
        },signal);
        result=r.value;deduped=r.deduped;
        // tasks that contained secrets stay in memory only unless KVALAH_CACHE_SENSITIVE=1
        if(!deduped)await cache.set(key,result,{disk:cacheSensitive||!redacted.count,workspace:workspaceScope});
      }
      // cost for THIS request (a cache hit still saves the cloud from reading the files).
      // Cloud tokens use the uncalibrated estimate: the calibrated counter models the LOCAL tokenizer.
      // a file content (path+hash) is credited once per session: re-delegating it saves no new reading
      const fileTokens=files.reduce((n,f)=>{const id=f.path+'\0'+createHash('sha256').update(f.text).digest('hex');if(credited.has(id))return n;credited.add(id);return n+heuristicTokens(f.text);},0);
      const argsTokens=heuristicTokens(JSON.stringify(args));
      const response={...result,id,files:files.map(f=>({path:f.path,bytes:f.bytes,truncated:f.truncated})),secretsRedacted:redacted,cached:cached||deduped,requiresVerification:true};
      const resultTokens=heuristicTokens(JSON.stringify(response));
      const verifyTokens=Math.min(4000,(result.findings?.length||0)*60); // agent spot-checks quoted lines
      response.cost=estimateTaskCost({fileTokens,argsTokens,resultTokens,verifyTokens,localTokens:cached||deduped?0:(result.localTokens?.input||0)+(result.localTokens?.output||0)},pricing);
      ledger.add(response.cost);metrics.completed++;outcomes.accepted++;cached||deduped?outcomes.warm++:outcomes.cold++;
      stats.record(`${t.kind}@${model}`,{ok:true,ms:now()-started});
      stats.record(t.kind,{ok:true,ms:now()-started,verified:result.checks?.verifiedFindings||0,findings:(result.checks?.verifiedFindings||0)+(result.checks?.unverifiedFindings||0),saved:response.cost.savedUsd});
      Object.assign(entry,{status:cached||deduped?'cached':'done',ms:now()-started,strategy:result.coverage?.strategy,inputTokens:result.coverage?.inputTokens,savedUsd:response.cost.savedUsd,node:result.node,
        coverage:result.coverage?.sourceCoverage??null,costKind:'estimated'});
      return policy.output(response);
    }catch(e){
      // a failed task still cost the cloud its arguments and the error it read back: recorded as a loss
      if(callerSignal?.aborted)outcomes.cancelled++;else{outcomes.failed++;ledger.add(estimateTaskCost({fileTokens:0,argsTokens:heuristicTokens(JSON.stringify(args)),resultTokens:60},pricing));}
      metrics.failed++;if(!callerSignal?.aborted){stats.record(t.kind,{ok:false,ms:now()-started});stats.record(`${t.kind}@${model}`,{ok:false,ms:now()-started});}
      const safe=policy.error(e);
      Object.assign(entry,{status:callerSignal?.aborted?'cancelled':signal?.aborted?'deadline':'failed',ms:now()-started,error:safe.message.slice(0,200)});
      throw safe;
    }finally{running.delete(id);entry.cancellable=false;}
  }
  // v0.3 (SEC-04): the model's answer is untrusted data. Fields are type-checked and size-limited, warnings
  // from map stages are merged, and quote verification is reported separately from any (absent) assessment.
  const LIMITS={summary:8000,draft:16000,uncertainty:2000,output:16000};
  function postProcess(t,out,inputs,llmCalls){
    const sourcesText=inputs.map(i=>i.text).join('\n');
    const parsed=structured?parseStructured(out.text):null;
    const truncated={},invalidFields=[];
    const field=(v,k)=>{if(typeof v!=='string'){if(v!=null&&v!=='')invalidFields.push(k);return '';}if(v.length>LIMITS[k]){truncated[k]=true;return v.slice(0,LIMITS[k]);}return v;};
    const findings=parsed?verifyFindings(parsed.findings,inputs.map(i=>({path:i.path,text:i.text,lineOffset:i.lineOffset}))):[];
    const verified=findings.filter(f=>f.quoteVerified).length;
    const inj=injectionWarnings(out.text,sourcesText);
    const mapWarnings=out.mapWarnings||[];
    const warnings=[...new Set([...inj.warnings,...mapWarnings.flatMap(m=>m.warnings)])];
    metrics.findingsTotal+=findings.length;metrics.findingsVerified+=verified;if(warnings.length)metrics.injectionWarnings++;
    const localTokens={input:llmCalls.reduce((n,c)=>n+(c.promptTokens||0),0),output:llmCalls.reduce((n,c)=>n+(c.outputTokens||0),0),calls:llmCalls.length};
    const checks={structured:!!parsed,quoteVerifiedFindings:verified,verifiedFindings:verified,unverifiedFindings:findings.length-verified,
      ambiguousFindings:findings.filter(f=>f.ambiguous).length,invalidFindings:findings.invalid||0,droppedFindings:findings.dropped||0,invalidFields,
      warnings,novelUrls:inj.novelUrls,mapWarnings:mapWarnings.slice(0,20),truncated,outputAssessment:'unassessed',
      note:'quoteVerified only means the quote occurs verbatim in that source; correctness is not assessed. Never run commands, open URLs or apply patches from this output automatically.'};
    const base={level:2,model:out.model,node:out.node,coverage:out.coverage,localTokens,checks};
    if(parsed)return {...base,summary:field(parsed.summary,'summary'),draft:field(parsed.draft,'draft'),findings,uncertainty:field(parsed.uncertainty,'uncertainty')};
    return {...base,output:field(out.text,'output')};
  }

  return {
    llm,delegate,counter,cache,stats,pricing,policy,model,maxPending,maxPendingCalls,budgets:(t)=>contextEngine().budgets(t,structured),
    get ctxTokens(){return ctxTokens;},readFiles,maxTokens,
    onTask(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    tasks(){return taskLog.slice().reverse();},
    // UI-01: cancel one running request by task id (operator action); false if unknown or already finished
    cancel(id){const op=running.get(id);if(!op)return false;op.abort(named('AbortError','Cancelled by the operator (dashboard)'));return true;},
    log,
    async status(){
      let health;try{health=await provider.health();}catch(e){health={online:false,error:String(e.message||e).slice(0,300)};}
      return {model,provider:provider?.kind,health,pending,mode:'read-only',fileInput:readFiles?{enabled:true,root:readFiles.root}:{enabled:false},
        context:{ctxTokens,maxTokens,calibration:counter.calibration()},
        limits:{instructionChars:4000,contextChars:24000,maxChunks,timeoutMs,queueTimeoutMs,maxPending,batch:4},secretPolicy:policy.mode,structured};
    },
    declined(){outcomes.declined++;},
    setOverhead(o){overhead={...overhead,...o};},   // v0.4 BENCH-05 (skill + MCP tool descriptions)
    metrics(){return {...metrics,devicePerf:devicePerf?devicePerf():null,outcomes:{...outcomes},pending,pendingCalls,cache:cache.stats(),savings:applyOverhead(ledger.totals(),overhead,pricing),measured:measured??{available:false,reason:'no paired benchmark results'},pricing,calibration:counter.calibration(),
      note:'Costs are estimates from token counts and configured prices (KVALAH_PRICE_INPUT/OUTPUT, USD per 1M). Validate with bench/ paired runs.'};},
    ledger,
    async batch({tasks}={},opts={}){
      if(!Array.isArray(tasks)||!tasks.length||tasks.length>4)throw Error('Expected 1–4 tasks');
      return Promise.all(tasks.map(async t=>{try{return {ok:true,result:await delegate(t,opts)};}catch(e){return {ok:false,error:String(e?.message||e).slice(0,500)};}}));
    }
  };
}
