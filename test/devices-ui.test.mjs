// Browser test of Settings → Devices → Pool memory (headless Chrome over CDP; skipped when Chrome is missing).
// Regression for 0.8.0: the screen re-renders every 2.5 s, which dropped the model picked in "From Ollama",
// so "Start pool" sent no model and failed with "Choose an existing GGUF model file".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {startApp,tempDir,mockModel,freePort} from './helpers.mjs';

function findChrome(){
  for(const c of [process.env.CHROME_PATH,'google-chrome-stable','google-chrome','chromium','chromium-browser'].filter(Boolean)){
    try{execFileSync(c,['--version'],{stdio:'ignore'});return c;}catch{}
  }
  return null;
}
const chrome=process.platform==='linux'?findChrome():null;

// One browser per test file; one page per scenario.
async function withBrowser(fn){
  const root=await tempDir();
  let browser,ws,version;
  try{
    // A cold Chrome on a CI runner can take a while; one retry on a fresh port.
    for(let attempt=0;attempt<2&&!version;attempt++){
      browser?.kill();
      const port=await freePort();
      browser=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port='+port,'--user-data-dir='+path.join(root,'chrome'+attempt),'about:blank'],{stdio:'ignore'});
      for(let i=0;i<225&&!version;i++){try{version=await (await fetch('http://127.0.0.1:'+port+'/json/version')).json();}catch{await sleep(200);}}
    }
    if(!version)throw Error('Chrome did not start');
    ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
    let id=0;const pending=new Map();
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
    const send=(method,params={},sessionId)=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method,params,sessionId}));});
    async function page(app){
      const {result:{targetId}}=await send('Target.createTarget',{url:'about:blank'});
      const {result:{sessionId}}=await send('Target.attachToTarget',{targetId,flatten:true});
      await send('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('kvalah-lang','en')"},sessionId);
      await send('Page.navigate',{url:app.origin+'/#token='+app.token},sessionId);
      const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
      const waitFor=async(expr,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await ev('!!('+expr+')'))return;await sleep(150);}throw Error('timeout: '+expr+'\n'+await ev("document.querySelector('#devicesBody')?.innerText"));};
      await waitFor("typeof window.openDevices==='function'");
      return {ev,waitFor};
    }
    return await fn(page);
  }finally{ws?.close();browser?.kill();}
}
async function ggufStore(dir,models){
  for(const [name,tag,hex] of models){
    await fs.mkdir(path.join(dir,'blobs'),{recursive:true});
    await fs.writeFile(path.join(dir,'blobs','sha256-'+hex),Buffer.concat([Buffer.from('GGUF'),Buffer.alloc(64)]));
    const mf=path.join(dir,'manifests','registry.ollama.ai','library',name,tag);
    await fs.mkdir(path.dirname(mf),{recursive:true});
    await fs.writeFile(mf,JSON.stringify({layers:[{mediaType:'application/vnd.ollama.image.model',digest:'sha256:'+hex,size:68}]}));
  }
}
// Minimal Ollama: /api/tags and /api/show (modelfile with the blob path), like the real one.
async function mockOllama(models){
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    if(req.url==='/api/tags'){res.end(JSON.stringify({models:models.map(m=>({name:m.name,size:9e9}))}));return;}
    if(req.url==='/api/show'){const m=models.find(x=>x.name===JSON.parse(raw||'{}').model);if(!m){res.statusCode=404;res.end('{}');return;}res.end(JSON.stringify({modelfile:'# FROM '+m.name+'\nFROM '+m.path+'\n'}));return;}
    res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>server.close(r))};
}
async function app0({store,ollamaUrl,root}){
  await fs.mkdir(path.join(root,'ws'),{recursive:true});
  const model=await mockModel(async()=>({content:'ok'}));
  const app=await startApp({modelUrl:model.url,data:path.join(root,'d'),workspace:path.join(root,'ws'),env:{KVALAH_LANG:'en',OLLAMA_MODELS:store,OLLAMA_URL:ollamaUrl,KVALAH_DISCOVERY_PORT:String(await freePort())}});
  // The chat runs on an OpenAI-compatible server (like the pool on :8080): the Ollama list must not care.
  const s=(await app.api('/api/state')).body.settings;
  const saved=await app.api('/api/settings',{...s,provider:'openai',baseUrl:'http://127.0.0.1:9/v1'});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  return {app,close:async()=>{await app.stop();await model.close();}};
}
const DEAD='http://127.0.0.1:9'; // nothing listens on the discard port

