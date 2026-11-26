import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

export async function until(check, description, timeout=60000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    const result=await check();
    if(result)return result;
    await delay(250);
  }
  throw Error('Timed out: '+description);
}

async function port() {
  const server=net.createServer().listen(0,'127.0.0.1');
  await once(server,'listening');
  const result=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return result;
}

export async function launch(executable,{args=[],env={},root=null}={}) {
  const debug=await port();
  const child=spawn(executable,[...args,'--remote-debugging-port='+debug],{env:{...process.env,...env},stdio:'ignore',windowsHide:true});
  child.on('error',()=>{});
  let ws,seq=0;
  const pending=new Map(),errors=[];
  function quit() {
    ws?.close();
    if(child.exitCode===null)child.kill();
  }
  try{
    const target=await until(async()=>{
      try{return (await (await fetch('http://127.0.0.1:'+debug+'/json')).json()).find(t=>t.type==='page'&&t.webSocketDebuggerUrl&&t.url!=='devtools://');}
      catch{return null;}
    },'debug page',25000);
    ws=new WebSocket(target.webSocketDebuggerUrl);
    await once(ws,'open');
    ws.onmessage=event=>{
      const message=JSON.parse(event.data);
      if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
      const complete=pending.get(message.id);
      if(complete){pending.delete(message.id);complete(message);}
    };
    function send(method,params={}) {
      const id=++seq;
      return new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},25000);
        pending.set(id,message=>{clearTimeout(timeout);message.error?reject(Error(message.error.message)):resolve(message.result);});
        ws.send(JSON.stringify({id,method,params}));
      });
    }
    await send('Runtime.enable');
    async function evaluate(expression) {
      const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
      return r.result.value;
    }
    return {root,errors,quit,send,evaluate,
      async click(selector){
        const escaped=JSON.stringify(selector);
        await until(()=>evaluate(`Boolean(document.querySelector(${escaped})?.checkVisibility()&&!document.querySelector(${escaped}).disabled)`),selector);
        await evaluate(`document.querySelector(${escaped}).click()`);
      },
      async shot(file){
        const image=await send('Page.captureScreenshot',{format:'png'});
        fs.writeFileSync(file,Buffer.from(image.data,'base64'));
      },
      async viewport(width,height){
        await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      }
    };
  }catch(error){quit();throw error;}
}

