// v0.4 BENCH-01..06: honest benchmark accounting.
import test from 'node:test';
import assert from 'node:assert/strict';

const meta=[{id:'big',category:'ci-log',eligible:true},{id:'mid',category:'search',eligible:true}];
const pricing={inputPerM:3,outputPerM:15,configured:true};
const cond={agent:'codex',agentVersion:'1.0',model:'gpt-x',config:'cfg1',snapshot:'abc123'};
const rec=(scenario,arm,rep,input,output,extra={})=>({scenario,arm,rep,cacheMode:'warm',usage:{input,output},usageSource:'agent-usage',durationMs:1000,assertionsPassed:1,critical:false,...cond,kvalahOutcome:arm==='hybrid'?'accepted':undefined,...extra});
const full=()=>{const r=[];for(const rep of [0,1,2])for(const id of ['big','mid'])r.push(rec(id,'baseline',rep,100000,1000),rec(id,'hybrid',rep,20000,1000));return r;};

test('v04 BENCH-01: a missing baseline or hybrid run makes the verdict INCOMPLETE, never PASS', async()=>{
  const {analyze}=await import('../bench/paired.mjs');
  const ok=analyze(full(),{scenarios:meta,pricing,minScenarios:2});
  assert.equal(ok.verdict,'PASS',JSON.stringify(ok.completeness));
  const missingHybrid=full().filter(x=>!(x.scenario==='mid'&&x.arm==='hybrid'&&x.rep===2));
  const a=analyze(missingHybrid,{scenarios:meta,pricing,minScenarios:2});
  assert.equal(a.verdict,'INCOMPLETE');assert.deepEqual(a.completeness.missing,[{scenario:'mid',rep:2,arm:'hybrid'}]);
  for(const g of Object.values(a.gates))assert.notEqual(g.pass,true,'no gate may pass on incomplete pairs');
  const onlyBaseline=full().filter(x=>!(x.scenario==='mid'&&x.arm==='hybrid'));
  assert.equal(analyze(onlyBaseline,{scenarios:meta,pricing,minScenarios:2}).verdict,'INCOMPLETE');
  // fewer complete scenarios than required (readiness: ≥50) → INCOMPLETE
  const few=analyze(full(),{scenarios:meta,pricing});assert.equal(few.verdict,'INCOMPLETE');assert.match(few.completeness.reason,/50/);
  // a scenario of the plan that has no record at all
  const planned=analyze(full(),{scenarios:[...meta,{id:'never',category:'docs',eligible:true}],pricing,minScenarios:2,requirePlanned:true});
  assert.equal(planned.verdict,'INCOMPLETE');assert.ok(planned.completeness.missing.some(m=>m.scenario==='never'));
});

test('v04 BENCH-02: comparison conditions are validated (model, agent version, config, snapshot, repetitions)', async()=>{
  const {analyze}=await import('../bench/paired.mjs');
  const bad=full().map(x=>x.scenario==='big'&&x.arm==='hybrid'&&x.rep===1?{...x,model:'other-model'}:x);
  const a=analyze(bad,{scenarios:meta,pricing,minScenarios:2});
  assert.equal(a.verdict,'INVALID');assert.ok(a.conditions.problems.some(p=>/model/.test(p)),a.conditions.problems.join('; '));
  for(const g of Object.values(a.gates))assert.notEqual(g.pass,true);
  const ver=analyze(full().map(x=>x.arm==='hybrid'?{...x,agentVersion:'2.0'}:x),{scenarios:meta,pricing,minScenarios:2});assert.equal(ver.verdict,'INVALID');
  const snap=analyze(full().map((x,i)=>i===0?{...x,snapshot:'zzz'}:x),{scenarios:meta,pricing,minScenarios:2});assert.equal(snap.verdict,'INVALID');
  const missing=analyze(full().map(x=>{const {config,...y}=x;return y;}),{scenarios:meta,pricing,minScenarios:2});assert.equal(missing.verdict,'INVALID');assert.ok(missing.conditions.problems.some(p=>/config/.test(p)));
  const reps=analyze(full().filter(x=>!(x.scenario==='mid'&&x.rep===2)),{scenarios:meta,pricing,minScenarios:2,reps:3});
  assert.notEqual(reps.verdict,'PASS');assert.ok(reps.conditions.problems.some(p=>/repetition/.test(p)));
});

