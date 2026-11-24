// RUN-02 regression: one shared compute service for the GUI and several MCP clients.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,stat,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createKvalahOffload} from '../compute/index.mjs';
import {buildServer} from '../mcp/server.mjs';
import {smartMock,workspace,sleep} from './helpers.mjs';

const posix=process.platform!=='win32';
// mock provider that records peak concurrency of model calls (the "GPU")
function gpu({delay=60}={}){
  const base=smartMock({delay,reply:({req})=>'ok '+req.messages[1].content.length});const g={active:0,peak:0,calls:0,aborted:0};
  const chat=base.chat;
  base.chat=async function*(req){g.active++;g.calls++;g.peak=Math.max(g.peak,g.active);req.signal?.addEventListener('abort',()=>g.aborted++,{once:true});try{yield* chat.call(base,req);}finally{g.active--;}};
  return {provider:base,g};
}
async function setup({maxActive=null,maxQueuePerClient=16,maxQueue=64,delay=60,files={'a.js':'export function hello(){}\n'}}={}){
  const {startService}=await import('../compute/service.mjs');
  const root=await workspace(files);const dir=await mkdtemp(path.join(tmpdir(),'kvs-'));
  const {provider,g}=gpu({delay});
  const env={KVALAH_MODEL:'mock',KVALAH_CACHE:'off',KVALAH_WORKSPACE:root,KVALAH_MAX_PARALLEL:'1',KVALAH_DATA_DIR:dir};
  const app=await createKvalahOffload({env,provider});
  const socketPath=posix?path.join(dir,'s.sock'):`\\\\.\\pipe\\kvs-${path.basename(dir)}`;const tokenFile=path.join(dir,'token');
  const svc=await startService({app,socketPath,tokenFile,maxActive,maxQueue,maxQueuePerClient,queueTimeoutMs:30000});
  const svcEnv={...env,KVALAH_SERVICE_SOCKET:socketPath,KVALAH_SERVICE_TOKEN_FILE:tokenFile};
  return {root,dir,app,svc,g,socketPath,tokenFile,env,svcEnv,async close(){await svc.close();await app.close();}};
}
async function mcpClient(env,provider=smartMock()){
  const {server,app,configError}=await buildServer({env,provider,log:()=>{}});
  const [a,b]=InMemoryTransport.createLinkedPair();const c=new Client({name:'t',version:'1'});
  await Promise.all([server.connect(a),c.connect(b)]);
  const call=async(name,args)=>{const r=await c.callTool({name,arguments:args});if(r.isError)throw Error(r.content[0].text);return r.structuredContent;};
  return {c,app,configError,call,close:async()=>{await c.close();await app?.close();}};
}
const delegate=i=>({kind:'summarize',instruction:'Summarize item '+i,context:'line '+i+'\n'.repeat(1+i)});

test('RUN-02 repro: two independent engines (v0.2 overlay/standalone per MCP process) exceed the device capacity', async()=>{
  const {provider,g}=gpu();
  const env={KVALAH_MODEL:'mock',KVALAH_CACHE:'off',KVALAH_MAX_PARALLEL:'1'};
  const a=await createKvalahOffload({env,provider}),b=await createKvalahOffload({env,provider});
  await Promise.all([a.engine.delegate(delegate(1)),b.engine.delegate(delegate(2))]);
  assert.equal(g.peak,2,'each process has its own scheduler: capacity 1 is exceeded');
  await a.close();await b.close();
});

test('RUN-02: GUI + two MCP clients share one queue and never exceed GPU capacity', async()=>{
  const s=await setup();const {connectService}=await import('../compute/service.mjs');
  const m1=await mcpClient({...s.svcEnv,KVALAH_SERVICE:'required'}),m2=await mcpClient({...s.svcEnv,KVALAH_SERVICE:'required'});
  const gui=await connectService({socketPath:s.socketPath,tokenFile:s.tokenFile,workspace:s.root,client:'gui',priority:'interactive'});
  try{
    assert.equal(m1.app.remote,true);assert.equal(m1.app.mode,'service');
    const rs=await Promise.all([...[1,2,3].map(i=>m1.call('kvalah_delegate',delegate(i))),...[4,5,6].map(i=>m2.call('kvalah_delegate',delegate(i))),gui.call('delegate',delegate(7)),gui.call('compute',{op:'symbols',name:'hello'})]);
    assert.equal(s.g.peak,1,'shared capacity: peak concurrency '+s.g.peak);
    assert.equal(rs.length,8);assert.ok(rs.slice(0,7).every(r=>r.answer||r.output||r.summary!==undefined));
    const st=await gui.call('state');assert.equal(st.service.connections,3);assert.equal(st.service.active.llm,0);
    const mm=await m1.call('kvalah_metrics',{});assert.ok(mm.service.completed>=8);assert.equal(mm.client.mode,'service');
  }finally{await gui.close();await m1.close();await m2.close();await s.close();}
});

