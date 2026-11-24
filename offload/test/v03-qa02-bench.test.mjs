// QA-02 regression: ≥50 paired scenarios, a randomized paired-run plan, honest analysis of real usage
// records (medians, p95, gates) and a mock end-to-end run that is labelled as mock, never as measured.
import test from 'node:test';
import assert from 'node:assert/strict';

const CATS=['ci-log','search','outline-deps','docs','tests','pre-review','large-repo','short','already-read'];

test('QA-02: at least 50 paired scenarios across all required categories, with objective assertions', async()=>{
  const {makeCorpus,scenarios}=await import('../bench/scenarios.mjs');
  const list=scenarios(makeCorpus(2026));
  assert.ok(list.length>=50,'scenarios: '+list.length);
  assert.equal(new Set(list.map(s=>s.id)).size,list.length);
  for(const c of CATS)assert.ok(list.some(s=>s.category===c),'missing category '+c);
  for(const s of list){
    assert.ok(s.prompt?.length>10,s.id);assert.ok(s.assert?.includes?.length>=1,s.id+' needs assertions');
    assert.ok(['compute','delegate','auto'].includes(s.hybrid.tool),s.id);assert.ok(s.baseline,s.id);
    assert.equal(s.eligible,!['short','already-read'].includes(s.category),s.id);
  }
});

test('QA-02: paired plan — repetitions, randomized arm order, cold and warm cache, reproducible by seed', async()=>{
  const {makeCorpus,scenarios}=await import('../bench/scenarios.mjs');const {plan}=await import('../bench/paired.mjs');
  const list=scenarios(makeCorpus(1)).slice(0,10);
  const p=plan(list,{reps:3,seed:7});
  assert.equal(p.runs.length,10*3*2);
  const firsts=new Set();for(let i=0;i<p.runs.length;i+=2){assert.equal(p.runs[i].scenario,p.runs[i+1].scenario);firsts.add(p.runs[i].arm);}
  assert.deepEqual([...firsts].sort(),['baseline','hybrid'],'both arm orders occur');
  assert.ok(p.runs.some(r=>r.arm==='hybrid'&&r.cacheMode==='cold')&&p.runs.some(r=>r.arm==='hybrid'&&r.cacheMode==='warm'));
  assert.deepEqual(plan(list,{reps:3,seed:7}),p);assert.ok(p.requirements.join(' ').match(/same agent.*model/i));
});

const rec=(scenario,arm,rep,input,output,extra={})=>({scenario,arm,rep,cacheMode:rep?'warm':'cold',usage:{input,output},usageSource:'agent-usage',durationMs:1000+rep*10,assertionsPassed:1,rubric:1,critical:false,agent:'codex',agentVersion:'x',model:'gpt',config:'c1',snapshot:'s1',...extra});   // v0.4 BENCH-02: config+snapshot are now required comparison conditions

test('QA-02: analysis — medians/p95, savings on target and whole set, quality/delegation/small-task gates', async()=>{
  const {analyze}=await import('../bench/paired.mjs');
  const pricing={inputPerM:3,outputPerM:15,configured:true};
  const meta=[{id:'big',category:'ci-log',eligible:true},{id:'tiny',category:'short',eligible:false}];
  const r=[];
  for(const rep of [0,1,2]){
    r.push(rec('big','baseline',rep,100000,1000),rec('big','hybrid',rep,20000+rep*1000,1200,{kvalahOutcome:'accepted'}));
    r.push(rec('tiny','baseline',rep,1000,100),rec('tiny','hybrid',rep,1080,100,{kvalahOutcome:'declined'}));
  }
  const a=analyze(r,{scenarios:meta,pricing});
  assert.equal(a.measured,true);
  const big=a.scenarios.find(s=>s.id==='big');assert.equal(big.hybrid.input.median,21000);assert.equal(big.hybrid.input.p95,22000);
  assert.ok(a.totals.target.savingsPct>70);assert.ok(a.totals.all.n===2);
  assert.equal(a.gates.savings.pass,true);assert.equal(a.gates.quality.pass,true);assert.equal(a.gates.delegation.pass,true);
  assert.equal(a.gates.smallTasks.pass,false,'>5% growth on small tasks exceeds the tolerance');assert.ok(a.gates.smallTasks.growthPct>5);
  assert.equal(a.delegation.declined,3);
  // quality regression and a critical error fail the quality gate
  const worse=r.map(x=>x.arm==='hybrid'&&x.scenario==='big'?{...x,assertionsPassed:0.5,critical:x.rep===1}:x);
  const b=analyze(worse,{scenarios:meta,pricing});assert.equal(b.gates.quality.pass,false);assert.equal(b.gates.quality.critical,1);
});

test('QA-02: estimated or mock usage is never reported as measured; gates are not evaluated', async()=>{
  const {analyze}=await import('../bench/paired.mjs');
  const r=[rec('big','baseline',0,100000,1000,{usageSource:'estimate'}),rec('big','hybrid',0,1000,100,{usageSource:'estimate'})];
  const a=analyze(r,{scenarios:[{id:'big',category:'ci-log',eligible:true}],pricing:{inputPerM:3,outputPerM:15,configured:true}});
  assert.equal(a.measured,false);for(const g of Object.values(a.gates))assert.equal(g.pass,null);
  assert.match(a.note,/not measured/i);
});

test('QA-02: mock paired run executes every scenario through the real pipeline and is labelled MOCK', async()=>{
  const {runMockPaired,toMarkdownPaired}=await import('../bench/paired.mjs');
  const rep=await runMockPaired({seed:2026,reps:1});
  assert.ok(rep.scenarios.length>=50);assert.equal(rep.measured,false);assert.equal(rep.label,'MOCK');
  assert.equal(rep.errors,0,JSON.stringify(rep.scenarios.filter(s=>s.error).map(s=>[s.id,s.error])));
  assert.ok(rep.scenarios.filter(s=>s.category==='short').every(s=>s.level===3),'router must decline small tasks');
  assert.ok(rep.scenarios.filter(s=>s.category==='already-read').every(s=>s.level===3));
  assert.ok(rep.meanRecall>=0.9,'pipeline recall '+rep.meanRecall);
  const md=toMarkdownPaired(rep);assert.match(md,/MOCK/);assert.match(md,/not measured/i);assert.doesNotMatch(md,/measured savings: \d/i);
});
