import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {workspace,smartMock,bigLog,sleep} from './helpers.mjs';
import {createKvalahOffload} from '../compute/index.mjs';
import {createCache} from '../compute/cache.mjs';
import {createStats} from '../compute/stats.mjs';
import {inferKind} from '../compute/router.mjs';
import {startDashboard} from '../compute/dashboard.mjs';

const baseEnv=root=>({KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',KVALAH_PRICE_INPUT:'3',KVALAH_PRICE_OUTPUT:'15'});
const project={'src/cart.mjs':"import {money} from './money.mjs';\nexport class Cart { total(){ return money(1); } }\n",'src/money.mjs':"export const money = n => n;\n",
  'src/checkout.mjs':"import {Cart} from './cart.mjs';\nexport function checkout(){ return new Cart().total(); }\n",'logs/ci.log':bigLog({lines:3000,errorsAt:[10,2900]}),'notes.txt':'short note\n'};

test('router: L1 for structural questions (EN/RU), L2 for big logs, L3 for tiny/inline or offline',async()=>{
  const root=await workspace(project);const app=await createKvalahOffload({env:baseEnv(root),provider:smartMock()});
  const d=g=>app.router.decide(g);
  assert.deepEqual(await d({goal:'Which files import src/money.mjs?',paths:['src/money.mjs']}).then(r=>[r.level,r.op,r.args.path]),[1,'deps','src/money.mjs']);
  assert.deepEqual(await d({goal:'Where is `checkout` defined?'}).then(r=>[r.level,r.op,r.args.name]),[1,'symbols','checkout']);
  assert.deepEqual(await d({goal:'Где определена функция checkout'}).then(r=>[r.level,r.op]),[1,'symbols']);
  assert.equal((await d({goal:'list all TODO comments'})).op,'todo');
  assert.equal((await d({goal:'find all occurrences of "money("'})).args.pattern,'money(');
  const big=await d({goal:'What errors happened in this CI run?',paths:['logs/ci.log']});assert.equal(big.level,2);assert.equal(big.kind,'logs');assert.ok(big.predictedSavedUsd>0);
  const tiny=await d({goal:'summarize',paths:['notes.txt']});assert.equal(tiny.level,3);assert.match(tiny.reason,/cost more|small input/); // v0.3: KVALAH_ROUTER_MIN_TOKENS gate
  const inline=await d({goal:'Convert to a table',context:'a=1\nb=2'});assert.equal(inline.level,3);assert.match(inline.advice,/Inline context/);
  assert.equal((await d({goal:'summarize',paths:['notes.txt'],prefer:'local'})).level,2);
  const off=await createKvalahOffload({env:baseEnv(root),provider:{...smartMock(),health:async()=>({online:false})}});
  assert.equal((await off.router.decide({goal:'What errors?',paths:['logs/ci.log']})).level,3);
  assert.equal(inferKind({goal:'write unit tests for cart'}),'tests');assert.equal(inferKind({goal:'review for security bugs'}),'review');
});
test('router learns: repeated failures for a kind push it to L3',async()=>{
  const root=await workspace(project);const app=await createKvalahOffload({env:baseEnv(root),provider:smartMock()});
  for(let i=0;i<6;i++)app.engine.stats.record('logs',{ok:false,ms:10});
  const r=await app.router.decide({goal:'What errors happened?',paths:['logs/ci.log']});assert.equal(r.level,3);assert.match(r.reason,/failed/);
});
test('kvalah_auto executes the chosen level end-to-end',async()=>{
  const root=await workspace(project);const app=await createKvalahOffload({env:baseEnv(root),provider:smartMock()});
  const l1=await app.auto({goal:'who imports src/money.mjs',paths:['src/money.mjs']});assert.equal(l1.level,1);assert.deepEqual(l1.importedBy,['src/cart.mjs']);
  const l2=await app.auto({goal:'List the errors in this log',paths:['logs/ci.log']});assert.equal(l2.level,2);assert.ok(l2.findings.some(f=>/worker-2900 /.test(f.quote)&&f.verified));
  const l3=await app.auto({goal:'summarize this',context:'tiny'});assert.equal(l3.level,3);
  assert.deepEqual(app.engine.tasks().map(t=>t.level),[3,2,1]);
});
test('persistent cache: survives restart, TTL expiry, byte cap pruning; stats persist',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'kvo-cache-'));let now=1000;
  const c1=createCache({dir,ttlMs:500,now:()=>now});await c1.set('ab'+'0'.repeat(62),{v:1});
  const c2=createCache({dir,ttlMs:500,now:()=>now});assert.deepEqual(await c2.get('ab'+'0'.repeat(62)),{v:1});assert.equal(c2.stats().diskHits,1);
  now+=1000;const c3=createCache({dir,ttlMs:500,now:()=>now});assert.equal(await c3.get('ab'+'0'.repeat(62)),undefined);
  const c4=createCache({dir,maxBytes:2000,now:()=>now});for(let i=0;i<30;i++)await c4.set(String(i).padStart(2,'0')+'f'.repeat(62),{pad:'x'.repeat(200)});await c4.prune();
  let files=0;for(const s of await readdir(dir))files+=(await readdir(path.join(dir,s))).length;assert.ok(files<=10,'pruned to cap: '+files);
  const sf=path.join(dir,'stats.json');const s1=createStats({file:sf});s1.record('logs',{ok:true,ms:5});await s1.flush();const s2=createStats({file:sf});await s2.load();assert.equal(s2.get('logs').n,1);
  // engine-level: a second process instance hits the disk cache
  const root=await workspace(project);const env={...baseEnv(root),KVALAH_CACHE:'on',KVALAH_CACHE_DIR:dir};
  const p1=smartMock();const a=await createKvalahOffload({env,provider:p1});await a.engine.delegate({kind:'logs',instruction:'errors',paths:['logs/ci.log']});
  const p2=smartMock();const b=await createKvalahOffload({env,provider:p2});const r=await b.engine.delegate({kind:'logs',instruction:'errors',paths:['logs/ci.log']});
  assert.equal(r.cached,true);assert.equal(p2.calls.length,0);
});

