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
    app=await startApp({modelUrl:model.url,data:path.join(root,'d'),workspace:ws,env:{KVALAH_PEER_BIND:'127.0.0.1',KVALAH_DISCOVERY_PORT:String(await freePort()),KVALAH_LANG:'en'}});
    const s=(await app.api('/api/devices')).body;
    assert.match(s.self.id,/^[a-f0-9-]{36}$/);assert.equal(s.llama.build.startsWith('b'),true);assert.equal(s.pool.state,'stopped');
    assert.equal((await app.api('/api/devices/share',{port:80})).body.error,'The port must be between 1024 and 65535.');
    assert.match((await app.api('/api/devices/pool/start',{workers:[],localGpu:false,model:'/x.gguf'})).body.error,/at least one device/);
    assert.match((await app.api('/api/devices/pool/start',{workers:[],localGpu:true,model:'/no/such.gguf'})).body.error,/GGUF/);
    const gguf=path.join(root,'m.gguf');fs.writeFileSync(gguf,'GGUF');
    assert.match((await app.api('/api/devices/pool/start',{workers:[],localGpu:true,model:gguf})).body.error,/llama\.cpp is not installed/);
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