test('RUN-02: authentication, workspace binding and file permissions', async()=>{
  const s=await setup();const {connectService}=await import('../compute/service.mjs');
  try{
    await assert.rejects(connectService({socketPath:s.socketPath,token:'0'.repeat(64),workspace:s.root}),/authentication failed/);
    const other=await workspace({'x.js':'1'});
    await assert.rejects(connectService({socketPath:s.socketPath,tokenFile:s.tokenFile,workspace:other}),/workspace mismatch/);
    await assert.rejects(connectService({socketPath:s.socketPath,tokenFile:s.tokenFile,workspace:null}),/workspace mismatch/);
    if(posix){
      assert.equal((await stat(s.tokenFile)).mode&0o777,0o600);assert.equal((await stat(s.socketPath)).mode&0o077,0);
      const net=await import('node:net');                                        // silent client is dropped
      const sock=net.connect(s.socketPath);await new Promise(r=>sock.once('connect',r));
      sock.write('{"type":"call","id":1,"method":"status"}\n');
      const got=await new Promise(r=>{let d='';sock.on('data',x=>d+=x);sock.on('close',()=>r(d));});
      assert.match(got,/authentication failed/);assert.doesNotMatch(got,/"type":"result"/);
    }
    assert.ok(s.svc.metrics().authFailures>=2);
    // the MCP client in 'required' mode fails closed when the token is wrong
    const bad=path.join(s.dir,'bad');await writeFile(bad,'x'.repeat(64),{mode:0o600});
    const m=await mcpClient({...s.svcEnv,KVALAH_SERVICE:'required',KVALAH_SERVICE_TOKEN_FILE:bad});
    assert.match(m.configError,/authentication failed/);await m.close();
  }finally{await s.close();}
});

test('RUN-02: fair scheduling — an interactive client is not starved by a background batch', async()=>{
  const s=await setup({delay:40});const {connectService}=await import('../compute/service.mjs');
  const bg=await connectService({socketPath:s.socketPath,tokenFile:s.tokenFile,workspace:s.root,client:'bulk',priority:'background'});
  const ui=await connectService({socketPath:s.socketPath,tokenFile:s.tokenFile,workspace:s.root,client:'gui',priority:'interactive'});
  try{
    const order=[];
    const bulk=[1,2,3,4,5,6,7,8].map(i=>bg.call('delegate',delegate(i)).then(()=>order.push('bg'+i)));
    await sleep(10);
    const mine=ui.call('delegate',delegate(99)).then(()=>order.push('ui'));
    await Promise.all([...bulk,mine]);
    assert.ok(order.indexOf('ui')<=2,'interactive job should run right after the running one: '+order.join(','));
    assert.equal(s.g.peak,1);
  }finally{await bg.close();await ui.close();await s.close();}
});

test('RUN-02: backpressure — per-client and global queue limits reject instead of growing', async()=>{
  const s=await setup({maxQueuePerClient:2,maxQueue:3,delay:80});const {connectService}=await import('../compute/service.mjs');
  const a=await connectService({socketPath:s.socketPath,tokenFile:s.tokenFile,workspace:s.root,client:'a'});
  const b=await connectService({socketPath:s.socketPath,tokenFile:s.tokenFile,workspace:s.root,client:'b'});
  try{
    const ra=await Promise.allSettled([1,2,3,4,5].map(i=>a.call('delegate',delegate(i))));
    const rejA=ra.filter(r=>r.status==='rejected');
    assert.ok(rejA.length>=2&&rejA.every(r=>r.reason.name==='ServiceOverloadError'),JSON.stringify(ra.map(r=>r.status)));
    assert.ok(ra.filter(r=>r.status==='fulfilled').length>=2);
    assert.ok(s.svc.metrics().rejected>=2);assert.equal(s.svc.metrics().queued,0);
    const rb=await b.call('delegate',delegate(10));assert.ok(rb);   // another client is still served
  }finally{await a.close();await b.close();await s.close();}
});

