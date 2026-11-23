import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {mockModel,startApp,tempDir} from './helpers.mjs';

const call=(name,args)=>({function:{name,arguments:args}});
const hasGit=(()=>{try{execFileSync('git',['--version']);return true;}catch{return false;}})();

test('agent turn end-to-end on an opened existing repository (Ollama, native + text tool calls)',async()=>{
  const root=await tempDir(),data=path.join(root,'data'),workspace=path.join(root,'ws'),repo=path.join(root,'repo');
  await fs.mkdir(workspace,{recursive:true});await fs.mkdir(repo);
  await fs.writeFile(path.join(repo,'app.js'),'function hello(){\r\n  return "hello";\r\n}\r\nmodule.exports={hello};\r\n');
  await fs.writeFile(path.join(repo,'AGENTS.md'),'Use two-space indentation.\n');
  if(hasGit){execFileSync('git',['init','-q'],{cwd:repo});execFileSync('git',['-c','user.name=t','-c','user.email=t@t','add','.'],{cwd:repo});execFileSync('git',['-c','user.name=t','-c','user.email=t@t','commit','-qm','init'],{cwd:repo});}
  const script=[
    {tool_calls:[call('search_code',{pattern:'hello'})]},
    {tool_calls:[call('update_plan',{steps:[{title:'Change greeting; check: node --check app.js'}],note:'plan'})]},
    {tool_calls:[call('edit_file',{path:'app.js',old_text:'function hello(){\n  return "hello";\n}',new_text:'function hello(){\n  return "hi";\n}'})]},
    {content:'Теперь добавлю файл.\n<tool_call>\n{"name": "apply_patch", "arguments": {"patch": "*** Begin Patch\\n*** Add File: util.js\\n+exports.x=1;\\n*** End Patch"}}\n</tool_call>'},
    {tool_calls:[call('verify_project',{command:'node --check app.js',artifacts:[{path:'util.js',kind:'file'}]})]},
    {tool_calls:[call('finish_task',{summary:'done'})]},
    {content:'Готово: приветствие изменено.'}
  ];
  const seen=[];
  const model=await mockModel(async(url,body,index)=>{seen.push(body);return script[index]||{content:'ok'};});
  let app;
  try{
    app=await startApp({modelUrl:model.url,data,workspace});
    const state=await app.api('/api/state');
    assert.equal(state.status,200);assert.equal(state.body.token,undefined,'token must not be served over HTTP');
    const noToken=await fetch(app.origin+'/api/state');assert.equal(noToken.status,403);
    const chat=(await app.api('/api/chats',{})).body;
    const opened=await app.api('/api/project/open',{chatId:chat.id,path:repo});
    assert.equal(opened.status,200,JSON.stringify(opened.body));assert.equal(opened.body.project.existing,true);
    const events=await app.turn({chatId:chat.id,text:'Поменяй приветствие на hi',model:'mock:latest',agent:true},async(e,api)=>{
      if(e.type==='approval'){assert.equal(e.name,'run_shell');assert.ok(e.args.rule);await api('/api/approve',{id:e.id,runId:e.runId,allowed:true,always:true});}
    });
    const done=events.find(e=>e.type==='done');
    assert.ok(done,'turn finished: '+JSON.stringify(events.filter(e=>e.type==='error'||e.type==='warning')));
    assert.equal(done.reason,'completed');
    const content=await fs.readFile(path.join(repo,'app.js'),'utf8');
    assert.equal(content,'function hello(){\r\n  return "hi";\r\n}\r\nmodule.exports={hello};\r\n','CRLF preserved and edit applied');
    assert.equal(await fs.readFile(path.join(repo,'util.js'),'utf8'),'exports.x=1;\n');
    assert.ok(events.some(e=>e.type==='content'),'text tool call was parsed and content replaced');
    await fs.access(path.join(repo,'.kvalah','PLAN.md'));
    await assert.rejects(fs.access(path.join(repo,'PLAN.md')),'existing projects keep managed files in .kvalah');
    // System prompt is stable between steps (KV-cache friendly); volatile state goes last.
    assert.equal(seen[0].messages[0].content,seen[3].messages[0].content);
    assert.match(seen[1].messages.at(-1).content,/kvalah task state/);
    assert.ok(seen[0].tools?.length>10);
    const project=(await app.api('/api/project?chatId='+chat.id)).body;
    assert.equal(project.workflow.phase,'completed');
    assert.deepEqual(project.allowRules,['node --check app.js']);
    assert.ok(project.workflow.changes[0].diff.includes('-  return "hello";'));
    if(hasGit){
      assert.equal(project.checkpoints.length,1);
      const rew=await app.api('/api/project/rewind',{chatId:chat.id,checkpointId:project.checkpoints[0].id});
      assert.equal(rew.status,200,JSON.stringify(rew.body));
      assert.match(await fs.readFile(path.join(repo,'app.js'),'utf8'),/"hello"/);
      await assert.rejects(fs.access(path.join(repo,'util.js')));
      assert.equal(execFileSync('git',['status','--porcelain'],{cwd:repo}).toString().trim(),'','user repository untouched after rewind (.kvalah excluded)');
    }
    const full=(await app.api('/api/chats/get?id='+chat.id)).body;
    assert.ok(full.messages.some(m=>m.role==='tool'&&m.tool_name==='apply_patch'));
    await fs.access(path.join(data,'chats',chat.id+'.json'));
  }finally{await app?.stop();await model.close();}
});

