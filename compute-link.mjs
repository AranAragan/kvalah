// Link to the Kvalah Compute Offload service (optional companion, lives in offload/ of this repo).
// When the service runs (an MCP client such as Codex / Claude Code / Cursor started it, or `kvalah-offload-service`),
// kvalah joins it as a 'device'-scoped client and LEASES a model slot for every local generation, so chats in
// kvalah and delegations from cloud agents share one fair queue and one GPU budget instead of competing.
// No service → nothing changes: lease() returns at once and kvalah runs exactly as before.
// Protocol: newline-delimited JSON over a Unix socket (0600) / Windows named pipe, token from a 0600 file.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PROTOCOL=1;
// Must match servicePaths() in kvalah-offload compute/service.mjs.
export function computeServicePaths(dataDir,env=process.env,platform=process.platform){
  const id=crypto.createHash('sha256').update((os.userInfo?.().username||'')+'|'+dataDir).digest('hex').slice(0,16);
  const paths=platform==='win32'?path.win32:path.posix;
  let socket=env.KVALAH_SERVICE_SOCKET;
  if(!socket){
    if(platform==='win32')socket=`\\\\.\\pipe\\kvalah-offload-${id}`;
    else{socket=paths.join(dataDir,'service.sock');if(Buffer.byteLength(socket)>100)socket=paths.join(os.tmpdir(),`kvalah-${process.getuid?.()??'u'}-${id}`,'service.sock');}
  }
  return {socket,tokenFile:env.KVALAH_SERVICE_TOKEN_FILE||paths.join(dataDir,'service.token')};
}
const named=(name,message)=>Object.assign(new Error(message),{name});
const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);

