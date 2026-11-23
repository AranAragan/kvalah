// Multi-device mode: LAN helpers, discovery parsing, node registry, scheduler (fake nodes, failover),
// llama.cpp command lines and asset selection, Ollama GGUF lookup, the authenticated RPC tunnel,
// and helper-agent parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {isPrivateAddress,lanAddresses,broadcastAddresses,buildAnnouncement,buildProbe,parseAnnouncement,parseHostPort,newPairingCode,normalizeCode,codesEqual,newToken,tokenHash,hashesEqual,createLimiter} from '../lan.mjs';
import {createRegistry,normalizeNode,sameModel} from '../nodes.mjs';
import {createScheduler,NoNodeError} from '../scheduler.mjs';
import {pickAssets,rpcServerArgs,llamaServerArgs,parseListDevices,ollamaGgufModels,findBinary,LLAMA_BUILD} from '../llamacpp.mjs';
import {createPeerListener,createTunnelClient} from '../tunnel.mjs';
import {parseEdit,batchPrompt,runSubagent} from '../subagent.mjs';
import {tempDir} from './helpers.mjs';

test('private address ranges: LAN yes, internet no',()=>{
  for(const a of ['10.0.0.5','172.16.3.4','172.31.255.1','192.168.1.20','169.254.10.1','100.100.1.1','127.0.0.1','::1','fe80::1','fd12:3456::1','::ffff:192.168.0.7'])assert.ok(isPrivateAddress(a),a);
  for(const a of ['8.8.8.8','172.32.0.1','192.169.0.1','100.128.0.1','2001:4860::8888','','not-an-ip'])assert.ok(!isPrivateAddress(a),a);
});

test('LAN interfaces and broadcast addresses',()=>{
  const ifaces={lo:[{address:'127.0.0.1',netmask:'255.0.0.0',family:'IPv4',internal:true}],
    eth0:[{address:'192.168.1.20',netmask:'255.255.255.0',family:'IPv4',internal:false},{address:'fe80::1',family:'IPv6',internal:false}],
    tailscale0:[{address:'100.101.102.103',netmask:'255.192.0.0',family:'IPv4',internal:false}],
    wan:[{address:'81.2.3.4',netmask:'255.255.255.0',family:'IPv4',internal:false}],
    docker:[{address:'172.17.0.1',netmask:'255.255.0.0',family:4,internal:false}]};
  const list=lanAddresses(ifaces);
  assert.deepEqual(list.map(a=>a.address),['192.168.1.20','172.17.0.1','100.101.102.103'],'public and loopback excluded, home LANs first');
  assert.equal(list[0].broadcast,'192.168.1.255');
  assert.deepEqual(broadcastAddresses(ifaces).sort(),['100.127.255.255','172.17.255.255','192.168.1.255']);
  assert.deepEqual(broadcastAddresses({}),['255.255.255.255']);
});

