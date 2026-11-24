// v0.4 IPC-02: resource limits — connections, in-flight requests per client, subscribers per job, total pending.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {sleep} from './helpers.mjs';

const posix=process.platform!=='win32';
async function setup(opts){
  const {startService,connectService}=await import('../compute/service.mjs');
  const dir=await mkdtemp(path.join(tmpdir(),'kv4l-'));const socketPath=posix?path.join(dir,'s.sock'):`\\\\.\\pipe\\kv4l-${path.basename(dir)}`;
  let release;const gate=new Promise(r=>release=r);
  const app={cfg:{model:'m',maxParallel:1,workspace:null},compute:async(a,{signal})=>{await Promise.race([gate,new Promise((_,j)=>signal.addEventListener('abort',()=>j(Error('aborted'))))]);return {ok:1};},
    status:async()=>({}),engine:{metrics:()=>({}),delegate:async(a,{signal})=>{await Promise.race([gate,new Promise((_,j)=>signal.addEventListener('abort',()=>j(Error('aborted'))))]);return {d:a.n??0};}},state:async()=>({})};
  const s=await startService({app,socketPath,tokenFile:path.join(dir,'t'),maxQueue:1000,maxQueuePerClient:1000,...opts});
  const conn=(client='c')=>connectService({socketPath,tokenFile:path.join(dir,'t'),client});
  return {s,socketPath,conn,release};
}
const tr=p=>p.then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason}));
const settle=ps=>Promise.all(ps);
const rejectedWith=(rs,name)=>rs.filter(r=>r.status==='rejected'&&r.reason.name===name).length;

test('v04 IPC-02: connection limit (authenticated or not)', async()=>{
  const t=await setup({maxConnections:4,helloTimeoutMs:5000});
  const idle=[];
  try{
    for(let i=0;i<4;i++){const c=net.connect(t.socketPath);c.on('error',()=>{});idle.push(c);await new Promise(r=>c.on('connect',r));}
    await assert.rejects(t.conn(),/too many connections|closed|unavailable/i);
    assert.ok(t.s.metrics().connectionsRefused>=1);
    for(const c of idle)c.destroy();await sleep(50);
    const c=await t.conn();await c.close();
  }finally{for(const c of idle)c.destroy();t.release();await t.s.close();}
});

test('v04 IPC-02: in-flight requests per client are bounded, also for identical (deduplicated) calls', async()=>{
  const t=await setup({maxInflightPerClient:8});const c=await t.conn();
  try{
    const ps=Array.from({length:30},()=>tr(c.call('delegate',{n:1})));await sleep(50);
    const distinct=Array.from({length:10},(_,i)=>tr(c.call('delegate',{n:100+i})));await sleep(50);t.release();
    const rs=await settle([...ps,...distinct]);
    assert.ok(rejectedWith(rs,'ServiceOverloadError')>=30+10-8,'rejected '+rejectedWith(rs,'ServiceOverloadError'));
    assert.equal(rs.filter(r=>r.status==='fulfilled').length,8);
  }finally{await c.close();await t.s.close();}
});

test('v04 IPC-02: subscribers per job and total pending requests are bounded', async()=>{
  const t=await setup({maxSubscribersPerJob:5,maxPendingTotal:12,maxInflightPerClient:100});
  const cs=await Promise.all([1,2,3,4].map(i=>t.conn('c'+i)));
  try{
    const same=cs.flatMap(c=>[1,2,3].map(()=>tr(c.call('delegate',{n:7}))));await sleep(30);
    const other=cs.flatMap(c=>[1,2,3,4].map((_,j)=>tr(c.call('delegate',{n:c.welcome.pid+j+Math.random()}))));await sleep(50);
    const m=t.s.metrics();assert.ok(m.pendingTotal<=12,'pending '+m.pendingTotal);
    t.release();const rs=await settle([...same,...other]);
    const sameOk=(await settle(same)).filter(r=>r.status==='fulfilled').length;assert.equal(sameOk,5,'at most 5 subscribers on one job');
    assert.ok(rs.filter(r=>r.status==='fulfilled').length<=12);assert.ok(rejectedWith(rs,'ServiceOverloadError')>=rs.length-12);
    assert.equal(t.s.metrics().pendingTotal,0,'pending returns to zero');
  }finally{for(const c of cs)await c.close();await t.s.close();}
});
