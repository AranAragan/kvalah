import test from 'node:test';
import assert from 'node:assert/strict';
import {symlink} from 'node:fs/promises';
import path from 'node:path';
import {workspace} from './helpers.mjs';
import {createFileReader} from '../compute/files.mjs';
import {createDeterministic} from '../compute/deterministic/index.mjs';
import {globToRegExp} from '../compute/deterministic/walk.mjs';
import {outline} from '../compute/deterministic/ast.mjs';

const project={
  'src/index.ts':"import {Cart} from './cart';\nimport type {Item} from './types';\nimport express from 'express';\nexport async function main(port: number = 3000): Promise<void> {\n  const c = new Cart();\n  // TODO: wire routes\n}\nexport default main;\n",
  'src/cart.ts':"import {Item} from './types';\nimport {fmt} from './util.js';\nexport class Cart {\n  private items: Item[] = [];\n  constructor() {}\n  add(item: Item) { this.items.push(item); }\n  static empty() { return new Cart(); }\n  total(): number { return this.items.reduce((s, i) => s + i.price, 0); }\n}\n",
  'src/types.ts':"export interface Item { price: number; name: string }\nexport type Id = string;\nexport enum Color { Red, Green }\n",
  'src/util.ts':"import {Cart} from './cart';\nexport const fmt = (n: number) => n.toFixed(2);\n",
  'lib/legacy.cjs':"const fs = require('fs');\nconst helper = require('./helper');\nmodule.exports = function legacy() { return import('./lazy.mjs'); };\n",
  'lib/helper.js':"exports.x = 1; // FIXME remove\n",
  'lib/lazy.mjs':"export const lazy = true;\n",
  'app/view.jsx':"export function View({title}) { return <h1>{title}</h1>; }\n",
  'tools/script.py':"import os\nfrom pathlib import Path\n\nclass Runner:\n    def run(self):\n        pass\n\ndef main():\n    Runner().run()\n",
  '.env':'SECRET=abc\n','node_modules/pkg/index.js':'export const cart = 1;\n','broken.js':'function ok() {}\nfunction (\n',
};
const setup=async()=>{const root=await workspace(project);await symlink('/etc/hostname',path.join(root,'src','link.ts')).catch(()=>{});return createDeterministic({reader:createFileReader({root})});};