export async function desktop(executable,args=[],env={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kvalah-ux-'));
  fs.writeFileSync(path.join(root,'language.json'),JSON.stringify({language:'ru',source:'user'}));
  const app=await launch(executable,{args,env:{...env,KVALAH_TEST_ROOT:root},root});
  await until(()=>app.evaluate('Boolean(window.kvCompute&&document.querySelector("#openCompute"))'),'Electron app');
  return app;
}

async function reference(out,old,chrome) {
  const app=await desktop(old);
  try{
    await app.viewport(1380,900);
    await app.click('#openCompute');
    await app.click('[data-act="feature-on"]');
    await until(()=>app.evaluate('Boolean(document.querySelector("#kcToggle"))'),'old Compute tabs');
    await app.shot(path.join(out,'01-installed-dev1.png'));
    assert.deepEqual(app.errors,[]);
  }finally{app.quit();}
  const browser=await launch(chrome,{args:['--headless=new','--user-data-dir='+fs.mkdtempSync(path.join(os.tmpdir(),'kvalah-ux-ref-')),pathToFileURL(path.join(out,'GUI_PREVIEW.html')).href]});
  try{
    await browser.viewport(1380,900);
    await until(()=>browser.evaluate('Boolean(document.querySelector("#volBtn"))'),'prototype');
    for(const [name,expression] of [
      ['02-prototype-contribution','reset()'],['03-prototype-invitation','invitation()'],
      ['04-prototype-consent','consent()'],['05-prototype-preparing','prepare()'],
      ['06-prototype-lab','reset(); mode("lab")'],['07-prototype-smoke','state.lab=true;render();wizard()']
    ]){
      await browser.evaluate(expression);
      await browser.shot(path.join(out,name+'.png'));
    }
  }finally{browser.quit();}
}

async function candidate(out,executable,source,kind){
  const lab=kind==='cpu-lab';
  const py=process.env.KVALAH_COMPUTE_PYTHON;
  const model=process.env.KVALAH_UX_TEST_MODEL;
  if(lab)assert.ok(py&&model,'CPU fixture paths are required');
  const app=await desktop(executable,source==='package'?[]:[source],lab?{
    KVALAH_COMPUTE_TEST:'1',KVALAH_UX_TEST_PYTHON:py,KVALAH_UX_TEST_MODEL:model
  }:{});
  const workers=[];
  let external;
  const shot=name=>app.shot(path.join(out,name+'.png'));
  const api=(route,data)=>app.evaluate(`api('/api/compute/v2/'+${JSON.stringify(route)},${JSON.stringify(data)})`);
  const state=()=>api('state');
  const put=(selector,value)=>app.evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)}`);
  try{
    await app.viewport(1380,900);
    await app.click('#openCompute');
    await until(()=>app.evaluate('Boolean(document.querySelector("[data-act=join-wizard]"))'),'contribution');
    await shot(lab?'11-new-my-contribution':'25-gpu-clean-contribution');
    if(lab){
      await app.click('[data-mode=laboratory]');
      await shot('16-new-lab-empty');
      await app.click('[data-act=auto-lab]');
      await until(async()=>(await state()).lab?.info.running,'local HTTPS coordinator');
      await api('profile',{profile_id:'tiny-test-ffa-r4'});
      await app.click('[data-act=lab-nav][data-arg=devices]');
      await app.click('[data-act=lab-join-ux]');
    }else{
      const {createCoordinatorService}=await import('../compute/coordinator/service.mjs');
      external=createCoordinatorService({dir:fs.mkdtempSync(path.join(os.tmpdir(),'kvalah-ux-admin-'))});
      await external.start({bindIp:'127.0.0.1',port:0});
      await app.click('[data-act=join-wizard]');
      await until(()=>app.evaluate('Boolean(document.querySelector("#kcInvitation"))'),'invitation wizard');
      await shot('12-new-invitation');
      await put('#kcInvitation',external.createPairing().pairing);
      await app.click('[data-act=submit-invitation]');
    }
    await until(async()=>{
      const error=await app.evaluate('document.querySelector("[data-dialog-error]")?.textContent');
      if(error)throw Error(error);
      return app.evaluate('Boolean(document.querySelector("#kcAgree"))');
    },'consent',15000);
    await shot(lab?'17-new-self-join':'13-new-consent');
    // An isolated, attended benchmark, with AC, thermal and RAM protections still enforced.
    const before=await state();
    await api('policy',{revision:before.policy.revision,policy:{only_idle:false}});
    await app.click('#kcAgree');
    await app.click('#kcAccept');
    if(!lab){
      const first=await until(async()=>{
        const p=external.coord.listDevices().find(d=>d.state==='pending');
        const s=await state();
        return s.preparation.status==='waiting'&&p;
      },'awaiting administrator approval');
      await shot('14-new-approval-pending');
      external.coord.approveDevice(first.id);
    }
    const prepared=await until(async()=>{
      const s=await state();
      if(s.preparation?.status==='blocked')throw Error(JSON.stringify({stage:s.preparation,preflight:s.preflight}));
      return s.preparation?.status==='ready'&&s.worker?s:null;
    },'runtime, model and real preflight',lab?110000:180000);
    assert.equal(prepared.preflight.ok,true);
    assert.equal(prepared.link.device_state,'active');
    await until(()=>app.evaluate('document.querySelector(".kc-hero h2")?.textContent.includes("готово")'),'ready rendered');
    await shot(lab?'18-new-cpu-ready':'15-new-gpu-ready');
    await app.click('[data-expand=policy] > summary');
    await shot(lab?'19-new-advanced':'26-gpu-advanced');
    await app.click('[data-expand=policy] > summary');
    if(!lab){
      await app.viewport(900,760);
      await shot('27-new-narrow');
      await app.viewport(450,760);
      await shot('28-new-zoom-layout');
      await app.evaluate('document.documentElement.dataset.theme="dark"');
      await shot('29-new-dark');
    }else{
      const {createIdentity,fileSecretBox}=await import('../compute/worker/identity.mjs');
      const {pairWithCoordinator}=await import('../compute/worker/pair.mjs');
      const {createWorker}=await import('../compute/worker/worker.mjs');
      const {createGovernor}=await import('../compute/governor/governor.mjs');
      for(const label of ['Узел B','Узел C']){
        const folder=fs.mkdtempSync(path.join(os.tmpdir(),'kvalah-ux-worker-'));
        const identity=await createIdentity(path.join(folder,'identity'),fileSecretBox);
        const invitation=await api('lab/pairing',{});
        const link=await pairWithCoordinator({pairing:invitation.pairing,identity,alias:label});
        await api('lab/approve',{id:identity.device_id});
        const gov=createGovernor({stateDir:folder,policy:{only_ac:false,only_idle:false,pause_on_games:false,gpu_target_pct:100,profile:'full'}});
        gov.setEnabled(true);
        const ram=()=>gov.setSensors({ram_free_bytes:8*2**30});
        ram();
        const timer=setInterval(ram,3000);timer.unref();
        const worker=createWorker({stateDir:folder,identity,link,governor:gov,
          runtime:{python:py,backend:'torch-cpu-test',model_dir:model,files_digest:prepared.model.files_digest,profile_id:prepared.profile.id,variant_id:'cpu-test'},
          capabilities:()=>({backend:'torch-cpu-test',preflight_ok:true,preflight_max_length:256,
            variants:[{profile_id:prepared.profile.id,variant_id:'cpu-test',files_digest:prepared.model.files_digest}]})});
        workers.push(async()=>{clearInterval(timer);await worker.stop();});
        worker.start();
      }
      await app.click('[data-mode=laboratory]');
      await until(async()=>(await state()).lab.smoke.ready,'three distinct eligible workers',45000);
      await app.click('[data-act=lab-nav][data-arg=overview]');
      await shot('20-new-lab-overview');
      await app.click('[data-act=lab-nav][data-arg=devices]');
      await shot('21-new-lab-devices');
      await app.click('[data-act=lab-nav][data-arg=data]');
      await shot('22-new-lab-models');
      await app.click('[data-act=new-experiment]');
      await shot('23-new-experiment-wizard');
      await app.click('[data-act=show-smoke]');
      await app.click('#kcSmokeUnverified');
      await shot('24-new-smoke-readiness');
      await app.click('[data-act=smoke-start]');
      const result=await until(async()=>{
        const s=await state(),e=s.lab.experiments[0];
        if(e?.state==='BLOCKED')throw Error('Smoke blocked: '+JSON.stringify(e.blocker));
        return e?.state==='COMPLETED'&&e.eval?.rounds?.[2]?.status==='DONE'?e:null;
      },'real Smoke with two committed rounds',210000);
      assert.equal(result.committed_rounds,2);
      const rounds=await api('lab/experiment/status',{id:result.id});
      assert.equal(rounds.rounds.filter(r=>r.state==='COMMITTED').flatMap(r=>r.accepted).length,6);
      await shot('30-new-experiment-monitor');
      fs.writeFileSync(path.join(out,'cpu-smoke-summary.json'),JSON.stringify({
        state:result.state,committed_rounds:result.committed_rounds,accepted_updates:6,evaluation:result.eval,
        devices:rounds.rounds[0].accepted.length,fixture:'tiny CPU PyTorch'
      },null,2));
    }
    assert.deepEqual(app.errors,[]);
    fs.writeFileSync(path.join(out,kind+'-onboarding-summary.json'),JSON.stringify({
      linked:prepared.link.device_state,ready:prepared.preparation.status,worker:prepared.worker.state,
      preflight:{ok:prepared.preflight.ok,backend:prepared.preflight.backend,max_length:prepared.preflight.max_length,step_s:prepared.preflight.step_s,
        model_load_s:prepared.preflight.model_load_s,info:prepared.preflight.info},
      checked_at:new Date().toISOString(),screenshots:'Native Electron via CDP',synthetic:lab
    },null,2));
  }catch(error){
    const visible=await app.evaluate('document.querySelector("#computeConsent[open]")?.textContent||document.querySelector("#computeContent")?.textContent').catch(()=>null);
    const raw=await state().catch(()=>null);
    fs.writeFileSync(path.join(out,kind+'-failure.json'),JSON.stringify({error:error.message,visible,phase:raw?.preparation,missing:raw?.missing,errors:app.errors},null,2));
    throw error;
  }finally{
    await Promise.allSettled(workers.map(stop=>stop()));
    app.quit();
    await external?.close();
  }
}

if(process.argv[2]==='reference')await reference(...process.argv.slice(3).map(p=>path.resolve(p)));
if(process.argv[2]==='candidate'){
  const [out,exe,source,kind]=process.argv.slice(3);
  await candidate(path.resolve(out),path.resolve(exe),source==='package'?source:path.resolve(source),kind);
}

if(process.argv[2]==='revisit'){
  const [output,binary,root]=process.argv.slice(3).map(p=>path.resolve(p));
  const app=await launch(binary,{env:{KVALAH_TEST_ROOT:root,KVALAH_COMPUTE_TEST:'1'},root});
  try{
    await until(()=>app.evaluate('Boolean(window.kvCompute&&document.querySelector("#openCompute"))'),'packaged Electron');
    await app.viewport(1380,900);
    await app.click('#openCompute');
    await app.click('[data-mode=laboratory]');
    await app.click('[data-act=lab-nav][data-arg=data]');
    await until(()=>app.evaluate('document.querySelector("#computeContent").textContent.includes("cpu-test")'),'registered test model shown');
    await app.shot(path.join(output,'22-new-lab-models.png'));
    await app.click('[data-act=lab-nav][data-arg=experiments]');
    await app.shot(path.join(output,'31-new-experiments.png'));
    await app.click('[data-act=exp-monitor]');
    await until(()=>app.evaluate('document.querySelector(".kc-monitor-progress")?.value===2'),'committed Smoke monitor');
    await app.shot(path.join(output,'30-new-experiment-monitor.png'));
    await app.click('[data-mode=contribution]');
    for(const [name,width,scaleDark] of [
      ['27-new-narrow',900,false],['28-new-zoom-layout',450,false],['29-new-dark',450,true]
    ]){
      await app.viewport(width,760);
      await app.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(scaleDark?'dark':'light')}`);
      await delay(250);
      const sizes=await app.evaluate('({scroll:document.querySelector("#computeBody").scrollWidth,width:document.querySelector("#computeBody").clientWidth,sidebar:getComputedStyle(document.querySelector("#sidebar")).display})');
      assert.ok(sizes.scroll<=sizes.width+1,JSON.stringify(sizes));
      if(width===450)assert.equal(sizes.sidebar,'none');
      await app.shot(path.join(output,name+'.png'));
    }
    assert.deepEqual(app.errors,[]);
  }finally{app.quit();}
}

if(process.argv[2]==='deep-link'){
  const executable=path.resolve(process.argv[3]);
  const {pairingString}=await import('../compute/worker/client.mjs');
  const url=pairingString({endpoint:'https://127.0.0.1:1',fingerprint:'aa'.repeat(32),code:'test-only'});
  const app=await desktop(executable,[url]);
  try{
    const field=await until(()=>app.evaluate('document.querySelector("#kcInvitation")?.value'),'cold-start invitation');
    assert.equal(field,url);
    const state=await app.evaluate('api("/api/compute/v2/state")');
    assert.equal(state.participation,false);
    assert.equal(state.link,null);
    assert.equal(state.runtime,null);
    assert.deepEqual(app.errors,[]);
    console.log('PASS packaged desktop deep link opens the invitation dialog without enrolling');
  }finally{app.quit();}
}
