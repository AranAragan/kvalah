// Cost analytics (v0.3, MET-01).
// * Two kinds of numbers, never mixed: `estimated` (from token heuristics, per task) and `measured`
//   (from real paired usage of a baseline run and a hybrid run, imported via pairedSavings()).
// * Prices are USD per 1M tokens and come ONLY from configuration (KVALAH_PRICE_INPUT/_OUTPUT/_CACHED_INPUT/
//   _REASONING). Without them every USD field is null ("unknown"); token figures are still reported.
// * Baseline = a normal agent that greps and reads selectively, not one that reads every byte:
//   selective ≈ min(full, 1500 + 20% of the file) tokens (heuristic, configurable via baselineFraction);
//   the full read is reported only as an upper bound (baselineTokens.fullRead).
// * Negative savings are kept. Subscription plans: only consumption metrics change, never the fixed fee.
export function pricingFromEnv(env=process.env){
  const n=v=>{if(v===undefined||v==='')return null;const x=Number(v);return Number.isFinite(x)&&x>=0?x:null;};
  const inputPerM=n(env.KVALAH_PRICE_INPUT),outputPerM=n(env.KVALAH_PRICE_OUTPUT);
  return {inputPerM,outputPerM,cachedInputPerM:n(env.KVALAH_PRICE_CACHED_INPUT),reasoningPerM:n(env.KVALAH_PRICE_REASONING),
    localPerM:n(env.KVALAH_PRICE_LOCAL)??0,kwhPrice:n(env.KVALAH_PRICE_KWH),currency:'USD',configured:inputPerM!==null&&outputPerM!==null,
    baseline:env.KVALAH_BASELINE==='full'?'full':'selective'};
}
const r6=x=>x===null?null:Math.round(x*1e6)/1e6;
const usd=(tokens,perM)=>perM===null||perM===undefined?null:tokens*perM/1e6;
export function selectiveBaseline(fileTokens,{fraction=0.2,floor=1500}={}){return Math.min(fileTokens,Math.ceil(floor+fraction*fileTokens));}
// fileTokens: tokens of file content the cloud agent did not have to read (already-credited files excluded by the caller)
export function estimateTaskCost({fileTokens=0,argsTokens=0,resultTokens=0,localTokens=0,verifyTokens=0,baseline},p){
  const kind=baseline||p.baseline||'selective';
  const full=fileTokens,selective=selectiveBaseline(fileTokens);
  const base=kind==='full'?full:selective;
  const withInput=resultTokens+verifyTokens,withOutput=argsTokens;
  const net=base-withInput-withOutput;
  let usdBlock=null;
  if(p.configured){
    const baselineCloudUsd=usd(base,p.inputPerM),offloadCloudUsd=usd(withOutput,p.outputPerM)+usd(withInput,p.inputPerM),localUsd=usd(localTokens,p.localPerM||0);
    usdBlock={baselineCloudUsd:r6(baselineCloudUsd),offloadCloudUsd:r6(offloadCloudUsd),localUsd:r6(localUsd),savedUsd:r6(baselineCloudUsd-offloadCloudUsd-localUsd)};
  }
  return {estimated:true,baselineKind:kind,baselineTokens:{selective,fullRead:full},
    cloudTokens:{without:base,withInput,withOutput,verify:verifyTokens},netCloudTokensSaved:net,localTokens,
    usd:usdBlock,
    // compatible flat fields (null when prices are not configured)
    baselineCloudUsd:usdBlock?.baselineCloudUsd??null,offloadCloudUsd:usdBlock?.offloadCloudUsd??null,localUsd:usdBlock?.localUsd??null,savedUsd:usdBlock?.savedUsd??null};
}
// Predict before running (router): resultTokens ≈ min(maxTokens, 8% of input) + envelope; verification ≈ 5% of the result.
export function predictSavings({fileTokens,inlineTokens=0,instructionTokens=60,maxTokens=2048,compression=0.08,verifyFraction=0.05},p){
  const result=Math.min(maxTokens,Math.max(150,Math.ceil((fileTokens+inlineTokens)*compression)))+120;
  return estimateTaskCost({fileTokens,argsTokens:instructionTokens+inlineTokens+20,resultTokens:result,verifyTokens:Math.ceil(result*verifyFraction)},p);
}
// Measured paired runs. usage = {input, cachedInput?, output, reasoning?} as reported by the cloud provider.
// net = cost(baseline) − cost(hybrid) − local cost (kWh × price, if measured). Missing usage → unknown (null), never estimated.
export function pairedSavings(pairs,p,{kwhPrice=p.kwhPrice??null,meta={}}={}){
  const cost=u=>{if(!u||!Number.isFinite(u.input)||!Number.isFinite(u.output))return null;if(!p.configured)return null;
    const cached=u.cachedInput||0,reasoning=u.reasoning||0,write=u.cacheWrite||0;   // BENCH-03: input = UNCACHED input (see compute/usage.mjs)
    return usd(u.input,p.inputPerM)+usd(cached,p.cachedInputPerM??p.inputPerM)+usd(write,p.cacheWritePerM??p.inputPerM)+usd(u.output,p.outputPerM)+usd(reasoning,p.reasoningPerM??p.outputPerM);};
  const rows=pairs.map(x=>{const b=cost(x.baseline),h=cost(x.hybrid);const local=Number.isFinite(x.localKWh)&&kwhPrice!==null?x.localKWh*kwhPrice:0;
    const net=b===null||h===null?null:b-h-local;
    return {id:x.id,baselineUsd:r6(b),hybridUsd:r6(h),localUsd:r6(local),netUsd:net===null?null:Math.round(net*1e9)/1e9,
      tokens:{baseline:x.baseline||null,hybrid:x.hybrid||null},quality:x.quality??null};});
  const known=rows.filter(r=>r.netUsd!==null);
  const tb=known.reduce((n,r)=>n+r.baselineUsd,0),th=known.reduce((n,r)=>n+r.hybridUsd+r.localUsd,0);
  return {measured:true,rows,unknown:rows.length-known.length,
    totals:{baselineUsd:r6(tb),hybridUsd:r6(th),netUsd:r6(tb-th),savingsPct:tb>0?Math.round((tb-th)/tb*1000)/10:null,n:known.length},
    meta:{model:null,tariff:null,date:null,usageSource:null,skillVersion:null,cacheMode:null,...meta}};
}
export function createLedger(){
  const t={kind:'estimated',tasks:0,netCloudTokensSaved:0,callTokens:0,verificationTokens:0,baselineCloudUsd:0,offloadCloudUsd:0,localUsd:0,savedUsd:0,usdKnown:true};
  return {add(c){t.tasks++;t.netCloudTokensSaved+=c.netCloudTokensSaved||0;
      const v=c.cloudTokens?.verify||0;t.verificationTokens+=v;t.callTokens+=(c.cloudTokens?.withInput||0)+(c.cloudTokens?.withOutput||0)-v;
      if(c.usd){for(const k of ['baselineCloudUsd','offloadCloudUsd','localUsd','savedUsd'])t[k]+=c.usd[k]||0;}else t.usdKnown=false;},
    totals(){const o={...t};for(const k of ['baselineCloudUsd','offloadCloudUsd','localUsd','savedUsd'])o[k]=t.usdKnown?r6(t[k]):null;delete o.usdKnown;return o;}};
}

