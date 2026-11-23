// End-to-end: two kvalah backends on one machine. B shares itself (bound to loopback for the test),
// A pairs with B's code, enables "Distribute tasks", and the agent's parallel_tasks / batch_files
// run sub-tasks on B through the authenticated peer proxy, with failover back to A.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {mockModel,startApp,tempDir,freePort} from './helpers.mjs';

const isHelper=body=>/read-only helper sub-agent|file-processing helper/.test(body.messages?.[0]?.content||'');

test('distributed tasks across paired devices: pairing, peer proxy auth, parallel_tasks, failover, batch_files',{timeout:90000},async()=>{
  const root=await tempDir(),ws=path.join(root,'ws');fs.mkdirSync(path.join(ws,'src'),{recursive:true});
  for(const n of ['a','b','c'])fs.writeFileSync(path.join(ws,'src',n+'.js'),'export const '+n+' = 1;\n');
  let bFailures=1,editStep=-1;
  const modelB=await mockModel(async(url,body)=>{
    if(isHelper(body)){
      if(bFailures-->0)throw Error('simulated crash');
      const file=/File: (\S+)/.exec(body.messages[1].content)?.[1];
      if(file)return {content:file.endsWith('b.js')?'<updated_file>\nexport const b = 2;\n</updated_file>':'NO_CHANGE'};
      return {content:'report from B: '+body.messages[1].content.split('\n')[0]};
    }
    return {content:'B main'};
  });
  const modelA=await mockModel(async(url,body,index)=>{
    if(isHelper(body))return {content:'report from A (local fallback)'};
    const last=body.messages.at(-1);
    if(editStep>=0){const steps=[{tool_calls:[{function:{name:'inspect_project',arguments:{}}}]},{tool_calls:[{function:{name:'update_plan',arguments:{steps:[{title:'bump b to 2'}],note:''}}}]},{tool_calls:[{function:{name:'batch_files',arguments:{instruction:'Set b to 2',files:['src/a.js','src/b.js'],mode:'edit'}}}]},{content:'Edited.'}];return steps[Math.min(editStep++,3)];}
    const text=body.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');
    if(last.role==='tool')return {content:'All done.'};
    if(body.messages.some(m=>m.role==='user'&&m.content==='hello'))return {content:'hi'};
    if(/report each/.test(text))return {tool_calls:[{function:{name:'batch_files',arguments:{instruction:'Summarize',pattern:'src/*.js',mode:'report'}}}]};
    if(/investigate/.test(text))return {tool_calls:[{function:{name:'parallel_tasks',arguments:{tasks:[{title:'usages',instruction:'Find usages of a'},{title:'review',instruction:'Review b.js'},{title:'tests',instruction:'Which tests are missing?'}]}}}]};
    return {content:'?'};
  });
  const peerPort=await freePort();
  const common={KVALAH_PEER_BIND:'127.0.0.1',KVALAH_DISCOVERY_PORT:String(await freePort()),KVALAH_DISCOVERY_TARGET:'127.0.0.1'};
  let a,b;
  try{
    b=await startApp({modelUrl:modelB.url,data:path.join(root,'b'),workspace:path.join(root,'wsb'),env:common});
    a=await startApp({modelUrl:modelA.url,data:path.join(root,'a'),workspace:ws,env:common});
    // Nothing is shared until the user turns it on.
    let sb=(await b.api('/api/devices')).body;
    assert.equal(sb.share.enabled,false);assert.equal(sb.share.listening,false);
    sb=(await b.api('/api/devices/share',{enabled:true,port:peerPort,name:'Laptop B'})).body;
    assert.equal(sb.share.listening,true,sb.share.error);assert.match(sb.share.code,/^\w{4}-\w{4}-\w{4}$/);
    const peer='http://127.0.0.1:'+peerPort;
    assert.equal((await fetch(peer+'/peer/info')).status,401,'peer API needs a token');
    assert.equal((await fetch(peer+'/peer/llm/api/tags')).status,401,'model proxy needs a token');
    assert.equal((await a.api('/api/devices/pair',{address:'127.0.0.1:'+peerPort,code:'0000-0000-0000'})).body.error,'Неверный код сопряжения.');
    assert.equal((await a.api('/api/devices/pair',{address:'8.8.8.8:'+peerPort,code:sb.share.code})).status,400,'public addresses are refused');
    let sa=(await a.api('/api/devices/pair',{address:'127.0.0.1:'+peerPort,code:sb.share.code.toLowerCase()})).body;
    assert.equal(sa.nodes.length,1);const node=sa.nodes[0];
    assert.equal(node.name,'Laptop B');assert.equal(node.kind,'kvalah');assert.equal(node.status.online,true,node.status.error);
    assert.deepEqual(node.status.models,['mock:latest']);assert.equal(node.paired,true);
    assert.deepEqual(node.status.info?.pool,{running:false},'the worker tells whether its GPUs run its own pool');
    assert.ok(!JSON.stringify(sa).includes('"token"'),'the pairing token never reaches the UI');
    sb=(await b.api('/api/devices')).body;assert.equal(sb.share.hosts.length,1);assert.equal(sb.share.hosts[0].hash,undefined);
    const stored=JSON.parse(fs.readFileSync(path.join(root,'a','devices.json'),'utf8')).nodes[0].token;
    const denied=await fetch(peer+'/peer/llm/api/pull',{method:'POST',headers:{'x-kvalah-token':stored}});assert.equal(denied.status,404,'only chat/model routes are proxied');
    // Tasks: B does the work, A only as a fallback.
    sa=(await a.api('/api/devices/tasks',{enabled:true,localParallel:0})).body;assert.equal(sa.tasks.enabled,true);
    const chat=(await a.api('/api/chats',{})).body;
    await a.api('/api/project/open',{chatId:chat.id,path:ws});
    const events=await a.turn({chatId:chat.id,text:'investigate the code',model:'mock:latest',agent:true});
    const result=events.find(e=>e.type==='tool_result')?.result;
    assert.ok(result,JSON.stringify(events.filter(e=>e.type==='error')));
    assert.deepEqual(result.tasks.map(t=>t.title),['usages','review','tests'],'reports in task order');
    const devicesUsed=result.tasks.map(t=>t.device);
    assert.ok(devicesUsed.includes('Laptop B'),JSON.stringify(result));
    assert.ok(devicesUsed.includes('local'),'the crashed request was retried and fell back to this device');
    assert.match(result.tasks.find(t=>t.device==='Laptop B').report,/report from B/);
    assert.ok(events.some(e=>e.type==='warning'&&/Laptop B/.test(e.text)),'retry is reported');
    assert.equal(events.at(-1).reason,'completed');
    const helperOnB=modelB.requests.filter(r=>r.url==='/api/chat'&&isHelper(r.body));
    assert.ok(helperOnB.length>=2);assert.deepEqual(helperOnB[0].body.tools.map(t=>t.function.name).sort(),['find_files','list_files','outline_file','read_file','search_code'],'helpers get read-only tools only');
    // The distributed tools are offered only while the mode is on.
    const mainReq=modelA.requests.filter(r=>r.url==='/api/chat'&&!isHelper(r.body));
    assert.ok(mainReq[0].body.tools.some(t=>t.function.name==='parallel_tasks'));
    // batch_files in report mode, results per file in order.
    const ev2=await a.turn({chatId:chat.id,text:'report each file',model:'mock:latest',agent:true});
    const r2=ev2.find(e=>e.type==='tool_result')?.result;
    assert.deepEqual(r2.files.map(f=>f.path),['src/a.js','src/b.js','src/c.js']);
    assert.ok(r2.files.every(f=>f.device==='Laptop B'&&f.answer),JSON.stringify(r2));
    // batch_files edit mode: helpers propose, this device applies the edits in order with a hash check.
    editStep=0;
    const ev3=await a.turn({chatId:chat.id,text:'edit files',model:'mock:latest',agent:true});editStep=-1;
    const r3=ev3.filter(e=>e.type==='tool_result').at(-1)?.result;
    assert.equal(r3?.mode,'edit',JSON.stringify(ev3.filter(e=>e.type==='tool_result'||e.type==='error')));
    assert.deepEqual(r3.files.map(f=>[f.path,f.status]),[['src/a.js','unchanged'],['src/b.js','changed']]);
    assert.equal(r3.changed,1);assert.match(r3.note,/verify_project/);
    assert.equal(fs.readFileSync(path.join(ws,'src','b.js'),'utf8'),'export const b = 2;\n');
    assert.equal(fs.readFileSync(path.join(ws,'src','a.js'),'utf8'),'export const a = 1;\n');
    // Turning the mode off removes the tools again.
    await a.api('/api/devices/tasks',{enabled:false});
    modelA.requests.length=0;
    await a.turn({chatId:chat.id,text:'hello',model:'mock:latest',agent:true});
    assert.ok(!modelA.requests.find(r=>r.url==='/api/chat').body.tools.some(t=>t.function.name==='parallel_tasks'));
    // Revoking on B cuts A off; A then reports the device as unpaired.
    await b.api('/api/devices/hosts/revoke',{id:sb.share.hosts[0].id});
    sa=(await a.api('/api/devices/check',{})).body;
    assert.equal(sa.nodes[0].status.online,false);assert.match(sa.nodes[0].status.error,/сопряжение|pairing/i);
    // Sharing off closes the port.
    await b.api('/api/devices/share',{enabled:false});
    await assert.rejects(fetch(peer+'/peer/info'));
  }finally{await a?.stop();await b?.stop();await modelA.close();await modelB.close();}
});