test('text tool protocol for models without native tools; truncated output is never executed',async()=>{
  const root=await tempDir(),data=path.join(root,'data'),workspace=path.join(root,'ws');await fs.mkdir(workspace,{recursive:true});
  const script=[
    {content:'<tool_call>{"name":"get_environment","arguments":{}}</tool_call>'},
    {content:'<tool_call>{"name":"write_file","arguments":{"path":"big.txt","content":"partial',reason:'length'},
    {content:'Сделано без записи.'}
  ];
  const seen=[];
  const model=await mockModel(Object.assign(async(url,body,index)=>{seen.push(body);return script[index]||{content:'ok'};},{capabilities:['completion']}));
  let app;
  try{
    app=await startApp({modelUrl:model.url,data,workspace});
    const chat=(await app.api('/api/chats',{})).body;
    const events=await app.turn({chatId:chat.id,text:'Проверь окружение',model:'mock:latest',agent:true});
    assert.equal(events.find(e=>e.type==='start').toolMode,'text');
    assert.equal(seen[0].tools,undefined,'no native tools sent');
    assert.match(seen[0].messages[0].content,/<tool_call>/);
    assert.ok(seen[1].messages.some(m=>m.role==='user'&&/<tool_result name="get_environment">/.test(m.content)));
    assert.ok(events.some(e=>e.type==='warning'&&/обрезан/.test(e.text)));
    const project=(await app.api('/api/chats/get?id='+chat.id)).body.project;
    await assert.rejects(fs.access(path.join(project.path,'big.txt')),'cut-off tool call must not run');
    assert.equal(events.find(e=>e.type==='done').reason,'completed');
  }finally{await app?.stop();await model.close();}
});

