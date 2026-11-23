import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';

export const APP=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function tempDir(prefix='kvalah-test-'){return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),prefix)));}
export async function freePort(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
// Scripted model server. handler(kind, body, index) returns a reply description.
export async function mockModel(handler){
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};
    requests.push({url:req.url,body});
    if(req.url==='/api/show'){res.end(JSON.stringify({capabilities:handler.capabilities||['completion','tools']}));return;}
    if(req.url==='/api/tags'){res.end(JSON.stringify({models:[{name:'mock:latest',size:1e9}]}));return;}
    if(req.url==='/api/ps'){res.end(JSON.stringify({models:[]}));return;}
    if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'mock-openai'}]}));return;}
    const index=requests.filter(r=>r.url===req.url).length-1;
    let reply;try{reply=await handler(req.url,body,index);}catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error.message||error)}));return;}
    if(req.url==='/api/chat'){
      res.setHeader('Content-Type','application/x-ndjson');
      if(reply.content)for(const part of reply.content.match(/[\s\S]{1,40}/g))res.write(JSON.stringify({message:{role:'assistant',content:part},done:false})+'\n');
      if(reply.tool_calls)res.write(JSON.stringify({message:{role:'assistant',content:'',tool_calls:reply.tool_calls},done:false})+'\n');
      res.end(JSON.stringify({message:{role:'assistant',content:''},done:true,done_reason:reply.reason||'stop',eval_count:10,eval_duration:1e9,prompt_eval_count:reply.promptTokens||100,total_duration:2e9})+'\n');
      return;
    }
    if(req.url==='/v1/chat/completions'){
      res.setHeader('Content-Type','text/event-stream');
      const send=d=>res.write('data: '+JSON.stringify(d)+'\n\n');
      if(reply.content)send({choices:[{index:0,delta:{content:reply.content}}]});
      for(const [i,c] of (reply.tool_calls||[]).entries()){
        const args=JSON.stringify(c.function.arguments);
        send({choices:[{index:0,delta:{tool_calls:[{index:i,id:'call_'+i,type:'function',function:{name:c.function.name,arguments:args.slice(0,5)}}]}}]});
        send({choices:[{index:0,delta:{tool_calls:[{index:i,function:{arguments:args.slice(5)}}]}}]});
      }
      send({choices:[{index:0,delta:{},finish_reason:reply.tool_calls?'tool_calls':reply.reason||'stop'}]});
      send({choices:[],usage:{prompt_tokens:120,completion_tokens:12}});
      res.end('data: [DONE]\n\n');return;
    }
    res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:'http://127.0.0.1:'+server.address().port,requests,close:()=>new Promise(r=>server.close(r))};
}
export async function startApp({modelUrl,data,workspace,env}){
  const port=await freePort();
  const child=spawn(process.execPath,[path.join(APP,'server.mjs')],{cwd:APP,env:{...process.env,LOCAL_CODEX_DATA:data,LOCAL_CODEX_PORT:String(port),KVALAH_WORKSPACE:workspace,OLLAMA_URL:modelUrl,KVALAH_DESKTOP:path.join(workspace,'Desktop'),KVALAH_LANG:'ru',...(env||{})},stdio:['ignore','pipe','pipe','ipc']});
  let log='';child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
  const ready=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('server did not start: '+log)),15000);child.on('message',m=>{if(m?.type==='ready'){clearTimeout(t);resolve(m);}});child.on('exit',c=>reject(Error('server exited '+c+': '+log)));});
  const origin=ready.origin,token=ready.token;
  async function api(route,data,{method,headers}={}){
    const r=await fetch(origin+route,{method:method||(data===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-Local-Token':token,Origin:origin,...headers},body:data===undefined?undefined:JSON.stringify(data)});
    const text=await r.text();let parsed;try{parsed=JSON.parse(text);}catch{parsed=text;}
    return {status:r.status,body:parsed};
  }
  async function turn(payload,onEvent=()=>{}){
    const r=await fetch(origin+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token,Origin:origin},body:JSON.stringify(payload)});
    if(!r.ok)throw Error('turn failed: '+await r.text());
    const events=[];let carry='';const decoder=new TextDecoder();
    for await(const chunk of r.body){carry+=decoder.decode(chunk,{stream:true});let p;while((p=carry.indexOf('\n'))>=0){const line=carry.slice(0,p);carry=carry.slice(p+1);if(line.trim()){const e=JSON.parse(line);events.push(e);await onEvent(e,api);}}}
    return events;
  }
  return {origin,token,api,turn,log:()=>log,stop:()=>new Promise(r=>{child.once('exit',r);child.kill();})};
}
