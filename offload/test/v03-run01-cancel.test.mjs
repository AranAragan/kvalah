// RUN-01 regression: end-to-end cancellation and resource release.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {smartMock,workspace,engine,bigLog,sleep} from './helpers.mjs';
import {createScheduler} from '../compute/vendor/scheduler.mjs';
import {createOffload} from '../compute/offload.mjs';
import {createCache} from '../compute/cache.mjs';
import {ollamaProvider} from '../compute/providers-lite.mjs';

const task=(x={})=>({kind:'summarize',instruction:'summarize',context:'ERROR one\nok\n',...x});
const idle=(e,sched)=>{assert.equal(e.metrics().pending,0,'pending not released');if(sched)assert.equal(sched.localState.inflight,0,'inflight not released');assert.equal(e.metrics().pendingCalls??0,0,'pending calls not released');};
function mk({provider,maxParallel=1,...opts}){const scheduler=createScheduler({local:{provider,model:'mock',maxParallel},maxAttempts:1});return {scheduler,e:createOffload({provider,model:'mock',scheduler,cache:createCache(),...opts})};}

test('RUN-01: cancel before queue and while queued; counters return to zero', {timeout:10000}, async()=>{
  const p=smartMock({delay:400});const {e,scheduler}=mk({provider:p});
  await assert.rejects(()=>e.delegate(task(),{signal:AbortSignal.abort()}));assert.equal(p.calls.length,0);
  const first=e.delegate(task({instruction:'first'}));
  const ac=new AbortController();const second=e.delegate(task({instruction:'second'}),{signal:ac.signal});
  await sleep(50);ac.abort();const t0=Date.now();
  await assert.rejects(second);assert.ok(Date.now()-t0<200,'queued request not released promptly');
  await first;assert.equal(p.calls.length,1,'cancelled queued request still reached the model');
  idle(e,scheduler);
});

test('RUN-01: cancel during HTTP inference closes the connection', {timeout:10000}, async()=>{
  let closed=false,started=false;
  const srv=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{started=true;res.writeHead(200,{'content-type':'application/x-ndjson'});res.write(JSON.stringify({message:{content:'{'}})+'\n');
    res.on('close',()=>{closed=true;});});});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  try{
    const provider=ollamaProvider(`http://127.0.0.1:${srv.address().port}`);
    const {e,scheduler}=mk({provider});const ac=new AbortController();
    const p=e.delegate(task(),{signal:ac.signal});
    while(!started)await sleep(10);ac.abort();
    await assert.rejects(p);await sleep(100);
    assert.ok(closed,'HTTP request to the model server was not aborted');idle(e,scheduler);
  }finally{srv.closeAllConnections();srv.close();}
});

test('RUN-01: a fatal map error cancels siblings and waits for them before rejecting', {timeout:10000}, async()=>{
  let active=0,aborted=0,n=0;
  const provider={kind:'mock',base:'m',health:async()=>({online:true}),async *chat(req){
    const me=++n;active++;
    try{
      if(me===2)throw Object.assign(Error('boom'),{fatal:true});
      await new Promise((res,rej)=>{const t=setTimeout(res,3000);req.signal.addEventListener('abort',()=>{clearTimeout(t);aborted++;setTimeout(()=>rej(req.signal.reason),30);},{once:true});});
      yield {type:'content',text:'NOTE: x'};yield {type:'done',reason:'stop',stats:{}};
    }finally{active--;}
  }};
  const root=await workspace({'big.log':bigLog({lines:3000})});
  const eng=engine({root,provider,maxParallel:4,ctxTokens:4096,maxTokens:256,maxChunks:100});
  const t0=Date.now();
  await assert.rejects(()=>eng.delegate({kind:'logs',instruction:'errors',paths:['big.log'],strategy:'map-reduce'}),/boom/);
  assert.ok(Date.now()-t0<2000,'siblings were not cancelled');
  assert.equal(active,0,'map calls still running after the request failed');assert.ok(aborted>=1);
});

test('RUN-01: dedupe — one of two subscribers cancels; all cancel; re-join after cancel starts a fresh job', {timeout:10000}, async()=>{
  const p=smartMock({delay:300});const {e,scheduler}=mk({provider:p});
  const a=new AbortController();const pa=e.delegate(task(),{signal:a.signal});const pb=e.delegate(task());
  await sleep(30);a.abort();await assert.rejects(pa);const rb=await pb;assert.ok(rb.summary);assert.equal(p.calls.length,1);
  // all subscribers leave → the underlying call is aborted
  let sawAbort=false;
  const slow={kind:'mock',base:'s',health:async()=>({online:true}),async *chat(req){await new Promise((res,rej)=>{const t=setTimeout(res,2000);req.signal.addEventListener('abort',()=>{clearTimeout(t);sawAbort=true;setTimeout(()=>rej(req.signal.reason),150);},{once:true});});yield {type:'content',text:'{"summary":"late","findings":[]}'};yield {type:'done',reason:'stop',stats:{}};}};
  const m2=mk({provider:slow,maxParallel:2});
  const c=new AbortController();const pc=m2.e.delegate(task(),{signal:c.signal});await sleep(30);c.abort();await assert.rejects(pc);
  await sleep(20);assert.ok(sawAbort,'last subscriber leaving did not abort the job');
  // race: the aborted job is still winding down (150ms) — a new identical request must not join it
  const pd=m2.e.delegate(task());
  await assert.doesNotReject(pd,'new request joined an aborted job');
  await sleep(200);idle(m2.e,m2.scheduler);
});

test('RUN-01: cancel right after the cache lookup is honoured', {timeout:10000}, async()=>{
  const ac=new AbortController();let armed=false;
  const cache=createCache();const get=cache.get.bind(cache);cache.get=async k=>{const v=await get(k);if(armed)ac.abort();return v;};
  const p=smartMock();const scheduler=createScheduler({local:{provider:p,model:'mock',maxParallel:1},maxAttempts:1});
  const e=createOffload({provider:p,model:'mock',scheduler,cache});
  await e.delegate(task());armed=true;                       // primed: the next lookup is a hit
  await assert.rejects(()=>e.delegate(task(),{signal:ac.signal}),'a request cancelled during the cache lookup returned a result');
});

test('RUN-01: retry re-arms the queue timeout (node 1 fails, node 2 busy forever)', {timeout:8000}, async()=>{
  // scheduler stub: first attempt runs the job on a failing node, the retry waits for a slot that never frees
  const scheduler={localState:{inflight:0},async run(job,{signal}){
    try{await job({kind:'x',async *chat(){throw Error('node1 down');}},'mock',{id:'n1',name:'n1'});}catch{}
    await new Promise((_,rej)=>{if(signal.aborted)return rej(signal.reason);signal.addEventListener('abort',()=>rej(signal.reason),{once:true});});
  }};
  const e=createOffload({provider:smartMock(),model:'mock',scheduler,cache:createCache(),queueTimeoutMs:300});
  const t0=Date.now();
  await assert.rejects(()=>e.delegate(task()),/Queue timeout/);
  assert.ok(Date.now()-t0<2000);assert.equal(e.metrics().queueTimeouts,1);idle(e);
});

test('RUN-01: request deadline bounds the whole request', {timeout:8000}, async()=>{
  const {e,scheduler}=mk({provider:smartMock({delay:3000}),requestDeadlineMs:300});
  const t0=Date.now();await assert.rejects(()=>e.delegate(task()),/deadline/i);assert.ok(Date.now()-t0<1500);
  await sleep(50);idle(e,scheduler);
});
