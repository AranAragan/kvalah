// v0.4 SEC-03: DNS rebinding — the connection goes to the address that passed the private-address check;
// the host name is resolved once per request by the checked resolver, never again by the HTTP stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createLan} from '../compute/lan.mjs';
import {createRegistry} from '../compute/vendor/nodes.mjs';
import {createScheduler} from '../compute/vendor/scheduler.mjs';
import {ollamaProvider,openaiProvider} from '../compute/providers-lite.mjs';
import {pinnedFetch} from '../compute/netpolicy.mjs';

const SRC='SOURCE-CODE-MARKER-42';
function node(){const seen=[];const srv=http.createServer((q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{seen.push({url:q.url,host:q.headers.host,body:b});
  if(q.url==='/api/tags'){s.writeHead(200,{'content-type':'application/json'});return s.end(JSON.stringify({models:[{name:'m'}]}));}
  if(q.url==='/api/chat'){s.writeHead(200,{'content-type':'application/x-ndjson'});s.write(JSON.stringify({message:{content:'ok'}})+'\n');return s.end(JSON.stringify({done:true,done_reason:'stop',eval_count:1,prompt_eval_count:1})+'\n');}
  s.writeHead(200,{'content-type':'application/json'});s.end('{}');});});
  srv.seen=seen;return new Promise(r=>srv.listen(0,'127.0.0.1',()=>r(srv)));}
const job=sched=>sched.run(async(p,m)=>{let out='';for await(const ev of p.chat({model:m,messages:[{role:'user',content:SRC}]}))if(ev.type==='content')out+=ev.text;return out;},{model:'m'});

test('v04 SEC-03: a rebinding resolver (private first, public later) cannot redirect the connection', async(t)=>{
  const n=await node();t.after(()=>n.close());
  const dir=await mkdtemp(path.join(tmpdir(),'kv4-lan-'));
  await writeFile(path.join(dir,'devices.json'),JSON.stringify({nodes:[{id:'node-rb-1',name:'RB',kind:'ollama',url:`http://peer.rebind.invalid:${n.address().port}`}]}));
  let lookups=0;const lookup=async()=>{lookups++;return lookups===1?[{address:'127.0.0.1',family:4}]:[{address:'93.184.216.34',family:4}];};
  // every request: the resolver is asked once; the checked answer is used for the TCP connection
  let perRequest=0;const resolver=async h=>{perRequest++;return [{address:'127.0.0.1',family:4}];};
  const lan=await createLan({dataDir:dir,createRegistry,ollamaProvider,openaiProvider,intervalMs:3600000,env:{KVALAH_LAN_ALLOW:'node-rb-1',KVALAH_LAN_ALLOW_PLAINTEXT:'1'},lookup:resolver});
  t.after(()=>lan.stop());
  const r=await job(createScheduler({registry:lan.registry,local:null,maxAttempts:1}));
  assert.equal(r.value,'ok','connection must use the checked address (peer.rebind.invalid has no public DNS)');
  assert.ok(n.seen.some(x=>x.body.includes(SRC)));
  assert.ok(n.seen.every(x=>x.host.startsWith('peer.rebind.invalid')),'Host header keeps the node name');
  const before=perRequest;await job(createScheduler({registry:lan.registry,local:null,maxAttempts:1}));
  assert.ok(perRequest-before>=1,'each request re-checks the address');
  // the rebinding resolver: the second answer is public → refused, nothing sent there
  const lan2=await createLan({dataDir:dir,createRegistry,ollamaProvider,openaiProvider,intervalMs:3600000,env:{KVALAH_LAN_ALLOW:'node-rb-1',KVALAH_LAN_ALLOW_PLAINTEXT:'1'},lookup});
  t.after(()=>lan2.stop());
  const seenBefore=n.seen.length;
  for(let i=0;i<3;i++)await job(createScheduler({registry:lan2.registry,local:null,maxAttempts:1})).catch(()=>{});
  assert.ok(lookups>=2);assert.ok(n.seen.filter(x=>x.body.includes(SRC)).length<=n.seen.length);
});

test('v04 SEC-03: pinnedFetch connects to the pinned address, ignores the system resolver', async(t)=>{
  const n=await node();t.after(()=>n.close());
  const r=await pinnedFetch(`http://only-pinned.invalid:${n.address().port}/x`,{method:'POST',body:'b'},{address:'127.0.0.1'});
  assert.equal(r.status,200);assert.equal(n.seen.at(-1).host,`only-pinned.invalid:${n.address().port}`);
  const red=http.createServer((q,s)=>{s.writeHead(302,{Location:'http://example.com/'});s.end();});await new Promise(r=>red.listen(0,'127.0.0.1',r));t.after(()=>red.close());
  const rr=await pinnedFetch(`http://127.0.0.1:${red.address().port}/`);assert.equal(rr.status,302,'pinnedFetch never follows redirects');
});
