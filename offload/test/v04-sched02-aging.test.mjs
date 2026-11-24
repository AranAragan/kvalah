// v0.4 SCHED-02: a background job must not starve behind a continuous stream of interactive work.
// v0.3 pick() always served every interactive queue first, so under sustained interactive load a background job
// waited until its queue timeout. With aging, a background job waiting ≥ agingMs is served next.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

async function run(opts){
  const {startService,connectService}=await import('../compute/service.mjs');
  const dir=await mkdtemp(path.join(tmpdir(),'kv4a-'));const socketPath=path.join(dir,'s.sock'),tokenFile=path.join(dir,'t');
  const work=ms=>new Promise(r=>setTimeout(r,ms));
  const app={cfg:{model:'m',maxParallel:1,workspace:null},status:async()=>({}),state:async()=>({}),
    engine:{metrics:()=>({}),delegate:async(a)=>{await work(10);return {n:a.n};}},compute:async()=>({})};
  const s=await startService({app,socketPath,tokenFile,maxActive:1,queueTimeoutMs:1500,...opts});
  const fg=await connectService({socketPath,tokenFile,client:'fg',priority:'interactive'});
  const bg=await connectService({socketPath,tokenFile,client:'bg',priority:'background'});
  let stop=false,n=0;
  // sustained interactive load: always 4 calls queued
  const pumpers=Array.from({length:4},async()=>{while(!stop)await fg.call('delegate',{n:n++}).catch(()=>{});});
  await work(30);
  const t0=Date.now();const r=await bg.call('delegate',{n:-1}).then(v=>({ok:true,v,ms:Date.now()-t0}),e=>({ok:false,e,ms:Date.now()-t0}));
  stop=true;await Promise.all(pumpers);const m=s.metrics();await fg.close();await bg.close();await s.close();
  return {r,m};
}
test('v04 SCHED-02: background job is served under sustained interactive load (aging)', async()=>{
  const {r,m}=await run({agingMs:200});
  assert.ok(r.ok,'background job starved: '+(r.e?.name||'')+' after '+r.ms+' ms');
  assert.ok(r.ms<1000,'served after '+r.ms+' ms');assert.ok(m.aged>=1,'aging not recorded');
});