test('devices API validation and pool preconditions',{timeout:60000},async()=>{
  const root=await tempDir(),ws=path.join(root,'ws');fs.mkdirSync(ws,{recursive:true});
  const model=await mockModel(async()=>({content:'ok'}));
  let app;
  try{
    app=await startApp({modelUrl:model.url,data:path.join(root,'d'),workspace:ws,env:{KVALAH_PEER_BIND:'127.0.0.1',KVALAH_DISCOVERY_PORT:String(await freePort()),KVALAH_LANG:'en',OLLAMA_MODELS:path.join(root,'ollama')}});
    const s=(await app.api('/api/devices')).body;
    assert.match(s.self.id,/^[a-f0-9-]{36}$/);assert.equal(s.llama.build.startsWith('b'),true);assert.equal(s.pool.state,'stopped');
    assert.equal((await app.api('/api/devices/share',{port:80})).body.error,'The port must be between 1024 and 65535.');
    assert.match((await app.api('/api/devices/pool/start',{workers:[],localGpu:false,model:'/x.gguf'})).body.error,/at least one device/);
    assert.match((await app.api('/api/devices/pool/start',{workers:[],localGpu:true,model:'/no/such.gguf'})).body.error,/GGUF/);
    const gguf=path.join(root,'m.gguf');fs.writeFileSync(gguf,'GGUF');
    assert.match((await app.api('/api/devices/pool/start',{workers:[],localGpu:true,model:gguf})).body.error,/llama\.cpp is not installed/);
    // Picking a model in "From Ollama" sends its name; the server finds the blob (0.8.0 lost the choice and failed).
    assert.match((await app.api('/api/devices/pool/start',{workers:[],localGpu:true})).body.error,/Choose a model from Ollama or a GGUF file/);
    assert.match((await app.api('/api/devices/pool/start',{workers:[],localGpu:true,model:'/no/such.gguf'})).body.error,/GGUF file not found: \/no\/such\.gguf/);
    const notGguf=path.join(root,'x.bin');fs.writeFileSync(notGguf,'nope');
    assert.match((await app.api('/api/devices/pool/start',{workers:[],localGpu:true,model:notGguf})).body.error,/not a GGUF model/);
    const store=path.join(root,'ollama'),hex='d'.repeat(64);
    fs.mkdirSync(path.join(store,'blobs'),{recursive:true});fs.writeFileSync(path.join(store,'blobs','sha256-'+hex),Buffer.concat([Buffer.from('GGUF'),Buffer.alloc(32)]));
    fs.mkdirSync(path.join(store,'manifests','registry.ollama.ai','library','qwen3.5'),{recursive:true});
    fs.writeFileSync(path.join(store,'manifests','registry.ollama.ai','library','qwen3.5','9b-q4_K_M'),JSON.stringify({layers:[{mediaType:'application/vnd.ollama.image.model',digest:'sha256:'+hex,size:36}]}));
    const listed=(await app.api('/api/devices/gguf')).body;
    assert.deepEqual(listed.models.map(m=>m.name),['qwen3.5:9b-q4_K_M']);assert.equal(listed.blobs,path.join(store,'blobs'));
    assert.match((await app.api('/api/devices/pool/start',{workers:[],localGpu:true,ollamaModel:'qwen3.5:9b-q4_K_M'})).body.error,/llama\.cpp is not installed/);
    assert.equal((await app.api('/api/devices')).body.pool.ollamaModel,'qwen3.5:9b-q4_K_M');
    const missing=(await app.api('/api/devices/pool/start',{workers:[],localGpu:true,ollamaModel:'nope:1b'})).body.error;
    assert.match(missing,/Ollama model nope:1b/);assert.ok(missing.includes(path.join(store,'manifests','registry.ollama.ai','library','nope','1b')));assert.ok(missing.includes(path.join(store,'blobs')));
    assert.match((await app.api('/api/devices/pool/use',{})).body.error,/not running/);
    assert.match((await app.api('/api/devices/llama/path',{path:root})).body.error,/llama-server/);
    const added=(await app.api('/api/devices/add',{kind:'ollama',url:model.url.replace('http://','')})).body;
    assert.equal(added.nodes[0].status.online,true);assert.equal(added.nodes[0].kind,'ollama');
    const id=added.nodes[0].id;
    const upd=(await app.api('/api/devices/node',{id,maxParallel:3,model:'mock:latest',memory:true})).body;
    assert.equal(upd.nodes[0].maxParallel,3);assert.equal(upd.nodes[0].memory,false,'memory pooling only with kvalah peers');
    assert.equal((await app.api('/api/devices/remove',{id})).body.nodes.length,0);
    assert.ok(Array.isArray((await app.api('/api/devices/gguf')).body.models));
    assert.equal((await fetch(app.origin+'/api/devices')).status,403,'local API still needs the session token');
  }finally{await app?.stop();await model.close();}
});