test('v04 BENCH-03: usage adapters — cached input and reasoning tokens are not counted twice', async()=>{
  const {normalizeUsage}=await import('../compute/usage.mjs');
  // OpenAI Chat Completions: cached ⊂ prompt_tokens, reasoning ⊂ completion_tokens
  assert.deepEqual(normalizeUsage({prompt_tokens:1000,completion_tokens:500,prompt_tokens_details:{cached_tokens:800},completion_tokens_details:{reasoning_tokens:300}},'openai-chat'),
    {input:200,cachedInput:800,cacheWrite:0,output:200,reasoning:300});
  // OpenAI Responses API
  assert.deepEqual(normalizeUsage({input_tokens:1000,output_tokens:500,input_tokens_details:{cached_tokens:800},output_tokens_details:{reasoning_tokens:300}},'openai-responses'),
    {input:200,cachedInput:800,cacheWrite:0,output:200,reasoning:300});
  // Anthropic Messages: input_tokens excludes cache reads/writes, which are reported separately
  assert.deepEqual(normalizeUsage({input_tokens:200,cache_read_input_tokens:800,cache_creation_input_tokens:100,output_tokens:500},'anthropic'),
    {input:200,cachedInput:800,cacheWrite:100,output:500,reasoning:0});
  // Gemini: cachedContentTokenCount ⊂ promptTokenCount; thoughtsTokenCount separate from candidatesTokenCount
  assert.deepEqual(normalizeUsage({promptTokenCount:1000,cachedContentTokenCount:800,candidatesTokenCount:200,thoughtsTokenCount:300},'gemini'),
    {input:200,cachedInput:800,cacheWrite:0,output:200,reasoning:300});
  assert.throws(()=>normalizeUsage({prompt_tokens:10,prompt_tokens_details:{cached_tokens:20}},'openai-chat'),/inconsistent/);
  assert.throws(()=>normalizeUsage({x:1},'nope'),/unknown usage format/);
  // analyze() applies the adapters: same raw OpenAI usage must not bill cached tokens at full price on top
  const {analyze}=await import('../bench/paired.mjs');
  const raw={prompt_tokens:100000,completion_tokens:1000,prompt_tokens_details:{cached_tokens:90000}};
  const r=[rec('big','baseline',0,0,0,{usage:undefined,rawUsage:raw,usageFormat:'openai-chat'}),rec('big','hybrid',0,0,0,{usage:undefined,rawUsage:raw,usageFormat:'openai-chat'})];
  const a=analyze(r,{scenarios:meta.slice(0,1),pricing:{...pricing,cachedInputPerM:0.3},minScenarios:1});
  const b=a.scenarios[0].baseline;assert.equal(b.input.median,10000);assert.equal(b.cachedInput.median,90000);
  assert.equal(a.totals.target.baselineUsd,+(10000*3/1e6+90000*0.3/1e6+1000*15/1e6).toFixed(6));
});

test('v04 BENCH-04: failed attempts, retries, fallback and final verification are part of the cost', async()=>{
  const {analyze}=await import('../bench/paired.mjs');
  const r=[];
  for(const id of ['big','mid']){r.push(rec(id,'baseline',0,100000,1000));}
  // big/hybrid: a failed attempt (50k) then a successful retry (20k) — both cost money
  r.push(rec('big','hybrid',0,50000,500,{error:'tool failed',attempt:1}),rec('big','hybrid',0,20000,1000,{attempt:2}));
  // mid/hybrid: Kvalah declined → agent fell back (extra usage) + final verification usage
  r.push(rec('mid','hybrid',0,20000,1000,{kvalahOutcome:'fallback',extraUsage:[{kind:'fallback',input:60000,output:500},{kind:'verification',input:5000,output:200}]}));
  const a=analyze(r,{scenarios:meta,pricing,minScenarios:2});
  const big=a.scenarios.find(s=>s.id==='big'),mid=a.scenarios.find(s=>s.id==='mid');
  assert.equal(big.hybrid.input.median,70000,'failed attempt counted');assert.equal(big.hybrid.attempts,2);assert.equal(big.hybrid.errors,0,'final attempt succeeded');
  assert.equal(mid.hybrid.input.median,85000,'fallback + verification counted');
  assert.ok(a.costBreakdown.hybrid.failedAttempts.input===50000&&a.costBreakdown.hybrid.fallback.input===60000&&a.costBreakdown.hybrid.verification.input===5000,JSON.stringify(a.costBreakdown));
});

