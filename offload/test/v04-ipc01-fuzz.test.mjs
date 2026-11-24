// v0.4 IPC-01: every IPC message is schema-validated (zod); malformed input never crashes the service or the client.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {rng} from './helpers.mjs';

const posix=process.platform!=='win32';
async function svc(extra={}){
  const {startService}=await import('../compute/service.mjs');
  const dir=await mkdtemp(path.join(tmpdir(),'kv4i-'));const socketPath=posix?path.join(dir,'s.sock'):`\\\\.\\pipe\\kv4i-${path.basename(dir)}`;
  const app={cfg:{model:'m',maxParallel:1,workspace:null},compute:async a=>({ok:true,echo:a.op??null}),status:async()=>({up:true}),engine:{metrics:()=>({}),delegate:async()=>({d:1}),batch:async()=>({b:1})},auto:async()=>({a:1}),state:async()=>({})};
  const s=await startService({app,socketPath,tokenFile:path.join(dir,'t'),helloTimeoutMs:300,...extra});
  return {s,socketPath,token:readFileSync(path.join(dir,'t'),'utf8'),tokenFile:path.join(dir,'t')};
}
// a line starting with "hello" is sent first; the rest after the welcome arrives (as a real client does)
const raw=(socketPath,lines,{wait=60}={})=>new Promise(res=>{const c=net.connect(socketPath);let out='',sent=false;c.on('error',()=>{});
  const rest=()=>{if(sent)return;sent=true;for(const l of lines.slice(lines[0]?.includes('"hello"')?1:0))if(!c.destroyed)c.write(l);setTimeout(()=>{c.destroy();res(out);},wait);};
  c.on('data',d=>{out+=d;if(out.includes('"welcome"'))rest();});
  c.on('connect',()=>{if(lines[0]?.includes('"hello"')){c.write(lines[0]);setTimeout(rest,200);}else rest();});});
function junk(r){
  const atoms=[null,true,false,0,-1,1e308,'',"x".repeat(1000),[],{},{type:'call'},{type:'hello'},{type:'cancel'},{type:'result'},{type:'welcome'},{type:'error'},{__proto__:{x:1}},{constructor:{prototype:{polluted:1}}}];
  const pick=()=>atoms[Math.floor(r()*atoms.length)];
  const k=Math.floor(r()*10);
  switch(k){
    case 0:return 'null\n';case 1:return '42\n';case 2:return '"str"\n';case 3:return '[1,2,3]\n';
    case 4:return JSON.stringify({type:pick(),id:pick(),method:pick(),args:pick(),token:pick(),protocol:pick()})+'\n';
    case 5:return '{"type":"call","id":1,"method":"compute","args":'+'['.repeat(5000)+']'.repeat(5000)+'}\n';
    case 6:return Buffer.from(Array.from({length:64},()=>Math.floor(r()*256))).toString('latin1')+'\n';
    case 7:return '{"type":"hello","protocol":1,"token":'+JSON.stringify('x'.repeat(Math.floor(r()*500)))+'}\n';
    case 8:return '{"__proto__":{"admin":true},"type":"call","id":"a","method":"status"}\n';
    default:return JSON.stringify(pick())+'\n';
  }
}

test('v04 IPC-01: 600 malformed messages before authentication — service survives and still serves', async()=>{
  const {s,socketPath,tokenFile}=await svc();const r=rng(4);
  try{
    for(let i=0;i<60;i++)await raw(socketPath,Array.from({length:10},()=>junk(r)),{wait:15});
    const {connectService}=await import('../compute/service.mjs');
    const c=await connectService({socketPath,tokenFile});assert.equal((await c.call('status')).up,true);await c.close();
    assert.ok(s.metrics().protocolErrors>0,'invalid messages are counted');assert.equal(({}).admin,undefined);assert.equal(({}).polluted,undefined);
  }finally{await s.close();}
});

test('v04 IPC-01: malformed messages after authentication get a protocol error, not a crash', async()=>{
  const {s,socketPath,token,tokenFile}=await svc();const r=rng(9);
  try{
    const hello=JSON.stringify({type:'hello',protocol:1,token,client:'fz'})+'\n';
    for(let i=0;i<60;i++){const out=await raw(socketPath,[hello,...Array.from({length:10},()=>junk(r))],{wait:15});assert.ok(out.includes('"welcome"')||out==='');}
    const out=await raw(socketPath,[hello,'{"type":"call","id":{"x":1},"method":"compute"}\n','{"type":"call","id":7,"method":"compute","args":"notobject"}\n','{"type":"call","id":8,"method":"compute","args":{"op":"x"}}\n'],{wait:80});
    assert.match(out,/ProtocolError/);assert.match(out,/"id":8,"ok":true/);
    const {connectService}=await import('../compute/service.mjs');const c=await connectService({socketPath,tokenFile});assert.ok(await c.call('status'));await c.close();
  }finally{await s.close();}
});

test('v04 IPC-01: the client rejects malformed service messages instead of crashing', async()=>{
  const {connectService}=await import('../compute/service.mjs');const {writeFileSync}=await import('node:fs');
  const dir=await mkdtemp(path.join(tmpdir(),'kv4ic-'));const sp=posix?path.join(dir,'f.sock'):`\\\\.\\pipe\\kv4ic-${path.basename(dir)}`;writeFileSync(path.join(dir,'t'),'x'.repeat(64),{mode:0o600});
  const fake=net.createServer(c=>{c.on('error',()=>{});c.on('data',d=>{const m=String(d);if(m.includes('hello'))c.write('{"type":"welcome","protocol":1,"pid":1,"model":null,"workspace":false,"limits":{}}\n');
    if(m.includes('"call"')){c.write('null\n{"type":"result"}\n{"type":"result","id":1,"ok":"yes"}\n'+'['.repeat(100000)+'\n');}});});
  await new Promise(r=>fake.listen(sp,r));
  try{
    const c=await connectService({socketPath:sp,tokenFile:path.join(dir,'t')});
    const e=await c.call('status').catch(e=>e);assert.equal(e.name,'ServiceProtocolError');await c.close();
    const bad=net.createServer(c=>c.on('error',()=>{}).on('data',()=>c.write('{"type":"welcome","protocol":"one"}\n')));const sp2=sp+'2';await new Promise(r=>bad.listen(sp2,r));
    await assert.rejects(connectService({socketPath:sp2,tokenFile:path.join(dir,'t')}),/ServiceProtocolError|invalid/i);bad.close();
  }finally{fake.close();}
});
