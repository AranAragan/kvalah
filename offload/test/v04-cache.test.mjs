// v0.4 CACHE-01/02/03: the file cache under several processes, the disk quota under concurrency, entry integrity.
// Real child processes share one cache directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readdir,stat,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCache} from '../compute/cache.mjs';

const CACHE=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','compute','cache.mjs');
function child(code){return new Promise((res,rej)=>{const p=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let out='',err='';
  p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('exit',c=>c===0?res(out):rej(Error('child exit '+c+': '+err)));});}
async function diskBytes(dir){let n=0;for(const sub of await readdir(dir).catch(()=>[])){const d=path.join(dir,sub);let fs=[];try{fs=await readdir(d);}catch{continue;}
  for(const f of fs)if(f.endsWith('.json')){const s=await stat(path.join(d,f)).catch(()=>null);if(s)n+=s.size;}}return n;}

test('v04 CACHE-01: concurrent writers and readers in 4 processes on the same keys never see a torn or corrupt entry', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'kv4c1-'));
  const code=`import {createCache} from ${JSON.stringify(CACHE)};const c=createCache({dir:${JSON.stringify(dir)},memoryEntries:0,maxBytes:1e9});
    let bad=0,reads=0;for(let i=0;i<150;i++){const k='k'+(i%5).toString().padStart(2,'0')+'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      await c.set(k,{pid:process.pid,i,blob:'x'.repeat(20000+(i%7)*1000)});const v=await c.get(k);reads++;if(!v||typeof v.blob!=='string'||v.blob.length<20000)bad++;}
    console.log(JSON.stringify({bad,reads,stats:c.stats()}));`;
  const outs=(await Promise.all([1,2,3,4].map(()=>child(code)))).map(o=>JSON.parse(o));
  for(const o of outs){assert.equal(o.bad,0,JSON.stringify(o));assert.equal(o.stats.corrupt,0);assert.equal(o.stats.errors,0);}
  const left=(await readdir(path.join(dir,'k0'))).filter(f=>f.endsWith('.tmp'));assert.deepEqual(left,[],'no temp files left behind');
});

test('v04 CACHE-02: the disk quota holds when 4 processes write at the same time', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'kv4c2-'));const max=60_000;
  const code=`import {createCache} from ${JSON.stringify(CACHE)};import {randomBytes} from 'node:crypto';const c=createCache({dir:${JSON.stringify(dir)},memoryEntries:0,maxBytes:${max}});
    for(let i=0;i<40;i++)await c.set(randomBytes(16).toString('hex'),{blob:'y'.repeat(3000)});console.log(JSON.stringify(c.stats()));`;
  await Promise.all([1,2,3,4].map(()=>child(code)));
  const used=await diskBytes(dir);
  assert.ok(used<=max,`disk ${used} B > quota ${max} B`);
});

test('v04 CACHE-03: modified, truncated or moved entries are rejected (checksum bound to the key)', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'kv4c3-'));
  const c=createCache({dir,memoryEntries:0});
  const k1='ab'+'1'.repeat(62),k2='ab'+'2'.repeat(62);
  await c.set(k1,{summary:'original',findings:[{quote:'ERROR a'}]});await c.set(k2,{summary:'other'});
  assert.equal((await c.get(k1)).summary,'original');
  const f1=path.join(dir,'ab',k1+'.json'),f2=path.join(dir,'ab',k2+'.json');
  // tamper: valid JSON, same structure, changed value
  const d=JSON.parse(await readFile(f1,'utf8'));d.value.summary='tampered';await writeFile(f1,JSON.stringify(d));
  assert.equal(await c.get(k1),undefined,'modified entry must be rejected');assert.ok(c.stats().corrupt>=1);
  // move another key's (intact) entry under k1's name
  await c.set(k1,{summary:'original'});await writeFile(f1,await readFile(f2,'utf8'));
  assert.equal(await c.get(k1),undefined,'entry of another key must be rejected');
  // truncated file
  await c.set(k1,{summary:'original'});const raw=await readFile(f1,'utf8');await writeFile(f1,raw.slice(0,raw.length-5));
  assert.equal(await c.get(k1),undefined);
  // intact entries still work after all that
  assert.equal((await c.get(k2)).summary,'other');
});