test('pool: a llama-server that stops making progress ends in an error, not an endless load',{timeout:60000,skip:process.platform==='win32'},async()=>{
  const root=await tempDir(),ws=path.join(root,'ws'),bin=path.join(root,'bin');fs.mkdirSync(ws,{recursive:true});fs.mkdirSync(bin);
  // A stand-in llama-server: lists a CPU device, then prints one line and hangs.
  const fake=path.join(bin,'llama-server');
  fs.writeFileSync(fake,'#!'+process.execPath+'\nif(process.argv.includes("--list-devices")){console.log("Available devices:\\n  CPU: test (1000 MiB, 900 MiB free)");process.exit(0);}\nconsole.error("load_tensors: loading model");setInterval(()=>{},1e6);\n',{mode:0o755});
  const gguf=path.join(root,'m.gguf');fs.writeFileSync(gguf,'GGUF');
  const model=await mockModel(async()=>({content:'ok'}));
  let app;
  try{
    app=await startApp({modelUrl:model.url,data:path.join(root,'d'),workspace:ws,env:{KVALAH_PEER_BIND:'127.0.0.1',KVALAH_DISCOVERY_PORT:String(await freePort()),KVALAH_LANG:'en',KVALAH_POOL_STALL_WARN_MS:'1500',KVALAH_POOL_STALL_STOP_MS:'4000'}});
    assert.equal((await app.api('/api/devices/llama/path',{path:bin})).body.error,undefined);
    const started=(await app.api('/api/devices/pool/start',{workers:[],localGpu:true,model:gguf})).body;
    assert.equal(started.error,undefined);
    let pool;
    for(let i=0;i<60;i++){pool=(await app.api('/api/devices')).body.pool;if(pool.state==='error')break;await new Promise(r=>setTimeout(r,250));}
    assert.equal(pool.state,'error');
    assert.match(pool.error,/without progress/);assert.match(pool.error,/load_tensors: loading model/);
    assert.ok(pool.warnings.some(w=>/made no progress/.test(w)),'warned before stopping');
  }finally{await app?.stop();await model.close();}
});

