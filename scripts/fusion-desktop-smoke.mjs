import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {desktop,until} from './compute-desktop-review.mjs';

const [exe,destination,...args]=process.argv.slice(2);
if(!exe||!destination)throw Error('node scripts/fusion-desktop-smoke.mjs <electron-or-kvalah> <output-dir> [app-path]');
const output=path.resolve(destination);
fs.mkdirSync(output,{recursive:true});
const app=await desktop(path.resolve(exe),args);
try{
  await app.click('#openCompute');
  await app.click('[data-mode=laboratory]');
  await app.click('[data-act=lab-nav][data-arg=fusion]');
  await until(()=>app.evaluate('!document.querySelector("#toast.show")'),'startup notification dismissed');
  await app.shot(path.join(output,'fusion-disabled.png'));
  const denied=await app.evaluate('api("/api/compute/fusion/state").then(()=>null,e=>e.code)');
  assert.equal(denied,'DISABLED');
  await app.click('[data-act=feature-on]');
  await app.click('[data-act=fusion-enable]');
  await until(()=>app.evaluate('Boolean(document.querySelector("[data-act=fusion-nav][data-arg=architecture]"))'),'Fusion laboratory');
  await app.shot(path.join(output,'fusion-overview.png'));
  await app.click('[data-act=fusion-nav][data-arg=architecture]');
  await app.click('[data-act=fusion-estimate]');
  await until(()=>app.evaluate('document.querySelector("#computeContent")?.textContent.includes("FP16 checkpoint")'),'tensor estimate');
  await app.shot(path.join(output,'fusion-architecture.png'));
  await app.viewport(450,760);
  const size=await app.evaluate('({scroll:document.querySelector("#computeBody").scrollWidth,width:document.querySelector("#computeBody").clientWidth})');
  assert.ok(size.scroll<=size.width+1,JSON.stringify(size));
  await app.shot(path.join(output,'fusion-architecture-450.png'));
  await app.click('[data-act=fusion-nav][data-arg=experts]');
  const input={key:'code',name:'Code fixture',domain:'code',kind:'ffa-lora',
    base:{revision:'reference',backbone_sha256:'a'.repeat(64),tokenizer_sha256:'b'.repeat(64),architecture_sha256:'c'.repeat(64),layers:4,width:4,parameters:400},
    layers:[1],tensors:[{name:'layers.1.mlp.A',shape:[1,4],dtype:'F32'},{name:'layers.1.mlp.B',shape:[4,1],dtype:'F32'}],rank:1,alpha:2,
    training:{optimizer:'sgd',lr:0.1,local_steps:1,grad_accum:1,clip:1},dataset_sha256:'d'.repeat(64),license:'CC0-1.0'};
  await app.evaluate(`(()=>{const input=document.querySelector('#fxSpec');input.value=${JSON.stringify(JSON.stringify(input))};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await app.click('[data-act=fusion-create]');
  await until(()=>app.evaluate('document.querySelector("#computeContent h3")?.textContent==="Code fixture"'),'new expert record');
  await app.shot(path.join(output,'fusion-experts.png'));
  await app.click('[data-act=fusion-archive]');
  await until(()=>app.evaluate('document.querySelector("#computeContent")?.textContent.includes("ARCHIVED")'),'expert archive');
  assert.deepEqual(app.errors,[]);
  console.log('Fusion desktop smoke passed');
}finally{app.quit();}
