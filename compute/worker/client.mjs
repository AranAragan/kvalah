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
  let u;try{u=new URL(String(s||'').trim());}catch{throw new ComputeError('INVALID_SCHEMA','pairing string is not valid');}
  if(u.protocol!=='kvalah-compute:')throw new ComputeError('INVALID_SCHEMA','pairing string must start with kvalah-compute://');
  const e=u.searchParams.get('e'),fp=normFingerprint(u.searchParams.get('fp')),c=u.searchParams.get('c');
  if(!e||fp.length!==95||!c)throw new ComputeError('INVALID_SCHEMA','pairing string is incomplete');
  parseEndpoint(e);return {endpoint:e,fingerprint:fp,code:c};
}
export const pairingString=({endpoint,fingerprint,code})=>`kvalah-compute://pair?e=${encodeURIComponent(endpoint)}&fp=${normFingerprint(fingerprint).replace(/:/g,'')}&c=${encodeURIComponent(code)}`;
const MAX_RESPONSE=16*1024*1024;
export function createClient({endpoint,fingerprint,identity,timeoutMs=30000}){
  const ep=parseEndpoint(endpoint),pin=normFingerprint(fingerprint);
  let offset=0,bytesIn=0,bytesOut=0,caPem=null;
  const pinError=()=>new ComputeError('UNAUTHORIZED','coordinator certificate fingerprint does not match the pairing string');
  const netError=e=>e instanceof ComputeError?e:Object.assign(new ComputeError('UNAVAILABLE','coordinator unreachable: '+(e.code||e.message)),{network:true});
  // Trust exactly one certificate: the one whose SHA-256 fingerprint was pinned out of band. We read the
  // presented certificate in a handshake that sends no application data, compare the fingerprint, and
  // then use that certificate as the only CA (plus the same fingerprint check) for every request.
  function ensureCA(){
    if(caPem)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const s=tls.connect({host:ep.host,port:ep.port,rejectUnauthorized:false,servername:/^[\d.:]+$/.test(ep.host)?undefined:ep.host,timeout:10000},()=>{
        const c=s.getPeerCertificate(true);s.end();
        if(!c?.raw||normFingerprint(c.fingerprint256)!==pin)return reject(pinError());
        caPem='-----BEGIN CERTIFICATE-----\n'+c.raw.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n';resolve();
      });
      s.on('timeout',()=>s.destroy(new ComputeError('UNAVAILABLE','coordinator timeout')));
      s.on('error',e=>reject(netError(e)));
    });
  }
  async function request(method,p,{body=null,json=true,signed=true,headers={}}={}){
    await ensureCA();
    const buf=body==null?Buffer.alloc(0):Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
    const h={'content-length':buf.length,...headers};
    if(body!=null&&!Buffer.isBuffer(body))h['content-type']='application/json';
    if(signed){
      const ts=Math.round(Date.now()+offset),n=nonce();
      Object.assign(h,{'x-kc-device':identity.device_id,'x-kc-ts':String(ts),'x-kc-nonce':n,
        'x-kc-sig':signBytes(identity.private_key,requestPayload({method,path:p,bodySha:sha256(buf),ts,nonce:n,deviceId:identity.device_id}))});
    }
    return new Promise((resolve,reject)=>{
      const r=https.request({host:ep.host,port:ep.port,method,path:p,headers:h,agent:false,timeout:timeoutMs,minVersion:'TLSv1.2',ca:[caPem],rejectUnauthorized:true,
        servername:/^[\d.:]+$/.test(ep.host)?undefined:ep.host,
        checkServerIdentity:(host,cert)=>normFingerprint(cert.fingerprint256)===pin?undefined:pinError()},res=>{
        const chunks=[];let n=0;
        res.on('data',c=>{n+=c.length;if(n>MAX_RESPONSE)r.destroy(new ComputeError('TOO_LARGE','response too large'));else chunks.push(c);});
        res.on('end',()=>{
          const b=Buffer.concat(chunks);bytesIn+=b.length;
          if(res.statusCode>=300&&res.statusCode<400)return reject(new ComputeError('FORBIDDEN_SCOPE','redirects are not followed'));
          if(res.statusCode>=400){let e;try{e=JSON.parse(b.toString()).error;}catch{e=null;}
            const err=new ComputeError(e?.code||'INTERNAL',e?.message||'HTTP '+res.statusCode);err.status=res.statusCode;err.retryAfter=Number(res.headers['retry-after'])||null;return reject(err);}
          if(!json)return resolve({bytes:b,headers:res.headers});
          try{resolve(b.length?JSON.parse(b.toString()):{});}catch{reject(new ComputeError('INVALID_SCHEMA','coordinator sent invalid JSON'));}
        });
      });
      r.on('timeout',()=>r.destroy(new ComputeError('UNAVAILABLE','coordinator timeout')));
      r.on('error',e=>reject(netError(e)));
      bytesOut+=buf.length;r.end(buf);
    });
  }
  return {
    async syncTime(){const t0=Date.now();const r=await request('GET','/v2/health/live',{signed:false});const t1=Date.now();offset=r.server_time-(t0+t1)/2;return offset;},
    get offset(){return offset;},get bytes(){return {in:bytesIn,out:bytesOut};},fingerprint:pin,endpoint,
    post:(p,body,o)=>request('POST',p,{body:body??{},...o}),
    get:(p,o)=>request('GET',p,o),
    put:(p,bytes,o)=>request('PUT',p,{body:bytes,headers:{'content-type':'application/octet-stream'},...o})
  };
}