test('discovery announcements: build/parse round trip and hostile input',()=>{
  const self={id:'aaaaaaaa-1111',name:'Desk <PC>',port:47317,version:'0.8.0',platform:'win32',modes:{tasks:true,rpc:false}};
  const r=parseAnnouncement(buildAnnouncement(self),{address:'192.168.1.30',port:47318},'other-id-1234');
  assert.deepEqual(r,{type:'announce',id:'aaaaaaaa-1111',name:'Desk PC',address:'192.168.1.30',port:47317,version:'0.8.0',platform:'win32',modes:{tasks:true,rpc:false}});
  assert.equal(parseAnnouncement(buildAnnouncement(self),{address:'192.168.1.30'},'aaaaaaaa-1111'),null,'own announcement ignored');
  assert.equal(parseAnnouncement(buildAnnouncement(self),{address:'8.8.8.8'},'x'),null,'internet source ignored');
  assert.equal(parseAnnouncement(Buffer.from('{not json'),{address:'192.168.1.30'},'x'),null);
  assert.equal(parseAnnouncement(Buffer.from(JSON.stringify({kvalah:2,type:'announce',id:'aaaaaaaa-1111',port:1})),{address:'192.168.1.30'},'x'),null,'unknown protocol');
  assert.equal(parseAnnouncement(Buffer.from(JSON.stringify({kvalah:1,type:'announce',id:'aaaaaaaa-1111',port:70000})),{address:'192.168.1.30'},'x'),null,'bad port');
  assert.equal(parseAnnouncement(Buffer.from(JSON.stringify({kvalah:1,type:'announce',id:'../../etc',port:1})),{address:'192.168.1.30'},'x'),null,'bad id');
  assert.equal(parseAnnouncement(Buffer.alloc(5000,32),{address:'192.168.1.30'},'x'),null,'oversized');
  assert.deepEqual(parseAnnouncement(buildProbe('bbbbbbbb-2222'),{address:'10.0.0.2',port:5555},'x'),{type:'probe',id:'bbbbbbbb-2222',address:'10.0.0.2',replyPort:5555});
});

