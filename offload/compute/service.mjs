#!/usr/bin/env node
// RUN-02: one long-lived Kvalah Compute Service shared by the Kvalah GUI and any number of MCP clients.
// Local IPC only (Unix socket 0600 in a 0700 directory, or a Windows named pipe), never TCP/HTTP.
// Every connection must authenticate with the token from a 0600 token file (rotated on each start) and
// declare the workspace it works on (must equal the service workspace). One engine/scheduler instance
// means one shared device capacity. On top: fair round-robin queues per client, interactive-before-
// background priority, global and per-client backpressure, queue timeouts, de-duplication of identical
// requests with subscriber counting, cancel (explicit or on disconnect), graceful shutdown and metrics.
// Protocol: newline-delimited JSON. client→ {type:'hello',protocol,token,client,priority,workspace}
// {type:'call',id,method,args} {type:'cancel',id}; service→ {type:'welcome',...} {type:'result',id,ok,result|error}.
import net from 'node:net';
import fs from 'node:fs';
import {readFile,writeFile,rename,unlink,mkdir,chmod,lstat,realpath,open,rm,stat} from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createPolicy} from './policy.mjs';
import {Hello,ClientMessage,ServiceMessage,parse} from './ipc-schema.mjs';

export const PROTOCOL=1;
const METHODS={compute:'cpu',status:'cpu',metrics:'cpu',state:'cpu',delegate:'llm',batch:'llm',auto:'llm',lease:'llm',release:'cpu'};
// v0.4 COMPUTE-02: a 'device'-scoped connection (the Kvalah desktop app, no single workspace) may only lease model
// slots and read metrics/status — never touch workspace files.
const DEVICE_METHODS=new Set(['lease','release','metrics','status']);
const DEDUPE=new Set(['compute','status','delegate','batch','auto']);
const named=(name,message,extra={})=>Object.assign(new Error(message),{name},extra);
const sha=s=>crypto.createHash('sha256').update(String(s)).digest();
const stable=v=>JSON.stringify(v,(k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(key=>[key,x[key]])):x);
const errOut=e=>({name:String(e?.name||'Error').slice(0,60),message:String(e?.message||e).split('\n    at ')[0].slice(0,800)});

export function servicePaths(env=process.env,dataDir,platform=process.platform){
  const id=crypto.createHash('sha256').update((os.userInfo?.().username||'')+'|'+dataDir).digest('hex').slice(0,16);
  let socket=env.KVALAH_SERVICE_SOCKET;
  if(!socket){
    if(platform==='win32')socket=`\\\\.\\pipe\\kvalah-offload-${id}`;
    else{socket=path.join(dataDir,'service.sock');if(Buffer.byteLength(socket)>100)socket=path.join(os.tmpdir(),`kvalah-${process.getuid?.()??'u'}-${id}`,'service.sock');}
  }
  return {socket,tokenFile:env.KVALAH_SERVICE_TOKEN_FILE||path.join(dataDir,'service.token')};
}
const isPipe=p=>p.startsWith('\\\\.\\pipe\\')||p.startsWith('\\\\?\\pipe\\');

