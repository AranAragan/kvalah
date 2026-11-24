// UI-01 regression: dashboard actions (cancel, cache clear) with token + Origin checks; honest state display.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createKvalahOffload} from '../compute/index.mjs';
import {smartMock,workspace,sleep} from './helpers.mjs';

const req=(url,{method='GET',headers={},body=null}={})=>new Promise((res,rej)=>{const u=new URL(url);
  const r=http.request({host:u.hostname,port:u.port,path:u.pathname+u.search,method,headers},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>res({status:x.statusCode,body:b}));});
  r.on('error',rej);if(body!=null)r.write(body);r.end();});
async function setup(env={}){
  const root=await workspace({'logs/ci.log':'INFO a\nERROR boom\n','src/a.js':'export function hello(){}\n'});
  let aborted=0;const p=smartMock({delay:400});const chat=p.chat;p.chat=async function*(r){r.signal?.addEventListener('abort',()=>aborted++,{once:true});yield* chat.call(p,r);};
  const app=await createKvalahOffload({env:{KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',KVALAH_DASHBOARD:'1',...env},provider:p});
  const d=app.dashboard,origin=`http://127.0.0.1:${d.port}`;
  const post=(path,body,h={})=>req(origin+path,{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json','X-Kvalah-Token':d.token,Origin:origin,...h}});
  return {app,d,origin,post,aborted:()=>aborted};
}

test('UI-01: mutations need POST + token header + same Origin + JSON (CSRF / DNS-rebinding defence)', async()=>{
  const s=await setup();
  try{
    assert.equal((await req(s.origin+'/api/cancel?t='+s.d.token)).status,405);
    assert.equal((await s.post('/api/cancel',{id:'x'},{'X-Kvalah-Token':'nope'})).status,401);
    assert.equal((await s.post('/api/cancel',{id:'x'},{Origin:'http://evil.example'})).status,403);
    assert.equal((await req(s.origin+'/api/cancel',{method:'POST',body:'{"id":"x"}',headers:{'Content-Type':'application/json','X-Kvalah-Token':s.d.token}})).status,403,'missing Origin');
    assert.equal((await s.post('/api/cancel',{id:'x'},{'Sec-Fetch-Site':'cross-site'})).status,403);
    assert.equal((await s.post('/api/cancel',{id:'x'},{'Content-Type':'text/plain'})).status,415);
    assert.equal((await s.post('/api/cancel',{id:'x'},{Host:'evil.example:80'})).status,421);
    assert.equal((await s.post('/api/cancel',{id:'x'.repeat(5000)})).status,413);
    assert.equal((await s.post('/api/cancel',{id:'unknown'})).status,404);
  }finally{await s.app.close();}
});

test('UI-01: cancel from the dashboard stops a running job and frees the slot', async()=>{
  const s=await setup();
  try{
    const run=s.app.engine.delegate({kind:'logs',instruction:'errors?',paths:['logs/ci.log']}).catch(e=>e);
    await sleep(60);
    const st=JSON.parse((await req(s.origin+'/api/state?t='+s.d.token)).body);
    const active=st.tasks.find(t=>t.status==='running');assert.ok(active?.cancellable,'running task is cancellable');
    const r=await s.post('/api/cancel',{id:active.id});assert.equal(r.status,200);assert.equal(JSON.parse(r.body).cancelled,true);
    const err=await run;assert.match(String(err?.message),/cancel/i);
    assert.equal(s.aborted(),1,'model call received the abort');
    const after=JSON.parse((await req(s.origin+'/api/state?t='+s.d.token)).body);
    assert.equal(after.tasks.find(t=>t.id===active.id).status,'cancelled');assert.equal(after.metrics.pending,0);
    assert.equal((await s.post('/api/cancel',{id:active.id})).status,404,'finished job is no longer cancellable');
  }finally{await s.app.close();}
});

test('UI-01: cache clear from the dashboard (current workspace)', async()=>{
  const s=await setup();
  try{
    const t={kind:'logs',instruction:'errors?',paths:['logs/ci.log']};
    await s.app.engine.delegate(t);assert.equal((await s.app.engine.delegate(t)).cached,true);
    const r=await s.post('/api/cache/clear',{});assert.equal(r.status,200);assert.equal(JSON.parse(r.body).cleared,true);
    assert.equal((await s.app.engine.delegate(t)).cached,false);
  }finally{await s.app.close();}
});

test('UI-01: state shows limits, queue, level, coverage, estimated vs measured cost; no paths/sources by default; token not exposed via MCP status', async()=>{
  const s=await setup();
  try{
    await s.app.engine.delegate({kind:'logs',instruction:'errors?',paths:['logs/ci.log'],tailBytes:8});
    const st=JSON.parse((await req(s.origin+'/api/state?t='+s.d.token)).body);
    assert.ok(st.limits.maxParallel>=1&&st.limits.ctxTokens&&st.limits.maxPendingCalls);
    assert.ok('pending' in st.queue&&'maxPending' in st.queue);
    const t=st.tasks[0];assert.equal(t.level,2);assert.ok(t.coverage<1,'tail read → partial coverage shown');
    assert.equal(st.cost.kind,'estimated');assert.equal(st.cost.measured,null);
    assert.equal(t.paths,undefined,'paths hidden by default');assert.ok(!JSON.stringify(st).includes('ERROR boom'),'no source text');
    const page=(await req(s.d.url)).body;for(const w of ['Cancel','Clear cache','estimated','measured','Queue','Coverage','Limits'])assert.ok(page.includes(w),w);
    const status=await s.app.status();assert.ok(!JSON.stringify(status).includes(s.d.token),'MCP status must not leak the dashboard token');
    const shown=await setup({KVALAH_DASHBOARD_SHOW_PATHS:'1'});await shown.app.engine.delegate({kind:'logs',instruction:'x',paths:['logs/ci.log']});
    assert.deepEqual(JSON.parse((await req(shown.origin+'/api/state?t='+shown.d.token)).body).tasks[0].paths,['logs/ci.log']);await shown.app.close();
  }finally{await s.app.close();}
});

test('UI-01: in service mode the dashboard shows the shared queue and clients', async()=>{
  const s=await setup();const {startService,connectService}=await import('../compute/service.mjs');
  const {mkdtemp}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');
  const dir=await mkdtemp(path.join(tmpdir(),'kvu-'));
  const svc=await startService({app:s.app,socketPath:process.platform==='win32'?`\\\\.\\pipe\\kvu-${path.basename(dir)}`:path.join(dir,'s.sock'),tokenFile:path.join(dir,'t')});
  try{
    const c=await connectService({socketPath:svc.socketPath,tokenFile:svc.tokenFile,workspace:s.app.cfg.workspace,client:'gui'});
    const st=JSON.parse((await req(s.origin+'/api/state?t='+s.d.token)).body);
    assert.equal(st.service.connections,1);assert.equal(st.service.clients[0].client,'gui');await c.close();
  }finally{await svc.close();await s.app.close();}
});
