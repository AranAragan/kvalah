// v0.4 COMPUTE-03: end-to-end cancel. A real HTTP model server (mock of Ollama's streaming /api/chat) records
// whether the generation connection was closed by the client and whether it went on generating afterwards.
// Covers: in-process engine, Compute Service (running and queued jobs, de-duplicated subscribers), batch,
// LAN node (distributed), and an MCP client over real stdio. Whether a REAL Ollama/llama.cpp frees the GPU when
// the HTTP stream is closed cannot be measured here (no GPU) — see V04-REPORT (NOT RUN).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createKvalahOffload} from '../compute/index.mjs';
import {startService,connectService} from '../compute/service.mjs';
import {mockOllama} from './mock-ollama.mjs';
import {workspace,sleep} from './helpers.mjs';

const until=async(f,ms=3000)=>{const t=Date.now();while(!f()){if(Date.now()-t>ms)return false;await sleep(10);}return true;};
const task=i=>({kind:'summarize',instruction:'sum '+i,context:'text number '+i});
async function env(o,extra={}){const root=await workspace({'a.txt':'x\n'});return {KVALAH_MODEL:'m',KVALAH_LOCAL_URL:o.url,KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',KVALAH_MAX_PARALLEL:'1',KVALAH_DATA_DIR:await mkdtemp(path.join(tmpdir(),'kv4c-')),...extra};}
function assertStopped(st,label){assert.equal(st.active,0,label+': generation still running');assert.equal(st.completed,0,label+': generation ran to completion');}

test('v04 COMPUTE-03: in-process engine — abort closes the model stream and generation stops', async()=>{
  const o=await mockOllama({tokens:100,tokenMs:20});const app=await createKvalahOffload({env:await env(o)});
  try{
    const ac=new AbortController();const p=app.engine.delegate(task(1),{signal:ac.signal});p.catch(()=>{});
    assert.ok(await until(()=>o.st.active===1));await sleep(60);ac.abort();
    await assert.rejects(p);assert.ok(await until(()=>o.st.active===0,1000),'stream not closed within 1 s');
    assertStopped(o.st,'engine');assert.equal(o.st.aborted,1);
  }finally{await app.close();await o.stop();}
});

test('v04 COMPUTE-03: Compute Service — cancel of a running job, of a queued job, and of one of two subscribers', async()=>{
  const o=await mockOllama({tokens:100,tokenMs:20});const e=await env(o);const app=await createKvalahOffload({env:e});
  const dir=e.KVALAH_DATA_DIR;const svc=await startService({app,socketPath:path.join(dir,'s.sock'),tokenFile:path.join(dir,'t')});
  const c1=await connectService({socketPath:path.join(dir,'s.sock'),tokenFile:path.join(dir,'t'),workspace:e.KVALAH_WORKSPACE});
  const c2=await connectService({socketPath:path.join(dir,'s.sock'),tokenFile:path.join(dir,'t'),workspace:e.KVALAH_WORKSPACE,client:'gui'});
  try{
    // running + queued (maxParallel 1): cancel both, the queued one must never reach the model
    const a1=new AbortController(),a2=new AbortController();
    const p1=c1.call('delegate',task(1),{signal:a1.signal});p1.catch(()=>{});const p2=c1.call('delegate',task(2),{signal:a2.signal});p2.catch(()=>{});
    assert.ok(await until(()=>o.st.active===1));await sleep(50);a2.abort();a1.abort();
    await assert.rejects(p1);await assert.rejects(p2);assert.ok(await until(()=>o.st.active===0,1000));
    await sleep(200);assertStopped(o.st,'service');assert.equal(o.st.chats,1,'queued job reached the model after cancel');assert.equal(o.st.aborted,1);
    // identical request from two clients: one cancels → the other still gets the result (generation continues)
    o.srv.tokens=15;const b1=new AbortController();
    const q1=c1.call('delegate',task(3),{signal:b1.signal});q1.catch(()=>{});const q2=c2.call('delegate',task(3));
    assert.ok(await until(()=>o.st.chats===2));await sleep(40);b1.abort();await assert.rejects(q1);
    const got=await q2;assert.equal(typeof got,'object');assert.equal(o.st.chats,2,'deduplicated: one generation');assert.equal(o.st.aborted,1,'kept running for the remaining subscriber');assert.equal(o.st.completed,1);
    // both subscribers cancel → stopped
    o.srv.tokens=100;const d1=new AbortController(),d2=new AbortController();
    const r1=c1.call('delegate',task(4),{signal:d1.signal});r1.catch(()=>{});const r2=c2.call('delegate',task(4),{signal:d2.signal});r2.catch(()=>{});
    assert.ok(await until(()=>o.st.chats===3));await sleep(40);d1.abort();d2.abort();await assert.rejects(r1);await assert.rejects(r2);
    assert.ok(await until(()=>o.st.active===0,1000));assert.equal(o.st.aborted,2);assert.equal(o.st.completed,1);
    const m=await c1.call('metrics');assert.ok(m.service.cancelled>=3,JSON.stringify(m.service));
  }finally{await c1.close();await c2.close();await svc.close();await app.close();await o.stop();}
});

test('v04 COMPUTE-03: batch — abort stops the running part and no further part starts', async()=>{
  const o=await mockOllama({tokens:100,tokenMs:20});const app=await createKvalahOffload({env:await env(o)});
  try{
    const ac=new AbortController();const p=app.engine.batch({tasks:[task(1),task(2),task(3),task(4)]},{signal:ac.signal});p.catch(()=>{});
    assert.ok(await until(()=>o.st.active===1));await sleep(60);ac.abort();
    await p.catch(()=>{});assert.ok(await until(()=>o.st.active===0,1000));await sleep(300);
    assertStopped(o.st,'batch');assert.equal(o.st.chats,1,'more batch parts started after abort');
  }finally{await app.close();await o.stop();}
});

test('v04 COMPUTE-03: distributed — abort reaches the LAN node (paired kvalah peer /peer/llm)', async()=>{
  const peer=await mockOllama({tokens:100,tokenMs:20,prefix:'/peer/llm',token:'s3cret'});
  const e=await env({url:'http://127.0.0.1:9'},{KVALAH_LAN:'1',KVALAH_LAN_ALLOW:'gpu-box',KVALAH_LAN_ALLOW_PLAINTEXT:'1'});
  await writeFile(path.join(e.KVALAH_DATA_DIR,'devices.json'),JSON.stringify({id:'self-1',nodes:[{id:'peer-0000001',name:'gpu-box',kind:'kvalah',url:peer.url,token:'s3cret',enabled:true,tasks:true,maxParallel:1}]}));
  const app=await createKvalahOffload({env:e});
  try{
    const ac=new AbortController();const p=app.engine.delegate(task(1),{signal:ac.signal});p.catch(()=>{});
    assert.ok(await until(()=>peer.st.active===1),'job did not reach the LAN node');await sleep(60);ac.abort();
    await assert.rejects(p);assert.ok(await until(()=>peer.st.active===0,1000));assertStopped(peer.st,'lan');assert.equal(peer.st.aborted,1);
  }finally{await app.close();await peer.stop();}
});

test('v04 COMPUTE-03: MCP client cancellation over real stdio (+ elected service) closes the model stream', async()=>{
  const o=await mockOllama({tokens:150,tokenMs:20});const e=await env(o,{KVALAH_SERVICE:'auto'});
  const server=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','mcp','server.mjs');
  const c=new Client({name:'t',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[server],env:{...process.env,...e},stderr:'pipe'}));
  try{
    const ac=new AbortController();const p=c.callTool({name:'kvalah_delegate',arguments:task(1)},undefined,{signal:ac.signal,timeout:60000});p.catch(()=>{});
    assert.ok(await until(()=>o.st.active===1,5000));await sleep(60);ac.abort();
    await assert.rejects(p);assert.ok(await until(()=>o.st.active===0,1500),'MCP cancel did not close the model stream');assertStopped(o.st,'mcp');
  }finally{await c.close();await o.stop();}
});