async function writeToken(file){
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const token=crypto.randomBytes(32).toString('hex');
  const tmp=`${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp,token,{mode:0o600,flag:'wx'});await rename(tmp,file);await chmod(file,0o600).catch(()=>{});
  return token;
}
async function prepareSocket(socket){
  if(isPipe(socket))return;
  await mkdir(path.dirname(socket),{recursive:true,mode:0o700});
  let st;try{st=await lstat(socket);}catch{return;}
  if(!st.isSocket())throw named('ServiceError',`refusing to replace non-socket file at ${socket}`);
  const alive=await new Promise(res=>{const c=net.connect(socket);c.once('connect',()=>{c.destroy();res(true);});c.once('error',()=>res(false));});
  if(alive)throw named('ServiceError',`a Kvalah service is already running at ${socket}`);
  await unlink(socket);  // stale socket of a crashed service
}

export async function startService({app,socketPath,tokenFile,fingerprint=null,unref=false,maxActive=null,maxCpu=4,maxQueue=64,maxQueuePerClient=16,maxConnections=32,maxInflightPerClient=32,maxSubscribersPerJob=64,maxPendingTotal=256,queueTimeoutMs=120000,agingMs=null,helloTimeoutMs=2000,maxMessageBytes=4_000_000,graceMs=5000,log=()=>{}}={}){
  if(!app||!socketPath||!tokenFile)throw Error('startService needs app, socketPath and tokenFile');
  const lanCap=()=>{try{return app.lan?.capacity?.(app.cfg?.model)||0;}catch{return 0;}};
  const limits={llm:()=>maxActive??Math.max(1,(app.cfg?.maxParallel||1)+lanCap()),cpu:()=>maxCpu};
  const workspace=app.cfg?.workspace?await realpath(app.cfg.workspace).catch(()=>path.resolve(app.cfg.workspace)):null;
  await prepareSocket(socketPath);
  const token=await writeToken(tokenFile);const tokenHash=sha(token);
  const lanes={llm:{active:0,order:[],queues:new Map()},cpu:{active:0,order:[],queues:new Map()}};
  const jobs=new Map();          // dedupe key → job (queued or running)
  const leases=new Map();        // v0.4 COMPUTE-02: lease id → {owner, client, done}: an llm slot held by an outside generator (Kvalah GUI)
  const conns=new Set();
  const m={aged:0,leasesGranted:0,leasesExpired:0,connectionsRefused:0,protocolErrors:0,connections:0,clientsTotal:0,authFailures:0,calls:0,completed:0,failed:0,cancelled:0,rejected:0,deduped:0,queueTimeouts:0,byMethod:{},byClient:{},waits:[]};
  let closing=false,nextJob=1;

  // v0.4 SEC-01: the IPC channel is filtered too (results, errors) — defence in depth over the app's own policy
  const policy=app.policy||createPolicy();
  const send=(c,msg)=>{if(c.sock.destroyed)return;if(msg.result!==undefined)msg={...msg,result:policy.output(msg.result)};if(msg.error)msg={...msg,error:{...msg.error,message:policy.text(String(msg.error.message||''))}};c.sock.write(JSON.stringify(msg)+'\n');};
  const pendingTotal=()=>{let n=0;for(const c of conns)n+=c.calls.size;return n;};
  const queued=()=>{let n=0;for(const l of Object.values(lanes))for(const q of l.queues.values())n+=q.interactive.length+q.background.length;return n;};
  const clientQueued=cid=>{let n=0;for(const l of Object.values(lanes)){const q=l.queues.get(cid);if(q)n+=q.interactive.length+q.background.length;}return n;};
  const qFor=(lane,cid)=>{let q=lane.queues.get(cid);if(!q){q={interactive:[],background:[]};lane.queues.set(cid,q);lane.order.push(cid);}return q;};
  const removeQueued=job=>{const q=lanes[job.lane].queues.get(job.owner);if(!q)return;for(const k of ['interactive','background']){const i=q[k].indexOf(job);if(i>=0)q[k].splice(i,1);}};
  const finish=(job,ok,payload)=>{
    if(jobs.get(job.key)===job)jobs.delete(job.key);clearTimeout(job.timer);
    for(const s of job.subs){send(s.conn,{type:'result',id:s.id,ok,...(ok?{result:payload}:{error:errOut(payload)})});s.conn.calls.delete(s.id);}
    job.subs.clear();
  };
  // fair pick: interactive across clients round-robin, then background round-robin
  // v0.4 SCHED-02: aging — a background job that waited ≥ agingMs (default min(30 s, queueTimeout/2)) is served next,
  // oldest first, so sustained interactive load cannot starve it into a queue timeout.
  const aging=agingMs??Math.min(30000,Math.floor(queueTimeoutMs/2));
  function pick(lane){
    let old=null,oq=null;const t=Date.now();
    for(const q of lane.queues.values()){const j=q.background[0];if(j&&t-j.enqueuedAt>=aging&&(!old||j.enqueuedAt<old.enqueuedAt)){old=j;oq=q;}}
    if(old){oq.background.shift();m.aged++;return old;}
    for(const level of ['interactive','background'])for(let i=0;i<lane.order.length;i++){
      const cid=lane.order[0];lane.order.push(lane.order.shift());
      const q=lane.queues.get(cid);if(q?.[level].length)return q[level].shift();
    }
    return null;
  }
  function pump(){
    for(const [name,lane] of Object.entries(lanes))while(!closing&&lane.active<limits[name]()){
      const job=pick(lane);if(!job)break;
      clearTimeout(job.timer);job.state='running';lane.active++;
      const wait=Date.now()-job.enqueuedAt;m.waits.push(wait);if(m.waits.length>200)m.waits.shift();
      run(job).then(r=>{m.completed++;finish(job,true,r);},e=>{if(job.ctrl.signal.aborted)m.cancelled++;else m.failed++;finish(job,false,e);})
        .finally(()=>{lane.active--;pump();});
    }
  }
  async function run(job){
    const o={signal:job.ctrl.signal},a=job.args||{};
    switch(job.method){
      case 'compute':return app.compute(a,o);
      case 'delegate':return app.engine.delegate(a,o);
      case 'batch':return app.engine.batch(a,o);
      case 'auto':return app.auto(a,o);
      case 'status':return {...await app.status(),service:metrics()};
      case 'metrics':return {...app.engine.metrics(),service:metrics()};
      case 'state':return {...await app.state(),service:metrics()};
      case 'lease':return new Promise(resolve=>{   // the slot stays taken until release / disconnect / ttl / abort
        const lid=crypto.randomUUID(),ttl=Math.min(1_800_000,Math.max(1000,Number(a.ttlMs)||600_000));
        const done=(why='released')=>{if(!leases.has(lid))return;leases.delete(lid);clearTimeout(t);if(why==='expired')m.leasesExpired++;resolve({lease:lid,end:why});};
        const t=setTimeout(()=>done('expired'),ttl);t.unref?.();
        const sub=[...job.subs][0];leases.set(lid,{owner:job.owner,client:sub?.conn.client??'?',label:String(a.label??'').slice(0,80),since:Date.now(),done});
        job.ctrl.signal.addEventListener('abort',()=>done('cancelled'),{once:true});m.leasesGranted++;
        for(const s of job.subs){send(s.conn,{type:'result',id:s.id,ok:true,result:{lease:lid,ttlMs:ttl,waitedMs:Date.now()-job.enqueuedAt}});s.conn.calls.delete(s.id);}
        job.subs.clear();
      });
    }
    throw named('ServiceError','unknown method');
  }
  function cancelSub(conn,id,reason='cancelled'){
    const sub=conn.calls.get(id);if(!sub)return;conn.calls.delete(id);const job=sub.job;job.subs.delete(sub);
    send(conn,{type:'result',id,ok:false,error:{name:'AbortError',message:'Request '+reason}});
    if(job.subs.size===0){                     // last subscriber gone → stop the work (queued or running)
      if(jobs.get(job.key)===job)jobs.delete(job.key);
      if(job.state==='queued'){removeQueued(job);clearTimeout(job.timer);m.cancelled++;}
      job.ctrl.abort(named('AbortError','Request '+reason));
    }
  }
  function onCall(conn,msg){
    const {id,method}=msg;
    if(typeof id!=='number'&&typeof id!=='string')return;
    if(!Object.hasOwn(METHODS,method))return send(conn,{type:'result',id,ok:false,error:{name:'ServiceError',message:'unknown method'}});
    if(conn.calls.has(id))return send(conn,{type:'result',id,ok:false,error:{name:'ServiceError',message:'duplicate id'}});
    if(conn.scope==='device'&&!DEVICE_METHODS.has(method))return send(conn,{type:'result',id,ok:false,error:{name:'WorkspaceMismatchError',message:'a device-scoped connection may only lease slots and read metrics'}});
    if(method==='release'){                      // immediate, never queued; only the owner may release
      const l=leases.get(msg.args?.lease);
      if(!l||l.owner!==conn.cid)return send(conn,{type:'result',id,ok:false,error:{name:'ServiceError',message:'unknown lease'}});
      l.done('released');return send(conn,{type:'result',id,ok:true,result:{released:true}});
    }
    m.calls++;m.byMethod[method]=(m.byMethod[method]||0)+1;const bc=m.byClient[conn.client]??={calls:0,rejected:0};bc.calls++;
    if(closing)return send(conn,{type:'result',id,ok:false,error:{name:'ServiceShutdownError',message:'Service is shutting down'}});
    // v0.4 IPC-02: bounded in-flight requests per client and in total (subscriptions to shared jobs included)
    const overload=msg2=>{m.rejected++;bc.rejected++;send(conn,{type:'result',id,ok:false,error:{name:'ServiceOverloadError',message:msg2+'; retry later or do the task yourself'}});};
    if(conn.calls.size>=maxInflightPerClient)return overload(`too many requests in flight from this client (limit ${maxInflightPerClient})`);
    if(pendingTotal()>=maxPendingTotal)return overload(`service has too many pending requests (limit ${maxPendingTotal})`);
    const key=DEDUPE.has(method)?method+':'+stable(msg.args??{}):method+':'+(nextJob);
    const existing=jobs.get(key);
    if(existing&&!existing.ctrl.signal.aborted){
      if(existing.subs.size>=maxSubscribersPerJob)return overload(`too many subscribers for one identical request (limit ${maxSubscribersPerJob})`);
      const sub={conn,id,job:existing};existing.subs.add(sub);conn.calls.set(id,sub);m.deduped++;
      if(existing.state==='queued'&&conn.priority==='interactive'&&existing.priority==='background'){removeQueued(existing);existing.priority='interactive';qFor(lanes[existing.lane],existing.owner).interactive.push(existing);}
      return;
    }
    if(queued()>=maxQueue||clientQueued(conn.cid)>=maxQueuePerClient){
      m.rejected++;bc.rejected++;
      return send(conn,{type:'result',id,ok:false,error:{name:'ServiceOverloadError',message:`Service queue full (${queued()} queued, ${clientQueued(conn.cid)} from this client); retry later or do the task yourself`}});
    }
    const job={n:nextJob++,key,method,args:msg.args,lane:METHODS[method],owner:conn.cid,priority:conn.priority,state:'queued',subs:new Set(),ctrl:new AbortController(),enqueuedAt:Date.now(),timer:null};
    const sub={conn,id,job};job.subs.add(sub);conn.calls.set(id,sub);jobs.set(key,job);
    job.timer=setTimeout(()=>{if(job.state!=='queued')return;removeQueued(job);m.queueTimeouts++;job.ctrl.abort();finish(job,false,named('QueueTimeoutError',`Waited ${queueTimeoutMs} ms in the service queue`));},queueTimeoutMs);job.timer.unref?.();
    qFor(lanes[job.lane],conn.cid)[job.priority].push(job);
    pump();
  }
  function onHello(conn,msg){
    const given=typeof msg.token==='string'?sha(msg.token):null;
    if(msg.type!=='hello'||!given||!crypto.timingSafeEqual(given,tokenHash)){m.authFailures++;send(conn,{type:'error',error:{name:'AuthError',message:'authentication failed'}});return conn.sock.end();}
    if(msg.protocol!==PROTOCOL){send(conn,{type:'error',error:{name:'ServiceError',message:`protocol ${msg.protocol} not supported (service speaks ${PROTOCOL})`}});return conn.sock.end();}
    const ws=msg.workspace?path.resolve(msg.workspace):null;
    const check=ws?realpath(ws).catch(()=>ws):Promise.resolve(null);
    check.then(real=>{
      const device=msg.scope==='device'&&!msg.workspace;
      if(!device&&(real||null)!==(workspace||null)){send(conn,{type:'error',error:{name:'WorkspaceMismatchError',message:'workspace mismatch: this service serves a different workspace'}});return conn.sock.end();}
      clearTimeout(conn.helloTimer);conn.authed=true;conn.client=String(msg.client||'client').replace(/[^\w.-]/g,'').slice(0,40)||'client';
      conn.priority=msg.priority==='background'?'background':'interactive';conn.scope=device?'device':'workspace';m.clientsTotal++;
      send(conn,{type:'welcome',protocol:PROTOCOL,pid:process.pid,model:app.cfg?.model??null,workspace:!!workspace,limits:{llm:limits.llm(),cpu:limits.cpu(),maxQueue,maxQueuePerClient,queueTimeoutMs,agingMs:aging},fingerprint});
    });
  }
  let cidSeq=0;
  const server=net.createServer(sock=>{
    if(unref)sock.unref();               // v0.4 COMPUTE-01: an elected in-process host never keeps its process alive by itself
    if(closing)return sock.destroy();
    if(conns.size>=maxConnections){m.connectionsRefused++;sock.on('error',()=>{});sock.end(JSON.stringify({type:'error',error:{name:'ServiceOverloadError',message:`too many connections (limit ${maxConnections})`}})+'\n');setTimeout(()=>sock.destroy(),100).unref?.();return;}
    const conn={sock,cid:'c'+(++cidSeq),authed:false,client:'?',priority:'interactive',calls:new Map(),buf:'',protocolErrors:0};
    conns.add(conn);m.connections=conns.size;
    conn.helloTimer=setTimeout(()=>{if(!conn.authed){m.authFailures++;sock.destroy();}},helloTimeoutMs);conn.helloTimer.unref?.();
    sock.setEncoding('utf8');
    sock.on('data',d=>{
      conn.buf+=d;if(conn.buf.length>maxMessageBytes){sock.destroy();return;}
      let i;while((i=conn.buf.indexOf('\n'))>=0){const line=conn.buf.slice(0,i);conn.buf=conn.buf.slice(i+1);if(!line.trim())continue;
        try{
          if(!conn.authed){                                     // one valid hello only; nothing else before welcome
            if(conn.helloSeen)continue;conn.helloSeen=true;
            const h=parse(Hello,line);if(!h.ok){m.protocolErrors++;m.authFailures++;send(conn,{type:'error',error:{name:'AuthError',message:'authentication failed'}});sock.end();return;}
            onHello(conn,h.value);continue;
          }
          const p=parse(ClientMessage,line);
          if(!p.ok){m.protocolErrors++;let rid=null;try{const v=JSON.parse(line);if(v&&(typeof v.id==='number'||typeof v.id==='string')&&String(v.id).length<=64)rid=v.id;}catch{}
            if(rid!==null)send(conn,{type:'result',id:rid,ok:false,error:{name:'ProtocolError',message:'invalid message: '+p.error}});
            else send(conn,{type:'error',error:{name:'ProtocolError',message:'invalid message: '+p.error}});
            if(++conn.protocolErrors>20){sock.destroy();return;}continue;}
          if(p.value.type==='call')onCall(conn,p.value);else cancelSub(conn,p.value.id);
        }catch(e){m.protocolErrors++;log('ipc handler error: '+String(e?.message||e).slice(0,200));}}
    });
    sock.on('error',()=>{});
    sock.on('close',()=>{clearTimeout(conn.helloTimer);for(const id of [...conn.calls.keys()])cancelSub(conn,id,'cancelled: client disconnected');
      for(const l of [...leases.values()])if(l.owner===conn.cid)l.done('disconnected');conns.delete(conn);m.connections=conns.size;
      for(const l of Object.values(lanes)){const q=l.queues.get(conn.cid);if(q&&!q.interactive.length&&!q.background.length){l.queues.delete(conn.cid);l.order=l.order.filter(x=>x!==conn.cid);}}});
  });
  await new Promise((res,rej)=>{
    server.once('error',rej);
    const old=isPipe(socketPath)?null:process.umask(0o177);  // socket file created 0600
    try{server.listen(socketPath,()=>{server.off('error',rej);if(unref)server.unref();res();});}finally{if(old!==null)process.umask(old);}
  });
  if(!isPipe(socketPath))await chmod(socketPath,0o600).catch(()=>{});
  log(`service listening on ${socketPath}`);
  app.setStateExtra?.(()=>({service:metrics()}));   // UI-01: dashboard shows the shared queue

  function metrics(){
    const w=[...m.waits].sort((a,b)=>a-b),q=p=>w.length?w[Math.min(w.length-1,Math.floor(p*w.length))]:null;
    const clients=[...conns].filter(c=>c.authed).map(c=>({client:c.client,priority:c.priority,scope:c.scope,pending:c.calls.size,leases:[...leases.values()].filter(l=>l.owner===c.cid).length}));
    return {protocol:PROTOCOL,connections:conns.size,clients,queued:queued(),active:{llm:lanes.llm.active,cpu:lanes.cpu.active},limits:{llm:limits.llm(),cpu:limits.cpu(),maxQueue,maxQueuePerClient,maxConnections,maxInflightPerClient,maxSubscribersPerJob,maxPendingTotal},
      leases:{active:leases.size,granted:m.leasesGranted,expired:m.leasesExpired,list:[...leases.values()].map(l=>({client:l.client,label:l.label,heldMs:Date.now()-l.since}))},protocolErrors:m.protocolErrors,connectionsRefused:m.connectionsRefused,aged:m.aged,agingMs:aging,pendingTotal:pendingTotal(),calls:m.calls,completed:m.completed,failed:m.failed,cancelled:m.cancelled,rejected:m.rejected,deduped:m.deduped,queueTimeouts:m.queueTimeouts,authFailures:m.authFailures,
      byMethod:{...m.byMethod},byClient:structuredClone(m.byClient),waitMs:{p50:q(0.5),p95:q(0.95)}};
  }
  async function close({grace=graceMs}={}){
    if(closing)return;closing=true;
    for(const l of [...leases.values()])l.done('shutdown');   // outside generators lose their slot on shutdown
    const stopped=new Promise(r=>server.close(()=>r()));   // stop accepting now; resolves once all connections ended
    for(const l of Object.values(lanes))for(const q of l.queues.values())for(const job of [...q.interactive,...q.background]){job.ctrl.abort();finish(job,false,named('ServiceShutdownError','Service is shutting down'));}
    for(const l of Object.values(lanes)){l.queues.clear();l.order=[];}
    const idle=()=>lanes.llm.active===0&&lanes.cpu.active===0;
    const until=Date.now()+grace;while(!idle()&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
    if(!idle()){for(const job of jobs.values())job.ctrl.abort(named('ServiceShutdownError','Service is shutting down'));const t=Date.now()+1000;while(!idle()&&Date.now()<t)await new Promise(r=>setTimeout(r,20));}
    for(const c of conns)c.sock.end();await new Promise(r=>setTimeout(r,10));for(const c of conns)c.sock.destroy();
    await stopped;                                    // Node removes the Unix socket file here
    app.setStateExtra?.(null);
    await unlink(tokenFile).catch(()=>{});
    if(!isPipe(socketPath))await unlink(socketPath).catch(()=>{});
  }
  return {socketPath,tokenFile,metrics,close};
}

// ---- client -------------------------------------------------------------------------------------------
export async function connectService({socketPath,tokenFile,token=null,workspace=null,client='mcp',priority='interactive',timeoutMs=1500,unref=false,scope=undefined}={}){
  if(!token){
    if(process.platform!=='win32'){const st=fs.statSync(tokenFile);if(st.mode&0o077)throw named('AuthError',`token file ${tokenFile} is readable by other users; expected 0600`);}
    token=(await readFile(tokenFile,'utf8')).trim();
  }
  const sock=net.connect(socketPath);sock.setEncoding('utf8');if(unref)sock.unref();
  const pending=new Map();let seq=0,buf='',closed=false,welcome=null;const closeHandlers=[];
  const ready=new Promise((res,rej)=>{
    const t=setTimeout(()=>{rej(named('ServiceUnavailableError','service did not answer'));sock.destroy();},timeoutMs);
    sock.once('error',e=>{clearTimeout(t);rej(named('ServiceUnavailableError','service unavailable: '+e.code));});
    const protoFail=why=>{const e=named('ServiceProtocolError','invalid message from the compute service: '+why);clearTimeout(t);rej(e);for(const p of pending.values()){p.cleanup();p.rej(e);}pending.clear();sock.destroy();};
    sock.on('data',d=>{buf+=d;if(buf.length>64_000_000)return protoFail('message too large');let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;
      const pm=parse(ServiceMessage,line);if(!pm.ok)return protoFail(pm.error);const msg=pm.value;
      if(msg.type==='welcome'){clearTimeout(t);welcome=msg;res(msg);}
      else if(msg.type==='error'){clearTimeout(t);rej(named(msg.error?.name||'ServiceError',msg.error?.message||'service error'));}
      else if(msg.type==='result'){const p=pending.get(msg.id);if(!p)continue;pending.delete(msg.id);p.cleanup();msg.ok?p.res(msg.result):p.rej(named(msg.error?.name||'Error',msg.error?.message||'error'));}}});
    sock.once('connect',()=>sock.write(JSON.stringify({type:'hello',protocol:PROTOCOL,token,client,priority,workspace:workspace?path.resolve(workspace):null,...(scope?{scope}:{})})+'\n'));
  });
  sock.on('close',()=>{closed=true;for(const p of pending.values()){p.cleanup();p.rej(named('ServiceUnavailableError','service connection closed'));}pending.clear();for(const f of closeHandlers)f();});
  sock.on('error',()=>{});
  await ready;
  function call(method,args={},{signal}={}){
    if(closed)return Promise.reject(named('ServiceUnavailableError','service connection closed'));
    signal?.throwIfAborted();
    const id=++seq;
    return new Promise((res,rej)=>{
      const onAbort=()=>{if(!pending.has(id))return;pending.delete(id);if(!closed)sock.write(JSON.stringify({type:'cancel',id})+'\n');rej(signal.reason??named('AbortError','aborted'));};
      signal?.addEventListener('abort',onAbort,{once:true});
      pending.set(id,{res,rej,cleanup:()=>signal?.removeEventListener('abort',onAbort)});
      sock.write(JSON.stringify({type:'call',id,method,args})+'\n');
    });
  }
  return {welcome,call,get closed(){return closed;},onClose:f=>closeHandlers.push(f),close:()=>new Promise(r=>{if(closed)return r();sock.once('close',r);sock.end();})};
}

// ---- v0.4 COMPUTE-01: host election ------------------------------------------------------------------------
// Several MCP servers started while no service runs must not each build an engine (N engines = N× device load).
// electService(): connect if a service answers; otherwise take an exclusive lock file (O_EXCL, pid inside, stale
// locks of dead pids are broken), re-check, and become the host: build the one engine, start the service on the
// socket, then connect to it like every other client (so the host's own calls share the same fair queue).
// Losers wait for the lock and connect. A crashed host leaves a stale socket; the next election replaces it under
// the lock (prepareSocket only unlinks a socket nobody answers on). `fingerprint` (a hash of the client's config)
// is announced by the host; a client whose config differs does not use that service (ServiceMismatchError).
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function lockPathFor(socketPath,tokenFile){
  return isPipe(socketPath)?path.join(path.dirname(tokenFile),'service-'+sha(socketPath).toString('hex').slice(0,12)+'.lock'):socketPath+'.lock';
}
async function tryLock(lock){
  await mkdir(path.dirname(lock),{recursive:true,mode:0o700});
  try{const fh=await open(lock,'wx',0o600);try{await fh.writeFile(String(process.pid));}finally{await fh.close();}return true;}
  catch(e){if(e.code!=='EEXIST')throw e;}
  let txt='';try{txt=(await readFile(lock,'utf8')).trim();}catch{return false;}
  const pid=Number.parseInt(txt,10);let stale;
  if(pid>0){try{process.kill(pid,0);stale=false;}catch(e){stale=e.code!=='EPERM';}}
  else{try{stale=Date.now()-(await stat(lock)).mtimeMs>10_000;}catch{stale=false;}}   // created but pid not written yet
  if(stale){                                      // break it atomically: move aside, verify it is still the dead one
    const aside=`${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
    try{await rename(lock,aside);const again=(await readFile(aside,'utf8')).trim();
      if(again!==txt){await rename(aside,lock).catch(()=>{});}else await rm(aside,{force:true});}catch{}
  }
  return false;
}
export async function electService({socketPath,tokenFile,createApp,workspace=null,client='mcp',priority='interactive',fingerprint=null,serviceOptions={},log=()=>{},timeoutMs=15000}){
  const lock=lockPathFor(socketPath,tokenFile);
  const connect=async(unref=false)=>{const c=await connectService({socketPath,tokenFile,workspace,client,priority,unref});
    if(fingerprint&&c.welcome?.fingerprint&&c.welcome.fingerprint!==fingerprint){await c.close();throw named('ServiceMismatchError','the running compute service uses a different configuration');}
    return c;};
  const deadline=Date.now()+timeoutMs;
  for(;;){
    try{return {conn:await connect(),host:null};}
    catch(e){if(e.name!=='ServiceUnavailableError'&&e.code!=='ENOENT')throw e;}
    if(await tryLock(lock)){
      try{
        try{return {conn:await connect(),host:null};}catch(e){if(e.name!=='ServiceUnavailableError'&&e.code!=='ENOENT')throw e;}
        const app=await createApp();let svc;
        try{svc=await startService({app,socketPath,tokenFile,fingerprint,log,unref:true,...serviceOptions});}
        catch(e){await app.close?.();if(/already running/.test(e.message))continue;throw e;}
        const conn=await connect(true);log('elected as compute service host at '+socketPath);
        return {conn,host:{app,svc,async close(){await svc.close();await app.close?.();}}};
      }finally{await rm(lock,{force:true}).catch(()=>{});}
    }
    if(Date.now()>deadline)throw named('ServiceUnavailableError','could not elect a compute service host (lock '+lock+' held)');
    await sleep(40+Math.floor(Math.random()*80));
  }
}

