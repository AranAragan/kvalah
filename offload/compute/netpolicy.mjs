// v0.4 SEC-02/SEC-03: one network policy for every outgoing model request (local providers, llama.cpp
// tokenizer, context/digest discovery, overlay mode and LAN peers).
//   * redirects are never followed: a 3xx response is an error (the body is discarded), so task data can not be
//     forwarded to another server by a redirect (307/308 would resend the POST body);
//   * http/https only, no credentials in URLs;
//   * pinnedFetch connects to an address that was checked beforehand (no second, unchecked DNS resolution);
//   * local endpoints must be loopback (127.0.0.0/8, ::1, or "localhost" resolving only to loopback).
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {Readable} from 'node:stream';
import {lookup as dnsLookup} from 'node:dns/promises';

export class NetPolicyError extends Error{constructor(m){super(m);this.name='NetPolicyError';this.fatal=true;}}
export const isLoopbackAddress=ip=>{ip=String(ip).replace(/^\[|\]$/g,'').toLowerCase();return /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(ip)||ip==='::1';};

// fetch-compatible request over node:http(s) that connects to `pin.address` (if given) instead of resolving the
// host again. TLS still verifies the certificate against the URL host name. Never follows redirects.
export function pinnedFetch(url,opt={},pin={}){
  const u=new URL(url);const mod=u.protocol==='https:'?https:http;
  const headers={};for(const [k,v] of Object.entries(opt.headers instanceof Headers?Object.fromEntries(opt.headers):opt.headers||{}))headers[k]=v;
  const body=opt.body==null?null:typeof opt.body==='string'||Buffer.isBuffer(opt.body)?opt.body:String(opt.body);
  if(body!=null&&!Object.keys(headers).some(k=>k.toLowerCase()==='content-length'))headers['Content-Length']=Buffer.byteLength(body);
  const fam=a=>net.isIPv6(a)?6:4;
  const lookup=pin.address?(host,o,cb)=>{if(typeof o==='function')cb=o;if(o?.all)cb(null,[{address:pin.address,family:fam(pin.address)}]);else cb(null,pin.address,fam(pin.address));}:undefined;
  return new Promise((resolve,reject)=>{
    if(opt.signal?.aborted)return reject(opt.signal.reason??Object.assign(Error('aborted'),{name:'AbortError'}));
    const req=mod.request(u,{method:opt.method||'GET',headers,lookup,signal:opt.signal,...(pin.ca?{ca:pin.ca}:{})},res=>{
      const h=new Headers();for(const [k,v] of Object.entries(res.headers))if(v!=null)h.set(k,Array.isArray(v)?v.join(', '):String(v));
      const empty=[204,205,304].includes(res.statusCode)||opt.method==='HEAD';
      if(empty)res.resume();
      resolve(new Response(empty?null:Readable.toWeb(res),{status:res.statusCode,statusText:res.statusMessage,headers:h}));
    });
    req.on('error',e=>reject(opt.signal?.aborted?(opt.signal.reason??e):e));
    if(body!=null)req.write(body);req.end();
  });
}
export function checkUrl(url){
  const u=new URL(url);
  if(u.protocol!=='http:'&&u.protocol!=='https:')throw new NetPolicyError('unsupported scheme '+u.protocol);
  if(u.username||u.password)throw new NetPolicyError('credentials in URL refused');
  return u;
}
export function refuseRedirect(r,label='request'){
  if(r.status>=300&&r.status<400){r.body?.cancel?.().catch?.(()=>{});throw new NetPolicyError(`${label}: redirect refused (HTTP ${r.status}); Kvalah never follows redirects`);}
  return r;
}
// Guarded fetch for local backends: loopback only, address pinned, no redirects.
export function localFetch({fetchImpl=pinnedFetch,lookup=h=>dnsLookup(h,{all:true,verbatim:true})}={}){
  return async(url,opt={})=>{
    const u=checkUrl(url);const host=u.hostname.replace(/^\[|\]$/g,'');
    let addrs=net.isIP(host)?[{address:host}]:host==='localhost'?await lookup(host):null;
    if(!addrs?.length||addrs.some(a=>!isLoopbackAddress(a.address)))throw new NetPolicyError('local backend must be a loopback address ('+host+')');
    return refuseRedirect(await fetchImpl(url,{...opt,redirect:'manual'},{address:addrs[0].address}),'local backend');
  };
}