test('Pool memory UI: list from disk without Ollama, path filled on pick, choice survives re-renders',{skip:!chrome&&'Chrome not found',timeout:150000},async()=>{
  const root=await tempDir(),store=path.join(root,'ollama');
  await ggufStore(store,[['qwen2.5-coder','14b','a'.repeat(64)],['qwen3.5','9b-q4_K_M','b'.repeat(64)]]);
  const {app,close}=await app0({store,ollamaUrl:DEAD,root});
  try{
    await withBrowser(async page=>{
      const {ev,waitFor}=await page(app);
      // Opening straight on the Pool tab loads the list (0.8.0 only loaded it on a tab click).
      await ev("window.openDevices('pool')");
      await waitFor("document.querySelector('#poolGguf')?.options.length===3");
      const body=await ev("document.querySelector('#devicesBody').innerText");
      assert.match(body,new RegExp('Ollama is not running at '+DEAD.replace(/[.]/g,'\\.')));assert.match(body,/Found 2 in the model folder/);
      await ev("(()=>{const s=document.querySelector('#poolGguf');s.focus();s.value='qwen3.5:9b-q4_K_M';s.dispatchEvent(new Event('change'));const c=document.querySelector('#poolCtx');c.value='65536';c.dispatchEvent(new Event('change'));document.querySelector('#poolLocal').focus();})()");
      const blob=path.join(store,'blobs','sha256-'+'b'.repeat(64));
      await waitFor(`document.querySelector('#poolModel').value===${JSON.stringify(blob)}`);
      await sleep(3200); // longer than the 2.5 s refresh
      assert.equal(await ev("document.querySelector('#poolGguf').value"),'qwen3.5:9b-q4_K_M');
      assert.equal(await ev("document.querySelector('#poolModel').value"),blob,'the resolved GGUF path stays visible');
      assert.equal(await ev("document.querySelector('#poolCtx').value"),'65536');
      await ev("document.querySelector('#poolStart').click()");
      await waitFor("document.querySelector('#devicesError').textContent");
      assert.match(await ev("document.querySelector('#devicesError').textContent"),/llama\.cpp is not installed/,'past model resolution');
      const pool=(await app.api('/api/devices')).body.pool;
      assert.equal(pool.ollamaModel,'qwen3.5:9b-q4_K_M');assert.equal(pool.model,blob);assert.equal(pool.ctx,65536);
      // Reopened later: the saved choice and its path are shown again.
      await ev("document.querySelector('#devicesDialog').close();window.openDevices('pool')");
      await waitFor("document.querySelector('#poolGguf')?.options.length===3");
      assert.equal(await ev("document.querySelector('#poolGguf').value"),'qwen3.5:9b-q4_K_M');
      assert.equal(await ev("document.querySelector('#poolModel').value"),blob);
    });
  }finally{await close();}
});