// ---- MCP adapter: an `app`-shaped object backed by the service, with failover to an in-process engine ----
export function createServiceApp({conn,policy,connect,fallback,required=false,log=()=>{}}){
  let current=conn,local=null,mode=conn?.role||'service',reconnecting=null;
  async function use(){
    if(local)return null;
    if(current&&!current.closed)return current;
    // v0.4 COMPUTE-01: concurrent calls share ONE reconnect/election (otherwise one process could win the election
    // and then overwrite its host connection with a second, plain one)
    reconnecting??=(async()=>{
      try{current=await connect();mode=current.role||'service';log('reconnected to compute service ('+mode+')');return current;}
      catch(e){if(required)throw named('ServiceUnavailableError','compute service unavailable (KVALAH_SERVICE=required): '+e.message);}
      log('compute service unavailable, falling back to in-process engine');local=await fallback();mode='local-fallback';return null;
    })().finally(()=>{reconnecting=null;});
    return reconnecting;
  }
  const viaLocal={compute:(a,o)=>local.compute(a,o),delegate:(a,o)=>local.engine.delegate(a,o),batch:(a,o)=>local.engine.batch(a,o),auto:(a,o)=>local.auto(a,o),
    status:()=>local.status(),metrics:()=>local.engine.metrics()};
  async function call(method,args,opts={}){
    const c=await use();if(!c)return viaLocal[method](args,opts);
    try{return await c.call(method,args,opts);}
    catch(e){if(e?.name!=='ServiceUnavailableError'||opts.signal?.aborted)throw e;   // read-only work: one retry elsewhere is safe
      const c2=await use();return c2?c2.call(method,args,opts):viaLocal[method](args,opts);}
  }
  return {remote:true,policy,get mode(){return mode;},
    status:async()=>({...await call('status',{}),client:{mode}}),
    compute:(a,o)=>call('compute',a,o),auto:(a,o)=>call('auto',a,o),
    engine:{delegate:(a,o)=>call('delegate',a,o),batch:(a,o)=>call('batch',a,o),metrics:async()=>({...await call('metrics',{}),client:{mode}})},
    async close(){await current?.close?.();await current?.closeHost?.();await local?.close?.();}};
}

