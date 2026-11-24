// SEC-03 regression: LAN nodes get source code only with explicit consent, over a verified channel,
// never via redirects, never on public addresses, and a revoked token stops traffic immediately.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createLan} from '../compute/lan.mjs';
import {createRegistry} from '../compute/vendor/nodes.mjs';
import {createScheduler} from '../compute/vendor/scheduler.mjs';
import {ollamaProvider,openaiProvider} from '../compute/providers-lite.mjs';
import {parseConfig} from '../compute/index.mjs';

const SRC='SOURCE-CODE-MARKER-42';
function mockNode({models=['m'],mode='ok',tls=null}={}){
  const seen=[];
  const handler=(req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    seen.push({url:req.url,headers:req.headers,body});
    if(srv.mode==='revoked'){res.writeHead(401);return res.end('unauthorized');}
    if(req.url==='/peer/info'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({models:srv.models,backend:'ollama'}));}
    if(req.url==='/api/tags'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({models:srv.models.map(n=>({name:n,...(/cloud/.test(n)?{remote_host:'https://ollama.com:443'}:{})}))}));}
    if(srv.mode==='redirect'&&req.url.includes('/api/chat')){res.writeHead(307,{location:srv.redirectTo+'/api/chat'});return res.end();}
    if(req.url.endsWith('/api/chat')){res.writeHead(200,{'content-type':'application/x-ndjson'});
      res.write(JSON.stringify({message:{content:'ok'}})+'\n');return res.end(JSON.stringify({done:true,done_reason:'stop',eval_count:1,prompt_eval_count:1})+'\n');}
    res.writeHead(404);res.end();
  });};
  const srv=tls?https.createServer(tls,handler):http.createServer(handler);
  srv.seen=seen;srv.mode=mode;srv.models=models;
  return new Promise(r=>srv.listen(0,'127.0.0.1',()=>{srv.url=`${tls?'https':'http'}://127.0.0.1:${srv.address().port}`;r(srv);}));
}
const close=s=>new Promise(r=>{s.closeAllConnections?.();s.close(()=>r());});
async function devices(nodes){const dir=await mkdtemp(path.join(tmpdir(),'kvo3-lan-'));await writeFile(path.join(dir,'devices.json'),JSON.stringify({nodes}));return dir;}
const sent=s=>s.seen.some(x=>x.body.includes(SRC));
async function job(sched,model='m'){
  return sched.run(async(provider,m)=>{let out='';for await(const ev of provider.chat({model:m,messages:[{role:'user',content:SRC}]}))if(ev.type==='content')out+=ev.text;return out;},{model});
}
const lanOpts=(dataDir,env,extra={})=>({dataDir,createRegistry,ollamaProvider,openaiProvider,intervalMs:3600000,env,...extra});

test('SEC-03: node not in KVALAH_LAN_ALLOW and a public address never receive anything', async(t)=>{
  const a=await mockNode(),unknown=await mockNode();t.after(()=>Promise.all([close(a),close(unknown)]));
  const calls=[];const spy=(u,o)=>{calls.push(String(u));return fetch(u,o);};
  const dir=await devices([{id:'node-aaaa-1',name:'A',kind:'kvalah',url:a.url,token:'tok-A-123456'},{id:'node-unkn-1',name:'U',kind:'kvalah',url:unknown.url,token:'tok-U-123456'},
    {id:'node-publ-1',name:'P',kind:'ollama',url:'http://8.8.8.8:11434'},{id:'node-dnsx-1',name:'D',kind:'ollama',url:'http://evil.example:11434'}]);
  const lan=await createLan(lanOpts(dir,{KVALAH_LAN_ALLOW:'node-aaaa-1,P,D',KVALAH_LAN_ALLOW_PLAINTEXT:'1'},{fetchImpl:spy,lookup:async(h)=>h==='evil.example'?[{address:'93.184.216.34',family:4}]:[{address:'127.0.0.1',family:4}]}));
  t.after(()=>lan.stop());
  const sched=createScheduler({registry:lan.registry,local:null,maxAttempts:3});
  for(let i=0;i<3;i++)assert.equal((await job(sched)).value,'ok');
  assert.equal(unknown.seen.length,0,'unknown node was contacted');
  assert.ok(!calls.some(u=>u.includes('8.8.8.8')||u.includes('evil.example')),'public endpoint contacted: '+calls.join(','));
  assert.ok(sent(a));
  const pub=lan.nodes();assert.ok(!JSON.stringify(pub).includes('tok-'),'token exposed in node list');
});