test('glob matching',()=>{const re=globToRegExp('**/*.{ts,tsx}');assert.ok(re.test('src/a/b.ts'));assert.ok(re.test('x.tsx'));assert.ok(!re.test('a.js'));assert.ok(globToRegExp('src/*.js').test('src/a.js'));assert.ok(!globToRegExp('src/*.js').test('src/x/a.js'));});
test('outline TS: classes, methods, interfaces, enums, params, imports/exports',()=>{
  const o=outline(project['src/cart.ts'],'src/cart.ts');
  assert.deepEqual(o.symbols.map(s=>s.name),['Cart','Cart.items','Cart.constructor','Cart.add','Cart.empty','Cart.total']);
  assert.equal(o.symbols.find(s=>s.name==='Cart.empty').static,true);
  const t=outline(project['src/types.ts'],'src/types.ts');assert.deepEqual(t.symbols.map(s=>s.kind),['interface','type','enum']);
  const i=outline(project['src/index.ts'],'src/index.ts');assert.deepEqual(i.symbols[0].params,['port=']);assert.equal(i.imports.find(x=>x.source==='./types').kind,'type');assert.ok(i.exports.some(e=>e.name==='default'));
});
test('outline CJS require/dynamic import/module.exports, JSX, python regex, error recovery',()=>{
  const l=outline(project['lib/legacy.cjs'],'lib/legacy.cjs');assert.deepEqual(l.imports.map(x=>[x.source,x.kind]),[['fs','require'],['./helper','require'],['./lazy.mjs','dynamic']]);assert.ok(l.exports.some(e=>e.name==='module.exports'));
  assert.equal(outline(project['app/view.jsx'],'app/view.jsx').symbols[0].name,'View');
  const p=outline(project['tools/script.py'],'tools/script.py');assert.deepEqual(p.symbols.map(s=>[s.name,s.kind]),[['Runner','class'],['run','method'],['main','function']]);assert.equal(p.approximate,true);
  const b=outline(project['broken.js'],'broken.js');assert.ok(b.symbols.some(s=>s.name==='ok'));
});
test('search: literal/regex/case, skips node_modules, .env and symlinks, explicit truncation',async()=>{
  const d=await setup();
  const r=await d.run('search',{pattern:'cart'});
  assert.ok(r.matches.every(m=>!m.path.startsWith('node_modules')&&m.path!=='.env'&&!m.path.endsWith('link.ts')));
  assert.ok(r.matches.some(m=>m.path==='src/cart.ts'&&m.line===3));
  assert.equal((await d.run('search',{pattern:'Cart',caseSensitive:true,glob:'src/util.ts'})).totalMatches,1);
  const re=await d.run('search',{pattern:'^export (class|interface)',regex:true});assert.equal(re.totalMatches,2);
  const t=await d.run('search',{pattern:'e',maxResults:3});assert.equal(t.matches.length,3);assert.equal(t.truncated,true);assert.match(t.notice,/first 3/);
  await assert.rejects(d.run('search',{pattern:'(a+)+$',regex:true}),/nested quantifiers/);
});
test('symbols index: find definition by name across workspace',async()=>{
  const d=await setup();
  const r=await d.run('symbols',{name:'total'});assert.deepEqual(r.symbols.map(s=>[s.path,s.name,s.line]),[['src/cart.ts','Cart.total',8]]);
  assert.ok((await d.run('symbols',{})).filesIndexed>=7);
});
test('references: whole-word textual',async()=>{const d=await setup();const r=await d.run('references',{name:'Cart'});assert.ok(r.matches.length>=4);assert.ok(r.matches.every(m=>/\bCart\b/.test(m.text)));});
test('deps: graph, cycles, importers, externals, TS .js→.ts mapping',async()=>{
  const d=await setup();
  const g=await d.run('deps',{});assert.deepEqual(g.cycles,[['src/cart.ts','src/util.ts']]);assert.equal(g.externals.express,1);assert.equal(g.externals.fs,1);
  const f=await d.run('deps',{path:'src/cart.ts'});assert.deepEqual(f.imports,['src/types.ts','src/util.ts']);assert.deepEqual(f.importedBy,['src/index.ts','src/util.ts']);assert.deepEqual(f.inCycle,['src/cart.ts','src/util.ts']);
  const l=await d.run('deps',{path:'lib/legacy.cjs'});assert.deepEqual(l.imports,['lib/helper.js','lib/lazy.mjs']);
});
test('hash, stats, todo',async()=>{
  const d=await setup();
  const h=await d.run('hash',{paths:['src/types.ts']});assert.match(h.files[0].sha256,/^[0-9a-f]{64}$/);
  const h2=await d.run('hash',{paths:['src/types.ts']});assert.equal(h.combined,h2.combined);
  await assert.rejects(d.run('hash',{paths:['.env']}).then(r=>{if(r.files[0].error)throw Error(r.files[0].error);}),/denied/);
  const s=await d.run('stats',{});assert.ok(s.byExtension['.ts'].files===4);
  const t=await d.run('todo',{});assert.deepEqual(t.matches.map(m=>m.path).sort(),['lib/helper.js','src/index.ts']);
});
test('outline cache invalidates on change and unknown ops are rejected',async()=>{
  const d=await setup();await assert.rejects(d.run('exec',{}),/Unknown op/);
  const o=await d.run('outline',{path:'src/types.ts'});assert.equal(o.level,1);assert.equal(o.symbols.length,3);
});