// v0.4 BENCH-05: the full cost of using Offload in a session, not only per call. Added on top of the per-call
// estimate (args + result + verification, already in netCloudTokensSaved):
//   skillTokens       the Skill text (SKILL.md) loaded into the agent's context once per session
//   toolSchemaTokens  the MCP tool descriptions/schemas; sent with EVERY agent turn while the server is enabled.
//                     Lower bound used here: once at full input price + once per delegated task at the cached-input
//                     price (cloud prompt caching; full input price when no cached price is configured).
// All of it is estimated (heuristic token counts); measured numbers come only from bench/ paired runs.
export function applyOverhead(t,o={},p={configured:false}){
  if(!t)return t;
  const skill=Math.max(0,o.skillTokens||0),tools=Math.max(0,o.toolSchemaTokens||0),tasks=t.tasks||0;
  const sessionTokens=skill+tools*(1+tasks);
  let overheadUsd=null;
  if(p.configured){const first=usd(skill+tools,p.inputPerM),resend=usd(tools*tasks,p.cachedInputPerM??p.inputPerM);overheadUsd=r6(first+resend);}
  return {...t,overhead:{skillTokens:skill,toolSchemaTokens:tools,callTokens:t.callTokens??null,verificationTokens:t.verificationTokens??null,sessionTokens,overheadUsd,
      source:o.source||'not reported by the MCP server',assumption:'tool descriptions counted once + once per delegated task (lower bound; agents resend them every turn, usually at the cached-input price)'},
    netCloudTokensSavedAfterOverhead:(t.netCloudTokensSaved||0)-sessionTokens,
    savedUsdAfterOverhead:t.savedUsd===null||t.savedUsd===undefined||overheadUsd===null?null:r6(t.savedUsd-overheadUsd)};
}