function mockOllamaServer({token=null,prefix=''}={}){
  const seen=[];
  const srv=http.createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{
    seen.push({url:req.url,token:req.headers['x-kvalah-token']});
    if(token&&req.headers['x-kvalah-token']!==token){res.statusCode=401;return res.end();}
    if(req.url===prefix+'/info'||req.url==='/peer/info'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({models:['mock'],backend:'ollama'}));}
    if(req.url===prefix+'/api/tags')return res.end(JSON.stringify({models:[{name:'mock'}]}));
    if(req.url===prefix+'/api/chat'){const p=JSON.parse(b);const user=p.messages[1].content;const hits=user.split('\n').filter(l=>/ERROR/.test(l)&&!l.startsWith('<'));
      const text=p.format?JSON.stringify({summary:'remote',draft:'',findings:hits.map(h=>({text:'e',quote:h,path:''})),uncertainty:''}):hits.map(h=>'NOTE: '+h).join('\n')||'NONE';
      res.write(JSON.stringify({message:{content:text}})+'\n');return res.end(JSON.stringify({done:true,done_reason:'stop',eval_count:5,prompt_eval_count:50})+'\n');}
    res.statusCode=404;res.end();});});
  return new Promise(r=>srv.listen(0,'127.0.0.1',()=>r({srv,seen,url:'http://127.0.0.1:'+srv.address().port})));
}
test('LAN: jobs run on paired kvalah peers (token header, /peer/llm proxy) from the desktop devices.json',async()=>{
  const peer=await mockOllamaServer({token:'s3cret',prefix:'/peer/llm'});
  const dataDir=await mkdtemp(path.join(tmpdir(),'kvo-data-'));
  await writeFile(path.join(dataDir,'devices.json'),JSON.stringify({id:'self-0001',nodes:[{id:'peer-0000001',name:'gpu-box',kind:'kvalah',url:peer.url,token:'s3cret',enabled:true,tasks:true,maxParallel:2},{id:'peer-0000002',name:'disabled',kind:'ollama',url:'http://127.0.0.1:9',enabled:false}]}));
  const root=await workspace(project);
  const deadLocal={kind:'mock',base:'x',health:async()=>({online:false}),async *chat(){throw Error('local down');}};
  const app=await createKvalahOffload({env:{...baseEnv(root),KVALAH_LAN:'1',KVALAH_DATA_DIR:dataDir,KVALAH_LAN_ALLOW:'gpu-box',KVALAH_LAN_ALLOW_PLAINTEXT:'1'},provider:deadLocal});
  const st=await app.status();assert.equal(st.lan.enabled,true);assert.deepEqual(st.lan.nodes.map(n=>[n.name,n.online]),[['gpu-box',true]]);
  const r=await app.engine.delegate({kind:'logs',instruction:'errors',context:'ok\nERROR from lan'});
  assert.equal(r.node,'gpu-box');assert.equal(r.findings[0].verified,true);
  assert.ok(peer.seen.some(s=>s.url==='/peer/llm/api/chat'&&s.token==='s3cret'));
  assert.equal((await app.router.decide({goal:'What errors?',paths:['logs/ci.log']})).level,2,'router treats LAN capacity as online');
  await app.close();peer.srv.close();
});
test('LAN: missing devices.json disables LAN with a reason instead of crashing',async()=>{
  const root=await workspace(project);const app=await createKvalahOffload({env:{...baseEnv(root),KVALAH_LAN:'1',KVALAH_DATA_DIR:'/nonexistent-kvalah'},provider:smartMock()});
  const st=await app.status();assert.equal(st.lan.enabled,false);assert.match(st.lan.error,/devices\.json/);
});
const get=(url,headers={})=>new Promise((res,rej)=>{const u=new URL(url);http.get({host:u.hostname,port:u.port,path:u.pathname+u.search,headers},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>res({status:r.statusCode,body:b,headers:r.headers}));}).on('error',rej);});
test('dashboard: loopback only, token + Host checks, CSP nonce, live state',async()=>{
  const root=await workspace(project);const app=await createKvalahOffload({env:{...baseEnv(root),KVALAH_DASHBOARD:'1'},provider:smartMock()});
  const d=app.dashboard;assert.match(d.url,/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/);
  await app.engine.delegate({kind:'logs',instruction:'x',context:'ERROR a'});
  const page=await get(d.url);assert.equal(page.status,200);assert.match(page.headers['content-security-policy'],/script-src 'nonce-/);assert.match(page.body,/Kvalah Compute Offload/);
  const api=await get(`http://127.0.0.1:${d.port}/api/state?t=${d.token}`);const s=JSON.parse(api.body);assert.equal(s.tasks.length,1);assert.ok(s.metrics.savings);assert.equal(s.nodes[0].name,'local');
  assert.equal((await get(`http://127.0.0.1:${d.port}/api/state`)).status,401);
  assert.equal((await get(`http://127.0.0.1:${d.port}/api/state?t=${d.token}`,{Host:'evil.example:80'})).status,421);
  assert.equal((await app.status()).dashboard.url,`http://127.0.0.1:${d.port}/`); // v0.3 UI-01: token is not exposed via MCP
  await app.close();
});
