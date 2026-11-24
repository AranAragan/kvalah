// v0.4 SCHED-01: the device choice must follow measured device performance (generation speed, first-token latency),
// not the raw duration of whatever job a device happened to run last. v0.3 scored devices by an EWMA of job wall
// time (mixed with probe latency), so a slow device that just finished a SMALL job looked faster than a fast
// device that finished a BIG one, and the next big job went to the slow device.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createKvalahOffload} from '../compute/index.mjs';
import {mockOllama} from './mock-ollama.mjs';
import {workspace,sleep} from './helpers.mjs';

const until=async(f,ms=5000)=>{const t=Date.now();while(!f()){if(Date.now()-t>ms)return false;await sleep(5);}return true;};
const tokensFor=b=>b.includes('BIGJOB')?60:3;

async function setup(extra={}){
  const local=await mockOllama({tokenMs:2,tokensFor});                                                   // fast GPU
  const peer=await mockOllama({tokenMs:20,tokensFor,prefix:'/peer/llm',token:'s3cret'});                // slow box
  const root=await workspace({'a.txt':'x\n'});
  const e={KVALAH_MODEL:'m',KVALAH_LOCAL_URL:local.url,KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',KVALAH_MAX_PARALLEL:'1',
    KVALAH_DATA_DIR:await mkdtemp(path.join(tmpdir(),'kv4s-')),KVALAH_LAN:'1',KVALAH_LAN_ALLOW:'slow-box',KVALAH_LAN_ALLOW_PLAINTEXT:'1',...extra};
  await writeFile(path.join(e.KVALAH_DATA_DIR,'devices.json'),JSON.stringify({id:'self-1',nodes:[{id:'peer-0000001',name:'slow-box',kind:'kvalah',url:peer.url,token:'s3cret',enabled:true,tasks:true,maxParallel:1}]}));
  const app=await createKvalahOffload({env:e});
  return {local,peer,app,async close(){await app.close();await local.stop();await peer.stop();}};
}
const job=(i,big)=>({kind:'summarize',instruction:'sum '+i,context:(big?'BIGJOB ':'small ')+'text '+i});

test('v04 SCHED-01: a big job goes to the device with the higher measured generation speed', async()=>{
  const s=await setup();
  try{
    // small job lands on the peer (it has a probe latency, the unmeasured local backend scores a default 1000 ms) …
    const a=s.app.engine.delegate(job(1,false));assert.ok(await until(()=>s.peer.st.active===1),'small job did not go to the peer');
    // … while the peer is busy, the big job runs on the fast local GPU
    const b=s.app.engine.delegate(job(2,true));await Promise.all([a,b]);
    assert.equal(s.local.st.completed,1);assert.equal(s.peer.st.completed,1);
    // next big job: local generated 60 tokens at ~2 ms/token, the peer 3 tokens at ~20 ms/token
    await s.app.engine.delegate(job(3,true));
    assert.equal(s.local.st.completed,2,'big job was sent to the slow device (scored by last job wall time)');
    const perf=s.app.engine.metrics().devicePerf;assert.ok(perf,'no device performance in metrics');
    const L=perf.find(d=>d.id==='local'),P=perf.find(d=>d.id==='peer-0000001');
    assert.ok(Number.isFinite(L.context),'local context unknown');assert.ok(L.genTokensPerSec>P.genTokensPerSec*3,`local ${L.genTokensPerSec} tok/s vs peer ${P.genTokensPerSec}`);
    for(const d of [L,P]){assert.ok(d.samples>=1);assert.ok(Number.isFinite(d.ttftMs));assert.ok('context' in d);assert.ok(Number.isFinite(d.plannedContext));assert.ok('load' in d&&'vramFreeBytes' in d&&'vramSource' in d);}
  }finally{await s.close();}
});

test('v04 SCHED-01: KVALAH_SCHED_PERF=0 keeps the v0.3 scoring', async()=>{
  const s=await setup({KVALAH_SCHED_PERF:'0'});
  try{
    const a=s.app.engine.delegate(job(1,false));assert.ok(await until(()=>s.peer.st.active===1));
    const b=s.app.engine.delegate(job(2,true));await Promise.all([a,b]);
    await s.app.engine.delegate(job(3,true));
    assert.equal(s.peer.st.completed,2,'legacy scoring expected (documents the v0.3 behaviour)');
  }finally{await s.close();}
});

test('v04 SCHED-01: perf model — tokens/s after the first token, TTFT, reference-job estimate; unmeasured → null', async()=>{
  const {createPerfModel}=await import('../compute/perf.mjs');
  const p=createPerfModel({refPromptTokens:1000,refOutputTokens:200});
  assert.equal(p.refMs('x'),null);
  p.observe('x',{ms:1100,ttftMs:100,promptTokens:500,outputTokens:101});      // 10 ms/token, 0.2 ms/prompt token
  const v=p.view('x');assert.equal(v.genTokensPerSec,100);assert.equal(v.promptTokensPerSec,5000);assert.equal(v.ttftMs,100);
  assert.equal(p.refMs('x'),Math.round(0.2*1000+10*200));
});

test('v04 SCHED-01: perf model — tokens/s after the first token, TTFT, reference-job estimate; unmeasured → null', async()=>{
  const {createPerfModel}=await import('../compute/perf.mjs');
  const p=createPerfModel({refPromptTokens:1000,refOutputTokens:200});
  assert.equal(p.refMs('x'),null);
  p.observe('x',{ms:1100,ttftMs:100,promptTokens:500,outputTokens:101});      // 10 ms/token, 0.2 ms/prompt token
  const v=p.view('x');assert.equal(v.genTokensPerSec,100);assert.equal(v.promptTokensPerSec,5000);assert.equal(v.ttftMs,100);
  assert.equal(p.refMs('x'),Math.round(0.2*1000+10*200));
});
