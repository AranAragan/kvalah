// CACHE-01 regression: key scope, atomic concurrent writes, strict disk quota, LRU on access,
// private permissions, per-workspace clearing, corrupt entries, and no disk cache for sensitive tasks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,stat,writeFile,mkdir,chmod,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {smartMock,workspace,engine} from './helpers.mjs';
import {createCache} from '../compute/cache.mjs';
const run=promisify(execFile);

async function walkFiles(dir){const out=[];for(const s of await readdir(dir).catch(()=>[])){const p=path.join(dir,s);const st=await stat(p);if(st.isDirectory())out.push(...await walkFiles(p));else out.push({p,size:st.size,mode:st.mode&0o777});}return out;}
const task={kind:'logs',instruction:'errors',paths:['a.log']};

test('CACHE-01: workspace, model revision, parameters, policy and TTL all change the key', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'kvo3-c1-'));
  const r1=await workspace({'a.log':'ERROR x\n'}),r2=await workspace({'a.log':'ERROR x\n'});
  let clock=1000;const now=()=>clock;
  const mk=(root,o={})=>{const p=smartMock();return {p,e:engine({root,provider:p,cache:createCache({dir,now,ttlMs:10000}),now,...o})};};
  const a=mk(r1);await a.e.delegate(task);
  const same=mk(r1);assert.equal((await same.e.delegate(task)).cached,true,'baseline: same scope must hit');
  for(const [why,x] of [['other workspace',mk(r2)],['model revision',mk(r1,{modelDigest:'sha256:new'})],['maxTokens',mk(r1,{maxTokens:1024})],['secret policy',mk(r1,{secretPolicy:'block'})]]){
    const r=await x.e.delegate(task);assert.equal(r.cached,false,why+' must miss');assert.equal(x.p.calls.length>0,true);
  }
  clock+=20000;const late=mk(r1);assert.equal((await late.e.delegate(task)).cached,false,'expired TTL must miss');
});

test('CACHE-01: concurrent writes (same process and several processes) are atomic; no tmp leftovers, no errors', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'kvo3-c2-'));
  const c=createCache({dir});const v={big:'x'.repeat(50000)};
  await Promise.all(Array.from({length:30},()=>c.set('ab'+'0'.repeat(62),v)));
  assert.equal(c.stats().errors,0,'same-key concurrent writes failed');
  const script=`import {createCache} from ${JSON.stringify(new URL('../compute/cache.mjs',import.meta.url).href)};
    const c=createCache({dir:process.argv[1]});for(let i=0;i<40;i++)await c.set('cd'+String(i%5).padStart(62,'0'),{p:process.pid,i,pad:'y'.repeat(20000)});
    if(c.stats().errors)process.exit(3);`;
  await Promise.all(Array.from({length:4},()=>run(process.execPath,['--input-type=module','-e',script,dir])));
  const files=await walkFiles(dir);
  assert.ok(!files.some(f=>/\.tmp$/.test(f.p)),'tmp files left behind');
  for(const f of files.filter(f=>f.p.endsWith('.json')))JSON.parse(await readFile(f.p,'utf8'));
});

test('CACHE-01: disk quota holds after every write; eviction is LRU (access refreshes)', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'kvo3-c3-'));let clock=1;const now=()=>clock;
  const c=createCache({dir,maxBytes:20000,now,memoryEntries:1});
  const key=i=>i.toString(16).padStart(64,'0');
  await c.set(key(1),{pad:'k'.repeat(1500)});
  for(let i=2;i<40;i++){clock++;await c.set(key(i),{pad:'z'.repeat(1500)});
    if(i%3===0){clock++;c.clearMemory();assert.ok(await c.get(key(1)),'recently used entry evicted at write '+i);}
    const total=(await walkFiles(dir)).reduce((n,f)=>n+f.size,0);assert.ok(total<=20000,`quota exceeded after write ${i}: ${total}`);}
  assert.match(c.stats().policy,/lru/i);
});

test('CACHE-01: private permissions, corrupt JSON is a miss, clear per workspace', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'kvo3-c4-'));await chmod(dir,0o755);
  const c=createCache({dir});const k='ef'+'1'.repeat(62);
  await c.set(k,{v:1},{workspace:'/w/one'});await c.set('ef'+'2'.repeat(62),{v:2},{workspace:'/w/two'});
  if(process.platform!=='win32'){
    assert.equal((await stat(dir)).mode&0o777,0o700,'cache dir not private');
    for(const f of await walkFiles(dir))assert.equal(f.mode,0o600,'cache file not private: '+f.p);
  }
  const f=(await walkFiles(dir)).find(x=>x.p.includes('1'.repeat(62)));await writeFile(f.p,'{broken');
  c.clearMemory();assert.equal(await c.get(k),undefined);assert.equal(c.stats().corrupt,1);
  await c.clear({workspace:'/w/two'});c.clearMemory();assert.equal(await c.get('ef'+'2'.repeat(62)),undefined);
});

test('CACHE-01: results of tasks that contained secrets are not written to disk unless explicitly allowed', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'kvo3-c5-'));
  const root=await workspace({'a.log':'ERROR login failed password="Tr0ub4dor&3xyz"\n'});
  const e=engine({root,provider:smartMock(),cache:createCache({dir})});
  await e.delegate(task);
  assert.equal((await walkFiles(dir)).filter(f=>f.p.endsWith('.json')).length,0,'sensitive result written to disk');
  const e2=engine({root,provider:smartMock(),cache:createCache({dir}),cacheSensitive:true});
  await e2.delegate(task);
  const files=(await walkFiles(dir)).filter(f=>f.p.endsWith('.json'));assert.equal(files.length,1);
  assert.ok(!(await readFile(files[0].p,'utf8')).includes('Tr0ub4dor'),'secret on disk');
});
