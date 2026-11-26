import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createSetup} from '../compute/onboarding.mjs';
import {downloadAssets,runtimeAssets} from '../compute/setup-assets.mjs';
import {parsePairing,pairingString} from '../compute/worker/client.mjs';

test('automatic setup does not touch the runtime before consent or coordinator approval',async()=>{
  const calls=[];
  let consent=false,approved=false,signal;
  const setup=createSetup({
    now:Date.now,hasConsent:()=>consent,readLink:()=>({device_state:approved?'active':'pending'}),
    refreshLink:s=>{signal=s;calls.push('approval');},
    candidates:()=>({backend:'test',variant:'test',runtimes:['python'],models:['model']}),
    useRuntime:async()=>{calls.push('runtime');return true;},useModel:async()=>true,
    runPreflight:async()=>true,activate:async()=>{}
  });
  setup.start();
  assert.equal(setup.state.reason,'CONSENT_REQUIRED');
  assert.deepEqual(calls,[]);
  await Promise.resolve();
  consent=true;
  setup.start();
  await Promise.resolve();
  assert.equal(setup.state.reason,'pending_approval');
  assert.deepEqual(calls,['approval']);
  await setup.cancel();
  assert.equal(signal.aborted,true);
  assert.equal(setup.state.status,'cancelled');
  assert.deepEqual(calls,['approval']);
});

test('pairing parser accepts only the exact invitation URI shape',()=>{
  const uri=pairingString({endpoint:'https://127.0.0.1:8888',fingerprint:Array(32).fill('aa').join(':'),code:'123'});
  assert.equal(parsePairing(uri).endpoint,'https://127.0.0.1:8888');
  for(const bad of [uri.replace('://pair?', '://other?'),uri+'&c=duplicate',uri+'#ignored','https://example.com','x'.repeat(5000)]){
    assert.throws(()=>parsePairing(bad),{code:'INVALID_SCHEMA'});
  }
});

test('Windows and macOS runtime inventories exclusively declare sized and hashed wheels',()=>{
  for(const [backend,platform,arch] of [['cuda','win32','x64'],['mlx','darwin','arm64']]){
    const plan=runtimeAssets(backend,platform,arch);
    assert.ok(plan.files.length>10);
    assert.equal(new Set(plan.files.map(x=>x.name)).size,plan.files.length);
    for(const w of plan.files)assert.ok(w.name.endsWith('.whl')&&w.size>0&&/^[a-f0-9]{64}$/.test(w.hash));
  }
  assert.equal(runtimeAssets('mlx','win32','x64'),null);
});

test('artifact transfer requires size approval, respects the budget, resumes exact bytes and verifies integrity',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kc-assets-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('content verified by digest'),hash=createHash('sha256').update(bytes).digest('hex');
  const files=[{name:'test.safetensors',size:bytes.length,hash,algorithm:'sha256',url:'https://huggingface.co/example'}];
  const plan={id:'one',kind:'model',files};
  let got=[],budget=7,consent=false,payload=bytes;
  t.mock.method(globalThis,'fetch',async (_url,o)=>{
    const range=o.headers.Range;
    got.push(range);
    if(!range)return new Response(payload);
    const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
    return new Response(payload.subarray(a,b+1),{status:206,headers:{'content-range':`bytes ${a}-${b}/${bytes.length}`}});
  });
  const governor={decide:()=>({run:true}),trafficRemaining:()=>budget,accountTraffic:n=>{budget-=n;}};
  const options={root,governor,signal:new AbortController().signal,approve:()=>consent,progress:()=>{}};
  await assert.rejects(downloadAssets(plan,options),{code:'DOWNLOAD_APPROVAL'});
  assert.equal(got.length,0);
  consent=true;
  await assert.rejects(downloadAssets(plan,options),{code:'PAUSED'});
  assert.equal(budget,0);
  budget=bytes.length;
  const folder=await downloadAssets(plan,options);
  assert.deepEqual(got,['bytes=0-6','bytes=7-'+(bytes.length-1)]);
  assert.deepEqual(fs.readFileSync(path.join(folder,files[0].name)),bytes);
  payload=Buffer.alloc(bytes.length,1);
  budget=bytes.length;
  await assert.rejects(downloadAssets({...plan,id:'tampered'},options),{code:'HASH_MISMATCH'});
});
