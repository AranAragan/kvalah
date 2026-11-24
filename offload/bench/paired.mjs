#!/usr/bin/env node
// QA-02: paired benchmark harness.
//   node bench/paired.mjs plan    [--reps 3] [--seed 1] [--out plan.json]     randomized run schedule for real agents
//   node bench/paired.mjs analyze --records runs.jsonl [--price-in 3 --price-out 15 --price-cached 0.3 --price-cache-write 3.75 --price-reasoning 15]
//                                 [--reps 3] [--min-scenarios 50] [--require-planned] [--out RESULTS-real.md] [--json analysis.json → KVALAH_BENCH_RESULTS]
//   node bench/paired.mjs mock    [--seed 2026] [--out bench/results]            pipeline check with the mock model (NOT measured)
// A run record (one JSON per line) is written by whoever drives the real agent (v0.4: + config, snapshot, attempt, extraUsage, rawUsage/usageFormat):
//   {scenario, arm:'baseline'|'hybrid', rep, cacheMode:'cold'|'warm', usage:{input,output,cachedInput?,reasoning?},
//    usageSource:'agent-usage'|'api'|'provider-dashboard'|'estimate'|'mock-estimate', durationMs, error?,
//    assertionsPassed:0..1, rubric?:0..1, critical?:bool, kvalahOutcome?:'accepted'|'declined'|'fallback'|'failed',
//    agent, agentVersion, model, kvalahVersion?, localModel?, hardware?}
// Only usageSource agent-usage/api/provider-dashboard counts as measured; anything else ⇒ gates not evaluated.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pairedSavings,selectiveBaseline} from '../compute/cost.mjs';
import {heuristicTokens} from '../compute/tokens.mjs';
import {normalizeUsage,addUsage,ZERO_USAGE} from '../compute/usage.mjs';
import {rng} from './fixtures.mjs';
import {makeCorpus,writeCorpus,scenarios as makeScenarios} from './scenarios.mjs';

export const MEASURED_SOURCES=['agent-usage','api','provider-dashboard'];
export const GATES={savingsPct:30,qualityPct:95,delegationPct:95,smallGrowthPct:5};
const median=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const p95=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.max(0,Math.ceil(0.95*s.length)-1)];};
const stat=a=>({median:median(a),p95:p95(a),n:a.length});
const mean=a=>a.length?a.reduce((n,x)=>n+x,0)/a.length:null;

export function plan(list,{reps=3,seed=1}={}){
  const r=rng(seed);const runs=[];
  for(let rep=0;rep<reps;rep++)for(const s of list){
    const order=r()<0.5?['baseline','hybrid']:['hybrid','baseline'];
    for(const arm of order)runs.push({scenario:s.id,category:s.category,arm,rep,cacheMode:arm==='hybrid'&&rep===0?'cold':'warm',prompt:s.prompt});
  }
  return {seed,reps,scenarios:list.length,runs,requirements:[
    'Use the same agent, model, settings, repository snapshot, prompt and quality criteria in both arms.',
    'Baseline: the agent with its normal tools only (Kvalah MCP server disabled). Hybrid: same agent with Kvalah enabled.',
    'cold = clear the Kvalah cache before the run (KVALAH_CACHE_DIR emptied); warm = keep it.',
    'Record usage from the agent/API usage report (usageSource), never from Kvalah estimates.',
    'Every record carries agent, agentVersion, model, config (hash of agent settings) and snapshot (repository commit); analyze() rejects mixed values (verdict INVALID).',
    'Log every attempt (attempt: 1, 2, …) including failed ones, and extraUsage for fallback/verification steps; usageFormat+rawUsage lets analyze() normalize provider usage.',
    'Check the final answer with scenario.assert.includes and the rubric; grade blind where possible.']};
}

