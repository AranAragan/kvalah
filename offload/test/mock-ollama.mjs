// A real HTTP server that speaks enough of the Ollama API for end-to-end tests: /api/tags, /api/ps, /api/show,
// /api/chat (NDJSON streaming, token by token). Records peak concurrency, aborted generations (client closed the
// connection mid-stream) and how many tokens were generated after the client went away.
import http from 'node:http';
export async function mockOllama({tokens=20,tokenMs=20,port=0,models=['m'],prefix='',token=null,tokensFor=null}={}){
  const st={active:0,peak:0,chats:0,aborted:0,completed:0,tokensAfterAbort:0,bodies:[]};
  const sockets=new Set();
  const srv=http.createServer((q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',async()=>{
    const json=v=>{s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify(v));};
    if(token&&q.headers['x-kvalah-token']!==token){s.writeHead(401);return s.end();}
    if(q.url==='/peer/info')return json({models,backend:'ollama'});
    if(prefix&&q.url.startsWith(prefix))q.url=q.url.slice(prefix.length);
    if(q.url==='/api/tags')return json({models:models.map(n=>({name:n,model:n,digest:'sha256:'+n}))});
    if(q.url==='/api/ps')return json({models:[]});
    if(q.url==='/api/show')return json({model_info:{'x.context_length':32768},parameters:'num_ctx 16384'});
    if(q.url!=='/api/chat'){s.writeHead(404);return s.end();}
    const n=tokensFor?tokensFor(b):srv.tokens;
    st.chats++;st.active++;st.peak=Math.max(st.peak,st.active);st.bodies.push(b);
    let gone=false;const onClose=()=>{if(!gone&&!s.writableEnded){gone=true;st.aborted++;}};s.on('close',onClose);
    s.writeHead(200,{'content-type':'application/x-ndjson'});
    try{
      for(let i=0;i<n;i++){await new Promise(r=>setTimeout(r,srv.tokenMs));if(gone){st.tokensAfterAbort++;break;}   // a real server stops when the client disconnects
        s.write(JSON.stringify({message:{content:i===0?'{"summary":"ok","draft":"","findings":[],"uncertainty":""}':''}})+'\n');}
      if(!gone){s.end(JSON.stringify({done:true,done_reason:'stop',eval_count:n,prompt_eval_count:100})+'\n');st.completed++;}
    }finally{st.active--;}
  });});
  srv.tokens=tokens;srv.tokenMs=tokenMs;
  srv.on('connection',c=>{sockets.add(c);c.on('close',()=>sockets.delete(c));});
  await new Promise(r=>srv.listen(port,'127.0.0.1',r));
  const bound=srv.address().port;   // still known after stop() (restart on the same port)
  return {st,srv,url:`http://127.0.0.1:${srv.address().port}`,port:srv.address().port,
    async stop(){for(const c of sockets)c.destroy();await new Promise(r=>srv.close(()=>r()));},
    async restart(){return mockOllama({tokens:srv.tokens,tokenMs:srv.tokenMs,port:bound,models,prefix,token,tokensFor});}};
}
