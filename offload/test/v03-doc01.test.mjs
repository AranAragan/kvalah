// DOC-01 regression: documentation matches the code (every env var documented, versions consistent,
// install/rollback/threat model/troubleshooting present, no unsupported claims).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>readFile(path.join(root,p),'utf8');
async function codeFiles(d){const out=[];for(const e of await readdir(path.join(root,d),{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())out.push(...await codeFiles(p));else if(p.endsWith('.mjs'))out.push(p);}return out;}

test('DOC-01: every KVALAH_* variable read by the code is documented in README.md', async()=>{
  const readme=await read('README.md');const vars=new Set();
  for(const f of [...await codeFiles('compute'),...await codeFiles('mcp')])for(const m of (await read(f)).matchAll(/KVALAH_[A-Z_]+[A-Z]/g))vars.add(m[0]);
  const missing=[...vars].filter(v=>!readme.includes(v));assert.deepEqual(missing,[]);
});

test('DOC-01: version is consistent and released docs exist', async()=>{
  const pkg=JSON.parse(await read('package.json'));const {VERSION}=await import('../compute/index.mjs');
  assert.equal(VERSION,pkg.version);assert.match(await read('CHANGELOG.md'),new RegExp('## '+pkg.version.replace(/\./g,'\\.')));
  assert.match(await read('README.md'),new RegExp('v'+pkg.version.split('.').slice(0,2).join('\\.')));
  const install=await read('docs/INSTALL.md');for(const w of ['Install','Update','Uninstall','Rollback','Troubleshooting','offline','timeout','cancel'])assert.ok(install.includes(w),w);
  const tm=await read('docs/THREAT-MODEL.md');for(const w of ['Assets','Trust boundaries','prompt injection','LAN','cache','Residual risks'])assert.ok(tm.toLowerCase().includes(w.toLowerCase()),w);
});

test('DOC-01: README makes no unsupported claims', async()=>{
  const t=await read('README.md');
  for(const re of [/instant and free/i,/results are exact/i,/any size works/i,/~0, exact/i,/guaranteed savings/i])assert.doesNotMatch(t,re);
  assert.match(t,/estimate/i);assert.match(t,/RESULTS-real\.md/);
});