test('v04 BENCH-05: estimated savings include the full Offload overhead (skill, tool descriptions, calls, checks)', async()=>{
  const {createKvalahOffload}=await import('../compute/index.mjs');const {smartMock,workspace}=await import('./helpers.mjs');
  const {buildServer}=await import('../mcp/server.mjs');
  const root=await workspace({'a.log':'ok\nERROR one\n'.repeat(400)});
  const {app}=await buildServer({env:{KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',KVALAH_PRICE_INPUT:'3',KVALAH_PRICE_OUTPUT:'15'},provider:smartMock(),log:()=>{}});
  await app.engine.delegate({kind:'logs',instruction:'errors',paths:['a.log']});
  const s=app.engine.metrics().savings;
  assert.equal(s.kind,'estimated');
  assert.ok(s.overhead,'overhead block present');
  for(const k of ['skillTokens','toolSchemaTokens','callTokens','verificationTokens'])assert.ok(Number.isFinite(s.overhead[k]),k+' '+JSON.stringify(s.overhead));
  assert.ok(s.overhead.toolSchemaTokens>200,'tool descriptions counted: '+s.overhead.toolSchemaTokens);
  assert.ok(s.overhead.skillTokens>100,'skill load counted: '+s.overhead.skillTokens);
  assert.equal(s.netCloudTokensSavedAfterOverhead,s.netCloudTokensSaved-s.overhead.sessionTokens,'net after overhead');
  await app.close();
});

test('v04 BENCH-06: estimated and measured are separate in the API, dashboard and reports', async()=>{
  const {createKvalahOffload}=await import('../compute/index.mjs');const {smartMock,workspace}=await import('./helpers.mjs');
  const {writeFile,mkdtemp}=await import('node:fs/promises');const path=await import('node:path');const {tmpdir}=await import('node:os');
  const root=await workspace({'a.txt':'x'});const dir=await mkdtemp(path.join(tmpdir(),'kv4b-'));
  let app=await createKvalahOffload({env:{KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off'},provider:smartMock()});
  let m=app.engine.metrics();assert.equal(m.savings.kind,'estimated');assert.equal(m.measured.available,false);assert.match(m.measured.reason,/no paired benchmark/i);
  const st=await app.state();assert.equal(st.metrics.measured.available,false);await app.close();
  // a mock (not measured) analysis must not become "measured"
  const {analyze}=await import('../bench/paired.mjs');
  const mock=analyze(full().map(x=>({...x,usageSource:'mock-estimate'})),{scenarios:meta,pricing,minScenarios:2});
  await writeFile(path.join(dir,'mock.json'),JSON.stringify(mock));
  app=await createKvalahOffload({env:{KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',KVALAH_BENCH_RESULTS:path.join(dir,'mock.json')},provider:smartMock()});
  m=app.engine.metrics();assert.equal(m.measured.available,false);assert.match(m.measured.reason,/not measured/);await app.close();
  const real=analyze(full(),{scenarios:meta,pricing,minScenarios:2});await writeFile(path.join(dir,'real.json'),JSON.stringify(real));
  app=await createKvalahOffload({env:{KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',KVALAH_BENCH_RESULTS:path.join(dir,'real.json')},provider:smartMock()});
  m=app.engine.metrics();assert.equal(m.measured.available,true);assert.equal(m.measured.verdict,'PASS');assert.equal(m.measured.pairs,6);assert.ok(m.measured.savingsPct>70);await app.close();
  // dashboard page labels both, report says which is which
  const {renderPage}=await import('../compute/dashboard.mjs');const DASHBOARD_HTML=renderPage('n','t');
  assert.match(DASHBOARD_HTML,/Saved \(estimated\)/);assert.match(DASHBOARD_HTML,/measured\.available/);
  const {toMarkdownReal}=await import('../bench/paired.mjs');const md=toMarkdownReal(real);assert.match(md,/Verdict: \*\*PASS\*\*/);assert.match(md,/measured/i);
  assert.match(toMarkdownReal(mock),/NOT_MEASURED/);
});