test('manual addresses, pairing codes, tokens and the attempt limiter',()=>{
  assert.deepEqual(parseHostPort('192.168.1.20'),{host:'192.168.1.20',port:47317});
  assert.deepEqual(parseHostPort('http://192.168.1.20:5000/x'),{host:'192.168.1.20',port:5000});
  assert.deepEqual(parseHostPort('[fe80::1]:9000'),{host:'fe80::1',port:9000});
  assert.deepEqual(parseHostPort('laptop.local:47317'),{host:'laptop.local',port:47317});
  assert.throws(()=>parseHostPort('1.2.3.4:99999'));assert.throws(()=>parseHostPort('a b:1'));assert.throws(()=>parseHostPort(''));
  const code=newPairingCode();
  assert.match(code,/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.ok(codesEqual(code,code.toLowerCase().replace(/-/g,' ')),'case, spaces and dashes are ignored');
  assert.equal(normalizeCode('ab0o-1il'),'AB00111');
  assert.ok(!codesEqual(code,'0000-0000-0000'));assert.ok(!codesEqual('',''),'empty codes never match');
  const token=newToken();assert.equal(token.length,64);
  assert.ok(hashesEqual(tokenHash(token),tokenHash(token)));assert.ok(!hashesEqual(tokenHash(token),tokenHash(newToken())));assert.ok(!hashesEqual('zz','zz'));
  let now=0;const lim=createLimiter({limit:3,windowMs:1000,globalLimit:5,now:()=>now});
  for(let i=0;i<3;i++){assert.ok(!lim.blocked('a'));lim.fail('a');}
  assert.ok(lim.blocked('a'),'blocked after 3 failures');assert.ok(!lim.blocked('b'));
  lim.fail('b');lim.fail('b');assert.ok(lim.blocked('c'),'global limit');
  now=2000;assert.ok(!lim.blocked('a'),'window expires');
});

function fakeRegistry(specs){
  const providers={};
  const reg=createRegistry({providerFor:n=>providers[n.id]});
  for(const s of specs){
    const node=reg.add({id:s.id,name:s.id,kind:'ollama',url:'http://10.0.0.'+s.n+':11434',maxParallel:s.max||1});
    providers[node.id]={id:s.id,models:async()=>{if(s.down)throw Error('ECONNREFUSED');return (s.models||['qwen:14b']).map(name=>({name}));}};
  }
  return {reg,providers};
}

test('node registry: normalization, health checks, model matching, failure tracking',async()=>{
  assert.throws(()=>normalizeNode({kind:'ftp',url:'http://x'}));
  assert.throws(()=>normalizeNode({kind:'ollama',url:'file:///etc'}));
  const n=normalizeNode({kind:'ollama',url:'http://10.0.0.2:11434/',name:'<b>box</b>',maxParallel:99,memory:true});
  assert.equal(n.url,'http://10.0.0.2:11434');assert.equal(n.name,'bbox/b');assert.equal(n.maxParallel,8);assert.equal(n.memory,false,'memory pooling only for kvalah peers');
  assert.ok(sameModel('qwen','qwen:latest'));assert.ok(!sameModel('qwen:7b','qwen:14b'));
  const {reg}=fakeRegistry([{id:'node-aaaa',n:2,models:['qwen:14b','llama3:latest']},{id:'node-bbbb',n:3,down:true}]);
  await reg.checkAll();
  const a=reg.get('node-aaaa'),b=reg.get('node-bbbb');
  assert.equal(a.status.online,true);assert.ok(a.status.latencyMs>=0);assert.deepEqual(a.status.models,['qwen:14b','llama3:latest']);
  assert.equal(b.status.online,false);assert.match(b.status.error,/ECONNREFUSED/);
  assert.equal(reg.modelFor(a,'llama3'),'llama3:latest');assert.equal(reg.modelFor(a,'mistral'),null);
  reg.update('node-aaaa',{model:'qwen:14b'});assert.equal(reg.modelFor(reg.get('node-aaaa'),'mistral'),'qwen:14b','pinned model wins');
  assert.ok(reg.available(reg.get('node-aaaa'),'anything'));assert.ok(!reg.available(b,'qwen:14b'));
  for(let i=0;i<3;i++){reg.begin('node-aaaa');reg.end('node-aaaa',{ok:false});}
  assert.equal(reg.get('node-aaaa').status.online,false,'offline after 3 consecutive failures');
  assert.equal(reg.get('node-aaaa').status.failed,3);
  const k=reg.add({id:'peer-cccc',kind:'kvalah',url:'http://10.0.0.9:47317',token:'secret',name:'peer'});
  assert.equal(JSON.stringify(reg.publicList()).includes('secret'),false,'tokens never leave the backend');
  assert.equal(reg.publicList().find(x=>x.id===k.id).paired,true);
  assert.equal(reg.serialize().find(x=>x.id===k.id).token,'secret');assert.equal(reg.serialize()[0].status,undefined);
});

test('scheduler: parallel spread by load, order-stable results, failover and local fallback',async()=>{
  const {reg}=fakeRegistry([{id:'node-aaaa',n:2,max:2},{id:'node-bbbb',n:3,max:1}]);
  await reg.checkAll();
  const local={id:'local'};
  const sched=createScheduler({registry:reg,local:{provider:local,model:'qwen:14b',maxParallel:1}});
  let running=0,peak=0;const where=[];
  const results=await sched.map([50,10,30,20,40],async(ms,index,provider,model,node)=>{
    running++;peak=Math.max(peak,running);where.push(node.id);
    await new Promise(r=>setTimeout(r,ms));running--;return 'item'+index+'@'+provider.id+'/'+model;
  },{model:'qwen:14b'});
  assert.deepEqual(results.map(r=>r.value.split('@')[0]),['item0','item1','item2','item3','item4'],'input order kept');
  assert.ok(results.every(r=>r.ok));
  assert.equal(peak,4,'capacity = 2 + 1 + local 1');
  assert.ok(where.includes('node-aaaa')&&where.includes('node-bbbb')&&where.includes('local'));
  // Failover: the first node fails → the job moves to another node; the error is recorded.
  const seen=[];
  const r=await sched.run(async(provider)=>{seen.push(provider.id);if(seen.length===1)throw Error('HTTP 500');return 'ok from '+provider.id;},{model:'qwen:14b'});
  assert.notEqual(r.nodeId,seen[0],'retried on a different node');assert.equal(r.attempts,2);assert.match(r.errors[0].error,/500/);
  // Every remote fails → local fallback.
  const r2=await sched.run(async provider=>{if(provider.id!=='local')throw Error('down');return provider.id;},{model:'qwen:14b'});
  assert.equal(r2.value,'local');assert.equal(r2.attempts,3);
  // Fatal errors are not retried.
  await assert.rejects(sched.run(async()=>{const e=Error('bad request');e.fatal=true;throw e;},{model:'qwen:14b'}),/bad request/);
});

test('scheduler: local only as fallback, missing model, nothing available, abort',async()=>{
  const {reg}=fakeRegistry([{id:'node-aaaa',n:2,max:1,models:['qwen:14b']}]);
  await reg.checkAll();
  const local={id:'local'};
  const fb=createScheduler({registry:reg,local:{provider:local,model:'qwen:14b',maxParallel:1,fallbackOnly:true}});
  const results=await fb.map([1,2,3],async(x,i,p)=>p.id,{model:'qwen:14b'});
  assert.deepEqual(results.map(r=>r.value),['node-aaaa','node-aaaa','node-aaaa'],'local not used while a remote node can take work');
  const other=await fb.map([1],async(x,i,p)=>p.id,{model:'mistral:7b'});
  assert.equal(other[0].value,'local','no remote node has the model → local');
  const none=createScheduler({registry:reg,local:null});
  await assert.rejects(none.run(async()=>1,{model:'mistral:7b'}),NoNodeError);
  const failing=createScheduler({registry:reg,local:null});
  const out=await failing.map([1],async()=>{throw Error('boom');},{model:'qwen:14b'});
  assert.equal(out[0].ok,false);assert.match(out[0].error,/boom/);
  const ac=new AbortController();
  const slow=createScheduler({registry:null,local:{provider:local,model:'m',maxParallel:1}});
  const p=slow.map([1,2],async()=>{ac.abort(Error('stopped'));await new Promise(r=>setTimeout(r,20));throw Error('aborted run');},{model:'m',signal:ac.signal});
  await assert.rejects(p,/aborted run|stopped/);
});

test('llama.cpp: prebuilt asset per platform, pinned build with checksums',()=>{
  const win=pickAssets({platform:'win32',arch:'x64',backend:'auto'});
  assert.equal(win.backend,'vulkan');assert.deepEqual(win.files.map(f=>f.name),[`llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`]);
  assert.match(win.files[0].url,new RegExp('^https://github.com/ggml-org/llama.cpp/releases/download/'+LLAMA_BUILD+'/'));
  assert.match(win.files[0].sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(pickAssets({platform:'win32',arch:'x64',backend:'cuda'}).files.map(f=>f.name),[`llama-${LLAMA_BUILD}-bin-win-cuda-12.4-x64.zip`,'cudart-llama-bin-win-cuda-12.4-x64.zip'],'CUDA needs the runtime too');
  assert.equal(pickAssets({platform:'win32',arch:'arm64',backend:'cuda'}).backend,'cpu');
  assert.equal(pickAssets({platform:'darwin',arch:'arm64',backend:'auto'}).files[0].name,`llama-${LLAMA_BUILD}-bin-macos-arm64.tar.gz`);
  assert.equal(pickAssets({platform:'darwin',arch:'x64',backend:'vulkan'}).backend,'metal');
  assert.equal(pickAssets({platform:'linux',arch:'x64',backend:'cpu'}).files[0].name,`llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz`);
  assert.equal(pickAssets({platform:'linux',arch:'arm64',backend:'auto'}).files[0].name,`llama-${LLAMA_BUILD}-bin-ubuntu-vulkan-arm64.tar.gz`);
  assert.equal(pickAssets({platform:'freebsd',arch:'x64'}),null);assert.equal(pickAssets({platform:'linux',arch:'ia32'}),null);
});

test('llama.cpp command lines: rpc-server on loopback, llama-server with N workers',()=>{
  assert.deepEqual(rpcServerArgs({port:50152}),['-H','127.0.0.1','-p','50152','-c']);
  assert.deepEqual(rpcServerArgs({port:'6000',cache:false,threads:6}),['-H','127.0.0.1','-p','6000','-t','6']);
  assert.throws(()=>rpcServerArgs({port:0}));
  const rpc=['127.0.0.1:41001','127.0.0.1:41002','127.0.0.1:41003'];
  const args=llamaServerArgs({model:'/m/qwen-32b.gguf',rpc,port:41010,ctx:16384,localGpu:true,apiKey:'k'});
  assert.deepEqual(args,['-m','/m/qwen-32b.gguf','--host','127.0.0.1','--port','41010','-c','16384','-ngl','999','-np','1','--alias','pool','--jinja','--rpc','127.0.0.1:41001,127.0.0.1:41002,127.0.0.1:41003','--api-key','k']);
  const remoteOnly=llamaServerArgs({model:'C:\\models\\a.gguf',rpc:rpc.slice(0,2),port:5000,localGpu:false});
  assert.deepEqual(remoteOnly.slice(remoteOnly.indexOf('--device'),remoteOnly.indexOf('--device')+2),['--device','RPC0,RPC1'],'only RPC devices get layers');
  assert.ok(!llamaServerArgs({model:'/a.gguf',port:5000}).includes('--rpc'),'local only');
  assert.throws(()=>llamaServerArgs({model:'',port:5000}),/GGUF/);
  assert.throws(()=>llamaServerArgs({model:'/a.gguf',port:5000,rpc:[],localGpu:false}),/at least one/);
  assert.throws(()=>llamaServerArgs({model:'/a.gguf',port:5000,rpc:['127.0.0.1:1;rm -rf /']}),/Invalid RPC/);
  assert.throws(()=>llamaServerArgs({model:'/a.gguf',port:5000,ctx:10}),/context/);
});

test('llama.cpp --list-devices output parsing',()=>{
  const out='load_backend: loaded RPC backend\nAvailable devices:\n  Vulkan0: NVIDIA GeForce RTX 3060 (12288 MiB, 11000 MiB free)\n  RPC0: 127.0.0.1:50152 (16002 MiB, 15990 MiB free)\n  RPC1: 127.0.0.1:50153 (8000 MiB, 7000 MiB free)\n';
  assert.deepEqual(parseListDevices(out),[
    {name:'Vulkan0',description:'NVIDIA GeForce RTX 3060',totalMiB:12288,freeMiB:11000},
    {name:'RPC0',description:'127.0.0.1:50152',totalMiB:16002,freeMiB:15990},
    {name:'RPC1',description:'127.0.0.1:50153',totalMiB:8000,freeMiB:7000}]);
  assert.deepEqual(parseListDevices('Available devices:\n  (none)\n'),[]);
});

test('Ollama model store: GGUF blobs are found from manifests',async()=>{
  const dir=await tempDir();
  const blob=async(hex,content)=>{await fs.mkdir(path.join(dir,'blobs'),{recursive:true});await fs.writeFile(path.join(dir,'blobs','sha256-'+hex),content);};
  const manifest=async(parts,layers)=>{const f=path.join(dir,'manifests',...parts);await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,JSON.stringify({schemaVersion:2,layers}));};
  const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);
  await blob(a,Buffer.concat([Buffer.from('GGUF'),Buffer.alloc(100)]));await blob(b,Buffer.from('not a gguf'));await blob(c,Buffer.concat([Buffer.from('GGUF'),Buffer.alloc(10)]));
  await manifest(['registry.ollama.ai','library','qwen2.5-coder','14b'],[{mediaType:'application/vnd.ollama.image.model',digest:'sha256:'+a,size:104},{mediaType:'application/vnd.ollama.image.template',digest:'sha256:'+b}]);
  await manifest(['registry.ollama.ai','library','broken','latest'],[{mediaType:'application/vnd.ollama.image.model',digest:'sha256:'+b,size:10}]);
  await manifest(['registry.ollama.ai','someone','tiny','q4'],[{mediaType:'application/vnd.ollama.image.model',digest:'sha256:'+c,size:14}]);
  await manifest(['hf.co','org','model','Q8_0'],[{mediaType:'application/vnd.ollama.image.model',digest:'sha256:'+c,size:14}]);
  const list=await ollamaGgufModels(dir);
  assert.deepEqual(list.map(m=>m.name),['hf.co/org/model:Q8_0','qwen2.5-coder:14b','someone/tiny:q4']);
  assert.equal(list.find(m=>m.name==='qwen2.5-coder:14b').path,path.join(dir,'blobs','sha256-'+a));
  assert.deepEqual(await ollamaGgufModels(path.join(dir,'missing')),[]);
  await fs.mkdir(path.join(dir,'build','bin'),{recursive:true});const exe=process.platform==='win32'?'.exe':'';
  await fs.writeFile(path.join(dir,'build','bin','ggml-rpc-server'+exe),'');
  assert.equal(await findBinary(dir,['ggml-rpc-server'+exe,'rpc-server'+exe]),path.join(dir,'build','bin','ggml-rpc-server'+exe));
});

