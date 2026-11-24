// v0.4 COMPUTE-01: several MCP servers started while no Compute Service runs must not each create an engine:
// exactly one becomes the host of the shared service (lock + socket), the others connect; when the host dies
// the rest re-elect. Real processes, official MCP stdio client, a real HTTP mock of Ollama.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mockOllama} from './mock-ollama.mjs';
import {workspace} from './helpers.mjs';

const server=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','mcp','server.mjs');
async function mcp(env){const c=new Client({name:'t',version:'1'});const tr=new StdioClientTransport({command:process.execPath,args:[server],env:{...process.env,...env},stderr:'pipe'});
  let err='';tr.stderr?.on('data',d=>err+=d);await c.connect(tr);return {c,tr,get stderr(){return err;},pid:tr.pid};}
const call=async(m,name,args)=>{const r=await m.c.callTool({name,arguments:args},undefined,{timeout:60000});if(r.isError)throw Error(r.content[0].text);return r.structuredContent??JSON.parse(r.content[0].text);};

test('v04 COMPUTE-01: three MCP servers started together share ONE engine (peak model concurrency = KVALAH_MAX_PARALLEL)', async()=>{
  const o=await mockOllama({tokens:10,tokenMs:30});const root=await workspace({'a.txt':'hello\n'});const data=await mkdtemp(path.join(tmpdir(),'kv4e-'));
  const env={KVALAH_MODEL:'m',KVALAH_LOCAL_URL:o.url,KVALAH_WORKSPACE:root,KVALAH_DATA_DIR:data,KVALAH_CACHE:'off',KVALAH_MAX_PARALLEL:'1',KVALAH_SERVICE:'auto'};
  const ms=await Promise.all([1,2,3].map(()=>mcp(env)));
  try{
    const rs=await Promise.all(ms.flatMap((m,i)=>[0,1].map(j=>call(m,'kvalah_delegate',{kind:'summarize',instruction:`task ${i}-${j}`,context:'text '+i+j}))));
    assert.equal(rs.length,6);
    assert.equal(o.st.peak,1,'model concurrency '+o.st.peak+' (one engine per process?)');
    const modes=await Promise.all(ms.map(async m=>(await call(m,'kvalah_metrics',{})).client?.mode));
    assert.equal(modes.filter(x=>x==='host').length,1,'exactly one host: '+modes.join(','));assert.equal(modes.filter(x=>x==='service').length,2);
  }finally{for(const m of ms)await m.c.close().catch(()=>{});await o.stop();}
});

test('v04 COMPUTE-01 / QA: host crash → survivors re-elect, keep one engine and keep working', async()=>{
  const o=await mockOllama({tokens:5,tokenMs:20});const root=await workspace({'a.txt':'hello\n'});const data=await mkdtemp(path.join(tmpdir(),'kv4e-'));
  const env={KVALAH_MODEL:'m',KVALAH_LOCAL_URL:o.url,KVALAH_WORKSPACE:root,KVALAH_DATA_DIR:data,KVALAH_CACHE:'off',KVALAH_MAX_PARALLEL:'1',KVALAH_SERVICE:'auto'};
  const ms=[];for(let i=0;i<3;i++){ms.push(await mcp(env));await call(ms[i],'kvalah_metrics',{});}
  try{
    const modes=await Promise.all(ms.map(async m=>(await call(m,'kvalah_metrics',{})).client?.mode));
    const hostIdx=modes.indexOf('host');assert.ok(hostIdx>=0,modes.join(','));
    process.kill(ms[hostIdx].pid,'SIGKILL');                       // crash, no graceful shutdown
    const rest=ms.filter((_,i)=>i!==hostIdx);const peakBefore=o.st.peak;o.st.peak=0;
    const rs=await Promise.all(rest.flatMap((m,i)=>[0,1].map(j=>call(m,'kvalah_delegate',{kind:'summarize',instruction:`after crash ${i}-${j}`,context:'x'+i+j}))));
    assert.equal(rs.length,4);assert.equal(o.st.peak,1,'still one engine after re-election');
    const after=await Promise.all(rest.map(async m=>(await call(m,'kvalah_metrics',{})).client?.mode));
    assert.equal(after.filter(x=>x==='host').length,1,after.join(','));
  }finally{for(const m of ms)await m.c.close().catch(()=>{});await o.stop();}
});

test('v04 COMPUTE-01: stale lock of a dead pid is broken; a service with another config fingerprint is not used', async()=>{
  const {electService,lockPathFor,servicePaths}=await import('../compute/service.mjs');
  const {createKvalahOffload}=await import('../compute/index.mjs');const {smartMock}=await import('./helpers.mjs');
  const {writeFile}=await import('node:fs/promises');
  const root=await workspace({'a.txt':'x'});const dir=await mkdtemp(path.join(tmpdir(),'kv4l-'));
  const env={KVALAH_MODEL:'mock',KVALAH_CACHE:'off',KVALAH_WORKSPACE:root,KVALAH_DATA_DIR:dir};
  const p=servicePaths(env,dir);const lock=lockPathFor(p.socket,p.tokenFile);
  await writeFile(lock,'999999999');                                   // pid that cannot exist
  const t0=Date.now();
  const a=await electService({socketPath:p.socket,tokenFile:p.tokenFile,workspace:root,fingerprint:'A',createApp:()=>createKvalahOffload({env,provider:smartMock()})});
  try{
    assert.ok(a.host,'became host despite the stale lock');assert.ok(Date.now()-t0<5000);
    const b=await electService({socketPath:p.socket,tokenFile:p.tokenFile,workspace:root,fingerprint:'A',createApp:()=>{throw Error('second engine built');}});
    assert.equal(b.host,null);await b.conn.close();
    await assert.rejects(electService({socketPath:p.socket,tokenFile:p.tokenFile,workspace:root,fingerprint:'B',createApp:()=>{throw Error('engine built');}}),{name:'ServiceMismatchError'});
  }finally{await a.conn.close();await a.host.close();}
});
