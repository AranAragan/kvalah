// v0.4 COMPUTE-02 (service side): the Kvalah desktop app joins the Compute Service as a 'device'-scoped client and
// LEASES model slots for its own generations, so GUI chats and MCP delegations share one queue and one device
// capacity (fair round-robin, interactive first). Device scope cannot touch workspace methods.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createKvalahOffload} from '../compute/index.mjs';
import {startService,connectService} from '../compute/service.mjs';
import {mockOllama} from './mock-ollama.mjs';
import {workspace,sleep} from './helpers.mjs';

async function setup(){
  const o=await mockOllama({tokens:5,tokenMs:10});const root=await workspace({'a.txt':'x\n'});const dir=await mkdtemp(path.join(tmpdir(),'kv4s-'));
  const app=await createKvalahOffload({env:{KVALAH_MODEL:'m',KVALAH_LOCAL_URL:o.url,KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',KVALAH_MAX_PARALLEL:'1',KVALAH_DATA_DIR:dir}});
  const sp={socketPath:path.join(dir,'s.sock'),tokenFile:path.join(dir,'t')};const svc=await startService({app,...sp});
  return {o,root,app,svc,sp,async close(){await svc.close();await app.close();await o.stop();}};
}

test('v04 COMPUTE-02: GUI lease holds the shared model slot; an MCP delegation waits for it; release/disconnect frees it', async()=>{
  const s=await setup();
  const gui=await connectService({...s.sp,client:'kvalah-gui',scope:'device'});
  const mcp=await connectService({...s.sp,workspace:s.root});
  try{
    const l=await gui.call('lease',{label:'chat',ttlMs:60000});assert.ok(l.lease);
    let m=await gui.call('metrics');assert.equal(m.service.leases.active,1);assert.equal(m.service.active.llm,1);
    let done=false;const d=mcp.call('delegate',{kind:'summarize',instruction:'s',context:'abc'}).then(r=>{done=true;return r;});
    await sleep(150);assert.equal(done,false,'delegation ran while the GUI held the only slot');assert.equal(s.o.st.chats,0);
    assert.deepEqual(await gui.call('release',{lease:l.lease}),{released:true});
    await d;assert.equal(s.o.st.chats,1);
    // lease again, then the GUI disconnects without releasing → slot comes back
    await gui.call('lease',{label:'chat2'});await gui.close();
    await mcp.call('delegate',{kind:'summarize',instruction:'s',context:'second'});
    m=await mcp.call('metrics');assert.equal(m.service.leases.active,0);assert.equal(m.service.leases.granted,2);
  }finally{await mcp.close();await s.close();}
});

test('v04 COMPUTE-02: device scope may not touch the workspace; others cannot release foreign leases; null workspace still needs scope', async()=>{
  const s=await setup();
  const gui=await connectService({...s.sp,client:'kvalah-gui',scope:'device'});const other=await connectService({...s.sp,workspace:s.root});
  try{
    await assert.rejects(gui.call('compute',{op:'stats'}),{name:'WorkspaceMismatchError'});
    await assert.rejects(gui.call('delegate',{kind:'summarize',instruction:'s',paths:['a.txt']}),{name:'WorkspaceMismatchError'});
    const l=await gui.call('lease',{});
    await assert.rejects(other.call('release',{lease:l.lease}),/unknown lease/);
    await gui.call('release',{lease:l.lease});
    await assert.rejects(connectService({...s.sp,workspace:null}),/workspace mismatch/);   // v0.3 contract unchanged
    assert.ok((await gui.call('status')).service);
  }finally{await gui.close();await other.close();await s.close();}
});

test('v04 COMPUTE-02: fair sharing — GUI leases and MCP jobs alternate round-robin on one slot', async()=>{
  const s=await setup();
  const gui=await connectService({...s.sp,client:'kvalah-gui',scope:'device'});const mcp=await connectService({...s.sp,workspace:s.root});
  try{
    const order=[];const first=await gui.call('lease',{});
    const g=[1,2].map(i=>gui.call('lease',{label:'g'+i}).then(async r=>{order.push('gui');await sleep(20);await gui.call('release',{lease:r.lease});}));
    const j=[1,2].map(i=>mcp.call('delegate',{kind:'summarize',instruction:'s'+i,context:'c'+i}).then(()=>order.push('mcp')));
    await sleep(50);await gui.call('release',{lease:first.lease});
    await Promise.all([...g,...j]);
    assert.deepEqual(order.slice(0,2).sort(),['gui','mcp'],'round-robin between the two clients: '+order.join(','));
  }finally{await gui.close();await mcp.close();await s.close();}
});
