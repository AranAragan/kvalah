// Kvalah ↔ Kvalah Compute Offload service link: local generations lease a shared model slot; without the service
// nothing changes. The service here is a protocol-level stand-in (the real service lives in kvalah-offload and is
// exercised against this file by kvalah-offload's integration check).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {mockModel,startApp,tempDir} from './helpers.mjs';
import {createComputeLink,computeServicePaths} from '../compute-link.mjs';
import {createScheduler} from '../scheduler.mjs';

const posix=process.platform!=='win32';
async function fakeService(dataDir,{slots=1}={}){
  const {socket,tokenFile}=computeServicePaths(dataDir);
  await fs.mkdir(path.dirname(socket),{recursive:true});await fs.writeFile(tokenFile,'tok',{mode:0o600});
  const log=[];let held=0;const waiters=[];let seq=0;
  const srv=net.createServer(sock=>{let buf='';sock.setEncoding('utf8');
    const send=m=>sock.write(JSON.stringify(m)+'\n');
    sock.on('error',()=>{});
    sock.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const msg=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);log.push(msg);
      if(msg.type==='hello'){if(msg.token!=='tok'||msg.scope!=='device'||msg.workspace!==null)return send({type:'error',error:{name:'AuthError',message:'authentication failed'}});send({type:'welcome',protocol:1,pid:1,model:'m',workspace:false,limits:{llm:slots}});}
      else if(msg.method==='lease'){const grant=()=>{held++;send({type:'result',id:msg.id,ok:true,result:{lease:'L'+(++seq),ttlMs:600000,waitedMs:0}});};grant.id=msg.id;held<slots?grant():waiters.push(grant);}
      else if(msg.type==='cancel'){const i=waiters.findIndex(w=>w.id===msg.id);if(i>=0)waiters.splice(i,1);}
      else if(msg.method==='release'){held--;send({type:'result',id:msg.id,ok:true,result:{released:true}});waiters.shift()?.();}
      else if(msg.method==='metrics')send({type:'result',id:msg.id,ok:true,result:{savings:{kind:'estimated',netCloudTokensSaved:100},measured:{available:false},service:{clients:[{client:'kvalah-gui',pending:0,leases:held}],queued:0,active:{llm:held},limits:{llm:slots},failed:0,cancelled:0,rejected:0,queueTimeouts:0,leases:{active:held,list:[]}}}});
      else if(msg.method==='status')send({type:'result',id:msg.id,ok:true,result:{lan:{nodes:[]}}});
    }});});
  await new Promise(r=>srv.listen(socket,r));
  return {log,get held(){return held;},close:()=>new Promise(r=>srv.close(r))};
}

test('service paths follow the kvalah-offload layout (data dir socket + 0600 token)',()=>{
  const p=computeServicePaths('/x/data',{},'linux');assert.equal(p.socket,'/x/data/service.sock');assert.equal(p.tokenFile,'/x/data/service.token');
  assert.match(computeServicePaths('C:\\d',{},'win32').socket,/^\\\\\.\\pipe\\kvalah-offload-[0-9a-f]{16}$/);
  assert.equal(computeServicePaths('/x',{KVALAH_SERVICE_SOCKET:'/s.sock'},'linux').socket,'/s.sock');
});

test('scheduler: a local job holds a shared lease for exactly its duration (also on failure)',async()=>{
  const events=[];const gate={lease:async({label})=>{events.push('lease '+label);return ()=>events.push('release');}};
  const s=createScheduler({registry:null,local:{provider:{},model:'m',maxParallel:1,gate}});
  await s.run(async()=>{events.push('job');return 1;},{model:'m',label:0});
  await assert.rejects(s.run(async()=>{events.push('job2');throw Object.assign(Error('x'),{fatal:true});},{model:'m',label:1}));
  assert.deepEqual(events,['lease task 0','job','release','lease task 1','job2','release']);
});

test('link: no service → lease is a no-op, snapshot says not connected',async()=>{
  const data=await tempDir();const link=createComputeLink({dataDir:data});
  const t0=Date.now();const release=await link.lease({label:'chat'});release();assert.ok(Date.now()-t0<500);
  const s=await link.snapshot();assert.equal(s.connected,false);link.close();
});

test('link: lease waits for the shared slot and abort cancels the wait',{skip:!posix&&'Unix socket stand-in'},async()=>{
  const data=await tempDir();const svc=await fakeService(data,{slots:1});const link=createComputeLink({dataDir:data});
  try{
    const r1=await link.lease({label:'a'});assert.equal(svc.held,1);
    const ac=new AbortController();const w=link.lease({label:'b',signal:ac.signal});setTimeout(()=>ac.abort(),50);
    await assert.rejects(w);await new Promise(r=>setTimeout(r,50));assert.ok(svc.log.some(m=>m.type==='cancel'),'cancel sent');
    r1();await new Promise(r=>setTimeout(r,50));assert.equal(svc.held,0);
  }finally{link.close();await svc.close();}
});

test('app: chats take a shared slot per model call when the service runs; /api/compute shows the dashboard data',{skip:!posix&&'Unix socket stand-in'},async()=>{
  const root=await tempDir(),data=path.join(root,'data'),workspace=path.join(root,'ws');await fs.mkdir(workspace,{recursive:true});await fs.mkdir(data,{recursive:true});
  const svc=await fakeService(data);
  const model=await mockModel(async()=>({content:'hello'}));
  let app;
  try{
    app=await startApp({modelUrl:model.url,data,workspace});
    const chat=(await app.api('/api/chats',{})).body;
    const events=await app.turn({chatId:chat.id,text:'hi',model:'mock:latest',agent:false});
    assert.ok(events.find(e=>e.type==='done'),JSON.stringify(events.filter(e=>e.type==='error')));
    const leases=svc.log.filter(m=>m.method==='lease'),releases=svc.log.filter(m=>m.method==='release');
    assert.ok(leases.length>=1,'chat leased a slot');assert.equal(releases.length,leases.length,'every lease released');assert.equal(svc.held,0);
    assert.equal(leases[0].args.label,'chat');
    const dash=(await app.api('/api/compute')).body;assert.equal(dash.connected,true);assert.equal(dash.metrics.service.limits.llm,1);assert.equal(dash.metrics.savings.kind,'estimated');
  }finally{await app?.stop();await model.close();await svc.close();}
});

test('app: without the service chats work exactly as before',async()=>{
  const root=await tempDir(),data=path.join(root,'data'),workspace=path.join(root,'ws');await fs.mkdir(workspace,{recursive:true});
  const model=await mockModel(async()=>({content:'hello'}));let app;
  try{
    app=await startApp({modelUrl:model.url,data,workspace});
    const chat=(await app.api('/api/chats',{})).body;
    const events=await app.turn({chatId:chat.id,text:'hi',model:'mock:latest',agent:false});assert.ok(events.find(e=>e.type==='done'));
    assert.equal((await app.api('/api/compute')).body.connected,false);
  }finally{await app?.stop();await model.close();}
});