test('RUN-02: identical requests from two clients run once (dedupe with subscriber counting)', async()=>{
  const s=await setup({delay:80});const {connectService}=await import('../compute/service.mjs');
  const a=await connectService({socketPath:s.socketPath,tokenFile:s.tokenFile,workspace:s.root,client:'a'});
  const b=await connectService({socketPath:s.socketPath,tokenFile:s.tokenFile,workspace:s.root,client:'b'});
  try{
    const ctrl=new AbortController();
    const pa=a.call('delegate',delegate(5),{signal:ctrl.signal}),pb=b.call('delegate',delegate(5));
    await sleep(20);ctrl.abort();                               // one subscriber leaves, the other still gets the result
    await assert.rejects(pa,/abort/i);const r=await pb;assert.ok(r);
    assert.equal(s.g.calls,1);assert.equal(s.g.aborted,0);assert.equal(s.svc.metrics().deduped,1);
  }finally{await a.close();await b.close();await s.close();}
});

test('RUN-02: cancel (explicit, queued, on disconnect) stops the work and frees all slots', async()=>{
  const s=await setup({delay:300});const {connectService}=await import('../compute/service.mjs');
  const a=await connectService({socketPath:s.socketPath,tokenFile:s.tokenFile,workspace:s.root,client:'a'});
  try{
    const c1=new AbortController(),c2=new AbortController();
    const running=a.call('delegate',delegate(1),{signal:c1.signal});const waiting=a.call('delegate',delegate(2),{signal:c2.signal});
    await sleep(50);c2.abort();c1.abort();
    await assert.rejects(running,/abort/i);await assert.rejects(waiting,/abort/i);
    await sleep(50);
    assert.equal(s.g.aborted,1,'running model call must receive the abort');assert.equal(s.g.calls,1,'queued job must never start');
    let m=s.svc.metrics();assert.equal(m.active.llm,0);assert.equal(m.queued,0);
    assert.equal(s.app.engine.metrics().inflight??0,0);
    // disconnect cancels everything the client had in flight
    const b=await connectService({socketPath:s.socketPath,tokenFile:s.tokenFile,workspace:s.root,client:'b'});
    const lost=b.call('delegate',delegate(3)).catch(e=>e);await sleep(50);await b.close();
    assert.equal((await lost).name,'ServiceUnavailableError');await sleep(50);
    assert.equal(s.g.aborted,2);m=s.svc.metrics();assert.equal(m.active.llm,0);assert.equal(m.queued,0);
  }finally{await a.close();await s.close();}
});

test('RUN-02: graceful shutdown, failover of an MCP client to the in-process engine, and restart', async()=>{
  const s=await setup({delay:100});const {startService,connectService}=await import('../compute/service.mjs');
  // v0.4 COMPUTE-01 contract change: KVALAH_SERVICE=auto now elects a host instead of falling back to a private
  // engine (see v04-compute01-election.test.mjs); the v0.3 behaviour tested here is kept as KVALAH_SERVICE=connect.
  const m=await mcpClient({...s.svcEnv,KVALAH_SERVICE:'connect'});
  try{
    assert.equal(m.app.mode,'service');
    const inflight=m.call('kvalah_delegate',delegate(1));await sleep(20);
    await s.svc.close({grace:2000});                            // finishes running work, then stops
    assert.ok(await inflight);
    if(posix)await assert.rejects(access(s.socketPath));await assert.rejects(access(s.tokenFile));
    const r=await m.call('kvalah_compute',{op:'symbols',name:'hello'});   // service gone → local fallback
    assert.ok(r.symbols?.length||r.matches?.length||r.results?.length);assert.equal(m.app.mode,'local-fallback');
    // restart on the same path: new token, new clients connect
    const svc2=await startService({app:s.app,socketPath:s.socketPath,tokenFile:s.tokenFile});
    const c=await connectService({socketPath:s.socketPath,tokenFile:s.tokenFile,workspace:s.root});
    assert.ok((await c.call('status')).service);await c.close();await svc2.close();
  }finally{await m.close();await s.app.close();}
});

test('RUN-02: stale socket of a crashed service is replaced; a live one is not', {skip:!posix&&'Unix sockets only'}, async()=>{
  const {startService}=await import('../compute/service.mjs');
  const dir=await mkdtemp(path.join(tmpdir(),'kvs-'));const sock=path.join(dir,'s.sock');
  const child=spawn(process.execPath,['-e',`require('net').createServer().listen(${JSON.stringify(sock)},()=>console.log('up'))`]);
  await new Promise(r=>child.stdout.once('data',r));
  const app={cfg:{model:'m',maxParallel:1,workspace:null},engine:{metrics:()=>({})},status:async()=>({})};
  await assert.rejects(startService({app,socketPath:sock,tokenFile:path.join(dir,'t')}),/already running/);
  child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));
  const svc=await startService({app,socketPath:sock,tokenFile:path.join(dir,'t')});await svc.close();
  await writeFile(sock,'not a socket');
  await assert.rejects(startService({app,socketPath:sock,tokenFile:path.join(dir,'t')}),/non-socket/);
});