test('links and live activity: failover to a working link, link measurement, peer activity',{timeout:60000},async()=>{
  const root=await tempDir();
  const model=await mockModel(async()=>({content:'ok'}));
  const peerPort=await freePort();
  const common={KVALAH_PEER_BIND:'127.0.0.1',KVALAH_DISCOVERY_PORT:String(await freePort()),KVALAH_DISCOVERY_TARGET:'127.0.0.1',KVALAH_LANG:'en'};
  let a,b;
  try{
    b=await startApp({modelUrl:model.url,data:path.join(root,'b'),workspace:path.join(root,'wsb'),env:common});
    a=await startApp({modelUrl:model.url,data:path.join(root,'a'),workspace:path.join(root,'wsa'),env:common});
    const sb=(await b.api('/api/devices/share',{enabled:true,port:peerPort,name:'Worker'})).body;
    let sa=(await a.api('/api/devices/pair',{address:'127.0.0.1:'+peerPort,code:sb.share.code})).body;
    const id=sa.nodes[0].id,good='http://127.0.0.1:'+peerPort;
    // Link measurement over the authenticated peer API.
    sa=(await a.api('/api/devices/measure',{})).body;
    const link=sa.nodes[0].status.link;
    assert.ok(link.rttMs>=0&&link.mbps>0,JSON.stringify(link));
    assert.equal((await fetch(good+'/peer/speedtest?bytes=10')).status,401,'speed test needs the token');
    assert.equal((await fetch(good+'/peer/activity')).status,401,'activity needs the token');
    // Own activity, and the worker's activity polled through the token-authenticated API.
    await a.api('/api/devices/tasks',{enabled:true});
    let act=(await a.api('/api/devices/activity')).body;
    assert.ok(act.cpu>=0&&act.ram.total>0&&act.net&&Array.isArray(act.roles));
    for(let i=0;i<20&&!act.peers?.[id];i++){await new Promise(r=>setTimeout(r,300));act=(await a.api('/api/devices/activity')).body;}
    assert.ok(act.peers[id],'worker activity reaches the host');assert.ok(act.peers[id].ram.total>0);
    // A faster link that does not answer (a Thunderbolt cable unplugged): the health check falls back.
    await a.stop();a=null;
    const file=path.join(root,'a','devices.json'),st=JSON.parse(fs.readFileSync(file,'utf8'));
    st.nodes[0].url='http://127.0.0.2:9';st.nodes[0].link='thunderbolt';st.nodes[0].links=[{url:'http://127.0.0.2:9',type:'thunderbolt'},{url:good,type:'ethernet'}];
    fs.writeFileSync(file,JSON.stringify(st));
    a=await startApp({modelUrl:model.url,data:path.join(root,'a'),workspace:path.join(root,'wsa'),env:common});
    sa=(await a.api('/api/devices/check',{})).body;
    assert.equal(sa.nodes[0].status.online,true,sa.nodes[0].status.error);
    assert.equal(sa.nodes[0].url,good,'switched to the link that answers');
  }finally{await a?.stop();await b?.stop();await model.close();}
});

