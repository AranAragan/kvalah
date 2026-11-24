#!/usr/bin/env node
// Reproducible benchmark: cloud cost WITH vs WITHOUT offload on seeded fixtures.
//   node bench/run.mjs                      # deterministic mock model (reproducible numbers)
//   node bench/run.mjs --provider ollama --model qwen3.5:9b [--url http://127.0.0.1:11434] [--ctx 16384]
//   --price-in 3 --price-out 15 (USD per 1M cloud tokens)  --out bench/results  --seed 2026
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFixtures,tasks as makeTasks} from './fixtures.mjs';
import {createOffload} from '../compute/offload.mjs';
import {createFileReader} from '../compute/files.mjs';
import {createDeterministic} from '../compute/deterministic/index.mjs';
import {createTokenCounter,heuristicTokens} from '../compute/tokens.mjs';
import {estimateTaskCost} from '../compute/cost.mjs';
import {createCache} from '../compute/cache.mjs';
import {loadKvalah} from '../compute/bridge.mjs';

export function mockProvider(getPattern){
  return {kind:'mock',base:'mock://bench',health:async()=>({online:true}),
    async *chat(req){
      const sys=req.messages[0].content,user=req.messages[1].content,pattern=getPattern();
      const data=user.slice(user.indexOf('Data:'));const hits=[];
      for(const l of data.split('\n')){const m=/^NOTE: (.*)$/.exec(l);if(m)hits.push(m[1]);else if(pattern.test(l)&&!l.startsWith('<'))hits.push(l.trim()?l:l);}
      const isMap=/extract facts from one chunk/.test(sys);const paths=[...user.matchAll(/path="([^"]+)"/g)].map(m=>m[1]);
      const text=isMap?(hits.length?hits.map(h=>'NOTE: '+h).join('\n'):'NONE'):JSON.stringify({summary:`${hits.length} relevant lines`,draft:'',findings:hits.slice(0,40).map(h=>({text:'relevant',quote:h.trim(),path:paths[0]||''})),uncertainty:''});
      yield {type:'content',text};yield {type:'done',reason:'stop',stats:{promptTokens:heuristicTokens(sys+user),tokens:heuristicTokens(text)}};
    }};
}
export async function runBench({provider:pk='mock',model='mock',url,ctx=16384,priceIn=3,priceOut=15,seed=2026,maxTokens=2048}={}){
  const fx=await writeFixtures(seed);const pricing={inputPerM:priceIn,outputPerM:priceOut,localPerM:0,currency:'USD',configured:true,note:'benchmark prices are parameters of the mock run, not measured costs'};
  const reader=createFileReader({root:fx.root});const counter=createTokenCounter();const det=createDeterministic({reader});
  let current=/x/;let provider;
  if(pk==='mock')provider=mockProvider(()=>current);
  else{const k=await loadKvalah();provider=pk==='ollama'?k.ollamaProvider(url||'http://127.0.0.1:11434'):k.openaiProvider(url||'http://127.0.0.1:1234/v1');}
  const {createScheduler}=await loadKvalah({...process.env,KVALAH_STANDALONE:'1'});
  const scheduler=createScheduler({local:{provider,model,maxParallel:1},maxAttempts:1});
  const engine=createOffload({provider,model,scheduler,readFiles:reader,counter,cache:createCache(),pricing,ctxTokens:ctx,maxTokens,maxChunks:64,timeoutMs:600000,queueTimeoutMs:600000});
  const rows=[];
  for(const t of makeTasks(fx)){
    current=t.mockPattern||/x/;const started=Date.now();let result,error=null;
    try{result=t.compute?await det.run(t.compute.op,t.compute):await engine.delegate(t.call);}catch(e){error=String(e.message||e);}
    const ms=Date.now()-started;
    // baseline: what the cloud agent reads without offload
    let fileTokens=0;
    if(t.baseline.readFiles)for(const p of t.baseline.readFiles)fileTokens+=heuristicTokens(fx.files[p]);
    if(t.baseline.grep){const g=await det.run('search',{pattern:t.baseline.grep.pattern});fileTokens=heuristicTokens(g.matches.map(m=>`${m.path}:${m.line}:${m.text}`).join('\n'))+20;}
    const args=t.compute?{op:t.compute.op,...t.compute}:t.call;
    const resultText=result?JSON.stringify(result):'';
    // the task defines its own realistic baseline (files a normal agent reads, or its grep output): use it as-is
    const cost=estimateTaskCost({fileTokens,argsTokens:heuristicTokens(JSON.stringify(args)),resultTokens:heuristicTokens(resultText),baseline:'full'},pricing);
    const recall=t.expect.filter(x=>resultText.includes(x)).length/t.expect.length;
    rows.push({id:t.id,level:t.level,ok:!error,error,ms,recall:+recall.toFixed(2),strategy:result?.coverage?.strategy||(t.compute?'deterministic':null),
      llmCalls:result?.localTokens?.calls??0,localTokens:(result?.localTokens?.input||0)+(result?.localTokens?.output||0),
      verified:result?.checks?`${result.checks.verifiedFindings}/${result.checks.verifiedFindings+result.checks.unverifiedFindings}`:null,...cost});
  }
  const sum=k=>rows.reduce((n,r)=>n+(r[k]||0),0);
  const totals={baselineCloudUsd:+sum('baselineCloudUsd').toFixed(6),offloadCloudUsd:+sum('offloadCloudUsd').toFixed(6),savedUsd:+sum('savedUsd').toFixed(6),
    netCloudTokensSaved:sum('netCloudTokensSaved'),meanRecall:+(sum('recall')/rows.length).toFixed(2)};
  return {meta:{provider:pk,model,ctx,seed,pricing,node:process.version,date:new Date().toISOString()},rows,totals,calibration:counter.calibration()};
}
export function toMarkdown(rep){
  const h='| task | level | strategy | ok | recall | verified | cloud tokens w/o | cloud in+out with | net tokens saved | saved USD | local tok | ms |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n';
  const b=rep.rows.map(r=>`| ${r.id} | L${r.level} | ${r.strategy||'-'} | ${r.ok?'✔':'✖ '+r.error} | ${r.recall} | ${r.verified??'-'} | ${r.cloudTokens.without} | ${r.cloudTokens.withInput}+${r.cloudTokens.withOutput} | ${r.netCloudTokensSaved} | ${r.savedUsd} | ${r.localTokens} | ${r.ms} |`).join('\n');
  return `# Kvalah offload benchmark${rep.meta.provider==='mock'?' — MOCK':''}\n\n_Cloud costs are estimates from token counts (baseline: full read of the listed files) at parameter prices, not measured usage. Paired real runs: bench/paired.mjs, bench/RESULTS-real.md._\n\nprovider=${rep.meta.provider} model=${rep.meta.model} ctx=${rep.meta.ctx} seed=${rep.meta.seed} prices in/out per 1M=${rep.meta.pricing.inputPerM}/${rep.meta.pricing.outputPerM} USD\n\n${h}${b}\n\n**Totals:** without offload ${rep.totals.baselineCloudUsd} USD, with offload ${rep.totals.offloadCloudUsd} USD, saved ${rep.totals.savedUsd} USD (${rep.totals.netCloudTokensSaved} cloud tokens), mean recall ${rep.totals.meanRecall}.\n\n_Mock provider = idealized extractor, so recall measures the pipeline (chunking, retrieval, verification), not model quality. Use --provider ollama for real quality._\n`;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const a=process.argv.slice(2);const get=(k,d)=>{const i=a.indexOf('--'+k);return i>=0?a[i+1]:d;};
  const rep=await runBench({provider:get('provider','mock'),model:get('model','mock'),url:get('url'),ctx:+get('ctx',16384),priceIn:+get('price-in',3),priceOut:+get('price-out',15),seed:+get('seed',2026)});
  const out=get('out',path.join(path.dirname(fileURLToPath(import.meta.url)),'results'));await mkdir(out,{recursive:true});
  const base=path.join(out,`bench-${rep.meta.provider}-${rep.meta.date.slice(0,10)}`);
  await writeFile(base+'.json',JSON.stringify(rep,null,2));await writeFile(base+'.md',toMarkdown(rep));
  console.log(toMarkdown(rep));console.error('written',base+'.{json,md}');
}
