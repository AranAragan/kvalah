// Kvalah Compute v0.2 through the real app: server.mjs → /api/compute/v2/* → compute host child →
// controller → coordinator/worker/sidecar. Then the real UI (public/compute.js) in headless Chrome over CDP.
// CPU only (tiny random model, torch-cpu-test backend); no downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {ROOT,python,tinyModel,tmp} from './compute-helpers.mjs';
const PY=['torch','transformers','tokenizers','safetensors','numpy'];
const freePort=()=>new Promise(r=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
async function startApp(extraEnv={}){
  const data=tmp('kc-app-'),port=await freePort();
  const child=spawn(process.execPath,[path.join(ROOT,'server.mjs')],{env:{...process.env,LOCAL_CODEX_DATA:data,LOCAL_CODEX_PORT:String(port),KVALAH_WORKSPACE:data,OLLAMA_URL:'http://127.0.0.1:9',KVALAH_COMPUTE_TEST:'1',...extraEnv},stdio:['ignore','pipe','pipe']});
  let out='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>out+=d);
  for(let i=0;i<100&&!/token=([0-9a-f]+)/.test(out);i++)await new Promise(r=>setTimeout(r,100));
  const token=/token=([0-9a-f]+)/.exec(out)?.[1];assert.ok(token,'server printed its URL: '+out.slice(-500));
  const origin='http://127.0.0.1:'+port;
  const api=async(route,body)=>{const r=await fetch(origin+route,body===undefined?{headers:{'X-Local-Token':token}}:{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token,Origin:origin},body:JSON.stringify(body)});const j=await r.json();if(!r.ok){const e=Error(j.error||r.status);e.status=r.status;e.code=j.code;throw e;}return j;};
  return {data,port,token,origin,api,child,log:()=>out,stop:async()=>{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}};
}
const until=async(fn,ms,what)=>{const t=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-t>ms)throw Error('timeout: '+what);await new Promise(r=>setTimeout(r,300));}};
const skip=python(PY)?false:'KVALAH_COMPUTE_PYTHON with torch/transformers not available';

