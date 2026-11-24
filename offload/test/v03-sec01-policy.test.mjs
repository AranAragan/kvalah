// SEC-01: one data-protection policy for every input and output path (all six MCP tools, cache, errors, dashboard, logs).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {buildServer} from '../mcp/server.mjs';
import {workspace,smartMock} from './helpers.mjs';

export const SECRETS={
  aws:'AKIAIOSFODNN7EXAMPLE',awsSecret:'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  github:'ghp_'+'Zq8xR2vL0mN4bT6yW1cK9pD3sF7hJ5gA2eU0',
  bearer:'abcDEF123456ghiJKL789mnoPQR0stuVWX',
  jwt:'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  password:'Tr0ub4dor&3xyz',dbPassword:'hunter22',
  pkBody:'MIIEowIBAAKCAQEA7bq9Xyz0SECRETKEYBODYabcdefghijklmnop',
};
export const files={
  'config.js':`// app config\nexport const config = {\n  aws_access_key_id: "${SECRETS.aws}",\n  aws_secret_access_key: "${SECRETS.awsSecret}",\n  password: "${SECRETS.password}",\n  github: "${SECRETS.github}",\n};\n// TODO rotate ${SECRETS.github}\nexport function connect() { return fetch(url, {headers: {Authorization: "Bearer ${SECRETS.bearer}"}}); }\n`,
  'logs/app.log':`INFO start\nERROR auth failed token=${SECRETS.jwt}\nDB_PASSWORD=${SECRETS.dbPassword}\nERROR connection reset\n`,
  'docs/keys.md':`# Keys\n\n-----BEGIN RSA PRIVATE KEY-----\n${SECRETS.pkBody}\n-----END RSA PRIVATE KEY-----\n\nUse ${SECRETS.aws} for staging.\n`,
};
const leaks=(text)=>Object.entries(SECRETS).filter(([,v])=>text.includes(v)).map(([k])=>k);

async function setup(t,policy,extraEnv={}){
  const root=await workspace(files);const cacheDir=await mkdtemp(path.join(tmpdir(),'kvo-sec01-cache-'));
  const logs=[];
  const env={KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'on',KVALAH_CACHE_DIR:cacheDir,KVALAH_SECRET_POLICY:policy,KVALAH_DASHBOARD:'1',KVALAH_CACHE_SENSITIVE:'1',...extraEnv};
  // echo model: repeats every data line back, so anything that reaches the model would come back out
  const provider=smartMock({pattern:/./});
  const {server,app}=await buildServer({env,provider,log:m=>logs.push(m)});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);
  const client=new Client({name:'t',version:'1'});await client.connect(ct);
  t.after(()=>app?.close());
  return {client,app,provider,cacheDir,logs};
}
async function exercise(client){
  const out=[];
  const call=async(name,args)=>{try{const r=await client.callTool({name,arguments:args});out.push(JSON.stringify(r));return r;}catch(e){out.push(String(e.message));}};
  await call('kvalah_status',{});
  await call('kvalah_compute',{op:'search',pattern:'AKIA'});
  await call('kvalah_compute',{op:'search',pattern:'password',contextLines:2});
  await call('kvalah_compute',{op:'todo'});
  await call('kvalah_compute',{op:'references',name:'Bearer'});
  await call('kvalah_compute',{op:'outline',path:'config.js'});
  await call('kvalah_compute',{op:'deps'});
  await call('kvalah_compute',{op:'search',pattern:SECRETS.aws});
  for(let i=0;i<2;i++){ // second round = cache hits
    await call('kvalah_delegate',{kind:'logs',instruction:'List every line',paths:['logs/app.log','config.js','docs/keys.md']});
    await call('kvalah_delegate',{kind:'summarize',instruction:`check key ${SECRETS.github}`,query:SECRETS.aws,context:`token: "${SECRETS.bearer}"\nERROR x`});
    await call('kvalah_batch',{tasks:[{kind:'logs',instruction:'lines',paths:['logs/app.log']},{kind:'review',instruction:'review',paths:['config.js'],strategy:'direct'}]});
    await call('kvalah_auto',{goal:'find all occurrences of "AKIA"'});
    await call('kvalah_auto',{goal:'Summarize everything in these files',paths:['config.js','logs/app.log','docs/keys.md'],prefer:'local'});
  }
  await call('kvalah_delegate',{kind:'logs',instruction:'x',paths:[`missing-${SECRETS.github}.log`]}); // error echoing a secret
  await call('kvalah_compute',{op:'outline',path:`nope/${SECRETS.aws}.js`});
  await call('kvalah_metrics',{});
  return out.join('\n');
}
const get=url=>new Promise((res,rej)=>http.get(url,r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>res(b));}).on('error',rej));
async function diskText(dir){let s='';for(const sub of await readdir(dir,{recursive:true}).catch(()=>[])){try{s+=await readFile(path.join(dir,sub),'utf8');}catch{}}return s;}

