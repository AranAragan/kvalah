#!/usr/bin/env node
// QA-01: `node --check` every .mjs in the package (excluding node_modules); non-zero exit on any failure.
import {readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=[];
(function walk(d){for(const e of readdirSync(d,{withFileTypes:true})){if(e.name==='node_modules'||e.name.startsWith('.'))continue;const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith('.mjs'))files.push(p);}})(root);
let failed=0;
for(const f of files.sort()){try{execFileSync(process.execPath,['--check',f],{stdio:'pipe'});console.log('ok   '+path.relative(root,f));}catch(e){failed++;console.log('FAIL '+path.relative(root,f)+'\n'+String(e.stderr||e.message));}}
console.log(`${files.length} files, ${failed} failed`);
process.exit(failed?1:0);
