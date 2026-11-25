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
async function startApp(){
  const data=tmp('kc-app-'),port=await freePort();
  const child=spawn(process.execPath,[path.join(ROOT,'server.mjs')],{env:{...process.env,LOCAL_CODEX_DATA:data,LOCAL_CODEX_PORT:String(port),KVALAH_WORKSPACE:data,OLLAMA_URL:'http://127.0.0.1:9',KVALAH_COMPUTE_TEST:'1'},stdio:['ignore','pipe','pipe']});
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
    s=await c('profile',{profile_id:'tiny-test-ffa-r4'});
    s=await c('runtime',{python:py,backend:'torch-cpu-test'});assert.equal(s.runtime.probe.backend_ok,true,JSON.stringify(s.runtime.probe));
    s=await c('model',{model_dir:model,variant_id:'cpu-test'});assert.equal(s.model.architecture_ok,true);
    s=await c('preflight',{});assert.equal(s.preflight.ok,true,JSON.stringify(s.preflight));
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
const CHROME=['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(f=>fs.existsSync(f));
async function cdp(url,{width=1024,height=768}={}){
  const port=await freePort(),prof=tmp('kc-chrome-');
  const ch=spawn(CHROME,['--headless=new','--no-sandbox','--disable-gpu','--remote-debugging-port='+port,'--user-data-dir='+prof,'--window-size='+width+','+height,'about:blank'],{stdio:'ignore'});
  const tabs=await until(async()=>{try{return (await (await fetch('http://127.0.0.1:'+port+'/json')).json()).filter(t=>t.type==='page');}catch{return null;}},15000,'chrome devtools');
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
test('UI: Compute view is wired to the real API (enable, tabs, policy, lab), no JS errors, fits 1024×768',{skip:!CHROME?'no Chrome/Chromium':skip,timeout:240000},async()=>{
  const app=await startApp(),py=python(PY),model=tinyModel(),shots=process.env.KVALAH_UI_SHOTS;
  const b=await cdp(app.origin+'/#token='+app.token);
  try{
    await until(()=>b.ev("!!document.getElementById('openCompute')&&document.getElementById('openCompute').textContent.length>0"),15000,'app loaded');
    await b.ev("click:#openCompute");
    await until(()=>b.ev("!!document.querySelector('[data-act=feature-on]')"),10000,'feature-off card');
    assert.equal(await b.ev("[...document.querySelectorAll('#computeTabs [data-tab]')].every(t=>t.hidden)"),true,'tabs hidden while off');
    if(shots)await b.shot(path.join(shots,'00-off.png'));
    await b.ev("click:[data-act=feature-on]");
    await until(()=>b.ev("!!document.getElementById('kcToggle')"),20000,'participation tab after enabling');
    assert.equal((await app.api('/api/compute/v2/state')).feature_enabled,true,'the button really enabled the feature');
    // Policy slider → POST policy → governor state.
    await b.ev("(()=>{const r=document.querySelector('[data-pol=gpu_target_pct]');r.value='25';r.dispatchEvent(new Event('input',{bubbles:true}));r.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await until(async()=>(await app.api('/api/compute/v2/state')).policy.gpu_target_pct===25,10000,'policy saved through the UI');
    await until(async()=>/^30 /.test(await b.ev("document.getElementById('kcNominal').textContent")),5000,'25% × 4 h × 30 = 30 h shown');
    // Toggle without a coordinator → goes to Devices (no fake participation).
    await b.ev("click:#kcToggle");
    await until(()=>b.ev("!!document.getElementById('kcPairing')"),5000,'devices tab');
    assert.equal((await app.api('/api/compute/v2/state')).participation,false);
    // Set up through the API, then let the UI show it.
    const c=(r,x)=>app.api('/api/compute/v2/'+r,x);
    await c('profile',{profile_id:'tiny-test-ffa-r4'});await c('runtime',{python:py,backend:'torch-cpu-test'});await c('model',{model_dir:model,variant_id:'cpu-test'});
    // Lab start from the UI.
    await b.ev("(()=>{const p=document.getElementById('kcPort');p.value='"+(await freePort())+"';document.querySelector('[data-act=lab-start]').click();})()");
    await until(async()=>(await c('state')).lab?.info?.running,15000,'coordinator started via UI');
    await until(()=>b.ev("!!document.querySelector('[data-act=lab-join]')"),10000,'join button');
    await b.ev("click:[data-act=lab-pairing]");
    await until(()=>b.ev("(document.getElementById('kcCode')||{}).textContent?.startsWith('kvalah-compute://pair?')"),10000,'pairing string shown');
    await b.ev("click:[data-act=lab-join]");
    await until(()=>b.ev("document.querySelectorAll('.dev-list li').length>=1"),20000,'device listed');
    if(shots)await b.shot(path.join(shots,'02-devices.png'));
    // Participation toggle now opens the consent dialog; accepting it goes through consent/accept.
    await b.ev("click:[data-tab=participate]");await until(()=>b.ev("!!document.getElementById('kcToggle')"),5000,'participate');
    await b.ev("click:#kcToggle");
    await until(()=>b.ev("document.getElementById('computeConsent').open"),5000,'consent dialog');
    assert.equal(await b.ev("document.getElementById('kcAccept').disabled"),true,'accept disabled until agreed');
    if(shots)await b.shot(path.join(shots,'03-consent.png'));
    await b.ev("(()=>{const a=document.getElementById('kcAgree');a.checked=true;a.dispatchEvent(new Event('change'));document.getElementById('kcAccept').click();})()");
    await until(async()=>(await c('state')).participation===true,10000,'consent accepted via UI');
    if(shots)await b.shot(path.join(shots,'01-participation.png'));
    await b.ev("click:[data-act=pause]");await until(async()=>(await c('state')).manual_pause===true,5000,'pause via UI');
    await b.ev("click:[data-act=resume]");await until(async()=>(await c('state')).manual_pause===false,5000,'resume via UI');
    // Preflight from the Models & data tab.
    await b.ev("click:[data-tab=data]");await b.ev("click:[data-act=preflight]");
    await until(async()=>(await c('state')).preflight?.ok===true,60000,'preflight via UI');
    await until(async()=>/Preflight OK/.test(await b.ev("document.getElementById('computeBody').textContent")),10000,'preflight result shown');
    // Sensors are unavailable outside Electron → the governor pauses with a reason; untick the limits in the UI.
    await until(async()=>(await c('state')).reason?.startsWith('sensor_unavailable'),20000,'paused for a missing sensor');
    await b.ev("click:[data-tab=participate]");await until(()=>b.ev("!!document.getElementById('kcToggle')"),5000,'participate');
    await until(async()=>/sensor unavailable/.test(await b.ev("document.getElementById('computeBody').textContent")),5000,'reason shown');
    for(const k of ['only_ac','only_idle','pause_on_games']){
      await until(()=>b.ev("!document.querySelector('[data-pol="+k+"]').disabled"),10000,'idle');
      await b.ev("(()=>{const x=document.querySelector('[data-pol="+k+"]');x.checked=false;x.dispatchEvent(new Event('change',{bubbles:true}));})()");
      await until(async()=>(await c('state')).policy[k]===false,10000,k+' saved');
    }
    // Lab: fixture import + dry run from the UI.
    await b.ev("click:[data-tab=lab]");await until(()=>b.ev("!!document.querySelector('[data-act=import-fixture]')"),5000,'lab');
    await b.ev("click:[data-act=import-fixture]");
    await until(()=>b.ev("document.querySelectorAll('#kcDataset option').length>0"),60000,'dataset imported via UI').catch(async e=>{throw Error(e.message+': '+(await b.ev("document.getElementById('computeBody').textContent")).slice(0,1500));});
    await b.ev("click:[data-act=register-model]");await until(async()=>(await c('state')).lab.variants.length>0,10000,'model registered');
    await until(()=>b.ev("!document.querySelector('[data-act=dry-run]').disabled"),10000,'idle');
    await b.ev("(()=>{document.getElementById('kcName').value='ui-run';document.getElementById('kcQMode').value='all';document.getElementById('kcQTarget').value='1';document.getElementById('kcSteps').value='1';document.querySelector('[data-act=dry-run]').click();})()");
    await until(()=>b.ev("!document.querySelector('[data-act=create]').disabled"),10000,'dry run plan shown').catch(async e=>{throw Error(e.message+': '+(await b.ev("[...document.querySelectorAll('.kc-msg')].map(x=>x.textContent).join(' | ')")));});
    assert.match(await b.ev("document.getElementById('computeBody').textContent"),/2 tasks|2 заданий/);
    if(shots)await b.shot(path.join(shots,'04-lab.png'));
    await b.ev("window.confirm=()=>true;document.querySelector('[data-act=create]').click()");
    await until(()=>b.ev("!!document.getElementById('kcExpSel')"),15000,'monitor tab after start');
    await until(async()=>{const s=await c('state');return s.lab.experiments[0]?.state==='COMPLETED';},120000,'UI-started experiment completes').catch(async err=>{const s2=await c('state');throw Error(err.message+' '+JSON.stringify({state:s2.state,reason:s2.reason,missing:s2.missing,policy:s2.policy,decision:s2.governor.decision,exp:s2.lab.experiments[0]&&{state:s2.lab.experiments[0].state,round:s2.lab.experiments[0].round,cfg:s2.lab.experiments[0].config.quorum},ev:s2.events.slice(-12).map(e=>e.code+' '+JSON.stringify(e.details))}).slice(0,5000));});
    await new Promise(r=>setTimeout(r,2500));
    assert.match(await b.ev("document.getElementById('computeBody').textContent"),/COMPLETED/);
    if(shots)await b.shot(path.join(shots,'05-monitor.png'));
    await b.ev("click:[data-tab=data]");await until(()=>b.ev("!!document.getElementById('kcPython')"),5000,'data tab');
    if(shots)await b.shot(path.join(shots,'06-data.png'));
    // Layout: nothing wider than the 1024 px window, in light and dark themes.
    for(const theme of ['light','dark']){
      await b.ev("document.documentElement.dataset.theme='"+theme+"'");
      for(const t of ['participate','devices','lab','monitor','data']){
        await b.ev("document.querySelector('[data-tab="+t+"]').click()");await new Promise(r=>setTimeout(r,400));
        const w=await b.ev("document.getElementById('computeBody').scrollWidth<=document.getElementById('computeBody').clientWidth+1");
        assert.equal(w,true,t+' fits 1024 px ('+theme+')');
      }
      if(shots)await b.shot(path.join(shots,'07-'+theme+'.png'));
    }
    // Russian UI strings.
    const ru=await b.ev("(async()=>{kvI18n.setLang('ru');document.querySelector('[data-tab=participate]').click();await new Promise(r=>setTimeout(r,600));return document.getElementById('computeBody').textContent;})()");
    assert.match(ru,/Предоставлять вычислительные ресурсы/);
    if(shots)await b.shot(path.join(shots,'08-ru.png'));
    assert.deepEqual(b.errors,[],'no JS errors in the page');
  }finally{b.close();await app.stop();}
});