for(const policy of ['redact','block']){
  test(`SEC-01 (${policy}): no synthetic secret appears in any tool result, error, cache file, dashboard or log`,async(t)=>{
    const {client,app,provider,cacheDir,logs}=await setup(t,policy);
    const text=await exercise(client);
    assert.deepEqual(leaks(text),[],'tool results/errors');
    assert.deepEqual(leaks(provider.calls.map(c=>c.user+c.sys).join('\n')),[],'nothing sensitive reaches the model');
    await app.engine.stats.flush?.();
    assert.deepEqual(leaks(await diskText(cacheDir)),[],'cache dir');
    assert.deepEqual(leaks(await get(`http://127.0.0.1:${app.dashboard.port}/api/state?t=${app.dashboard.token}`)),[],'dashboard');
    assert.deepEqual(leaks(logs.join('\n')),[],'logs');
    // useful work still happens: deterministic search finds the line (content masked/withheld), line numbers preserved
    const r=await client.callTool({name:'kvalah_compute',arguments:{op:'search',pattern:'aws_access_key_id'}});
    assert.equal(r.structuredContent.matches[0].line,3);
    if(policy==='redact')assert.match(r.structuredContent.matches[0].text,/\[REDACTED:/);
    else assert.equal(r.structuredContent.matches[0].blocked,true);
    await app.close();
  });
}
test('SEC-01: block mode refuses to send sensitive input to a model; redact keeps line numbers',async(t)=>{
  const b=await setup(t,'block');
  const r=await b.client.callTool({name:'kvalah_delegate',arguments:{kind:'logs',instruction:'x',paths:['logs/app.log']}});
  assert.equal(r.isError,true);assert.match(r.content[0].text,/sensitive|Secret/i);assert.equal(b.provider.calls.length,0);
  const r2=await b.client.callTool({name:'kvalah_delegate',arguments:{kind:'logs',instruction:`use ${SECRETS.aws}`,context:'ERROR plain'}});
  assert.equal(r2.isError,true);assert.equal(b.provider.calls.length,0);
  await b.app.close();
  const red=await setup(t,'redact');
  const d=await red.client.callTool({name:'kvalah_delegate',arguments:{kind:'logs',instruction:'list lines',paths:['docs/keys.md'],strategy:'direct'}});
  const f=d.structuredContent.findings.find(x=>/staging/.test(x.quote));assert.equal(f.line,7,'private key block redacted line-by-line, numbering preserved');
  await red.app.close();
});
test('SEC-01: custom deny patterns and allow-list exceptions',async(t)=>{
  const s=await setup(t,'redact',{KVALAH_SECRET_DENY:JSON.stringify(['ACME-[0-9]{6}']),KVALAH_SECRET_ALLOW:JSON.stringify(['AKIAIOSFODNN7EXAMPLE'])});
  const r=await s.client.callTool({name:'kvalah_delegate',arguments:{kind:'logs',instruction:'x',context:'id ACME-123456 key AKIAIOSFODNN7EXAMPLE\nERROR y'}});
  const txt=JSON.stringify(r);assert.ok(!txt.includes('ACME-123456'));assert.ok(txt.includes('AKIAIOSFODNN7EXAMPLE'),'allow-listed example key passes');
  await s.app.close();
});
