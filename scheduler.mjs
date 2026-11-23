// Parallel scheduler for independent sub-tasks across nodes (registry) plus the local backend.
// - picks the least-loaded node that has the model (inflight/capacity × latency)
// - retries a failed job on another node, then falls back to the local backend
// - map() returns results in input order, whatever node finished first (deterministic output)
export class NoNodeError extends Error{constructor(m){super(m);this.name='NoNodeError';}}

export function createScheduler({registry,local,maxAttempts=4,now=Date.now,onEvent=()=>{}}){
  // local: {provider, model, maxParallel, enabled}
  const localState={id:'local',inflight:0,ewmaMs:null};
  const waiters=new Set();
  const wake=()=>{for(const w of [...waiters]){waiters.delete(w);w();}};
  const remoteCandidates=(model,exclude)=>registry?registry.list().filter(n=>!exclude.has(n.id)&&registry.available(n,model)):[];
  const score=(inflight,capacity,ms)=>(inflight+1)/capacity*(ms||1000);
  function pick(model,exclude){
    const options=[];
    for(const n of remoteCandidates(model,exclude))options.push({id:n.id,node:n,inflight:n.status.inflight,capacity:n.maxParallel,ms:n.status.ewmaMs??n.status.latencyMs});
    // fallbackOnly: the local backend is used only when no remote device can take the job.
    if(local&&local.enabled!==false&&!exclude.has('local')&&!(local.fallbackOnly&&options.length))options.push({id:'local',node:null,inflight:localState.inflight,capacity:Math.max(1,local.maxParallel||1),ms:localState.ewmaMs});
    if(!options.length)return {none:true};
    const free=options.filter(o=>o.inflight<o.capacity);
    if(!free.length)return {wait:true};
    // Stable tie-break: remote nodes in registry order first, local last.
    free.sort((a,b)=>score(a.inflight,a.capacity,a.ms)-score(b.inflight,b.capacity,b.ms));
    return {choice:free[0]};
  }
  async function acquire(model,exclude,signal){
    while(true){
      if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:Error('aborted');
      const r=pick(model,exclude);
      if(r.choice){
        if(r.choice.id==='local')localState.inflight++;else registry.begin(r.choice.id);
        return r.choice;
      }
      if(r.none)throw new NoNodeError('No device can run this task');
      await new Promise(resolve=>{const done=()=>{signal?.removeEventListener('abort',done);waiters.delete(done);resolve();};waiters.add(done);signal?.addEventListener('abort',done,{once:true});});
    }
  }
  function release(choice,ok,ms){
    if(choice.id==='local'){localState.inflight=Math.max(0,localState.inflight-1);if(ok&&Number.isFinite(ms))localState.ewmaMs=localState.ewmaMs==null?ms:Math.round(localState.ewmaMs*0.7+ms*0.3);}
    else registry.end(choice.id,{ok,ms});
    wake();
  }
  // job(provider, model, nodeInfo) → value. Throw err.fatal=true for errors that must not be retried.
  async function run(job,{model,signal,label}={}){
    const exclude=new Set(),errors=[];
    for(let attempt=1;attempt<=maxAttempts;attempt++){
      let choice;
      try{choice=await acquire(model,exclude,signal);}
      catch(e){if(e instanceof NoNodeError&&errors.length){const err=Error(errors.map(x=>x.node+': '+x.error).join('; '));err.attempts=errors;throw err;}throw e;}
      const provider=choice.id==='local'?local.provider:registry.providerForNode(choice.node);
      const nodeModel=choice.id==='local'?local.model:registry.modelFor(choice.node,model);
      const name=choice.id==='local'?'local':choice.node.name;
      const started=now();
      onEvent({type:'start',label,node:name,attempt});
      try{
        const value=await job(provider,nodeModel,{id:choice.id,name});
        release(choice,true,now()-started);
        onEvent({type:'done',label,node:name,attempt});
        return {value,node:name,nodeId:choice.id,attempts:attempt,errors};
      }catch(e){
        release(choice,false);
        if(signal?.aborted||e.fatal)throw e;
        errors.push({node:name,error:String(e.message||e).slice(0,200)});
        onEvent({type:'retry',label,node:name,attempt,error:e.message});
        exclude.add(choice.id);
      }
    }
    const err=Error(errors.map(x=>x.node+': '+x.error).join('; ')||'failed');err.attempts=errors;throw err;
  }
  // Runs fn(item, index, provider, model, node) for every item; results keep the input order.
  async function map(items,fn,{model,signal,concurrency=Infinity,onProgress=()=>{}}={}){
    const results=new Array(items.length);let next=0,done=0;
    const capacity=()=>{let c=0;for(const n of registry?registry.list():[])if(registry.available(n,model))c+=n.maxParallel;if(local&&local.enabled!==false&&!(local.fallbackOnly&&c))c+=Math.max(1,local.maxParallel||1);return Math.max(1,c);};
    const workers=Math.max(1,Math.min(items.length,concurrency,capacity()));
    async function worker(){
      while(next<items.length){
        const index=next++;
        try{const r=await run((provider,m,node)=>fn(items[index],index,provider,m,node),{model,signal,label:index});results[index]={ok:true,value:r.value,node:r.node,attempts:r.attempts};}
        catch(e){if(signal?.aborted)throw e;results[index]={ok:false,error:String(e.message||e).slice(0,500),attempts:e.attempts?.length||1};}
        onProgress(++done,items.length);
      }
    }
    await Promise.all(Array.from({length:workers},worker));
    return results;
  }
  return {run,map,pick:(model)=>pick(model,new Set()),localState};
}
