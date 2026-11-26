// HTTPS /v2 API of the coordinator (spec §9.2). Every device request is signed with the device Ed25519 key
// (method, path, body digest, timestamp, nonce); there is no shared bearer token. Admin operations are not
// reachable over the network. Bounded bodies, header/request timeouts, a concurrency cap and per-device
// rate limits protect the process; errors never include stack traces.
import https from 'node:https';
import {randomBytes} from 'node:crypto';
import {ComputeError,errorBody,fail} from '../protocol/errors.mjs';
import {sha256} from '../protocol/hash.mjs';
import {requestPayload,verifyBytes} from '../protocol/sign.mjs';
import {MAX_UPDATE_BYTES} from './coordinator.mjs';
export const MAX_JSON=64*1024,SKEW_MS=120*1000;
export function createApi(coord,{cert,key,now=Date.now,maxConcurrent=32,ratePerSec=20,log=()=>{}}){
  let inflight=0,payloads=0;const buckets=new Map();
  function rate(id){
    const t=now(),b=buckets.get(id)||{tokens:ratePerSec*2,at:t};
    b.tokens=Math.min(ratePerSec*2,b.tokens+(t-b.at)/1000*ratePerSec);b.at=t;
    if(b.tokens<1){buckets.set(id,b);const e=new ComputeError('RATE_LIMITED','slow down');e.retryAfter=1;throw e;}
    b.tokens-=1;buckets.set(id,b);
  }
  function readBody(req,limit){
    return new Promise((resolve,reject)=>{
      const declared=Number(req.headers['content-length']||0);
      if(req.headers['transfer-encoding'])return reject(new ComputeError('INVALID_SCHEMA','chunked bodies are not accepted; send Content-Length'));
      if(declared>limit)return reject(new ComputeError('TOO_LARGE','body exceeds '+limit+' bytes'));
      const chunks=[];let n=0;
      req.on('data',c=>{n+=c.length;if(n>limit){reject(new ComputeError('TOO_LARGE','body exceeds limit'));req.destroy();}else chunks.push(c);});
      req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject);
      req.on('close',()=>{if(!req.complete)reject(new ComputeError('UNAVAILABLE','request body interrupted'));});
    });
  }
  function authenticate(req,route,body){
    const id=String(req.headers['x-kc-device']||''),ts=Number(req.headers['x-kc-ts']),n=String(req.headers['x-kc-nonce']||''),sig=String(req.headers['x-kc-sig']||'');
    if(!id||!sig)fail('UNAUTHORIZED','signed request required');
    if(!Number.isFinite(ts)||Math.abs(now()-ts)>SKEW_MS)fail('CLOCK_SKEW','request timestamp outside the allowed window; sync with /v2/health/live server_time');
    const d=coord.authDevice(id,{allowPending:true});
    if(!verifyBytes(d.public_key,requestPayload({method:req.method,path:route,bodySha:sha256(body),ts,nonce:n,deviceId:id}),sig))fail('BAD_SIGNATURE','request signature invalid');
    coord.useNonce(n,id,SKEW_MS*2+1000);
    rate(id);
    return id;
  }
  const json=(res,code,obj,headers={})=>{const b=Buffer.from(JSON.stringify(obj));res.writeHead(code,{'content-type':'application/json','content-length':b.length,'cache-control':'no-store',...headers});res.end(b);};
  async function handle(req,res){
    const cid=randomBytes(6).toString('hex');
    if(inflight>=maxConcurrent)return json(res,503,errorBody(new ComputeError('UNAVAILABLE','busy'),cid),{'retry-after':'2'});
    let reservedPayload=false;
    inflight++;
    try{
      const url=new URL(req.url,'https://coordinator'),route=url.pathname+url.search,p=url.pathname;
      if(!p.startsWith('/v2/'))fail('NOT_FOUND','not found');
      if(req.method==='GET'&&p==='/v2/health/live')return json(res,200,{ok:true,server_time:now(),protocol_version:'2.0'});
      if(req.method==='GET'&&p==='/v2/health/ready')return json(res,200,{ready:true});
      const isContent=req.method==='PUT'&&/^\/v2\/updates\/[\w-]+\/content$/.test(p);
      if(isContent){
        if(payloads>=Math.max(1,Math.floor(maxConcurrent/2)))return json(res,503,errorBody(new ComputeError('UNAVAILABLE','payload queue busy'),cid),{'retry-after':'2'});
        payloads++;
        reservedPayload=true;
      }
      const body=await readBody(req,isContent?MAX_UPDATE_BYTES:MAX_JSON);
      const parse=()=>{if(!body.length)return {};try{const v=JSON.parse(body.toString('utf8'));if(!v||typeof v!=='object'||Array.isArray(v))throw 0;return v;}catch{fail('INVALID_SCHEMA','body must be a JSON object');}};
      if(req.method==='POST'&&p==='/v2/pair/start')return json(res,200,coord.pairStart());
      if(req.method==='POST'&&p==='/v2/pair/complete')return json(res,200,coord.pairComplete(parse()));
      const dev=authenticate(req,route,body);
      let m;
      if(req.method==='POST'&&p==='/v2/devices/session')return json(res,200,coord.startSession(dev));
      if(req.method==='GET'&&p==='/v2/devices/state')return json(res,200,{state:coord.authDevice(dev,{allowPending:true}).state});
      if(req.method==='POST'&&p==='/v2/devices/heartbeat')return json(res,200,coord.heartbeat(dev,parse()));
      if(req.method==='POST'&&p==='/v2/tasks/claim'){const r=coord.claim(dev,parse());return r.task?json(res,200,r):json(res,200,r,{'retry-after':String(r.retry_after_s||5)});}
      if(req.method==='POST'&&(m=p.match(/^\/v2\/tasks\/([\w-]+)\/(renew|progress|abandon)$/)))return json(res,200,coord[m[2]](dev,m[1],parse()));
      if(req.method==='GET'&&(m=p.match(/^\/v2\/artifacts\/([0-9a-f]{64})$/))){const b=coord.artifactFor(dev,m[1]);res.writeHead(200,{'content-type':'application/octet-stream','content-length':b.length,'x-kc-sha256':m[1]});return res.end(b);}
      if(req.method==='POST'&&p==='/v2/updates')return json(res,200,coord.declareUpdate(dev,parse()));
      if(isContent){m=p.match(/^\/v2\/updates\/([\w-]+)\/content$/);return json(res,200,coord.putContent(dev,m[1],body,url.searchParams.get('session_id')));}
      if(req.method==='POST'&&(m=p.match(/^\/v2\/updates\/([\w-]+)\/commit$/)))return json(res,200,coord.commitUpdate(dev,m[1],parse()));
      if(req.method==='GET'&&(m=p.match(/^\/v2\/updates\/([\w-]+)\/status$/)))return json(res,200,coord.updateStatus(dev,m[1]));
      fail('NOT_FOUND','not found');
    }catch(e){
      const err=e instanceof ComputeError?e:new ComputeError('INTERNAL','internal error');
      if(!(e instanceof ComputeError))log('internal error '+cid+': '+(e?.stack||e));
      if(!res.headersSent)json(res,err.status===204?200:err.status,errorBody(err,cid),err.retryAfter?{'retry-after':String(err.retryAfter)}:{});else res.destroy();
    }finally{inflight--;if(reservedPayload)payloads--;}
  }
  const server=https.createServer({cert,key,minVersion:'TLSv1.2'},handle);
  server.headersTimeout=10000;server.requestTimeout=60000;server.keepAliveTimeout=5000;server.maxHeadersCount=40;
  server.setTimeout(65000);
  return server;
}
