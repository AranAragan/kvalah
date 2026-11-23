// Browser test of Settings → Devices → Pool memory (headless Chrome over CDP; skipped when Chrome is missing).
// Regression for 0.8.0: the screen re-renders every 2.5 s, which dropped the model picked in "From Ollama",
// so "Start pool" sent no model and failed with "Choose an existing GGUF model file".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
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

test('Pool memory: the model picked in "From Ollama" survives re-renders and reaches the server',{skip:!chrome&&'Chrome not found',timeout:90000},async()=>{
  const root=await tempDir(),store=path.join(root,'ollama'),hex='a'.repeat(64);
  await fs.mkdir(path.join(store,'blobs'),{recursive:true});
  await fs.writeFile(path.join(store,'blobs','sha256-'+hex),Buffer.concat([Buffer.from('GGUF'),Buffer.alloc(64)]));
  const mf=path.join(store,'manifests','registry.ollama.ai','library','qwen2.5-coder','14b');
  await fs.mkdir(path.dirname(mf),{recursive:true});
  await fs.writeFile(mf,JSON.stringify({layers:[{mediaType:'application/vnd.ollama.image.model',digest:'sha256:'+hex,size:68}]}));
  await fs.mkdir(path.join(root,'ws'));
  const model=await mockModel(async()=>({content:'ok'}));
  const app=await startApp({modelUrl:model.url,data:path.join(root,'d'),workspace:path.join(root,'ws'),env:{KVALAH_LANG:'en',OLLAMA_MODELS:store,KVALAH_DISCOVERY_PORT:String(await freePort())}});
  const port=await freePort();
  const browser=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port='+port,'--user-data-dir='+path.join(root,'chrome'),'about:blank'],{stdio:'ignore'});
  let ws;
  try{
    let version;
    for(let i=0;i<100&&!version;i++){try{version=await (await fetch('http://127.0.0.1:'+port+'/json/version')).json();}catch{await sleep(200);}}
    ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
    let id=0;const pending=new Map();
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
    const send=(method,params={},sessionId)=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method,params,sessionId}));});
    const {result:{targetId}}=await send('Target.createTarget',{url:'about:blank'});
    const {result:{sessionId}}=await send('Target.attachToTarget',{targetId,flatten:true});
    await send('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('kvalah-lang','en')"},sessionId);
    await send('Page.navigate',{url:app.origin+'/#token='+app.token},sessionId);
    const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
    const waitFor=async(expr,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await ev('!!('+expr+')'))return;await sleep(150);}throw Error('timeout: '+expr);};
    await waitFor("typeof window.openDevices==='function'");
    // Opening straight on the Pool tab loads the Ollama list too (0.8.0 only loaded it on a tab click).
    await ev("window.openDevices('pool')");
    await waitFor("document.querySelector('#poolGguf')?.options.length===2");
    await ev("(()=>{const s=document.querySelector('#poolGguf');s.focus();s.value='qwen2.5-coder:14b';s.dispatchEvent(new Event('change'));const c=document.querySelector('#poolCtx');c.value='65536';c.dispatchEvent(new Event('change'));document.querySelector('#poolLocal').focus();})()");
    await sleep(3200); // longer than the 2.5 s refresh
    assert.equal(await ev("document.querySelector('#poolGguf').value"),'qwen2.5-coder:14b');
    assert.equal(await ev("document.querySelector('#poolCtx').value"),'65536');
    assert.match(await ev("document.querySelector('#devicesBody').innerText"),new RegExp('Ollama keeps model files in '+path.join(store,'blobs').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    await ev("document.querySelector('#poolStart').click()");
    await waitFor("document.querySelector('#devicesError').textContent");
    // Past model resolution: the next precondition (llama.cpp) is what fails here.
    assert.match(await ev("document.querySelector('#devicesError').textContent"),/llama\.cpp is not installed/);
    const pool=(await app.api('/api/devices')).body.pool;
    assert.equal(pool.ollamaModel,'qwen2.5-coder:14b');assert.equal(pool.ctx,65536);
  }finally{ws?.close();browser.kill();await app.stop();await model.close();}
});