test('RPC tunnel: one LAN port for HTTP and token-authenticated rpc-server tunnels',async()=>{
  // Stand-in for ggml-rpc-server: echoes bytes, prefixed so the direction is visible.
  const echo=net.createServer(s=>s.on('data',d=>s.write(Buffer.concat([Buffer.from('<'),d]))));
  await new Promise(r=>echo.listen(0,'127.0.0.1',r));
  const httpServer=http.createServer((req,res)=>res.end('http:'+req.url));
  const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  let running=true;const seen=[];
  const listener=createPeerListener({addresses:['127.0.0.1'],port,httpServer,authorizeTunnel:t=>t==='good-token'?'host-a':null,tunnelTarget:()=>running?{host:'127.0.0.1',port:echo.address().port}:null,onTunnel:x=>seen.push(x.host)});
  await listener.start();
  try{
    assert.equal(await (await fetch('http://127.0.0.1:'+port+'/peer/info')).text(),'http:/peer/info','HTTP still works on the same port');
    const client=createTunnelClient({host:'127.0.0.1',port,token:'good-token'});const local=await client.listen();
    const reply=await new Promise((resolve,reject)=>{const s=net.connect(local,'127.0.0.1',()=>s.write('hello'));let got='';s.on('data',d=>{got+=d;if(got.length>=6){s.end();resolve(got);}});s.on('error',reject);});
    assert.equal(reply,'<hello');assert.deepEqual(seen,['host-a']);
    assert.ok(client.stats.bytesUp>=5&&client.stats.bytesDown>=6);client.close();
    const raw=async token=>new Promise(resolve=>{const s=net.connect(port,'127.0.0.1',()=>s.write('KVRPC1 '+token+'\nping'));let got='';s.on('data',d=>got+=d);s.on('close',()=>resolve(got));});
    assert.equal(await raw('bad-token'),'ERR unauthorized\n');
    running=false;assert.equal(await raw('good-token'),'ERR rpc-server is not running\n');
    const bad=createTunnelClient({host:'127.0.0.1',port,token:'bad-token'});const p2=await bad.listen();
    await new Promise(resolve=>{const s=net.connect(p2,'127.0.0.1',()=>s.write('x'));s.on('close',resolve);s.on('error',resolve);});
    assert.equal(bad.stats.lastError,'unauthorized');bad.close();
  }finally{listener.close();echo.close();}
  // Connections from outside private ranges are dropped before anything is read.
  const guarded=createPeerListener({addresses:['127.0.0.1'],port,httpServer,authorizeTunnel:()=>null,tunnelTarget:()=>null,allowRemote:()=>false});
  await guarded.start();
  try{await assert.rejects(fetch('http://127.0.0.1:'+port+'/'));}finally{guarded.close();}
});