test('app routes: feature flag off by default, full lab run through server → host → controller',{skip,timeout:240000},async()=>{
  const app=await startApp(),py=python(PY),model=tinyModel();
  try{
    const c=(r,b)=>app.api('/api/compute/v2/'+r,b);
    assert.deepEqual(await c('state'),{feature_enabled:false},'off by default: no host process');
    await assert.rejects(c('runtime',{python:py,backend:'mock'}),e=>e.status===409);
    await assert.rejects(fetch(app.origin+'/api/compute/v2/state').then(r=>{if(!r.ok)throw Error(r.status);}),'token required');
    assert.equal((await app.api('/api/compute/v2/feature',{enabled:true})).feature_enabled,true);
    let s=await c('state');assert.equal(s.feature_enabled,true);assert.equal(s.state,'DISABLED');assert.equal(s.participation,false);
    await assert.rejects(c('lab/import-mlx-conversion',{reviewed:false}),{code:'CONVERSION_INVALID'});
    s=await c('profile',{profile_id:'tiny-test-ffa-r4'});
    s=await c('runtime',{python:py,backend:'torch-cpu-test'});assert.equal(s.runtime.probe.backend_ok,true,JSON.stringify(s.runtime.probe));
    s=await c('model',{model_dir:model,variant_id:'cpu-test'});assert.equal(s.model.architecture_ok,true);
    await assert.rejects(c('preflight',{}),/the resource policy does not allow work/);
    s=await c('policy',{policy:{only_idle:false,only_ac:false,pause_on_games:false},revision:s.policy.revision});
    s=await c('preflight',{});assert.equal(s.preflight.ok,true,JSON.stringify(s.preflight));
    const diagnostics=await c('diagnostics');
    assert.equal(diagnostics.schema_version,1);
    assert.equal(diagnostics.runtime.backend,'torch-cpu-test');
    assert.ok(!JSON.stringify(diagnostics).includes(JSON.stringify(model).slice(1,-1)));
    const lp=await freePort();
    s=await c('lab/start',{bind_ip:'127.0.0.1',port:lp});assert.equal(s.lab.info.running,true);assert.match(s.lab.info.endpoint,/^https:\/\/127\.0\.0\.1:/);
    s=await c('lab/join-self',{alias:'app-test'});assert.equal(s.link.device_state,'active');assert.equal(s.consent.required,true,'consent is required before any work');assert.equal(s.participation,false);
    const ct=s.consent.text;
    await assert.rejects(c('consent/accept',{text_revision:'old',project_id:ct.project_id}),/consent text changed/);
    s=await c('consent/accept',{text_revision:ct.text_revision,project_id:ct.project_id});assert.equal(s.participation,true);
    s=await c('policy',{policy:{...s.policy,only_idle:false,only_ac:false,pause_on_games:false,gpu_target_pct:50,cpu_target_pct:50},revision:s.policy.revision});
    await assert.rejects(c('policy',{policy:{...s.policy,gpu_target_pct:7},revision:s.policy.revision}),/steps of 5/);
    const ds=await c('lab/import-dataset',{fixture:true});assert.ok(ds.id);
    // Register the variant the (self-joined) device reported, then the locally verified folder (same digest).
    s=await c('state');const self=s.lab.devices.find(d=>d.id===s.lab.self_device);
    assert.equal(self.capabilities.variants[0].files_digest,s.model.files_digest);
    await c('lab/register-model',{device_id:self.id,variant_id:'cpu-test'});
    assert.equal((await c('state')).lab.variants.find(v=>v.variant_id==='cpu-test').files_digest,s.model.files_digest);
    await assert.rejects(c('lab/register-model',{device_id:'dev-'+'0'.repeat(32),variant_id:'cpu-test'}),/not found/);
    await c('lab/register-model',{});
    const cfg={name:'app-e2e',preset:'smoke',dataset_id:ds.id,variants:['cpu-test'],local_steps:2,quorum:{mode:'all',target:1},optimizer:{name:'adamw',lr:1e-3}};
    const plan=await c('lab/dry-run',{config:cfg});assert.equal(plan.tasks,2);assert.equal(plan.research_pass_possible,false,'synthetic data + unverified model');
    const e=await c('lab/create',{config:cfg});await c('lab/experiment/start',{id:e.id});
    const st=await until(async()=>{const r=await c('lab/experiment/status',{id:e.id});return r.status.state==='COMPLETED'&&r.status.eval?.rounds?.[2]?.nll!=null?r:null;},180000,'experiment completes').catch(async err=>{
      const r=await c('lab/experiment/status',{id:e.id}),s2=await c('state'),ev=await c('lab/events',{after:0});
      throw Error(err.message+'\n'+JSON.stringify({status:r.status,state:s2.state,reason:s2.reason,worker:s2.worker,events:s2.events.slice(-25),coord:ev.slice(-25)},null,1).slice(0,9000));});
    assert.equal(st.status.committed_rounds,2);assert.ok(Number.isFinite(st.status.eval.rounds[0].nll));
    const test=await c('lab/experiment/evaluate-test',{id:e.id});
    assert.equal(test.status,'DONE',JSON.stringify(test));
    assert.equal(test.split,'test');
    assert.equal(test.rows,ds.manifest.split_counts.test);
    assert.equal(test.tokens,ds.manifest.tokens_by_split.test.supervised);
    assert.equal(test.checkpoint,st.status.checkpoint.sha256);
    const evaluated=await c('lab/experiment/status',{id:e.id});
    assert.deepEqual(evaluated.status.eval.gate,st.status.eval.gate);
    const next=await c('lab/dry-run',{config:{...cfg,name:'continue',initial_checkpoint:{experiment_id:e.id,sha256:test.checkpoint}}});
    assert.equal(next.initial_adapter_sha256,test.checkpoint);
    s=await c('state');assert.ok(s.worker===null||s.worker.metrics.tasks_accepted>=2||s.events.some(x=>x.code==='update.accepted'));
    const out=tmp('kc-app-out-');
    const rep=await c('lab/report',{experiment_id:e.id,dir:out,include_weights:true});assert.ok(fs.existsSync(rep.path));
    const v=await c('verify-report',{file:rep.path});assert.equal(v.ok,true,JSON.stringify(v.problems));
    const pe=await c('lab/export-peft',{experiment_id:e.id,dir:out});assert.ok(fs.existsSync(path.join(pe.out_dir||pe.path||'',"adapter_config.json"))||fs.readdirSync(out).some(f=>f.startsWith('kvalah-peft-')));
    // Stop: participation off → worker stops at a safe boundary; feature off → host exits.
    s=await c('participation',{enabled:false});assert.equal(s.participation,false);
    assert.equal((await app.api('/api/compute/v2/feature',{enabled:false})).feature_enabled,false);
    assert.deepEqual(await c('state'),{feature_enabled:false});
  }finally{await app.stop();}
});