test('OpenAI-compatible backend with streamed tool-call fragments',async()=>{
  const root=await tempDir(),data=path.join(root,'data'),workspace=path.join(root,'ws');await fs.mkdir(workspace,{recursive:true});
  const script=[{tool_calls:[call('list_files',{path:'.'})]},{content:'Пусто.'}];
  const seen=[];
  const model=await mockModel(async(url,body,index)=>{seen.push(body);return script[index]||{content:'ok'};});
  let app;
  try{
    app=await startApp({modelUrl:model.url,data,workspace});
    const saved=await app.api('/api/settings',{workspace,context:16384,maxSteps:8,thinking:false,model:'mock-openai',provider:'openai',baseUrl:model.url+'/v1',apiKey:'secret-key',approvalMode:'auto',toolMode:'auto'});
    assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.apiKey,undefined);assert.equal(saved.body.apiKeySet,true);
    const models=(await app.api('/api/models')).body;assert.equal(models.models[0].name,'mock-openai');
    const chat=(await app.api('/api/chats',{})).body;
    const events=await app.turn({chatId:chat.id,text:'Что в папке?',model:'mock-openai',agent:true});
    assert.equal(events.find(e=>e.type==='done').reason,'completed',JSON.stringify(events.filter(e=>e.type==='error')));
    const result=events.find(e=>e.type==='tool_result');assert.ok(Array.isArray(result.result.entries));
    const second=seen[1].messages;
    const asst=second.find(m=>m.role==='assistant'&&m.tool_calls);assert.equal(asst.tool_calls[0].id,'call_0');assert.equal(typeof asst.tool_calls[0].function.arguments,'string');
    assert.equal(second.find(m=>m.role==='tool').tool_call_id,'call_0');
    assert.equal(events.find(e=>e.type==='stats').stats.promptTokens,120);
  }finally{await app?.stop();await model.close();}
});

test('B1 end-to-end: paged read never unlocks full overwrite; malformed text call is repaired with a JSON schema',async()=>{
  const root=await tempDir(),data=path.join(root,'data'),workspace=path.join(root,'ws'),repo=path.join(root,'proj');
  await fs.mkdir(workspace,{recursive:true});await fs.mkdir(repo);
  const original=Array.from({length:3000},(_,i)=>'const value'+i+' = '+i+'; // строка с комментарием').join('\n')+'\n';
  await fs.writeFile(path.join(repo,'big.js'),original);
  const script=[
    {tool_calls:[call('update_plan',{steps:[{title:'rewrite'}],note:''})]},
    {tool_calls:[call('read_file',{path:'big.js'})]},
    {tool_calls:[call('write_file',{path:'big.js',content:'oops\n'})]},
    {content:'<tool_call>totally broken</tool_call>'},
    {content:'{"name":"list_files","arguments":{"path":"."}}'},
    {content:'Готово.'}
  ];
  const seen=[];
  const model=await mockModel(async(url,body,index)=>{seen.push(body);return script[index]||{content:'ok'};});
  let app;
  try{
    app=await startApp({modelUrl:model.url,data,workspace});
    await app.api('/api/settings',{workspace,context:8192,maxSteps:10,thinking:false,model:'mock:latest',toolMode:'text'});
    const chat=(await app.api('/api/chats',{})).body;
    const wide=await app.api('/api/project/open',{chatId:chat.id,path:path.parse(root).root});assert.equal(wide.status,400);
    assert.equal((await app.api('/api/project/open',{chatId:chat.id,path:repo})).status,200);
    const events=await app.turn({chatId:chat.id,text:'Перепиши файл',model:'mock:latest',agent:true});
    const results=events.filter(e=>e.type==='tool_result').map(e=>e.result);
    const read=results[1];assert.equal(read.truncated,true);assert.ok(read.endLine<3000);assert.match(read.notice,/startLine=/);
    assert.match(results[2].error,/Read the full file/);
    assert.equal(await fs.readFile(path.join(repo,'big.js'),'utf8'),original,'file not overwritten from a partial read');
    assert.ok(seen[4].format?.properties?.name,'retry used a JSON schema (constrained decoding)');
    assert.ok(Array.isArray(results[3].entries),'repaired call executed');
    assert.equal(events.find(e=>e.type==='done').reason,'completed');
    const exp=await fetch(app.origin+'/api/export?id='+chat.id);assert.equal(exp.status,403,'export needs the token');
    const bad=await fetch(app.origin+'/api/approve',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':app.token,Origin:'http://evil.example'},body:'{}'});assert.equal(bad.status,403);
  }finally{await app?.stop();await model.close();}
});
