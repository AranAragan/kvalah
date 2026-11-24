// v0.4 ROUTE-01/ROUTE-02: routing by EXPECTED savings — failure probability (historic success rate of the local
// model for this kind), verification cost (share of unverifiable findings), files the agent already read, and the
// MCP interaction overhead (tool schemas resent per delegated task, BENCH-05).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter} from '../compute/router.mjs';
import {createTokenCounter} from '../compute/tokens.mjs';
import {pricingFromEnv} from '../compute/cost.mjs';
import {createStats} from '../compute/stats.mjs';

function mk({sizes={},stats=createStats(),metrics={pending:0,pendingCalls:0},minTokens=2000,pricing=pricingFromEnv({})}={}){
  return createRouter({engine:{model:'m',maxTokens:2048,maxPending:8,maxPendingCalls:64,readFiles:{sizes:async p=>p.map(x=>({path:x,bytes:sizes[x]??100}))},budgets:()=>({final:12000}),metrics:()=>metrics},
    det:{},counter:createTokenCounter(),pricing,stats,health:async()=>({online:true}),minTokens});
}
const goal='Summarize the failures in this CI log';

test('v04 ROUTE-01: failure probability and verification cost can make a marginal delegation a loss → L3', async()=>{
  const sizes={'mid.log':2700};                                                      // ~710 tokens
  const fresh=await mk({sizes,minTokens:500}).decide({goal,paths:['mid.log']});
  assert.equal(fresh.level,2,'baseline case should delegate: '+JSON.stringify(fresh));
  const stats=createStats();for(let i=0;i<20;i++)stats.record('logs@m',{ok:i<11,ms:500,findings:20,verified:i<11?13:0});   // 55% success, 35% verified
  const d=await mk({sizes,minTokens:500,stats}).decide({goal,paths:['mid.log']});
  assert.equal(d.level,3,'marginal delegation with a 45% failure rate still routed to the local model: '+JSON.stringify(d));
  assert.match(d.reason,/expected/);
  assert.ok(d.expected&&d.expected.pFail>0.4&&d.expected.verifyTokens>0&&d.expected.expectedNetTokens<=0,JSON.stringify(d.expected));
});

test('v04 ROUTE-01: files the agent already read do not count as savings (alreadyRead)', async()=>{
  const r=mk({sizes:{'ci.log':120000,'b.log':120000}});
  const all=await r.decide({goal,paths:['ci.log'],alreadyRead:['ci.log']});
  assert.equal(all.level,3,JSON.stringify(all));assert.match(all.reason,/already/);
  const part=await r.decide({goal,paths:['ci.log','b.log'],alreadyRead:['ci.log']});
  assert.equal(part.level,2);assert.ok(part.fileTokens<40000,'already-read file counted: '+part.fileTokens);
});

test('v04 ROUTE-02: MCP interaction overhead above the expected saving keeps the task with the agent', async()=>{
  const sizes={'ci.log':20000};
  const plain=await mk({sizes}).decide({goal,paths:['ci.log']});assert.equal(plain.level,2);
  const heavy=await mk({sizes,metrics:{pending:0,pendingCalls:0,savings:{overhead:{toolSchemaTokens:9000}}}}).decide({goal,paths:['ci.log']});
  assert.equal(heavy.level,3,JSON.stringify(heavy));assert.match(heavy.reason,/MCP/);
  assert.equal(heavy.expected.mcpOverheadTokens,9000);
  // with cloud prompt caching priced, the resend is billed at the cached ratio → delegation pays again
  const priced=pricingFromEnv({KVALAH_PRICE_INPUT:'3',KVALAH_PRICE_OUTPUT:'15',KVALAH_PRICE_CACHED_INPUT:'0.3'});
  const cached=await mk({sizes,pricing:priced,metrics:{pending:0,pendingCalls:0,savings:{overhead:{toolSchemaTokens:9000}}}}).decide({goal,paths:['ci.log']});
  assert.equal(cached.level,2,JSON.stringify(cached));assert.equal(cached.expected.mcpOverheadTokens,900);
});