// ---------- UI in headless Chrome (real DOM, real API) ----------
const CHROME=[
  process.env.KVALAH_TEST_CHROME,
  '/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',
  ...(process.platform==='win32'?[path.join(process.env.ProgramFiles||'C:/Program Files','Google','Chrome','Application','chrome.exe')]:[]),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(f=>f&&fs.existsSync(f));
async function cdp(url,{width=1024,height=768}={}){
  const port=await freePort(),prof=tmp('kc-chrome-');
  const ch=spawn(CHROME,['--headless=new','--no-sandbox','--disable-gpu','--remote-debugging-port='+port,'--user-data-dir='+prof,'--window-size='+width+','+height,'about:blank'],{stdio:'ignore'});
  let tabs;
  try{tabs=await until(async()=>{try{const t=(await (await fetch('http://127.0.0.1:'+port+'/json')).json()).filter(t=>t.type==='page'&&t.webSocketDebuggerUrl);return t.length?t:null;}catch{return null;}},15000,'chrome devtools');}
  catch(e){ch.kill();throw e;}
  const ws=new WebSocket(tabs[0].webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
  let id=0;const pend=new Map(),errors=[];
  ws.onmessage=m=>{const d=JSON.parse(m.data);if(d.id&&pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id);}
    if(d.method==='Runtime.exceptionThrown')errors.push(d.params.exceptionDetails.exception?.description||d.params.exceptionDetails.text);
    if(d.method==='Runtime.consoleAPICalled'&&d.params.type==='error')errors.push(d.params.args.map(a=>a.value||a.description).join(' '));};
  const send=(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});
  await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url});
  const ev=async expr=>{if(/^click:/.test(expr)){const sel=expr.slice(6);await until(async()=>(await ev("!!document.querySelector('"+sel+"')&&!document.querySelector('"+sel+"').disabled")),10000,'element '+sel);expr="document.querySelector('"+sel+"').click()";}const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});if(r.result.exceptionDetails)throw Error(r.result.exceptionDetails.exception?.description||'eval failed');return r.result.result.value;};
  const shot=async file=>{const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(file,Buffer.from(r.result.data,'base64'));};
  return {ev,shot,errors,close:()=>{ws.close();ch.kill();}};
}
test('UI: contribution, advanced settings, invitation consent and automatic setup use the real host',{skip:!CHROME?'no Chrome/Chromium':skip,timeout:180000},async()=>{
  const app=await startApp({KVALAH_UX_TEST_PYTHON:python(PY),KVALAH_UX_TEST_MODEL:tinyModel()});
  const c=(r,b)=>app.api('/api/compute/v2/'+r,b);
  let browser;
  try{
    browser=await cdp(app.origin+'/#token='+app.token);
    const ev=browser.ev;
    await until(()=>ev('document.readyState!=="loading"&&Boolean(window.kvCompute)&&document.querySelector("#openCompute")?.textContent.trim()'),'desktop renderer booted',15000);
    await ev('click:#openCompute');
    await until(()=>ev("Boolean(document.querySelector('[data-act=join-wizard]'))"),10000,'contribution');
    assert.equal(await ev("document.querySelector('[data-mode=contribution]').getAttribute('aria-pressed')"),'true');
    assert.equal(await ev("document.querySelectorAll('.kc-profile').length"),3);
    assert.equal(await ev("Boolean(document.querySelector('#kcPython,[data-act=preflight],.kc-lab-tabs'))"),false);
    await ev("click:[data-act=policy-preset][data-arg=balanced]");
    await until(async()=>(await c('state')).policy.gpu_target_pct===25,15000,'selected Balanced');
    assert.equal(await ev("document.querySelector('[data-expand=policy]').open"),false);
    const initial=await c('state');
    await c('policy',{policy:{only_idle:false,only_ac:false,pause_on_games:false},revision:initial.policy.revision});
    await ev('click:[data-mode=laboratory]');
    await ev('click:[data-act=lab-nav][data-arg=data]');
    await ev('click:[data-act=show-mlx-import]');
    assert.deepEqual(await ev("['kcMlxManifest','kcMlxSource','kcMlxOutput','kcMlxReviewed'].map(id=>Boolean(document.getElementById(id)))"),[true,true,true,true]);
    await ev('click:[data-act=import-mlx]');
    await until(()=>ev("Boolean(document.querySelector('[data-dialog-error]')?.textContent)"),8000,'MLX import requests review');
    await ev('click:[data-act=close-dialog]');
    await c('profile',{profile_id:'tiny-test-ffa-r4'});
    await ev('click:[data-act=lab-nav][data-arg=overview]');
    await ev('click:[data-act=auto-lab]');
    await until(async()=>(await c('state')).lab?.info.running,15000,'native HTTPS lab');
    await ev('click:[data-act=lab-join-ux]');
    await until(()=>ev("Boolean(document.querySelector('#kcAccept'))"),10000,'consent');
    assert.equal(await ev("document.querySelector('#kcAccept').disabled"),true);
    const before=await c('state');
    assert.equal(before.participation,false);
    assert.equal(before.runtime,null);
    await ev('click:#kcAgree');
    await ev('click:#kcAccept');
    const ready=await until(async()=>{
      const s=await c('state');
      if(s.preparation.status==='blocked')throw Error(JSON.stringify(s.preparation));
      return s.preparation.status==='ready'&&s.worker?s:null;
    },85000,'automatic runtime, model and preflight');
    assert.equal(ready.runtime.backend,'torch-cpu-test');
    assert.equal(ready.preflight.ok,true);
    await ev('click:[data-act=pause]');
    await until(async()=>(await c('state')).manual_pause,8000,'manual pause');
    await ev('click:[data-act=resume]');
    await until(async()=>!(await c('state')).manual_pause,8000,'resume');
    await ev('click:[data-mode=laboratory]');
    await ev('click:[data-act=show-smoke]');
    assert.equal(await ev("document.querySelector('[data-act=smoke-start]').disabled"),true,'one worker cannot satisfy the three-device gate');
    await ev('click:[data-act=close-dialog]');
    for(const theme of ['light','dark']){
      await ev("document.documentElement.dataset.theme='"+theme+"'");
      for(const tab of ['overview','devices','experiments','data']){
        await ev("click:[data-act=lab-nav][data-arg="+tab+"]");
        assert.ok(await ev("document.querySelector('#computeBody').scrollWidth<=document.querySelector('#computeBody').clientWidth+1"),tab+' fits at 1024 px in '+theme);
      }
    }
    assert.deepEqual(browser.errors,[]);
  }finally{browser?.close();await app.stop();}
});