test('pool: a slow integrated GPU next to a discrete one gets no layers (explicit --device list)',{timeout:60000,skip:process.platform==='win32'},async()=>{
  const root=await tempDir(),ws=path.join(root,'ws'),bin=path.join(root,'bin');fs.mkdirSync(ws,{recursive:true});fs.mkdirSync(bin);
  const argsFile=path.join(root,'args.json');
  fs.writeFileSync(path.join(bin,'llama-server'),'#!'+process.execPath+'\nconst fs=require("fs");if(process.argv.includes("--list-devices")){console.log("Available devices:\\n  Vulkan0: NVIDIA GeForce RTX 4060 Laptop GPU (8188 MiB, 7900 MiB free)\\n  Vulkan1: AMD Radeon 610M (RADV RAPHAEL_MENDOCINO) (7800 MiB, 7400 MiB free)");process.exit(0);}\nfs.writeFileSync('+JSON.stringify(argsFile)+',JSON.stringify(process.argv.slice(2)));setInterval(()=>{},1e6);\n',{mode:0o755});
  const gguf=path.join(root,'m.gguf');fs.writeFileSync(gguf,'GGUF');
  const model=await mockModel(async()=>({content:'ok'}));
  let app;
  try{
    app=await startApp({modelUrl:model.url,data:path.join(root,'d'),workspace:ws,env:{KVALAH_PEER_BIND:'127.0.0.1',KVALAH_DISCOVERY_PORT:String(await freePort()),KVALAH_LANG:'en'}});
    await app.api('/api/devices/llama/path',{path:bin});
    const s=(await app.api('/api/devices/pool/start',{workers:[],localGpu:true,model:gguf,ctx:8192})).body;
    assert.equal(s.error,undefined);
    for(let i=0;i<40&&!fs.existsSync(argsFile);i++)await new Promise(r=>setTimeout(r,100));
    const args=JSON.parse(fs.readFileSync(argsFile,'utf8'));
    assert.equal(args[args.indexOf('--device')+1],'Vulkan0');
    assert.deepEqual(s.pool.devices.map(d=>[d.device,d.used]),[['Vulkan0',true],['Vulkan1',false]]);
    assert.ok(s.pool.warnings.some(w=>/Radeon 610M/.test(w)),JSON.stringify(s.pool.warnings));
    assert.equal(s.pool.skipIgpu,true);
    await app.api('/api/devices/pool/stop',{});
  }finally{await app?.stop();await model.close();}
});