test('helper agents: edit replies are validated before anything is written',()=>{
  const original=Array.from({length:30},(_,i)=>'line '+i).join('\n')+'\n';
  assert.deepEqual(parseEdit('NO_CHANGE',original),{status:'unchanged'});
  const changed=original.replace('line 3','line three');
  assert.deepEqual(parseEdit('Sure!\n<updated_file>\n'+changed+'</updated_file>',original),{status:'changed',content:changed});
  assert.equal(parseEdit('```js\n'+changed.trimEnd()+'\n```',original).content,changed,'fenced block accepted, final newline kept');
  assert.equal(parseEdit('<updated_file>\n'+original+'</updated_file>',original).status,'unchanged');
  assert.match(parseEdit('<updated_file>\nline 0\n// ... rest of the file unchanged\n</updated_file>',original).reason,/placeholder/);
  assert.match(parseEdit('<updated_file>\n'+original.split('\n').slice(0,10).join('\n')+'\n</updated_file>',original).reason,/dropped/);
  assert.equal(parseEdit('I would change line 3.',original).status,'rejected');
  assert.match(batchPrompt({instruction:'Add a header',file:'a.js',content:'x',mode:'edit'}),/<updated_file>/);
  assert.doesNotMatch(batchPrompt({instruction:'Summarize',file:'a.js',content:'x',mode:'report'}),/updated_file/);
});

