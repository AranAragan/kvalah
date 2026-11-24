// MET-01 regression: honest economics — estimated vs measured, unknown prices stay unknown, selective-read
// baseline, no repeated credit for the same file, negative savings kept, outcomes counted separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../compute/cost.mjs';
const {pricingFromEnv,estimateTaskCost}=C;const pairedSavings=(...a)=>{if(!C.pairedSavings)throw Error('v0.2 has no measured paired-usage model');return C.pairedSavings(...a);};
import {smartMock,workspace,engine,bigLog} from './helpers.mjs';

test('MET-01: unconfigured prices are unknown (no placeholder USD); tariffs scale; tokens always reported', ()=>{
  const none=pricingFromEnv({});assert.equal(none.configured,false);assert.equal(none.inputPerM,null);
  const c=estimateTaskCost({fileTokens:50000,argsTokens:100,resultTokens:800},none);
  assert.equal(c.savedUsd,null);assert.equal(c.usd,null);assert.equal(c.estimated,true);assert.ok(c.netCloudTokensSaved>0);
  const a=estimateTaskCost({fileTokens:50000,argsTokens:100,resultTokens:800},pricingFromEnv({KVALAH_PRICE_INPUT:'3',KVALAH_PRICE_OUTPUT:'15'}));
  const b=estimateTaskCost({fileTokens:50000,argsTokens:100,resultTokens:800},pricingFromEnv({KVALAH_PRICE_INPUT:'1.25',KVALAH_PRICE_OUTPUT:'10'}));
  assert.ok(a.savedUsd>b.savedUsd&&b.savedUsd>0);
});

test('MET-01: baseline is a selective reader (grep + partial reads), full read is only an upper bound', ()=>{
  const p=pricingFromEnv({KVALAH_PRICE_INPUT:'3',KVALAH_PRICE_OUTPUT:'15'});
  const c=estimateTaskCost({fileTokens:100000,argsTokens:100,resultTokens:800},p);
  assert.ok(c.baselineTokens.selective<c.baselineTokens.fullRead);assert.equal(c.baselineKind,'selective');
  assert.ok(c.netCloudTokensSaved<100000-900,'savings must not assume the agent reads everything');
});

test('MET-01: paired measured usage — cached input, reasoning, missing usage, negative savings', ()=>{
  const p=pricingFromEnv({KVALAH_PRICE_INPUT:'3',KVALAH_PRICE_OUTPUT:'15',KVALAH_PRICE_CACHED_INPUT:'0.3'});
  const r=pairedSavings([
    {id:'a',baseline:{input:40000,cachedInput:10000,output:1500,reasoning:500},hybrid:{input:6000,cachedInput:10000,output:1800,reasoning:500},localKWh:0.002},
    {id:'b',baseline:{input:3000,output:400},hybrid:{input:3500,output:700}},          // offload made it worse
    {id:'c',baseline:{input:5000,output:300},hybrid:null},                              // usage missing
  ],p,{kwhPrice:0.3,meta:{model:'claude-x',tariff:'api',date:'2026-11-24',usageSource:'provider dashboard',skillVersion:'0.3.0',cacheMode:'cold'}});
  assert.equal(r.measured,true);assert.equal(r.rows.find(x=>x.id==='c').netUsd,null);assert.equal(r.unknown,1);
  assert.ok(r.rows.find(x=>x.id==='b').netUsd<0,'negative savings must be kept');
  const a=r.rows.find(x=>x.id==='a');
  // baseline: 40000*3 + 10000*0.3 + (1500+500)*15 ; hybrid: 6000*3 + 10000*0.3 + (1800+500)*15 ; local 0.002*0.3
  const exp=((40000*3+10000*0.3+2000*15)-(6000*3+10000*0.3+2300*15))/1e6-0.0006;
  assert.ok(Math.abs(a.netUsd-exp)<1e-9,a.netUsd+' vs '+exp);
  assert.ok(r.meta.model&&r.meta.usageSource&&r.meta.cacheMode);
});

test('MET-01: repeated delegation of the same file gets no second full credit; failed/cancelled/accepted counted apart', async()=>{
  const root=await workspace({'ci.log':bigLog({lines:3000})});
  const e=engine({root,provider:smartMock(),pricing:pricingFromEnv({KVALAH_PRICE_INPUT:'3',KVALAH_PRICE_OUTPUT:'15'}),ctxTokens:8192,maxTokens:512,maxChunks:100});
  const first=await e.delegate({kind:'logs',instruction:'errors',paths:['ci.log']});
  const second=await e.delegate({kind:'logs',instruction:'list the fatal ones',paths:['ci.log']});
  assert.ok(first.cost.netCloudTokensSaved>0);
  assert.ok(second.cost.netCloudTokensSaved<=0,'same file credited twice: '+second.cost.netCloudTokensSaved);
  const bad=engine({root,provider:{...smartMock(),async *chat(){throw Object.assign(Error('model crashed'),{fatal:true});}}});
  await assert.rejects(()=>bad.delegate({kind:'logs',instruction:'x',context:'ERROR a\n'.repeat(10)}));
  const ac=new AbortController();ac.abort();await assert.rejects(()=>bad.delegate({kind:'logs',instruction:'y',context:'ERROR b'},{signal:ac.signal}));
  const m=bad.metrics();assert.equal(m.outcomes.failed,1);assert.equal(m.outcomes.cancelled,1);assert.equal(m.outcomes.accepted,0);
  assert.ok(m.savings.netCloudTokensSaved<0,'failed task cost must be recorded as a loss');
  const mm=e.metrics();assert.equal(mm.outcomes.accepted,2);assert.ok(mm.outcomes.cold>=1);assert.ok(Number.isFinite(mm.queueMs)&&Number.isFinite(mm.execMs));
  assert.equal(mm.savings.kind,'estimated');
});
