// CLI (compute/cli.mjs): headless lab run with this machine as the only worker, then verify-report and the
// v0.1 legacy import. Same controller as the app; CPU tiny model; no downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {ROOT,python,tinyModel,tmp,v01Zip} from './compute-helpers.mjs';
const CLI=path.join(ROOT,'compute','cli.mjs');
const run=(args,timeout=240000)=>spawnSync(process.execPath,[CLI,...args],{encoding:'utf8',timeout,env:{...process.env,KVALAH_COMPUTE_TEST:'1'}});
const PY=['torch','transformers','tokenizers'];
test('cli run → report → verify-report',{skip:python(PY)?false:'no torch runtime',timeout:300000},()=>{
  const d=tmp('kc-cli-'),rep=tmp('kc-cli-rep-'),cfg=path.join(d,'exp.json');
  fs.writeFileSync(cfg,JSON.stringify({name:'cli',preset:'smoke',profile_id:'tiny-test-ffa-r4',variants:['cpu-test'],local_steps:1,quorum:{mode:'all',target:1}}));
  const r=run(['run','--dir',path.join(d,'state'),'--profile','tiny-test-ffa-r4','--bind','127.0.0.1','--port','0','--python',python(PY),'--backend','torch-cpu-test','--model-dir',tinyModel(),'--variant','cpu-test','--config',cfg,'--fixture','--join-self','--i-consent','--no-idle','--no-ac','--no-games','--report-dir',rep,'--weights','--json']);
  assert.equal(r.status,0,r.stderr.slice(-2000));
  const zip=fs.readdirSync(rep).find(f=>f.endsWith('.zip'));assert.ok(zip);
  const v=run(['verify-report','--dir',path.join(d,'state'),'--file',path.join(rep,zip),'--json']);
  assert.equal(v.status,0,v.stdout+v.stderr);assert.match(v.stdout,/"ok": true/);
  // Without --i-consent the worker part refuses and prints the consent text.
  const n=run(['run','--dir',path.join(d,'state2'),'--profile','tiny-test-ffa-r4','--bind','127.0.0.1','--port','0','--python',python(PY),'--backend','torch-cpu-test','--model-dir',tinyModel(),'--variant','cpu-test','--config',cfg,'--fixture','--join-self']);
  assert.notEqual(n.status,0);assert.match(n.stderr,/--i-consent/);
});
test('cli legacy-import reproduces v0.1',{skip:v01Zip()?false:'KVALAH_V01_ZIP not set'},()=>{
  const r=run(['legacy-import','--dir',tmp('kc-cli-l-'),'--file',v01Zip(),'--json']);
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/"verified_all": true/);
});
