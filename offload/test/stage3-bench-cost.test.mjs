import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateTaskCost,predictSavings,pricingFromEnv,createLedger} from '../compute/cost.mjs';
import {runBench,toMarkdown} from '../bench/run.mjs';
import {engine,workspace,bigLog} from './helpers.mjs';

const p={inputPerM:3,outputPerM:15,localPerM:0,configured:true}; // v0.3 (MET-01): USD only with configured prices
test('cost model: file reads saved, tool-call args billed at output price, result at input price',()=>{
  const c=estimateTaskCost({fileTokens:100000,argsTokens:100,resultTokens:1000,baseline:'full'},p); // full-read upper bound keeps the formula check exact
  assert.equal(c.baselineCloudUsd,0.3);assert.equal(c.offloadCloudUsd,0.0045);assert.equal(c.savedUsd,0.2955);assert.equal(c.netCloudTokensSaved,98900);
  const inline=estimateTaskCost({fileTokens:0,argsTokens:6000,resultTokens:500},p);assert.ok(inline.savedUsd<0,'inline context must cost, not save');
});
test('pricing from env, defaults flagged as unconfigured; local electricity price supported',()=>{
  assert.equal(pricingFromEnv({}).configured,false);
  const q=pricingFromEnv({KVALAH_PRICE_INPUT:'1.25',KVALAH_PRICE_OUTPUT:'10',KVALAH_PRICE_LOCAL:'0.05'});assert.deepEqual([q.inputPerM,q.outputPerM,q.localPerM,q.configured],[1.25,10,0.05,true]);
  assert.ok(estimateTaskCost({fileTokens:0,localTokens:1e6},q).localUsd===0.05);
});
test('predictSavings: small inputs are not worth offloading, large ones are',()=>{
  assert.ok(predictSavings({fileTokens:300},p).savedUsd<0);assert.ok(predictSavings({fileTokens:50000},p).savedUsd>0.02); // v0.3: selective-read baseline (MET-01)
  assert.ok(predictSavings({fileTokens:50000,baseline:'full'},{...p,baseline:'full'}).savedUsd>0.1);
});
test('ledger accumulates; engine attaches per-task cost and totals',async()=>{
  const l=createLedger();l.add({usd:{savedUsd:0.1,baselineCloudUsd:0.2,offloadCloudUsd:0.1},netCloudTokensSaved:5});l.add({usd:{savedUsd:-0.01},netCloudTokensSaved:-3});
  assert.equal(l.totals().tasks,2);assert.equal(l.totals().savedUsd,0.09);
  const root=await workspace({'a.log':bigLog({lines:3000})});const e=engine({root,pricing:p,maxChunks:64});
  const r=await e.delegate({kind:'logs',instruction:'errors',paths:['a.log']});
  assert.ok(r.cost.savedUsd>0);assert.ok(r.cost.cloudTokens.without>r.cost.cloudTokens.withInput);
  const r2=await e.delegate({kind:'logs',instruction:'errors',paths:['a.log']});assert.equal(r2.cached,true);assert.equal(r2.cost.localUsd,0);
  assert.equal(e.metrics().savings.tasks,2);
});
test('benchmark is reproducible with the mock provider and reports honest negatives',async()=>{
  const strip=r=>JSON.stringify(r.rows.map(({ms,...x})=>x));
  const a=await runBench({seed:7}),b=await runBench({seed:7});
  assert.equal(strip(a),strip(b));
  assert.equal(a.totals.meanRecall,1);
  assert.ok(a.rows.find(r=>r.id==='ci-failures').savedUsd>0.05);
  assert.ok(a.rows.find(r=>r.id==='tiny-inline-transform').savedUsd<0);
  assert.ok(a.rows.filter(r=>r.level===1).every(r=>r.ok&&r.localTokens===0));
  assert.match(toMarkdown(a),/\| ci-failures \| L2 \| map-reduce \| ✔ \| 1 \|/);
});
