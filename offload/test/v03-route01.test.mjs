// ROUTE-01 regression: meaningful routing with an explanation for each situation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter} from '../compute/router.mjs';
import {createTokenCounter} from '../compute/tokens.mjs';
import {pricingFromEnv} from '../compute/cost.mjs';
import {createStats} from '../compute/stats.mjs';
import {workspace,smartMock} from './helpers.mjs';
import {createKvalahOffload} from '../compute/index.mjs';

function mk({online=true,sizes={},stats=createStats(),metrics={pending:0,pendingCalls:0},det={}}={}){
  return createRouter({engine:{model:'qwen3.5:9b',maxTokens:2048,maxPending:8,maxPendingCalls:64,readFiles:{sizes:async p=>p.map(x=>({path:x,bytes:sizes[x]??100}))},budgets:()=>({final:12000}),metrics:()=>metrics},
    det,counter:createTokenCounter(),pricing:pricingFromEnv({}),stats,health:async()=>({online})});
}
const big={'ci.log':120_000,'small.js':1200};

test('ROUTE-01: expected level + reason for each situation', async()=>{
  const cases=[
    ['offline',mk({online:false,sizes:big}),{goal:'Summarize the failures in this CI log',paths:['ci.log']},3,/offline/],
    ['short snippet',mk({sizes:big}),{goal:'Explain this',context:'const a = 1;'},3,/small|already in your context|cost more/],
    ['already-read file',mk({sizes:big}),{goal:'Summarize the failures in this CI log',paths:['ci.log'],contextAlreadyLoaded:true},3,/already/],
    ['long logs',mk({sizes:big}),{goal:'Summarize the failures in this CI log',paths:['ci.log']},2,/saving|chunk/],
    ['small file',mk({sizes:big}),{goal:'Summarize this file',paths:['small.js']},3,/small|directly/],
    ['security decision',mk({sizes:big}),{goal:'Is this change safe to merge? Check for security vulnerabilities',paths:['ci.log'],prefer:'local'},3,/security/],
    ['overloaded queue',mk({sizes:big,metrics:{pending:8,pendingCalls:60}}),{goal:'Summarize the failures in this CI log',paths:['ci.log']},3,/overload|queue/],
  ];
  for(const [name,r,t,level,re] of cases){const d=await r.decide(t);assert.equal(d.level,level,`${name}: ${JSON.stringify(d)}`);assert.match(d.reason,re,name);}
});

test('ROUTE-01: ambiguous dependency wording is not routed to L1; explicit structural questions are', async()=>{
  const r=mk({sizes:big});
  for(const g of ['Should we upgrade the lodash dependency?','Review the dependency injection setup','Which dependency version is best?'])
    assert.notEqual((await r.decide({goal:g})).level,1,g);
  assert.equal((await r.decide({goal:'Find circular imports in the project'})).level,1);
  assert.equal((await r.decide({goal:'Who imports src/db.js?',paths:['src/db.js']})).level,1);
  assert.equal((await r.decide({goal:'Where is `createRouter` defined?'})).op,'symbols');
});

test('ROUTE-01: low model quality per kind+model → L3; KVALAH_ROUTER_MIN_TOKENS is honoured', async()=>{
  const stats=createStats();for(let i=0;i<6;i++)stats.record('logs@qwen3.5:9b',{ok:i===0,ms:1000});
  const d=await mk({sizes:big,stats}).decide({goal:'Summarize the failures in this CI log',paths:['ci.log']});
  assert.equal(d.level,3);assert.match(d.reason,/failed|quality/);
  const r=createRouter({engine:{model:'m',maxTokens:2048,readFiles:{sizes:async p=>p.map(x=>({path:x,bytes:20000}))},budgets:()=>({final:12000}),metrics:()=>({pending:0,pendingCalls:0})},det:{},counter:createTokenCounter(),pricing:pricingFromEnv({}),stats:createStats(),health:async()=>({online:true}),minTokens:10000});
  assert.equal((await r.decide({goal:'Summarize this',paths:['x.log']})).level,3);
});

test('ROUTE-01: an explicit deterministic request works with Ollama down', async()=>{
  const root=await workspace({'src/a.js':'export function createThing(){}\n'});
  const dead={kind:'mock',base:'x',health:async()=>({online:false}),async *chat(){throw Error('down');}};
  const app=await createKvalahOffload({env:{KVALAH_MODEL:'m',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off'},provider:dead});
  try{const r=await app.auto({goal:'Where is `createThing` defined?'});assert.equal(r.route.level,1);assert.equal(r.symbols[0].name,'createThing');}
  finally{await app.close();}
});

test('ROUTE-01/QA-02: contextAlreadyLoaded also wins over a structural (L1) match', async()=>{
  const r=mk({sizes:big});
  const d=await r.decide({goal:'What does a.mjs import?',paths:['src/a.mjs'],contextAlreadyLoaded:true});
  assert.equal(d.level,3);assert.match(d.reason,/already in your context/);
  assert.equal((await r.decide({goal:'What does a.mjs import?',paths:['src/a.mjs']})).level,1,'without the flag the L1 route stays');
});