export function createComputeLink({dataDir,env=process.env,log=()=>{},retryMs=5000,timeoutMs=1500,client='kvalah-gui'}={}){
  const {socket,tokenFile}=computeServicePaths(dataDir,env);
  let conn=null,connecting=null,nextTry=0,lastError=null,seq=0;
  const stats={leases:0,leaseWaitMs:0,leaseErrors:0,connects:0,disconnects:0};
  function open(){
    return new Promise((resolve,reject)=>{
      let token;
      try{
        if(process.platform!=='win32'&&(fs.statSync(tokenFile).mode&0o077))throw named('AuthError','service token file is readable by other users');
        token=fs.readFileSync(tokenFile,'utf8').trim();
      }catch(e){return reject(e.name==='AuthError'?e:named('ServiceUnavailableError','no compute service ('+(e.code||e.message)+')'));}
      const sock=net.connect(socket);sock.setEncoding('utf8');sock.unref();
      const pending=new Map();let buf='',welcome=null,closed=false;
      const t=setTimeout(()=>{sock.destroy();reject(named('ServiceUnavailableError','compute service did not answer'));},timeoutMs);
      const failAll=e=>{for(const p of pending.values())p.reject(e);pending.clear();};
      sock.on('error',e=>{clearTimeout(t);if(!welcome)reject(named('ServiceUnavailableError','compute service unavailable: '+(e.code||e.message)));});
      sock.on('close',()=>{closed=true;clearTimeout(t);failAll(named('ServiceUnavailableError','compute service connection closed'));if(conn===c){conn=null;stats.disconnects++;}});
      sock.on('data',d=>{
        buf+=d;if(buf.length>8_000_000){sock.destroy();return;}
        let i;while((i=buf.indexOf('\n'))>=0){
          const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;
          let msg;try{msg=JSON.parse(line);}catch{sock.destroy();return;}
          if(!isObj(msg))continue;
          if(msg.type==='welcome'&&!welcome){clearTimeout(t);welcome=msg;resolve(c);}
          else if(msg.type==='error'){clearTimeout(t);reject(named(String(msg.error?.name||'ServiceError').slice(0,60),String(msg.error?.message||'service error').slice(0,300)));}
          else if(msg.type==='result'){const p=pending.get(msg.id);if(!p)continue;pending.delete(msg.id);
            msg.ok?p.resolve(msg.result):p.reject(named(String(msg.error?.name||'Error').slice(0,60),String(msg.error?.message||'error').slice(0,300)));}
        }
      });
      sock.once('connect',()=>sock.write(JSON.stringify({type:'hello',protocol:PROTOCOL,token,client,priority:'interactive',workspace:null,scope:'device'})+'\n'));
      const c={
        get welcome(){return welcome;},get closed(){return closed;},
        call(method,args={},signal){
          if(closed)return Promise.reject(named('ServiceUnavailableError','compute service connection closed'));
          const id=++seq;
          return new Promise((res,rej)=>{
            const onAbort=()=>{if(!pending.has(id))return;pending.delete(id);if(!closed)sock.write(JSON.stringify({type:'cancel',id})+'\n');rej(signal.reason instanceof Error?signal.reason:named('AbortError','aborted'));};
            pending.set(id,{resolve:v=>{signal?.removeEventListener('abort',onAbort);res(v);},reject:e=>{signal?.removeEventListener('abort',onAbort);rej(e);}});
            if(signal){if(signal.aborted)return onAbort();signal.addEventListener('abort',onAbort,{once:true});}
            sock.write(JSON.stringify({type:'call',id,method,args})+'\n');
          });
        },
        close(){sock.end();}
      };
    });
  }
  // Connect lazily; after a failure wait retryMs before trying again (no busy loop, no log spam).
  async function ensure(){
    if(conn&&!conn.closed)return conn;
    if(env.KVALAH_COMPUTE_LINK==='0')return null;
    if(connecting)return connecting;
    if(Date.now()<nextTry)return null;
    connecting=open().then(c=>{conn=c;lastError=null;stats.connects++;log('compute service linked ('+socket+')');return c;},
      e=>{if(lastError!==e.message&&e.name!=='ServiceUnavailableError')log('compute service: '+e.message);lastError=e.message;nextTry=Date.now()+retryMs;return null;})
      .finally(()=>{connecting=null;});
    return connecting;
  }
  // Waits for a shared model slot. Returns release(); never throws except on abort (a broken link degrades to "no lease").
  async function lease({label='chat',signal}={}){
    const c=await ensure();if(!c)return ()=>{};
    const t0=Date.now();let r;
    try{r=await c.call('lease',{label:String(label).slice(0,80),ttlMs:600000},signal);}
    catch(e){if(signal?.aborted)throw e;stats.leaseErrors++;log('compute service lease failed, running without it: '+e.message);return ()=>{};}
    stats.leases++;stats.leaseWaitMs+=Date.now()-t0;
    let released=false;
    return ()=>{if(released)return;released=true;if(!c.closed)c.call('release',{lease:r.lease}).catch(()=>{});};
  }
  // Dashboard data: service metrics (queue, clients, leases, errors, cancels, savings) + device status.
  let cache=null;
  async function snapshot(){
    if(cache&&Date.now()-cache.at<1000)return cache.v;
    const c=await ensure();let v;
    if(!c)v={connected:false,socket,error:lastError,link:{...stats}};
    else{
      const timeout=ms=>new Promise((_,rej)=>setTimeout(()=>rej(named('TimeoutError','compute service did not answer in time')),ms).unref());
      try{
        const [metrics,status]=await Promise.all([Promise.race([c.call('metrics'),timeout(3000)]),Promise.race([c.call('status'),timeout(3000)]).catch(()=>null)]);
        v={connected:true,socket,welcome:{protocol:c.welcome?.protocol,model:c.welcome?.model,pid:c.welcome?.pid},metrics,status,link:{...stats}};
      }catch(e){v={connected:false,socket,error:e.message,link:{...stats}};}
    }
    cache={at:Date.now(),v};return v;
  }
  return {lease,snapshot,ensure,paths:{socket,tokenFile},stats,close(){conn?.close();conn=null;}};
}
