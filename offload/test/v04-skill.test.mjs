// v0.4 SKILL-01..09: the skill must match the current MCP API and package, stay small, and follow Agensi's
// packaging rules (https://www.agensi.io/docs/packaging, https://www.agensi.io/security,
// https://www.agensi.io/learn/skill-md-creator-checklist; checked 2026-11-24, see docs/notes/v04-sources.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const read=p=>readFile(new URL(p,root),'utf8');
const skillAll=async()=>(await read('skill/SKILL.md'))+'\n'+(await read('skill/references/ADVANCED.md'))+'\n'+(await read('skill/README.md'));

test('v04 SKILL-01: every tool and kvalah_auto field named in the skill exists in the MCP server, and every tool is covered', async()=>{
  const srv=await read('mcp/server.mjs');const tools=[...srv.matchAll(/registerTool\('([a-z_]+)'/g)].map(m=>m[1]);
  const all=await skillAll();const named=new Set([...all.matchAll(/\bkvalah_[a-z]+\b/g)].map(m=>m[0]));
  for(const n of named)assert.ok(tools.includes(n),'skill names a tool the server does not have: '+n);
  for(const t of tools)assert.ok(named.has(t),'tool not covered by the skill: '+t);
  const autoSchema=srv.slice(srv.indexOf("registerTool('kvalah_auto'"),srv.indexOf("registerTool('kvalah_metrics'"));
  for(const f of ['alreadyRead','contextAlreadyLoaded','prefer','query','paths'])assert.match(autoSchema,new RegExp(f+':'),'server lacks '+f);
  for(const f of ['alreadyRead','contextAlreadyLoaded'])assert.match(await read('skill/SKILL.md'),new RegExp('`'+f),'SKILL.md does not use '+f);
});
test('v04 SKILL-02: SKILL.md stays small (≤ 2600 chars incl. frontmatter; description ≤ 400)', async()=>{
  const s=await read('skill/SKILL.md');assert.ok(s.length<=2600,'SKILL.md '+s.length+' chars');
  const d=s.match(/^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n/);assert.ok(d,'frontmatter');assert.ok(d[2].length<=400,'description '+d[2].length);
  assert.match(d[2],/^Use when/,'trigger-style description (Agensi checklist)');
});
test('v04 SKILL-03/04/05: already-read files, low-saving decline and unavailability are covered', async()=>{
  const s=await read('skill/SKILL.md');
  assert.match(s,/already read/i);assert.match(s,/level 3|L3/i);assert.match(s,/route\.expected|expected saving/i);
  for(const re of [/ServiceUnavailableError|service (is )?unavailable/i,/offline/i,/kvalah_status/])assert.match(s,re);
});
test('v04 SKILL-06/07: install for Codex, Claude Code, Cursor with the v0.4 archive; Node requirement = package.json engines', async()=>{
  const r=await read('skill/README.md');const engines=JSON.parse(await read('package.json')).engines.node;
  assert.ok(r.includes(engines),'README Node requirement differs from package.json engines ('+engines+')');
  assert.doesNotMatch(r,/v0\.[0-3]\.zip/);assert.match(r,/kvalah-offload-v0\.4\.zip/);
  for(const re of [/mcp_servers\.kvalah/,/claude mcp add/,/\.cursor\/mcp\.json/,/codex mcp add|config\.toml/])assert.match(r,re);
});
test('v04 SKILL-08: no unproven savings/accuracy/security promises', async()=>{
  const all=await skillAll();
  for(const re of [/\bsaves? (you )?\d+ ?%/i,/guarantee/i,/100 ?% (safe|secure|accurate)/i,/always (correct|accurate)/i,/never leaks?/i,/fully secure/i,/proven/i])assert.doesNotMatch(all,re);
});

// SKILL-05: the unavailability behaviour the skill describes is what the server actually does
test('v04 SKILL-05: model offline → kvalah_status health.online false and kvalah_auto level 3; service required but absent → tool error naming the service', async()=>{
  const {buildServer}=await import('../mcp/server.mjs');const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
  const {mkdtemp}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=(await import('node:path')).default;const {workspace,bigLog}=await import('./helpers.mjs');
  const root=await workspace({'ci.log':bigLog({lines:3000,errorsAt:[5]})});
  const open=async env=>{const {server,app,configError}=await buildServer({env:{KVALAH_DATA_DIR:await mkdtemp(path.join(tmpdir(),'kv4k-')),KVALAH_MODEL:'m',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',KVALAH_LOCAL_URL:'http://127.0.0.1:9',...env},log:()=>{}});
    const [a,b]=InMemoryTransport.createLinkedPair();const c=new Client({name:'t',version:'1'});await Promise.all([server.connect(a),c.connect(b)]);return {c,app,configError};};
  const off=await open({KVALAH_SERVICE:'off'});
  try{
    const st=(await off.c.callTool({name:'kvalah_status',arguments:{}})).structuredContent;assert.equal(st.health.online,false);
    const r=(await off.c.callTool({name:'kvalah_auto',arguments:{goal:'Summarize the failures in this CI log',paths:['ci.log']}})).structuredContent;
    assert.equal(r.route.level,3);assert.match(r.route.reason,/offline/);
  }finally{await off.c.close();await off.app?.close();}
  const req=await open({KVALAH_SERVICE:'required'});
  try{
    const r=await req.c.callTool({name:'kvalah_auto',arguments:{goal:'Summarize the failures in this CI log',paths:['ci.log']}});
    assert.ok(r.isError||req.configError,'required mode without a service must fail visibly');
    assert.match(String(req.configError||r.content?.[0]?.text),/service/i);
  }finally{await req.c.close();await req.app?.close();}
});