export const MIN_SCENARIOS=50;
export const COND_FIELDS=['agent','agentVersion','model','config','snapshot'];
export function analyze(records,{scenarios=[],pricing={configured:false},gates=GATES,minScenarios=MIN_SCENARIOS,reps=null,requirePlanned=false}={}){
  // v0.4 BENCH-03: provider usage → one shape (uncached input, cache reads/writes, visible output, reasoning), so
  // cached input and reasoning tokens are neither dropped nor billed twice. Records may carry rawUsage+usageFormat.
  records=records.map(x=>{
    if(x.rawUsage)return {...x,usage:normalizeUsage(x.rawUsage,x.usageFormat||'normalized')};
    if(x.usage&&x.usageFormat&&x.usageFormat!=='normalized')return {...x,usage:normalizeUsage(x.usage,x.usageFormat)};
    return x;
  });
  const meta=new Map(scenarios.map(s=>[s.id,s]));
  const measured=records.length>0&&records.every(x=>MEASURED_SOURCES.includes(x.usageSource));
  const ids=[...new Set(records.map(x=>x.scenario))];
  // v0.4 BENCH-04: one RUN = all attempts of (scenario, arm, rep) — failed attempts, retries and the extra usage of
  // fallback / verification / retry steps (record.extraUsage:[{kind,input,output,...}]) are summed into its cost.
  const EXTRA=['failedAttempts','retry','fallback','verification'];
  const breakdown={baseline:Object.fromEntries(EXTRA.map(k=>[k,{...ZERO_USAGE}])),hybrid:Object.fromEntries(EXTRA.map(k=>[k,{...ZERO_USAGE}]))};
  const runCache=new Map();
  function runsOf(id,a){
    const key=id+'\u0000'+a;if(runCache.has(key))return runCache.get(key);
    const groups=new Map();for(const x of records)if(x.scenario===id&&x.arm===a){const r=x.rep??0;if(!groups.has(r))groups.set(r,[]);groups.get(r).push(x);}
    const runs=[...groups.entries()].sort((p,q)=>p[0]-q[0]).map(([rep,att])=>{
      att=[...att].sort((p,q)=>(p.attempt??0)-(q.attempt??0));const last=att[att.length-1];
      let u=null;const br=breakdown[a]||{};
      for(const x of att){
        if(x.usage){const xu=normalizeUsage(x.usage,'normalized');u=addUsage(u||ZERO_USAGE,xu);if(x.error&&br.failedAttempts)br.failedAttempts=addUsage(br.failedAttempts,xu);}
        for(const e of x.extraUsage||[]){const eu=normalizeUsage(e,'normalized');u=addUsage(u||ZERO_USAGE,eu);const k=e.kind==='failed-attempt'?'failedAttempts':e.kind;if(br[k])br[k]=addUsage(br[k],eu);}
      }
      return {rep,usage:u,error:last.error||null,attempts:att.length,cacheMode:last.cacheMode,durationMs:att.reduce((n,x)=>n+(Number.isFinite(x.durationMs)?x.durationMs:0),0)||null,
        assertionsPassed:last.assertionsPassed,rubric:last.rubric,critical:att.some(x=>x.critical),kvalahOutcome:last.kvalahOutcome,
        agent:last.agent,agentVersion:last.agentVersion,model:last.model,config:last.config,snapshot:last.snapshot};
    });
    runCache.set(key,runs);return runs;
  }
  const per=ids.map(id=>{
    const m=meta.get(id)||{id,category:'unknown',eligible:true};
    const arm=a=>{const rs=runsOf(id,a);
      const f=k=>rs.map(x=>x.usage?.[k]).filter(Number.isFinite);   // BENCH-04: failed runs cost money too — never dropped
      return {runs:rs.length,errors:rs.filter(x=>x.error).length,attempts:rs.reduce((n,x)=>n+x.attempts,0),input:stat(f('input')),output:stat(f('output')),cachedInput:stat(f('cachedInput')),cacheWrite:stat(f('cacheWrite')),reasoning:stat(f('reasoning')),
        durationMs:stat(rs.map(x=>x.durationMs).filter(Number.isFinite)),assertions:mean(rs.map(x=>x.error?0:(x.assertionsPassed??0))),rubric:mean(rs.map(x=>x.rubric).filter(Number.isFinite)),
        critical:rs.filter(x=>x.critical).length,outcomes:rs.reduce((o,x)=>{if(x.kvalahOutcome)o[x.kvalahOutcome]=(o[x.kvalahOutcome]||0)+1;return o;},{}),
        byCache:{cold:stat(rs.filter(x=>x.cacheMode==='cold').map(x=>x.usage?.input).filter(Number.isFinite)),warm:stat(rs.filter(x=>x.cacheMode==='warm').map(x=>x.usage?.input).filter(Number.isFinite))}};};
    return {id,category:m.category,eligible:m.eligible!==false,baseline:arm('baseline'),hybrid:arm('hybrid')};
  });
  const usage=a=>a.input.median===null?null:{input:a.input.median,output:a.output.median??0,cachedInput:a.cachedInput.median??0,cacheWrite:a.cacheWrite.median??0,reasoning:a.reasoning.median??0};
  const pairs=set=>set.map(s=>({id:s.id,baseline:usage(s.baseline),hybrid:usage(s.hybrid),quality:s.hybrid.assertions}));
  const target=pairedSavings(pairs(per.filter(s=>s.eligible)),pricing),all=pairedSavings(pairs(per),pricing);
  // token fallback when prices are not configured
  const tok=u=>u?u.input+u.output+u.cachedInput+(u.cacheWrite||0)+u.reasoning:null;
  const sumTok=(set,a)=>set.reduce((n,s)=>n+(tok(usage(s[a]))||0),0);
  const pct=(b,h)=>b>0?Math.round((b-h)/b*1000)/10:null;
  const targetSet=per.filter(s=>s.eligible),small=per.filter(s=>!s.eligible);
  const savingsPct=pricing.configured?target.totals.savingsPct:pct(sumTok(targetSet,'baseline'),sumTok(targetSet,'hybrid'));
  const ratios=per.map(s=>{const b=s.baseline.assertions,h=s.hybrid.assertions;if(h===null)return null;return b?Math.min(1.5,h/b):(h>=0?1:0);}).filter(x=>x!==null);
  const qualityPct=ratios.length?Math.round(mean(ratios)*1000)/10:null;const critical=per.reduce((n,s)=>n+s.hybrid.critical,0);
  const hyb=ids.flatMap(id=>runsOf(id,'hybrid').map(r=>({...r,scenario:id})));const eligHyb=hyb.filter(x=>(meta.get(x.scenario)?.eligible)!==false);
  const delegation={eligibleRuns:eligHyb.length,accepted:eligHyb.filter(x=>x.kvalahOutcome==='accepted'&&!x.error).length,declined:hyb.filter(x=>x.kvalahOutcome==='declined').length,
    fallback:hyb.filter(x=>x.kvalahOutcome==='fallback').length,failed:hyb.filter(x=>x.kvalahOutcome==='failed'||x.error).length};
  delegation.successPct=eligHyb.length?Math.round(delegation.accepted/eligHyb.length*1000)/10:null;
  const smallCost=a=>pricing.configured?pairedSavings(pairs(small),pricing).totals[a==='baseline'?'baselineUsd':'hybridUsd']:sumTok(small,a);
  const sb=small.length?smallCost('baseline'):null,sh=small.length?smallCost('hybrid'):null;
  const growthPct=sb?Math.round((sh-sb)/sb*1000)/10:null;
  let g={savings:{pass:savingsPct!==null&&savingsPct>=gates.savingsPct,savingsPct,threshold:gates.savingsPct,basis:pricing.configured?'usd':'tokens'},
    quality:{pass:qualityPct!==null&&qualityPct>=gates.qualityPct&&critical===0,qualityPct,critical,threshold:gates.qualityPct},
    delegation:{pass:delegation.successPct!==null&&delegation.successPct>=gates.delegationPct,successPct:delegation.successPct,threshold:gates.delegationPct},
    smallTasks:{pass:growthPct===null?null:growthPct<=gates.smallGrowthPct,growthPct,threshold:gates.smallGrowthPct}};
  // v0.4 BENCH-01: every (scenario, rep) needs BOTH arms; otherwise nothing passes (INCOMPLETE, never PASS)
  const missing=[];
  const planned=requirePlanned?[...new Set([...ids,...scenarios.map(x=>x.id)])]:ids;
  for(const id of planned){
    const repsSeen=new Set(records.filter(x=>x.scenario===id).map(x=>x.rep??0));
    const want=reps?Array.from({length:reps},(_,i)=>i):(repsSeen.size?[...repsSeen].sort((p,q)=>p-q):[0]);
    for(const rep of want)for(const arm of ['baseline','hybrid'])if(!records.some(x=>x.scenario===id&&x.arm===arm&&(x.rep??0)===rep))missing.push({scenario:id,rep,arm});
  }
  const completeIds=planned.filter(id=>!missing.some(m=>m.scenario===id));
  const completeness={missing,completeScenarios:completeIds.length,required:minScenarios,pairs:completeIds.reduce((n,id)=>n+runsOf(id,'hybrid').length,0),
    reason:missing.length?`${missing.length} run(s) missing: baseline and hybrid are required for every scenario and repetition`
      :completeIds.length<minScenarios?`${completeIds.length} complete paired scenarios; at least ${minScenarios} are required`:null};
  // v0.4 BENCH-02: both arms must run under the same conditions — one agent, agent version, cloud model, config and
  // repository snapshot for the whole comparison — with the same number of repetitions per scenario.
  const problems=[];
  for(const k of COND_FIELDS){
    const without=records.filter(x=>x[k]===undefined||x[k]===null||x[k]==='').length;
    if(without)problems.push(`${without} record(s) without ${k}`);
    const vals=[...new Set(records.map(x=>x[k]).filter(v=>v!==undefined&&v!==null&&v!==''))];
    if(vals.length>1)problems.push(`${k} differs between runs (${vals.slice(0,4).map(v=>String(v).slice(0,40)).join(' vs ')})`);
  }
  const repCount=new Map(ids.map(id=>[id,new Set(records.filter(x=>x.scenario===id).map(x=>x.rep??0)).size]));
  if(reps){for(const [id,c] of repCount)if(c<reps)problems.push(`repetitions: ${id} has ${c} of ${reps}`);}
  else if(new Set(repCount.values()).size>1)problems.push('repetitions differ between scenarios ('+[...new Set(repCount.values())].join(', ')+')');
  const conditions={valid:problems.length===0,fields:COND_FIELDS,problems};
  if(!measured)g=Object.fromEntries(Object.entries(g).map(([k,v])=>[k,{...v,pass:null,reason:'not evaluated: usage not measured'}]));
  else if(problems.length)g=Object.fromEntries(Object.entries(g).map(([k,v])=>[k,{...v,pass:null,reason:'INVALID: '+problems.join('; ')}]));
  else if(missing.length)g=Object.fromEntries(Object.entries(g).map(([k,v])=>[k,{...v,pass:null,reason:'INCOMPLETE: '+completeness.reason}]));
  const verdict=!measured?'NOT_MEASURED':problems.length?'INVALID':completeness.reason?'INCOMPLETE':Object.values(g).some(v=>v.pass===false)?'FAIL':'PASS';
  return {verdict,completeness,conditions,measured,note:measured?'Measured usage from agent/API reports.':'Usage is not measured (estimate or mock); savings and gates are not evaluated and must not be published as results.',
    scenarios:per,totals:{target:target.totals,all:all.totals,tokens:{targetBaseline:sumTok(targetSet,'baseline'),targetHybrid:sumTok(targetSet,'hybrid')}},delegation,gates:g,records:records.length,costBreakdown:breakdown};
}

