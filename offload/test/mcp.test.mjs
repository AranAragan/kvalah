import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {existsSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {buildServer} from '../mcp/server.mjs';
import {workspace,smartMock,bigLog,sleep} from './helpers.mjs';
import {loadKvalah} from '../compute/bridge.mjs';

const project={'src/a.mjs':"import {b} from './b.mjs';\nexport function a(){ return b(); }\n",'src/b.mjs':"export function b(){ return 1; } // TODO x\n",'ci.log':bigLog({lines:2000,errorsAt:[5,1990]})};
async function connect(env,provider){
  env={KVALAH_DATA_DIR:await mkdtemp(path.join(tmpdir(),'kvmcp-')),...env};   // runtime files (service token) never in the repo
  const {server,app}=await buildServer({env,provider,log:()=>{}});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);
  const client=new Client({name:'test',version:'1'});await client.connect(ct);return {client,app};
}
const env=root=>({KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off'});
const call=(c,name,args,opts)=>c.callTool({name,arguments:args},undefined,opts);

test('SDK: tools listed with schemas and annotations',async()=>{
  const root=await workspace(project);const {client}=await connect(env(root),smartMock());
  const {tools}=await client.listTools();
  assert.deepEqual(tools.map(t=>t.name).sort(),['kvalah_auto','kvalah_batch','kvalah_compute','kvalah_delegate','kvalah_metrics','kvalah_status']);
  const d=tools.find(t=>t.name==='kvalah_delegate');assert.ok(d.inputSchema.properties.paths);assert.equal(d.annotations.readOnlyHint,true);
  assert.deepEqual(tools.find(t=>t.name==='kvalah_compute').inputSchema.properties.op.enum,['search','outline','symbols','references','deps','hash','stats','todo']);
});
test('SDK: compute, delegate (structured), auto, metrics',async()=>{
  const root=await workspace(project);const {client}=await connect(env(root),smartMock());
  const c=await call(client,'kvalah_compute',{op:'deps',path:'src/b.mjs'});assert.deepEqual(c.structuredContent.importedBy,['src/a.mjs']);
  const d=await call(client,'kvalah_delegate',{kind:'logs',instruction:'errors',paths:['ci.log']});
  assert.ok(!d.isError,d.content?.[0]?.text);assert.ok(d.structuredContent.findings.some(f=>/worker-1990 /.test(f.quote)&&f.verified));
  const a=await call(client,'kvalah_auto',{goal:'list TODO comments'});assert.equal(a.structuredContent.route.level,1);assert.equal(a.structuredContent.matches.length,1);
  const b=await call(client,'kvalah_batch',{tasks:[{kind:'logs',instruction:'x',context:'ERROR q'},{kind:'logs',instruction:'y',context:'ERROR r'}]});assert.equal(b.structuredContent.results.length,2);
  const m=await call(client,'kvalah_metrics',{});assert.ok(m.structuredContent.savings.tasks>=3);
});
test('SDK: invalid / unknown arguments are rejected',async()=>{
  const root=await workspace(project);const {client}=await connect(env(root),smartMock());
  const r=await call(client,'kvalah_delegate',{kind:'logs',instruction:'x',context:'ERROR',evil:1}).catch(e=>({isError:true,content:[{text:e.message}]}));
  assert.equal(r.isError,true);
  const r2=await call(client,'kvalah_delegate',{kind:'execute',instruction:'x'}).catch(e=>({isError:true}));assert.equal(r2.isError,true);
});
test('SDK: client cancellation aborts the local model call',async()=>{
  const root=await workspace(project);let aborted=false;const p=smartMock({delay:2000});const orig=p.chat;p.chat=function(req){req.signal.addEventListener('abort',()=>aborted=true,{once:true});return orig.call(this,req);};
  const {client,app}=await connect(env(root),p);const ac=new AbortController();setTimeout(()=>ac.abort('user'),100);
  await assert.rejects(call(client,'kvalah_delegate',{kind:'logs',instruction:'x',context:'ERROR slow'},{signal:ac.signal}));
  await sleep(50);assert.equal(aborted,true);assert.equal(app.engine.metrics().cancelled,1);
});
test('SDK: configuration errors surface as tool errors, server still starts',async()=>{
  const {client}=await connect({KVALAH_MODEL:'m',KVALAH_LOCAL_URL:'http://10.0.0.5:11434',KVALAH_CACHE:'off'},null);
  const r=await call(client,'kvalah_status',{});assert.equal(r.isError,true);assert.match(r.content[0].text,/only explicitly local/);
});

function mockOllama(){
  return new Promise(r=>{const srv=http.createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{
    if(req.url==='/api/show')return res.end(JSON.stringify({model_info:{'llama.context_length':8192},parameters:'num_ctx 4096'}));
    if(req.url==='/api/ps')return res.end(JSON.stringify({models:[]}));
    if(req.url==='/api/chat'){const p=JSON.parse(b);const hits=p.messages[1].content.split('\n').filter(l=>/ERROR/.test(l)&&!l.startsWith('<'));
      const text=p.format?JSON.stringify({summary:'s',draft:'',findings:hits.map(h=>({text:'e',quote:h,path:''})),uncertainty:''}):(hits.map(h=>'NOTE: '+h).join('\n')||'NONE');
      res.write(JSON.stringify({message:{content:text}})+'\n');return res.end(JSON.stringify({done:true,done_reason:'stop',eval_count:3,prompt_eval_count:40})+'\n');}
    res.statusCode=404;res.end();});});srv.listen(0,'127.0.0.1',()=>r(srv));});
}
test('stdio e2e: real process, context window auto-detected from Ollama /api/show',async()=>{
  const srv=await mockOllama();const root=await workspace(project);
  const t=new StdioClientTransport({command:process.execPath,args:['mcp/server.mjs'],cwd:new URL('..',import.meta.url).pathname,stderr:'pipe',
    env:{...process.env,KVALAH_MODEL:'m',KVALAH_LOCAL_URL:'http://127.0.0.1:'+srv.address().port,KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',KVALAH_STANDALONE:'1'}});
  const c=new Client({name:'e2e',version:'1'});await c.connect(t);
  const s=(await call(c,'kvalah_status',{})).structuredContent;
  assert.equal(s.context.ctxTokens,8192);assert.equal(s.context.detected.modelMax,8192);assert.equal(s.kvalah.mode,'standalone');assert.equal(s.health.online,true);
  const d=await call(c,'kvalah_delegate',{kind:'logs',instruction:'errors',paths:['ci.log']});assert.ok(d.structuredContent.findings.length>=2,JSON.stringify(d).slice(0,300));
  assert.equal(d.structuredContent.coverage.ctxTokens,8192);
  await c.close();srv.close();
});
const KHOME=process.env.KVALAH_HOME||'/workspace/kvalah-offload-review/kvalah-main';
test('overlay mode: uses kvalah\'s own providers.mjs/scheduler.mjs/nodes.mjs when available',{skip:!existsSync(KHOME+'/providers.mjs')&&'kvalah checkout not found'},async()=>{
  const k=await loadKvalah({KVALAH_HOME:KHOME});assert.equal(k.mode,'overlay');
  const srv=await mockOllama();const root=await workspace(project);
  const {client}=await connect({KVALAH_HOME:KHOME,KVALAH_MODEL:'m',KVALAH_LOCAL_URL:'http://127.0.0.1:'+srv.address().port,KVALAH_WORKSPACE:root,KVALAH_CACHE:'off'},null);
  const s=(await call(client,'kvalah_status',{})).structuredContent;assert.equal(s.kvalah.mode,'overlay');
  const d=await call(client,'kvalah_delegate',{kind:'logs',instruction:'errors',paths:['ci.log']});assert.ok(!d.isError,d.content[0].text);assert.ok(d.structuredContent.findings.length>=2);
  srv.close();
});