test('helper agents: read-only tool loop with native and text tool calls',async()=>{
  const tools=['read_file','search_code','find_files','outline_file','list_files','write_file','run_shell'].map(name=>({type:'function',function:{name,description:name,parameters:{type:'object',properties:{path:{type:'string'}}}}}));
  const scripted=replies=>{let i=0;const seen=[];return {seen,chat:async function*({messages,tools:t}){seen.push({messages:structuredClone(messages),tools:t});const r=replies[Math.min(i++,replies.length-1)];if(r.content)yield {type:'content',text:r.content};if(r.calls)yield {type:'tool_calls',calls:r.calls};yield {type:'done',reason:'stop'};}};};
  const executed=[];
  const exec=async(name,args)=>{executed.push(name+':'+args.path);return {content:'1: export const x = 1;'};};
  const native=scripted([{calls:[{function:{name:'read_file',arguments:{path:'a.js'}}},{function:{name:'run_shell',arguments:{command:'rm -rf /'}}}]},{content:'a.js exports x (line 1).'}]);
  const r=await runSubagent({provider:native,model:'m',native:true,task:{title:'T',instruction:'What does a.js export?'},tools,execTool:exec});
  assert.equal(r.text,'a.js exports x (line 1).');assert.deepEqual(executed,['read_file:a.js'],'write/shell tools are never executed');
  assert.deepEqual(native.seen[0].tools.map(t=>t.function.name),['read_file','search_code','find_files','outline_file','list_files'],'only read-only tools are offered');
  assert.match(native.seen[1].messages.at(-1).content,/not available to sub-agents/);
  const text=scripted([{content:'<tool_call>\n{"name":"read_file","arguments":{"path":"b.js"}}\n</tool_call>'},{content:'done'}]);
  const r2=await runSubagent({provider:text,model:'m',native:false,task:{title:'T',instruction:'x'},tools,execTool:exec});
  assert.equal(r2.text,'done');assert.equal(executed.at(-1),'read_file:b.js');
  assert.match(text.seen[0].messages[0].content,/TOOLS \(text protocol\)/);assert.match(text.seen[1].messages.at(-1).content,/<tool_result/);
  const looping=scripted([{calls:[{function:{name:'list_files',arguments:{path:'.'}}}]}]);
  const r3=await runSubagent({provider:looping,model:'m',native:true,task:{title:'T',instruction:'x'},tools,execTool:exec,maxSteps:2});
  assert.equal(looping.seen.length,3,'bounded: 2 tool rounds + final answer');assert.deepEqual(looping.seen[2].tools,[]);void r3;
});