test('SEC-03: plaintext http needs explicit opt-in; self-signed TLS is rejected (no content sent)', async(t)=>{
  const a=await mockNode();t.after(()=>close(a));
  const dir=await devices([{id:'node-aaaa-1',name:'A',kind:'kvalah',url:a.url,token:'tok-A-123456'}]);
  const lan=await createLan(lanOpts(dir,{KVALAH_LAN_ALLOW:'node-aaaa-1'}));t.after(()=>lan.stop());
  const sched=createScheduler({registry:lan.registry,local:null,maxAttempts:2});
  await assert.rejects(()=>job(sched));assert.equal(a.seen.length,0,'plaintext node contacted without KVALAH_LAN_ALLOW_PLAINTEXT=1');
  let tls;try{const d=await mkdtemp(path.join(tmpdir(),'kvo3-tls-'));execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(d,'k.pem'),'-out',path.join(d,'c.pem'),'-days','2','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
    tls={key:await readFile(path.join(d,'k.pem')),cert:await readFile(path.join(d,'c.pem'))};}catch{t.diagnostic('openssl unavailable: TLS case skipped');return;}
  const s=await mockNode({tls});t.after(()=>close(s));
  const dir2=await devices([{id:'node-tlss-1',name:'S',kind:'kvalah',url:s.url,token:'tok-S-123456'}]);
  const lan2=await createLan(lanOpts(dir2,{KVALAH_LAN_ALLOW:'node-tlss-1'}));t.after(()=>lan2.stop());
  await assert.rejects(()=>job(createScheduler({registry:lan2.registry,local:null,maxAttempts:2})));
  assert.equal(s.seen.length,0,'self-signed TLS node received a request');
});

test('SEC-03: redirects are not followed (token and source never reach the redirect target)', async(t)=>{
  const a=await mockNode({mode:'redirect'}),evil=await mockNode();a.redirectTo=evil.url;t.after(()=>Promise.all([close(a),close(evil)]));
  const dir=await devices([{id:'node-aaaa-1',name:'A',kind:'kvalah',url:a.url,token:'tok-A-123456'}]);
  const lan=await createLan(lanOpts(dir,{KVALAH_LAN_ALLOW:'node-aaaa-1',KVALAH_LAN_ALLOW_PLAINTEXT:'1'}));t.after(()=>lan.stop());
  await assert.rejects(()=>job(createScheduler({registry:lan.registry,local:null,maxAttempts:1})));
  assert.equal(evil.seen.length,0,'redirect target contacted');
});

test('SEC-03: two allowed nodes — one goes down (failover), the other revokes the token (offline at once); local-only rejects cloud models', async(t)=>{
  const a=await mockNode(),b=await mockNode({models:['m','gpt-oss:120b-cloud']});t.after(()=>Promise.all([close(a),close(b)]));
  const dir=await devices([{id:'node-aaaa-1',name:'A',kind:'kvalah',url:a.url,token:'tok-A-123456'},{id:'node-bbbb-1',name:'B',kind:'kvalah',url:b.url,token:'tok-B-123456'}]);
  const lan=await createLan(lanOpts(dir,{KVALAH_LAN_ALLOW:'A,B',KVALAH_LAN_ALLOW_PLAINTEXT:'1'}));t.after(()=>lan.stop());
  const sched=createScheduler({registry:lan.registry,local:null,maxAttempts:3});
  assert.equal(lan.nodes().filter(n=>n.online).length,2);
  // cloud model on a "local" node is not offered in local-only mode
  await assert.rejects(()=>job(sched,'gpt-oss:120b-cloud'),/No device/);
  assert.ok(!b.seen.some(x=>x.body.includes(SRC)));
  await close(a);                                  // A disappears → B serves
  assert.equal((await job(sched)).node,'B');
  b.mode='revoked';const before=b.seen.length;
  await assert.rejects(()=>job(sched));
  assert.equal(lan.nodes().find(n=>n.name==='B').online,false,'revoked node still online');
  const afterFirst=b.seen.length;await assert.rejects(()=>job(sched));
  assert.equal(b.seen.length,afterFirst,'revoked node contacted again');assert.ok(afterFirst-before<=1);
  assert.throws(()=>parseConfig({KVALAH_MODEL:'gpt-oss:120b-cloud'}),/cloud/i);
  assert.doesNotThrow(()=>parseConfig({KVALAH_MODEL:'gpt-oss:120b-cloud',KVALAH_ALLOW_CLOUD_MODELS:'1'}));
});
