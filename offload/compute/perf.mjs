// v0.4 SCHED-01: per-device performance model for the scheduler.
// Measured per device from real model calls: generation speed (output tokens/s after the first token), first-token
// latency (TTFT, includes prompt processing), prompt speed (prompt tokens / TTFT). The scheduler's latency input
// (`ewmaMs`) is replaced by the expected time of a reference job (KVALAH_SCHED_REF_PROMPT/OUTPUT tokens) on that
// device, so devices are compared by speed rather than by the size of the last job they happened to run.
// Load (inflight/capacity) stays the scheduler's own factor. Context comes from the node (peer info / detection).
// Free VRAM is used only when a device reports it (kvalah peer info `vramFree`/`vramTotal`); Ollama's API has no
// free-VRAM endpoint, so for a plain Ollama backend it is reported as unknown — never guessed.
// Devices without measurements keep the original value (v0.3 behaviour), so nothing changes before the first job.
const ew=(old,v,a=0.3)=>old==null?v:old*(1-a)+v*a;
const fin=x=>Number.isFinite(x)&&x>0;
export function createPerfModel({refPromptTokens=1000,refOutputTokens=200}={}){
  const devs=new Map();
  const get=id=>{let d=devs.get(id);if(!d){d={samples:0,msPerOut:null,msPerPrompt:null,ttftMs:null,lastAt:0};devs.set(id,d);}return d;};
  return {
    observe(id,{ms,ttftMs,promptTokens,outputTokens,at=Date.now()}){
      if(!fin(ms))return;const d=get(id);d.samples++;d.lastAt=at;
      const ttft=fin(ttftMs)&&ttftMs<=ms?ttftMs:null;
      if(ttft!=null){d.ttftMs=ew(d.ttftMs,ttft);if(fin(promptTokens))d.msPerPrompt=ew(d.msPerPrompt,ttft/promptTokens);}
      if(fin(outputTokens)){const gen=ttft!=null&&outputTokens>1?(ms-ttft)/(outputTokens-1):ms/outputTokens;if(gen>=0)d.msPerOut=ew(d.msPerOut,Math.max(gen,0.01));}
    },
    // expected ms for the reference job; null when the device has not been measured yet
    refMs(id){const d=devs.get(id);if(!d||d.msPerOut==null)return null;
      const pre=d.msPerPrompt!=null?d.msPerPrompt*refPromptTokens:(d.ttftMs??0);
      return Math.max(1,Math.round(pre+d.msPerOut*refOutputTokens));},
    view(id){const d=devs.get(id);if(!d)return {samples:0,genTokensPerSec:null,promptTokensPerSec:null,ttftMs:null,refJobMs:null};
      return {samples:d.samples,genTokensPerSec:d.msPerOut?+(1000/d.msPerOut).toFixed(1):null,promptTokensPerSec:d.msPerPrompt?+(1000/d.msPerPrompt).toFixed(1):null,
        ttftMs:d.ttftMs==null?null:Math.round(d.ttftMs),refJobMs:this.refMs(id)};},
    ids:()=>[...devs.keys()],
    ref:{promptTokens:refPromptTokens,outputTokens:refOutputTokens},
  };
}
// Wraps kvalah's createScheduler (unchanged, vendored or overlay) so its latency input comes from the perf model.
export function perfScheduler(createScheduler,{registry,perf,...opts}){
  const view=registry?{
    __proto__:registry,
    list:()=>registry.list().map(n=>({__proto__:n,status:new Proxy(n.status,{get:(t,k)=>k==='ewmaMs'?(perf.refMs(n.id)??t.ewmaMs):t[k]})})),
    available:(n,m)=>registry.available(n,m),begin:(id)=>registry.begin(id),end:(id,r)=>registry.end(id,r),
    providerForNode:(n)=>registry.providerForNode(registry.get?.(n.id)||n),modelFor:(n,m)=>registry.modelFor(registry.get?.(n.id)||n,m),
  }:null;
  const s=createScheduler({...opts,registry:view});
  if(s.localState){let raw=s.localState.ewmaMs;Object.defineProperty(s.localState,'ewmaMs',{get:()=>perf.refMs('local')??raw,set:v=>{raw=v;},enumerable:true});}
  return s;
}
