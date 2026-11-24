// v0.4 SEC-02: no HTTP redirect is followed by any provider (local, llama.cpp tokenizer, overlay), so
// task data can never be forwarded to another server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createKvalahOffload} from '../compute/index.mjs';
import {llamaCppTokenizer} from '../compute/tokens.mjs';

const SECRET_CODE='CONFIDENTIAL-SOURCE-42';
async function servers(){
  const seen=[];
  const sink=http.createServer((q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{seen.push({url:q.url,body:b});s.writeHead(200,{'Content-Type':'application/json'});s.end('{}');});});
  await new Promise(r=>sink.listen(0,'127.0.0.1',r));const sinkUrl=`http://127.0.0.1:${sink.address().port}`;
  const redir=http.createServer((q,s)=>{q.resume();s.writeHead(307,{Location:sinkUrl+q.url});s.end();});
  await new Promise(r=>redir.listen(0,'127.0.0.1',r));
  return {seen,url:`http://127.0.0.1:${redir.address().port}`,close(){sink.close();redir.close();}};
}
const env=(url,extra={})=>({KVALAH_MODEL:'m',KVALAH_CACHE:'off',KVALAH_LOCAL_URL:url,KVALAH_SERVICE:'off',KVALAH_STANDALONE:'1',...extra});

test('v04 SEC-02: Ollama provider refuses redirects; task data never reaches the redirect target', async()=>{
  const s=await servers();
  try{
    const app=await createKvalahOffload({env:env(s.url)});
    const err=await app.engine.delegate({kind:'summarize',instruction:'x',context:'line '+SECRET_CODE}).catch(e=>e);
    assert.ok(err instanceof Error);assert.match(err.message,/redirect/i);
    assert.equal(s.seen.length,0,'redirect target received: '+JSON.stringify(s.seen.map(x=>x.url)));
    assert.equal((await app.status()).online===true,false);
    await app.close();
  }finally{s.close();}
});

test('v04 SEC-02: OpenAI-compatible provider and llama.cpp tokenizer refuse redirects', async()=>{
  const s=await servers();
  try{
    const app=await createKvalahOffload({env:env(s.url+'/v1',{KVALAH_PROVIDER:'openai'})});
    const err=await app.engine.delegate({kind:'summarize',instruction:'x',context:'line '+SECRET_CODE}).catch(e=>e);
    assert.ok(err instanceof Error);await app.close();
    await assert.rejects(llamaCppTokenizer(s.url+'/v1')(SECRET_CODE),/redirect/i);
    assert.equal(s.seen.length,0,JSON.stringify(s.seen.map(x=>x.url)));
  }finally{s.close();}
});

const KV=process.env.KVALAH_HOME||'/workspace/kvalah/repo';
test('v04 SEC-02: overlay mode (kvalah providers.mjs follows redirects) uses the guarded providers', {skip:!existsSync(path.join(KV,'providers.mjs'))&&'no kvalah checkout'}, async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'kvhome-'));
  for(const f of ['providers.mjs','scheduler.mjs','nodes.mjs','i18n.mjs'])await copyFile(path.join(KV,f),path.join(home,f));
  await mkdir(path.join(home,'public','i18n'),{recursive:true});await copyFile(path.join(KV,'public/i18n/en.json'),path.join(home,'public/i18n/en.json'));
  await writeFile(path.join(home,'package.json'),'{"type":"module"}');
  const s=await servers();
  try{
    const app=await createKvalahOffload({env:{...env(s.url),KVALAH_STANDALONE:'0',KVALAH_HOME:home}});
    assert.equal((await app.status()).kvalah.mode,'overlay');
    await app.engine.delegate({kind:'summarize',instruction:'x',context:'line '+SECRET_CODE}).catch(e=>e);
    assert.equal(s.seen.length,0,'overlay provider followed a redirect: '+JSON.stringify(s.seen.map(x=>x.url)));
    await app.close();
  }finally{s.close();}
});
