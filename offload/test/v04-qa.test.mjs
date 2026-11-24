// v0.4 QA (the parts that can run here, all on real processes/sockets/HTTP; no GPU, one OS, one machine):
//  - load test of the Compute Service (many clients, many calls, device capacity never exceeded, nothing left pending)
//  - recovery after the Ollama server goes away and comes back (real HTTP mock of Ollama, same port)
//  - end-to-end secret sweep over every output channel of one task: IPC result, dashboard /api/state, disk cache, logs
// Real-GPU cancel, several models, multi-machine, Win/macOS, live agents and ≥50 paired runs are NOT RUN (V04-REPORT).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,readdir,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createKvalahOffload} from '../compute/index.mjs';
import {startService,connectService} from '../compute/service.mjs';
import {mockOllama} from './mock-ollama.mjs';
import {smartMock,workspace,sleep} from './helpers.mjs';

const tmp=p=>mkdtemp(path.join(tmpdir(),p));

test('v04 QA: Compute Service load — 12 clients × 20 calls answered; a 12 × 40 burst is shed with ServiceOverloadError (maxPendingTotal 256) while capacity 2 is never exceeded', async()=>{
  const root=await workspace({'a.txt':'x\n'});const dir=await tmp('kv4q-');
  let active=0,peak=0;const base=smartMock({delay:4});const chat=base.chat;
  base.chat=async function*(r){active++;peak=Math.max(peak,active);try{yield* chat.call(base,r);}finally{active--;}};
  const app=await createKvalahOffload({env:{KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',KVALAH_MAX_PARALLEL:'2'},provider:base});
  const sp=path.join(dir,'s.sock'),tf=path.join(dir,'t');
  const svc=await startService({app,socketPath:sp,tokenFile:tf,maxQueue:400,maxQueuePerClient:40});
  const clients=await Promise.all(Array.from({length:12},(_,i)=>connectService({socketPath:sp,tokenFile:tf,client:'agent-'+i,workspace:root,priority:i%3?'interactive':'background'})));
  const t0=Date.now();
  try{
    const wave=(n,tag)=>Promise.all(clients.flatMap((c,i)=>Array.from({length:n},(_,j)=>c.call('delegate',{kind:'summarize',instruction:tag+' '+i+'-'+j,context:'text '+tag+i+' '+j}).then(()=>'ok',e=>e.name))));
    const res=await wave(20,'a');const ms=Date.now()-t0;let m=svc.metrics();
    const bad=res.filter(r=>r!=='ok');
    console.log(`[QA load] ${res.length} calls in ${ms} ms, peak model concurrency ${peak}, failed ${bad.length}, wait p50/p95 ${m.waitMs?.p50}/${m.waitMs?.p95} ms`);
    assert.deepEqual(bad,[]);assert.ok(peak<=2,'capacity exceeded: '+peak);
    const burst=await wave(40,'b');const shed=burst.filter(r=>r==='ServiceOverloadError').length,ok=burst.filter(r=>r==='ok').length;m=svc.metrics();
    console.log(`[QA burst] ${burst.length} calls: ${ok} ok, ${shed} shed (ServiceOverloadError), other ${burst.length-ok-shed}, peak ${peak}`);
    assert.equal(ok+shed,burst.length);assert.ok(shed>0&&ok>=256,'expected backpressure, got ok='+ok+' shed='+shed);assert.ok(peak<=2);
    assert.equal(m.queued,0);assert.equal(m.pendingTotal,0);assert.equal(app.engine.metrics().pendingCalls,0);
  }finally{await Promise.all(clients.map(c=>c.close()));await svc.close();await app.close();}
});

test('v04 QA: Ollama goes away mid-session and comes back — fast failure, health offline, then normal service again', async()=>{
  let o=await mockOllama({tokens:3,tokenMs:2});const root=await workspace({'a.txt':'x\n'});
  const app=await createKvalahOffload({env:{KVALAH_MODEL:'m',KVALAH_LOCAL_URL:o.url,KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',KVALAH_TIMEOUT_MS:'5000'}});
  const task=i=>({kind:'summarize',instruction:'sum '+i,context:'text '+i});
  try{
    await app.engine.delegate(task(1));
    await o.stop();
    const t0=Date.now();await assert.rejects(app.engine.delegate(task(2)));const failMs=Date.now()-t0;
    assert.ok(failMs<5000,'failure took '+failMs+' ms');
    const s=await app.auto({goal:'Summarize the failures in this CI log',context:'x '.repeat(5000)});assert.equal(s.level,3,'router must decline while offline');
    o=await o.restart();await sleep(10100);   // health is cached for 10 s
    const r=await app.engine.delegate(task(3));assert.ok(r);assert.equal(o.st.completed,1);
    assert.equal(app.engine.metrics().pendingCalls,0);
  }finally{await app.close();await o.stop().catch(()=>{});}
});

test('v04 QA: one secret-bearing task, every output channel checked (IPC result, dashboard, disk cache, logs)', async()=>{
  const SECRET='ghp_'+'Zq8xR2vL0mN4bT6yW1cK9pD3sF7hJ5gA2eU0';
  const root=await workspace({'conf.log':'INFO start\nERROR auth failed token='+SECRET+'\nINFO done\n'});
  const echo={kind:'mock',base:'echo',health:async()=>({online:true}),
    async *chat(r){const u=r.messages.map(m=>m.content).join('\n');yield {type:'content',text:JSON.stringify({summary:'echo: '+u.slice(-600),draft:'',findings:[],uncertainty:''})};yield {type:'done',reason:'stop',stats:{tokens:10,promptTokens:50}};}};
  const logs=[];const dir=await tmp('kv4qs-');const cacheDir=path.join(dir,'cache');
  const app=await createKvalahOffload({env:{KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'on',KVALAH_CACHE_DIR:cacheDir,KVALAH_CACHE_SENSITIVE:'1',KVALAH_DASHBOARD:'1',KVALAH_DATA_DIR:dir},provider:echo,log:l=>logs.push(String(l))});
  const sp=path.join(dir,'s.sock'),tf=path.join(dir,'t');const svc=await startService({app,socketPath:sp,tokenFile:tf,log:l=>logs.push(String(l))});
  const c=await connectService({socketPath:sp,tokenFile:tf,client:'qa',workspace:root});
  try{
    const r=await c.call('delegate',{kind:'logs',instruction:'what failed? quote the token',paths:['conf.log']});
    const st=await new Promise((res,rej)=>http.get(`http://127.0.0.1:${app.dashboard.port}/api/state?t=${app.dashboard.token}`,x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>res(b));}).on('error',rej));
    const files=[];const walk=async d=>{for(const e of await readdir(d,{withFileTypes:true}).catch(()=>[])){const p=path.join(d,e.name);if(e.isDirectory())await walk(p);else files.push(p);}};await walk(cacheDir);
    const disk=(await Promise.all(files.map(f=>readFile(f,'utf8')))).join('\n');
    const channels={ipc:JSON.stringify(r),dashboard:st,cache:disk,logs:logs.join('\n'),metrics:JSON.stringify(await c.call('metrics',{}))};
    assert.ok(files.length>0,'nothing cached — cache channel not exercised');
    for(const [k,v] of Object.entries(channels))assert.ok(!v.includes(SECRET),'secret leaked via '+k);
    assert.ok(!channels.ipc.includes('Zq8xR2vL0mN4'),'partial secret in IPC result');
  }finally{await c.close();await svc.close();await app.close();}
});