test('Pool memory UI: models only the Ollama API knows (another store) are listed and resolved',{skip:!chrome&&'Chrome not found',timeout:150000},async()=>{
  const root=await tempDir(),store=path.join(root,'empty-store'),other=path.join(root,'D','ollama-models');
  await fs.mkdir(store,{recursive:true});
  await ggufStore(other,[['llama3.1','8b','c'.repeat(64)]]);
  const blob=path.join(other,'blobs','sha256-'+'c'.repeat(64));
  const ollama=await mockOllama([{name:'llama3.1:8b',path:blob}]);
  const {app,close}=await app0({store,ollamaUrl:ollama.url,root});
  try{
    const listed=(await app.api('/api/devices/gguf')).body;
    assert.deepEqual(listed.models.map(m=>[m.name,m.path]),[['llama3.1:8b',blob]]);assert.equal(listed.ollama.reachable,true);assert.equal(listed.ollama.url,ollama.url);
    assert.equal((await app.api('/api/devices/gguf/resolve',{name:'llama3.1:8b'})).body.path,blob);
    assert.match((await app.api('/api/devices/gguf/resolve',{name:'nope:1b'})).body.error,/Ollama model nope:1b/);
    await withBrowser(async page=>{
      const {ev,waitFor}=await page(app);
      await ev("window.openDevices('pool')");
      await waitFor("document.querySelector('#poolGguf')?.options.length===2");
      await ev("(()=>{const s=document.querySelector('#poolGguf');s.value='llama3.1:8b';s.dispatchEvent(new Event('change'));})()");
      await waitFor(`document.querySelector('#poolModel').value===${JSON.stringify(blob)}`);
    });
  }finally{await close();await ollama.close();}
});

test('Pool memory UI: empty list says why (Ollama not running, nothing in the folder) and can be refreshed',{skip:!chrome&&'Chrome not found',timeout:150000},async()=>{
  const root=await tempDir(),store=path.join(root,'ollama');await fs.mkdir(store,{recursive:true});
  const {app,close}=await app0({store,ollamaUrl:DEAD,root});
  try{
    await withBrowser(async page=>{
      const {ev,waitFor}=await page(app);
      await ev("window.openDevices('pool')");
      await waitFor("/not running/.test(document.querySelector('#poolGguf')?.options[0]?.textContent||'')");
      assert.equal(await ev("document.querySelector('#poolGguf').options.length"),1);
      const body=await ev("document.querySelector('#devicesBody').innerText");
      assert.match(body,new RegExp('No Ollama models found in '+store.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
      // Pull a model, press refresh: it appears without reopening.
      await ggufStore(store,[['qwen2.5-coder','14b','d'.repeat(64)]]);
      await ev("document.querySelector('#poolGgufReload').click()");
      await waitFor("document.querySelector('#poolGguf')?.options.length===2");
    });
  }finally{await close();}
});

test('Sidebar activity indicator: live CPU/RAM/network, idle state, click opens Devices',{skip:!chrome&&'Chrome not found',timeout:150000},async()=>{
  const root=await tempDir(),store=path.join(root,'ollama');
  const {app,close}=await app0({store,ollamaUrl:DEAD,root});
  try{
    await withBrowser(async page=>{
      const {ev,waitFor}=await page(app);
      await waitFor("/CPU \\d+% · RAM [\\d.]+\\/[\\d.]+ GB/.test(document.querySelector('#activityRes')?.textContent||'')");
      assert.equal(await ev("document.querySelector('#activityRole').textContent"),'Idle');
      assert.match(await ev("document.querySelector('#activityNet').textContent"),/↑ \d+ KB\/s ↓ \d+ KB\/s/);
      assert.ok(await ev("document.querySelector('#activity').classList.contains('idle')"));
      // Directly above "On your computer".
      assert.ok(await ev("document.querySelector('#activity').nextElementSibling.classList.contains('device')"));
      for(const theme of ['light','dark']){
        await ev(`document.documentElement.dataset.theme='${theme}'`);
        const color=await ev("getComputedStyle(document.querySelector('#activityRole')).color");
        assert.notEqual(color,await ev("getComputedStyle(document.querySelector('#activity')).backgroundColor"),theme+': text is visible');
      }
      await ev("document.querySelector('#activity').click()");
      await waitFor("document.querySelector('#devicesDialog').open");
    });
  }finally{await close();}
});
