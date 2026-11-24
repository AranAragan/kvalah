// v0.4 SEC-04: configuration and diagnostic errors never echo tokens, keys or passwords.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {buildServer} from '../mcp/server.mjs';
import {createKvalahOffload} from '../compute/index.mjs';
import {ollamaProvider} from '../compute/providers-lite.mjs';

const TOKEN='ghp_'+'Zq8xR2vL0mN4bT6yW1cK9pD3sF7hJ5gA2eU0',PASS='S3cr3tPassw0rd!x';
const cases=[
  ['invalid deny regex containing a token',{KVALAH_MODEL:'m',KVALAH_SECRET_DENY:TOKEN+'(['}],
  ['invalid allow regex containing a token',{KVALAH_MODEL:'m',KVALAH_SECRET_ALLOW:'(('+TOKEN}],
  ['credentials in KVALAH_LOCAL_URL',{KVALAH_MODEL:'m',KVALAH_LOCAL_URL:`http://admin:${PASS}@10.1.2.3:11434`}],
  ['token in a remote KVALAH_LOCAL_URL query',{KVALAH_MODEL:'m',KVALAH_LOCAL_URL:`http://10.1.2.3:11434/?key=${TOKEN}`}],
];
const clean=s=>!String(s).includes(TOKEN)&&!String(s).includes(PASS);

for(const [name,env] of cases)test('v04 SEC-04: MCP tool error and stderr log are clean — '+name, async()=>{
  const logs=[];const {server,app}=await buildServer({env:{KVALAH_CACHE:'off',KVALAH_SERVICE:'off',...env},log:m=>logs.push(m)});
  const [a,b]=InMemoryTransport.createLinkedPair();const c=new Client({name:'t',version:'1'});await Promise.all([server.connect(a),c.connect(b)]);
  try{
    const r=await c.callTool({name:'kvalah_status',arguments:{}});
    assert.ok(clean(JSON.stringify(r)),'tool result leaks: '+JSON.stringify(r).slice(0,300));
    assert.ok(logs.length&&logs.every(clean),'log leaks: '+logs.join(' | '));
  }finally{await c.close();await app?.close();}
});

test('v04 SEC-04: provider "unreachable" errors do not echo URL credentials or query secrets', async()=>{
  const p=ollamaProvider(`http://user:${PASS}@127.0.0.1:9/?token=${TOKEN}`);
  const e=await p.models().catch(e=>e);assert.ok(e instanceof Error);assert.ok(clean(e.message),e.message);
});

test('v04 SEC-04: the service CLI reports config errors without secrets or stack traces', ()=>{
  const cli=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','compute','service.mjs');
  const r=spawnSync(process.execPath,[cli],{env:{...process.env,KVALAH_MODEL:'m',KVALAH_SECRET_DENY:TOKEN+'([',KVALAH_DATA_DIR:'/tmp/kv4-sec04'},encoding:'utf8',timeout:15000});
  assert.notEqual(r.status,0);assert.ok(clean(r.stderr+r.stdout),r.stderr.slice(0,400));assert.doesNotMatch(r.stderr,/\n\s+at /);
});
