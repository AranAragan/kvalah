// v0.4 SEC-01: no raw data past the nesting limit; every output channel (MCP, IPC, cache, dashboard, logs) is filtered.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createPolicy} from '../compute/policy.mjs';
import {createCache} from '../compute/cache.mjs';
import {startDashboard} from '../compute/dashboard.mjs';
import {buildServer} from '../mcp/server.mjs';
import {smartMock,workspace} from './helpers.mjs';

const SECRET='ghp_'+'Zq8xR2vL0mN4bT6yW1cK9pD3sF7hJ5gA2eU0';
const deep=(n,leaf={token:SECRET,note:'Authorization: Bearer '+SECRET})=>{let v=leaf;for(let i=0;i<n;i++)v={level:i,child:v,list:[v]};return v;};
const deepNarrow=n=>{let v={token:SECRET};for(let i=0;i<n;i++)v={c:v};return v;};
const leaks=v=>JSON.stringify(v??null).includes(SECRET);

test('v04 SEC-01: policy.output never returns raw data beyond the depth limit (objects, arrays, cycles)', ()=>{
  const p=createPolicy();
  for(const n of [11,12,13,20,60])assert.ok(!leaks(p.output(deepNarrow(n))),'leak at depth '+n);
  let arr=[SECRET];for(let i=0;i<40;i++)arr=[arr];assert.ok(!leaks(p.output(arr)));
  const cyc={a:{token:SECRET}};cyc.self=cyc;let c=cyc;for(let i=0;i<20;i++)c={c};
  assert.doesNotThrow(()=>p.output(c));assert.ok(!leaks(p.output(c)));
  const b=createPolicy({mode:'block'});assert.ok(!leaks(b.output(deepNarrow(30))));
  assert.equal(p.output(deepNarrow(3)).c.c.c.token.includes('ghp_'),false);   // shallow still works
});

test('v04 SEC-01: IPC channel — results, metrics, state and errors are filtered by the service', async()=>{
  const {startService,connectService}=await import('../compute/service.mjs');
  const dir=await mkdtemp(path.join(tmpdir(),'kv4-'));const socketPath=process.platform==='win32'?`\\\\.\\pipe\\kv4-${path.basename(dir)}`:path.join(dir,'s.sock');
  const app={cfg:{model:'m',maxParallel:1,workspace:null},policy:createPolicy(),
    compute:async a=>{if(a.op==='fail')throw Object.assign(Error('backend said token '+SECRET),{name:'Error'});return deepNarrow(25);},
    status:async()=>({info:deepNarrow(30)}),state:async()=>({tasks:[{error:'x '+SECRET}]}),engine:{metrics:()=>({m:deepNarrow(20)})}};
  const svc=await startService({app,socketPath,tokenFile:path.join(dir,'t')});
  const c=await connectService({socketPath,tokenFile:path.join(dir,'t')});
  try{
    assert.ok(!leaks(await c.call('compute',{op:'x'})));assert.ok(!leaks(await c.call('status')));
    assert.ok(!leaks(await c.call('metrics')));assert.ok(!leaks(await c.call('state')));
    const e=await c.call('compute',{op:'fail'}).catch(e=>e);assert.ok(!String(e.message).includes(SECRET),e.message);
  }finally{await c.close();await svc.close();}
});

test('v04 SEC-01: dashboard /api/state is filtered even if getState returns raw data', async()=>{
  const d=await startDashboard({getState:async()=>({deep:deepNarrow(30),err:'token '+SECRET}),policy:createPolicy()});
  try{
    const body=await new Promise((res,rej)=>http.get({host:'127.0.0.1',port:d.port,path:'/api/state?t='+d.token,headers:{Host:'127.0.0.1:'+d.port}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>res(b));}).on('error',rej));
    assert.ok(!body.includes(SECRET),body.slice(0,200));
  }finally{await d.close();}
});

test('v04 SEC-01: cache never persists raw deep secrets; MCP structuredContent and text are filtered', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'kv4c-'));const p=createPolicy();
  const cache=createCache({dir});await cache.set('k',p.output({r:deepNarrow(30)}),{disk:true});
  let n=0;for(const f of await readdir(dir,{recursive:true})){const fp=path.join(dir,f);try{const t=await readFile(fp,'utf8');n++;assert.ok(!t.includes(SECRET),'cache file leaks');}catch(e){if(e.code!=='EISDIR')throw e;}}
  assert.ok(n>=1,'cache wrote a file');
  const root=await workspace({'a.js':'export const a=1;\n'});
  const {server,app}=await buildServer({env:{KVALAH_MODEL:'mock',KVALAH_CACHE:'off',KVALAH_WORKSPACE:root,KVALAH_SERVICE:'off'},provider:smartMock(),log:()=>{}});
  app.compute=async()=>deepNarrow(40);
  const [a,b]=InMemoryTransport.createLinkedPair();const cl=new Client({name:'t',version:'1'});await Promise.all([server.connect(a),cl.connect(b)]);
  try{const r=await cl.callTool({name:'kvalah_compute',arguments:{op:'stats'}});assert.ok(!leaks(r),'MCP leaks');}
  finally{await cl.close();await app.close();}
});

test('v04 SEC-01: diagnostic log lines are filtered', async()=>{
  const {createKvalahOffload}=await import('../compute/index.mjs');const lines=[];
  const app=await createKvalahOffload({env:{KVALAH_MODEL:'mock',KVALAH_CACHE:'off',KVALAH_LAN:'1',KVALAH_DATA_DIR:'/nonexistent-'+SECRET},provider:smartMock(),log:m=>lines.push(m)});
  await app.close();assert.ok(lines.length>0);assert.ok(!lines.some(l=>l.includes(SECRET)),lines.join('\n'));
});
