// Coordinator client: pinned TLS (certificate fingerprint from the pairing string), Ed25519-signed requests,
// server-time offset, bounded timeouts, no system proxy, no redirects.
import https from 'node:https';
import tls from 'node:tls';
import {sha256} from '../protocol/hash.mjs';
import {requestPayload,signBytes,nonce} from '../protocol/sign.mjs';
import {normFingerprint} from '../coordinator/tls.mjs';
import {ComputeError} from '../protocol/errors.mjs';
export function parseEndpoint(s){
  let u;try{u=new URL(String(s));}catch{throw new ComputeError('INVALID_SCHEMA','endpoint must look like https://192.168.1.10:8765');}
  if(u.protocol!=='https:')throw new ComputeError('INVALID_SCHEMA','only https:// endpoints are allowed');
  if(u.username||u.password||(u.pathname!=='/'&&u.pathname!=='')||u.search||u.hash)throw new ComputeError('INVALID_SCHEMA','endpoint must be https://host:port only');
  return {host:u.hostname.replace(/^\[|\]$/g,''),port:Number(u.port||443),origin:u.origin};
}
// Pairing string: kvalah-compute://pair?e=<endpoint>&fp=<sha256 fingerprint>&c=<one-time code>
export function parsePairing(s){
  let u;try{if(typeof s!=='string'||s.length>4096)throw Error();u=new URL(s.trim());}catch{throw new ComputeError('INVALID_SCHEMA','pairing string is not valid');}
  if(u.protocol!=='kvalah-compute:'||u.hostname!=='pair'||u.pathname||u.username||u.password||u.port||u.hash||
    [...u.searchParams].length!==3)throw new ComputeError('INVALID_SCHEMA','pairing string is not valid');
  const e=u.searchParams.get('e'),fp=normFingerprint(u.searchParams.get('fp')),c=u.searchParams.get('c');
  if(!e||fp.length!==95||!c)throw new ComputeError('INVALID_SCHEMA','pairing string is incomplete');
  parseEndpoint(e);return {endpoint:e,fingerprint:fp,code:c};
}
export const pairingString=({endpoint,fingerprint,code})=>`kvalah-compute://pair?e=${encodeURIComponent(endpoint)}&fp=${normFingerprint(fingerprint).replace(/:/g,'')}&c=${encodeURIComponent(code)}`;
const MAX_RESPONSE=16*1024*1024;
export function createClient({endpoint,fingerprint,identity,timeoutMs=30000,controlMs=15000,transferMs=90000,onTraffic=()=>{},onRequest=()=>{}}){
  const ep=parseEndpoint(endpoint),pin=normFingerprint(fingerprint);
  let offset=0,bytesIn=0,bytesOut=0,caPem=null,handshake=null;
  let transferFailures=0,transferBlockedUntil=0;
  const latency={control:null,transfer:null};
  const controlAgent=new https.Agent({keepAlive:true,maxSockets:4,maxFreeSockets:2});
  const transferAgent=new https.Agent({keepAlive:true,maxSockets:1,maxFreeSockets:1});
  const pinError=()=>new ComputeError('UNAUTHORIZED','coordinator certificate fingerprint does not match the pairing string');
  const netError=e=>e instanceof ComputeError?e:Object.assign(new ComputeError('UNAVAILABLE','coordinator unreachable: '+(e.code||e.message)),{network:true});
  // Trust exactly one certificate: the one whose SHA-256 fingerprint was pinned out of band. We read the
  // presented certificate in a handshake that sends no application data, compare the fingerprint, and
  // then use that certificate as the only CA (plus the same fingerprint check) for every request.
  function ensureCA(){
    if(caPem)return Promise.resolve();
    if(handshake)return handshake;
    handshake=new Promise((resolve,reject)=>{
      const s=tls.connect({host:ep.host,port:ep.port,rejectUnauthorized:false,servername:/^[\d.:]+$/.test(ep.host)?undefined:ep.host,timeout:10000},()=>{
        const c=s.getPeerCertificate(true);s.destroy();
        if(!c?.raw||normFingerprint(c.fingerprint256)!==pin)return reject(pinError());
        caPem='-----BEGIN CERTIFICATE-----\n'+c.raw.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n';resolve();
      });
      s.on('timeout',()=>s.destroy(new ComputeError('UNAVAILABLE','coordinator timeout')));
      s.on('error',e=>reject(netError(e)));
    }).finally(()=>{handshake=null;});
    return handshake;
  }
  async function request(method,p,{body=null,json=true,signed=true,headers={},signal,payload=false,maxPayload=MAX_RESPONSE}={}){
    const channel=payload?'transfer':'control',max=payload?transferMs:controlMs;
    const deadline=latency[channel]===null?max:Math.min(max,Math.ceil(Math.max(payload?15000:5000,latency[channel]*6)));
    const timeout=AbortSignal.timeout(deadline);
    const requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
    const route=p.split('?')[0].replace(/\/(?:task|upd)-[\w-]+/g,'/:id').replace(/\/artifacts\/[0-9a-f]{64}$/,'/artifacts/:sha');
    const start=performance.now();
    let stage='tls';
    let receivedPayload=0;
    let socketAt=null,handshakeAt=null,reused=null;
    try {
    requestSignal.throwIfAborted();
      if(payload&&transferBlockedUntil>start){
        const error=new ComputeError('UNAVAILABLE','transfer circuit temporarily open');
        error.circuitOpen=true;error.retryAfter=(transferBlockedUntil-start)/1000;
        throw error;
      }
    await ensureCA();
    requestSignal.throwIfAborted();
    const buf=body==null?Buffer.alloc(0):Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
    if(payload&&buf.length>maxPayload)throw new ComputeError('TRAFFIC_CAP','payload exceeds the remaining traffic budget');
    const h={'content-length':buf.length,...headers};
    if(body!=null&&!Buffer.isBuffer(body))h['content-type']='application/json';
    if(signed){
      const ts=Math.round(Date.now()+offset),n=nonce();
      Object.assign(h,{'x-kc-device':identity.device_id,'x-kc-ts':String(ts),'x-kc-nonce':n,
        'x-kc-sig':signBytes(identity.private_key,requestPayload({method,path:p,bodySha:sha256(buf),ts,nonce:n,deviceId:identity.device_id}))});
    }
    const reply=await new Promise((resolve,reject)=>{
      stage='send';
      if(payload&&buf.length)onTraffic(buf.length,'out');
      const r=https.request({host:ep.host,port:ep.port,method,path:p,headers:h,agent:payload?transferAgent:controlAgent,signal:requestSignal,timeout:Math.min(timeoutMs,deadline),minVersion:'TLSv1.2',ca:[caPem],rejectUnauthorized:true,
        servername:/^[\d.:]+$/.test(ep.host)?undefined:ep.host,
        checkServerIdentity:(host,cert)=>normFingerprint(cert.fingerprint256)===pin?undefined:pinError()},res=>{
        stage='read';
        const chunks=[];let n=0;
        const limit=payload&&!json&&res.statusCode===200?Math.min(maxPayload,MAX_RESPONSE):MAX_RESPONSE;
        res.on('aborted',()=>reject(new ComputeError('UNAVAILABLE','coordinator response interrupted')));
        res.on('error',reject);
        res.on('close',()=>{if(!res.complete)reject(new ComputeError('UNAVAILABLE','coordinator response incomplete'));});
        if(Number(res.headers['content-length'])>limit){
          const code=limit<MAX_RESPONSE?'TRAFFIC_CAP':'TOO_LARGE';
          reject(new ComputeError(code,'response exceeds the allowed body size'));
          r.destroy();
          return;
        }
        res.on('data',c=>{
          n+=c.length;bytesIn+=c.length;
          if(payload&&!json&&res.statusCode===200)receivedPayload+=c.length;
          if(n>limit)r.destroy(new ComputeError(limit<MAX_RESPONSE?'TRAFFIC_CAP':'TOO_LARGE','response too large'));
          else chunks.push(c);
        });
        res.on('end',()=>{
          stage='decode';
          const b=Buffer.concat(chunks);
          if(res.statusCode>=300&&res.statusCode<400)return reject(new ComputeError('FORBIDDEN_SCOPE','redirects are not followed'));
          if(res.statusCode>=400){let e;try{e=JSON.parse(b.toString()).error;}catch{e=null;}
            const err=new ComputeError(e?.code||'INTERNAL',e?.message||'HTTP '+res.statusCode);err.status=res.statusCode;err.httpStatus=res.statusCode;err.correlationId=e?.correlation_id;
            const retry=res.headers['retry-after'];
            if(retry)err.retryAfter=/^\d+$/.test(retry)?Number(retry):Math.max(0,(Date.parse(retry)-Date.now())/1000)||null;
            return reject(err);}
          if(!json)return resolve({bytes:b,headers:res.headers});
          try{resolve(b.length?JSON.parse(b.toString()):{});}catch{reject(new ComputeError('INVALID_SCHEMA','coordinator sent invalid JSON'));}
        });
      });
      r.on('socket',socket=>{
        socketAt=performance.now();reused=r.reusedSocket;
        if(socket.connecting){
          stage='connect';
          socket.once('secureConnect',()=>{handshakeAt=performance.now();stage='send';});
        }
      });
      r.on('timeout',()=>r.destroy(new ComputeError('UNAVAILABLE','coordinator timeout')));
      r.on('error',e=>reject(netError(e)));
      bytesOut+=buf.length;r.end(buf);
    });
    const elapsed=performance.now()-start;
    latency[channel]=latency[channel]===null?elapsed:latency[channel]*0.8+elapsed*0.2;
    if(payload)onRequest({method,route,channel,duration_ms:Math.round(elapsed),bytes_sent:buf.length,bytes_received:receivedPayload,
      socket_wait_ms:socketAt===null?null:Math.round(socketAt-start),tls_ms:handshakeAt===null?null:Math.round(handshakeAt-socketAt),
      reused_socket:reused,source:'http'});
    if(payload)transferFailures=0;
    return reply;
    }catch(error){
      const err=requestSignal.aborted&&signal?.aborted&&signal.reason instanceof ComputeError ? signal.reason : netError(error);
      if(payload&&!err.circuitOpen&&!signal?.aborted&&(err.network||err.code==='UNAVAILABLE')){
        if(++transferFailures>=3){transferBlockedUntil=performance.now()+Math.min(20000,1000*2**Math.min(4,transferFailures-3));transferAgent.destroy();}
      }
      err.rpc={method,route,stage,channel,duration_ms:Math.round(performance.now()-start),timeout_ms:deadline,
        socket_wait_ms:socketAt===null?null:Math.round(socketAt-start),tls_ms:handshakeAt===null?null:Math.round(handshakeAt-socketAt),
        reused_socket:reused,status:err.httpStatus??null,source:err.httpStatus?'http':err.circuitOpen?'circuit':'local',
        code:err.code,correlation_id:err.correlationId,errno:error.cause?.code||error.code};
      throw err;
    }finally{
      if(receivedPayload)onTraffic(receivedPayload,'in');
    }
  }
  let features=[];
  return {
    async syncTime({signal}={}){const t0=Date.now();const r=await request('GET','/v2/health/live',{signed:false,signal});const t1=Date.now();offset=r.server_time-(t0+t1)/2;features=Array.isArray(r.features)?r.features:[];return offset;},
    get features(){return [...features];},
    get offset(){return offset;},get bytes(){return {in:bytesIn,out:bytesOut};},fingerprint:pin,endpoint,
    close(){controlAgent.destroy();transferAgent.destroy();},
    post:(p,body,o)=>request('POST',p,{body:body??{},...o}),
    get:(p,o)=>request('GET',p,o),
    put:(p,bytes,o)=>request('PUT',p,{body:bytes,headers:{'content-type':'application/octet-stream'},...o})
  };
}