// Mock paired run: the hybrid arm really runs Kvalah (deterministic ops, router, context engine) with a deterministic
// extractor model; cloud token usage of both arms is a heuristic ESTIMATE. Validates the harness, not the product.
export function mockModel(getPattern){
  return {kind:'mock',base:'mock://paired',health:async()=>({online:true}),
    async *chat(req){
      const sys=req.messages[0].content,user=req.messages[1].content,pattern=getPattern();
      const data=user.slice(user.indexOf('Data:'));const hits=[];
      for(const l of data.split('\n')){const m=/^NOTE: (.*)$/.exec(l);if(m)hits.push(m[1]);else if(pattern.test(l)&&!l.startsWith('<'))hits.push(l);}
      const isMap=/extract facts from one chunk/.test(sys);const paths=[...user.matchAll(/path="([^"]+)"/g)].map(m=>m[1]);
      const text=isMap?(hits.length?hits.map(h=>'NOTE: '+h).join('\n'):'NONE'):JSON.stringify({summary:`${hits.length} relevant lines`,draft:'',findings:hits.slice(0,40).map(h=>({text:'relevant',quote:h.trim(),path:paths[0]||''})),uncertainty:''});
      yield {type:'content',text};yield {type:'done',reason:'stop',stats:{promptTokens:heuristicTokens(sys+user),tokens:heuristicTokens(text)}};
    }};
}
export async function runMockPaired({seed=2026,reps=1,ctx=16384,priceIn=3,priceOut=15}={}){
  const {createKvalahOffload}=await import('../compute/index.mjs');
  const corpus=await writeCorpus(seed);const list=makeScenarios(corpus);let current=/(?!)/;
  const app=await createKvalahOffload({env:{KVALAH_MODEL:'mock',KVALAH_WORKSPACE:corpus.root,KVALAH_CACHE:'off',KVALAH_CONTEXT:String(ctx),KVALAH_MAX_CHUNKS:'64',
    KVALAH_PRICE_INPUT:String(priceIn),KVALAH_PRICE_OUTPUT:String(priceOut),KVALAH_TIMEOUT_MS:'600000',KVALAH_DATA_DIR:path.join(corpus.root,'.kvalah-data')},provider:mockModel(()=>current)});
  const pricing={inputPerM:priceIn,outputPerM:priceOut,configured:true};
  const rows=[],records=[];
  try{
    for(let rep=0;rep<reps;rep++)for(const s of list){
      current=s.mockPattern||/(?!)/;const started=Date.now();let result=null,error=null;
      try{const a=s.hybrid.args;result=s.hybrid.tool==='compute'?await app.compute(a):s.hybrid.tool==='delegate'?await app.engine.delegate(a):await app.auto(a);}catch(e){error=String(e.message||e);}
      const ms=Date.now()-started;const level=result?.route?.level??result?.level??null;const text=result?JSON.stringify(result):'';
      let base=0;const b=s.baseline;
      if(b.read)base=b.read.reduce((n,p)=>n+selectiveBaseline(heuristicTokens(corpus.files[p])),0);
      else if(b.grep){const g=await app.compute({op:'search',pattern:b.grep,maxResults:500}).catch(()=>({matches:[]}));base=heuristicTokens(g.matches.map(m=>`${m.path}:${m.line}:${m.text}`).join('\n'))+20;}
      const promptT=heuristicTokens(s.prompt),answerT=200,argsT=heuristicTokens(JSON.stringify(s.hybrid.args)),resT=heuristicTokens(text);
      const verifyT=Math.min(4000,(result?.findings?.length||0)*60);
      const baseline={input:promptT+base,output:answerT};
      const hybrid=level===3?{input:promptT+resT+base,output:argsT+answerT}:{input:promptT+resT+verifyT,output:argsT+answerT};
      const recall=level===3||error?null:s.assert.includes.filter(x=>text.includes(x)).length/s.assert.includes.length;
      rows.push({id:s.id,category:s.category,eligible:s.eligible,level,ok:!error,error,ms,recall,strategy:result?.coverage?.strategy||(level===1?'deterministic':level===3?'declined':null),baseline,hybrid});
      const outcome=error?'failed':level===3?'declined':'accepted';
      records.push({scenario:s.id,arm:'baseline',rep,cacheMode:'warm',usage:baseline,usageSource:'mock-estimate',assertionsPassed:1},
        {scenario:s.id,arm:'hybrid',rep,cacheMode:rep?'warm':'cold',usage:hybrid,usageSource:'mock-estimate',assertionsPassed:recall??1,durationMs:ms,kvalahOutcome:outcome,error:error||undefined});
    }
  }finally{await app.close();}
  const rec=rows.filter(r=>r.recall!==null);
  return {label:'MOCK',measured:false,meta:{seed,reps,ctx,pricing,node:process.version,date:new Date().toISOString(),model:'mock extractor (deterministic)'},
    scenarios:rows,errors:rows.filter(r=>!r.ok).length,meanRecall:rec.length?Math.round(mean(rec.map(r=>r.recall))*100)/100:null,
    analysis:analyze(records,{scenarios:list,pricing})};
}
export function toMarkdownPaired(rep){
  const a=rep.analysis;const t=a.totals.tokens;
  const rows=rep.scenarios.map(r=>`| ${r.id} | ${r.category} | ${r.eligible?'yes':'no'} | ${r.level??'-'} | ${r.strategy??'-'} | ${r.ok?'✔':'✖ '+r.error} | ${r.recall??'n/a'} | ${r.baseline.input}+${r.baseline.output} | ${r.hybrid.input}+${r.hybrid.output} | ${r.ms} |`).join('\n');
  return `# Kvalah paired benchmark — MOCK (not measured)\n\n${rep.label}: deterministic mock model; cloud token usage of BOTH arms is a heuristic estimate. This run checks the harness and the pipeline (routing, chunking, retrieval, quote verification). It is not measured usage and must not be quoted as savings.\n\nseed=${rep.meta.seed} reps=${rep.meta.reps} ctx=${rep.meta.ctx} node=${rep.meta.node} date=${rep.meta.date}\n\nScenarios: ${rep.scenarios.length}; errors: ${rep.errors}; mean pipeline recall (L1/L2 scenarios): ${rep.meanRecall}; router declined (L3): ${rep.scenarios.filter(r=>r.level===3).length}.\n\nEstimated cloud tokens on the target set (mock heuristic): baseline ${t.targetBaseline}, hybrid ${t.targetHybrid}. Gates: not evaluated (usage not measured).\n\n| scenario | category | target set | level | strategy | ok | recall | baseline in+out (est.) | hybrid in+out (est.) | ms |\n|---|---|---|---|---|---|---|---|---|---|\n${rows}\n`;
}
export function toMarkdownReal(a,meta={}){
  const g=a.gates;const f=v=>v===null||v===undefined?'n/a':v;
  const why=[a.completeness?.reason,...(a.conditions?.problems||[])].filter(Boolean);
  return `# Kvalah paired benchmark — real runs\n\nVerdict: **${a.verdict??'n/a'}**${why.length?' — '+why.join('; '):''}\n\nUsage: ${a.measured?'**measured** (agent/API usage reports)':'**not measured** (estimate/mock) — no savings may be quoted'}. Kvalah’s own per-task numbers are *estimated* and are not used here.\n\n${a.note}\n\nRecords: ${a.records}; scenarios: ${a.scenarios.length}; meta: ${JSON.stringify(meta)}\n\n| gate | value | threshold | pass |\n|---|---|---|---|\n| savings (target set, ${g.savings.basis}) | ${f(g.savings.savingsPct)}% | ≥${g.savings.threshold}% | ${f(g.savings.pass)} |\n| quality vs baseline | ${f(g.quality.qualityPct)}% (critical ${g.quality.critical}) | ≥${g.quality.threshold}% | ${f(g.quality.pass)} |\n| delegation success | ${f(g.delegation.successPct)}% | ≥${g.delegation.threshold}% | ${f(g.delegation.pass)} |\n| small-task cost growth | ${f(g.smallTasks.growthPct)}% | ≤${g.smallTasks.threshold}% | ${f(g.smallTasks.pass)} |\n\nWhole set: ${JSON.stringify(a.totals.all)}\nDelegation: ${JSON.stringify(a.delegation)}\n\n| scenario | category | target | baseline input median/p95 | hybrid input median/p95 | hybrid cold/warm median | errors b/h | assertions b/h |\n|---|---|---|---|---|---|---|---|\n${a.scenarios.map(s=>`| ${s.id} | ${s.category} | ${s.eligible?'yes':'no'} | ${f(s.baseline.input.median)}/${f(s.baseline.input.p95)} | ${f(s.hybrid.input.median)}/${f(s.hybrid.input.p95)} | ${f(s.hybrid.byCache.cold.median)}/${f(s.hybrid.byCache.warm.median)} | ${s.baseline.errors}/${s.hybrid.errors} | ${f(s.baseline.assertions)}/${f(s.hybrid.assertions)} |`).join('\n')}\n`;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [cmd,...a]=process.argv.slice(2);const get=(k,d)=>{const i=a.indexOf('--'+k);return i>=0?a[i+1]:d;};
  const here=path.dirname(fileURLToPath(import.meta.url));
  if(cmd==='plan'){const p=plan(makeScenarios(makeCorpus(+get('seed',2026))),{reps:+get('reps',3),seed:+get('seed',1)});const out=get('out');if(out)await writeFile(out,JSON.stringify(p,null,2));else console.log(JSON.stringify(p,null,2));}
  else if(cmd==='analyze'){
    const lines=(await readFile(get('records'),'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l));
    const pi=get('price-in'),po=get('price-out');const pricing=pi&&po?{inputPerM:+pi,outputPerM:+po,configured:true}:{configured:false};
    const n=k=>{const v=get(k);return v===undefined?undefined:+v;};
    if(pricing.configured)Object.assign(pricing,{cachedInputPerM:n('price-cached'),cacheWritePerM:n('price-cache-write'),reasoningPerM:n('price-reasoning')});
    const res=analyze(lines,{scenarios:makeScenarios(makeCorpus(+get('seed',2026))),pricing,reps:n('reps')??null,minScenarios:n('min-scenarios')??50,requirePlanned:a.includes('--require-planned')});
    const md=toMarkdownReal(res,{pricing});
    const out=get('out');if(out)await writeFile(out,md);const js=get('json');if(js)await writeFile(js,JSON.stringify(res,null,2));console.log(md);
  }else if(cmd==='mock'){
    const rep=await runMockPaired({seed:+get('seed',2026),reps:+get('reps',1)});
    const out=get('out',path.join(here,'results'));await mkdir(out,{recursive:true});
    const base=path.join(out,`paired-mock-${rep.meta.date.slice(0,10)}`);await writeFile(base+'.json',JSON.stringify(rep,null,2));await writeFile(base+'.md',toMarkdownPaired(rep));
    console.log(toMarkdownPaired(rep));console.error('written',base+'.{json,md}');
  }else{console.error('usage: node bench/paired.mjs plan|analyze|mock [options]');process.exit(2);}
}
