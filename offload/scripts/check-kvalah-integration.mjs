#!/usr/bin/env node
// v0.4 COMPUTE-02 / UI-01: cross-repo check of the kvalah desktop integration patch (docs/kvalah-integration.patch)
// against the REAL Compute Service of this package. Usage: node scripts/check-kvalah-integration.mjs <patched-kvalah-checkout>
// Runs: real service + real kvalah server.mjs (headless, the same process Electron starts) + scripted model servers.
// It does NOT run the Electron window (no display here); the dashboard tab is checked through /api/compute.
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createKvalahOffload} from '../compute/index.mjs';
import {startService,connectService,servicePaths} from '../compute/service.mjs';
import {mockOllama} from '../test/mock-ollama.mjs';

const K=path.resolve(process.argv[2]||'');
const link=await import(pathToFileURL(path.join(K,'compute-link.mjs')).href);
const kh=await import(pathToFileURL(path.join(K,'test','helpers.mjs')).href);
const step=(s)=>console.log('✔ '+s);
const root=await realpath(await mkdtemp(path.join(tmpdir(),'kvint-')));const data=path.join(root,'data'),ws=path.join(root,'ws');await mkdir(data);await mkdir(ws);
const ours=servicePaths({},data),theirs=link.computeServicePaths(data,{});
assert.deepEqual(theirs,ours);step('socket/token paths agree: '+ours.socket);
const o=await mockOllama({tokens:20,tokenMs:15});
const app=await createKvalahOffload({env:{KVALAH_MODEL:'m',KVALAH_LOCAL_URL:o.url,KVALAH_WORKSPACE:ws,KVALAH_CACHE:'off',KVALAH_MAX_PARALLEL:'1',KVALAH_DATA_DIR:data}});
const svc=await startService({app,socketPath:ours.socket,tokenFile:ours.tokenFile});
const mcp=await connectService({socketPath:ours.socket,tokenFile:ours.tokenFile,workspace:ws});
const gui=link.createComputeLink({dataDir:data});
let model,k;
try{
  const release=await gui.lease({label:'chat'});
  let m=await mcp.call('metrics');assert.equal(m.service.leases.active,1);assert.equal(m.service.clients.find(c=>c.client==='kvalah-gui')?.scope,'device');step('kvalah link leased the only model slot (device scope)');
  let done=false;const d=mcp.call('delegate',{kind:'summarize',instruction:'s',context:'abc'}).then(()=>done=true);
  await new Promise(r=>setTimeout(r,200));assert.equal(done,false);assert.equal(o.st.chats,0);step('MCP delegation queued behind the kvalah generation');
  release();await d;assert.equal(o.st.chats,1);step('after release the delegation ran');
  const snap=await gui.snapshot();assert.equal(snap.connected,true);assert.ok(snap.metrics.service.clients.length>=2);assert.equal(snap.metrics.savings.kind,'estimated');
  step('dashboard snapshot: clients='+snap.metrics.service.clients.map(c=>c.client).join(',')+' queue='+snap.metrics.service.queued+' savings.kind='+snap.metrics.savings.kind);
  gui.close();
  // the real kvalah server.mjs (what Electron runs) against the real service
  model=await kh.mockModel(async()=>({content:'hello from kvalah'}));
  k=await kh.startApp({modelUrl:model.url,data,workspace:ws});
  const before=(await mcp.call('metrics')).service.leases.granted;
  const chat=(await k.api('/api/chats',{})).body;
  const ev=await k.turn({chatId:chat.id,text:'hi',model:'mock:latest',agent:false});assert.ok(ev.find(e=>e.type==='done'));
  m=await mcp.call('metrics');assert.ok(m.service.leases.granted>before,'kvalah chat leased a slot');assert.equal(m.service.leases.active,0,'and released it');
  step('kvalah server.mjs chat took and released a shared slot (granted '+before+' → '+m.service.leases.granted+')');
  const dash=(await k.api('/api/compute')).body;assert.equal(dash.connected,true);assert.ok(dash.metrics.service.clients.some(c=>c.client==='kvalah-gui'));
  step('GET /api/compute (Compute tab data) served by kvalah: connected, '+dash.metrics.service.clients.length+' clients');
  console.log('ALL CHECKS PASSED (Electron window itself not started: no display in this environment)');
}finally{await k?.stop();await model?.close();await mcp.close();await svc.close();await app.close();await o.stop();}