// ---- CLI: node compute/service.mjs ----------------------------------------------------------------------
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const isMain=(()=>{try{return !!process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href;}catch{return false;}})();
if(isMain){
  const {createKvalahOffload}=await import('./index.mjs');const {defaultDataDir}=await import('./lan.mjs');
  const log=s=>process.stderr.write('[kvalah-service] '+s+'\n');
  const int=(v,d)=>{const n=Number.parseInt(v??'',10);return Number.isFinite(n)&&n>0?n:d;};
  let app;
  try{app=await createKvalahOffload({env:process.env,log});}
  catch(e){const {createPolicy}=await import('./policy.mjs');log('config error: '+createPolicy().text(String(e?.message||e)).split('\n')[0]);process.exit(1);}
  const p=servicePaths(process.env,defaultDataDir(process.env));
  const svc=await startService({app,socketPath:p.socket,tokenFile:p.tokenFile,log,maxActive:process.env.KVALAH_SERVICE_MAX_ACTIVE?int(process.env.KVALAH_SERVICE_MAX_ACTIVE,1):null,
    maxQueue:int(process.env.KVALAH_SERVICE_MAX_QUEUE,64),maxQueuePerClient:int(process.env.KVALAH_SERVICE_MAX_QUEUE_PER_CLIENT,16),queueTimeoutMs:app.cfg.queueTimeoutMs,agingMs:process.env.KVALAH_SERVICE_AGING_MS?int(process.env.KVALAH_SERVICE_AGING_MS,30000):null});
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;log('shutting down');await svc.close();await app.close();process.exit(0);};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
