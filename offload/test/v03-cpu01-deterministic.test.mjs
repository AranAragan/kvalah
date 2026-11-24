// CPU-01 regression: deterministic ops never block the event loop (worker thread with timeout + memory
// limit, terminated on cancel), and results state their precision and incompleteness honestly.
import test from 'node:test';
import assert from 'node:assert/strict';
import {workspace,smartMock} from './helpers.mjs';
import {createKvalahOffload} from '../compute/index.mjs';

const env=(root,extra={})=>({KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',...extra});
// measure the worst event-loop stall while fn runs
async function maxLag(fn){
  let worst=0,last=performance.now(),stop=false;
  const tick=()=>{const now=performance.now();worst=Math.max(worst,now-last-20);last=now;if(!stop)t=setTimeout(tick,20);};let t=setTimeout(tick,20);
  let res,err;try{res=await fn();}catch(e){err=e;}stop=true;clearTimeout(t);
  return {worst,res,err};
}

test('CPU-01: pathological regex does not block status; it times out and the worker is replaced', async()=>{
  const root=await workspace({'evil.txt':'a'.repeat(36)+'b\n','ok.txt':'hello\n'});
  const app=await createKvalahOffload({env:env(root,{KVALAH_DET_TIMEOUT_MS:'1500'}),provider:smartMock()});
  try{
    let statusMs=null;
    const {worst,err}=await maxLag(async()=>{
      const p=app.compute({op:'search',pattern:'^(a|aa)+$',regex:true});
      await new Promise(r=>setTimeout(r,200));
      const s0=performance.now();await app.status();statusMs=performance.now()-s0;
      return p;
    });
    assert.ok(worst<400,`event loop blocked for ${Math.round(worst)}ms`);
    assert.ok(statusMs<400,'status blocked: '+statusMs);
    assert.ok(err&&/timeout|time limit/i.test(err.message),'expected a timeout, got '+(err?.message));
    const r=await app.compute({op:'search',pattern:'hello'});assert.equal(r.matches.length,1,'worker not replaced after timeout');
  }finally{await app.close();}
});

test('CPU-01: cancel terminates the running worker promptly', async()=>{
  const root=await workspace({'evil.txt':'a'.repeat(40)+'b\n'});
  const app=await createKvalahOffload({env:env(root,{KVALAH_DET_TIMEOUT_MS:'60000'}),provider:smartMock()});
  try{
    const ac=new AbortController();const t0=performance.now();
    const p=app.compute({op:'search',pattern:'^(a|aa)+$',regex:true},{signal:ac.signal});
    setTimeout(()=>ac.abort(),150);
    await assert.rejects(p,/abort|cancel/i);
    assert.ok(performance.now()-t0<1500,'cancel took too long');
    assert.ok(app.det.stats().terminated>=1,'worker was not terminated');
  }finally{await app.close();}
});

test('CPU-01: precision and completeness are explicit (textual references, parse errors, dynamic imports, aliases, skipped files)', async()=>{
  const root=await workspace({
    'src/a.js':"import {b} from './b.js';\nexport const a=()=>b();\nconst m=await import(name);\n",
    'src/b.js':"import {a} from './a.js';\nimport u from '@/utils';\nexport function b(){return a;}\n",
    'src/broken.js':'export function ok( {\n  return 1;\n',
    'bin.dat':Buffer.from([0,1,2,3]),
  });
  const app=await createKvalahOffload({env:env(root),provider:smartMock()});
  try{
    const refs=await app.compute({op:'references',name:'b'});assert.equal(refs.precision,'textual');
    const deps=await app.compute({op:'deps'});
    assert.equal(deps.complete,false,'graph claims completeness');assert.ok(deps.incomplete.dynamicImports>=1);assert.ok(deps.incomplete.aliasImports>=1);
    assert.ok(deps.cycles.some(c=>c.includes('src/a.js')&&c.includes('src/b.js')));
    const o=await app.compute({op:'outline',path:'src/broken.js'});assert.ok(o.parseErrors>0||o.approximate,'parse problems hidden');
    const s=await app.compute({op:'search',pattern:'zzz'});assert.ok(s.skipped&&s.skipped.binary>=1,'skipped files not reported: '+JSON.stringify(s));
    const sym=await app.compute({op:'symbols',name:'b'});assert.equal(sym.precision,'syntactic');
  }finally{await app.close();}
});
