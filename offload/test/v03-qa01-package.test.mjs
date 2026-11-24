// QA-01 regression: engines agree with the lockfile, CI matrix exists, scripts check syntax and packaging.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
const json=async p=>JSON.parse(await readFile(new URL('../'+p,import.meta.url),'utf8'));

test('QA-01: engines.node is the intersection of dependency engines (Babel 8 needs ^22.18.0 || >=24.11.0)', async()=>{
  const pkg=await json('package.json'),lock=await json('package-lock.json');
  assert.equal(pkg.engines.node,'^22.18.0 || >=24.11.0');
  assert.equal(lock.packages[''].engines.node,pkg.engines.node,'lockfile root out of sync (run npm install)');
  const babel=lock.packages['node_modules/@babel/parser'].engines.node;assert.equal(babel,'^22.18.0 || >=24.11.0');
});

test('QA-01: CI workflow covers Linux/macOS/Windows and supported Node lines, runs ci/test/syntax/pack/audit', async()=>{
  const y=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  for(const re of [/ubuntu-latest/,/macos-latest/,/windows-latest/,/22\.18/,/24\.11|'24'|24\.x/,/npm ci/,/npm test/,/npm run check/,/npm pack --dry-run/,/npm audit/])assert.match(y,re);
});

test('QA-01: scripts — syntax check of every .mjs and a pack check', async()=>{
  const pkg=await json('package.json');
  assert.match(pkg.scripts.check,/check-syntax/);assert.ok(pkg.scripts['pack:check']);
  await access(new URL('../scripts/check-syntax.mjs',import.meta.url));
  assert.ok(pkg.files.includes('skill/')&&!pkg.files.some(f=>f.startsWith('test')));
});
