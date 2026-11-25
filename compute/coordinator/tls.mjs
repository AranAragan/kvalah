// Self-signed TLS certificate for a LAN coordinator (ECDSA P-256), built with node:crypto + a tiny DER
// encoder. Workers pin the SHA-256 fingerprint shown in the pairing string; no certificate authority,
// no verify=False. The private key stays in the coordinator directory (mode 0600).
import {generateKeyPairSync,createSign,randomBytes,X509Certificate} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const len=n=>n<128?Buffer.from([n]):n<256?Buffer.from([0x81,n]):Buffer.from([0x82,n>>8,n&255]);
const tlv=(tag,body)=>Buffer.concat([Buffer.from([tag]),len(body.length),body]);
const seq=(...x)=>tlv(0x30,Buffer.concat(x)),set=(...x)=>tlv(0x31,Buffer.concat(x));
const oid=s=>{const p=s.split('.').map(Number),out=[40*p[0]+p[1]];for(const v of p.slice(2)){const b=[];let x=v;do{b.unshift(x&127);x>>=7;}while(x);for(let i=0;i<b.length-1;i++)b[i]|=128;out.push(...b);}return tlv(0x06,Buffer.from(out));};
const int=b=>tlv(0x02,b[0]&0x80?Buffer.concat([Buffer.from([0]),b]):b);
const utf8=s=>tlv(0x0c,Buffer.from(s,'utf8'));
const time=d=>{const s=d.toISOString().replace(/[-:T]/g,'').slice(2,14)+'Z';return tlv(0x17,Buffer.from(s));};
const bool=v=>tlv(0x01,Buffer.from([v?255:0]));
const octet=b=>tlv(0x04,b);
const bits=b=>tlv(0x03,Buffer.concat([Buffer.from([0]),b]));
const ext=(id,critical,value)=>seq(oid(id),...(critical?[bool(true)]:[]),octet(value));
function ipBytes(ip){if(ip.includes(':')){const full=ip.split('::');const head=full[0]?full[0].split(':'):[],tail=full[1]?full[1].split(':'):[];const mid=Array(8-head.length-tail.length).fill('0');return Buffer.from([...head,...mid,...tail].flatMap(h=>{const v=parseInt(h||'0',16);return [v>>8,v&255];}));}return Buffer.from(ip.split('.').map(Number));}
export function makeCertificate({ips=['127.0.0.1'],dnsNames=['localhost'],commonName='Kvalah Compute Coordinator',days=730}={}){
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
  const spki=publicKey.export({format:'der',type:'spki'});
  const algo=seq(oid('1.2.840.10045.4.3.2'));                 // ecdsa-with-SHA256
  const name=seq(set(seq(oid('2.5.4.3'),utf8(commonName))));
  const now=new Date(Date.now()-24*3600e3),end=new Date(Date.now()+days*24*3600e3);
  const san=seq(...dnsNames.map(d=>tlv(0x82,Buffer.from(d))),...ips.map(ip=>tlv(0x87,ipBytes(ip))));
  const exts=tlv(0xa3,seq(
    ext('2.5.29.19',true,seq(bool(true))),                       // basicConstraints CA:TRUE (self-signed trust anchor)
    ext('2.5.29.15',true,bits(Buffer.from([0x84]))),             // keyUsage digitalSignature|keyCertSign
    ext('2.5.29.37',false,seq(oid('1.3.6.1.5.5.7.3.1'))),        // extKeyUsage serverAuth
    ext('2.5.29.17',false,san)));
  const serial=randomBytes(16);serial[0]&=0x7f;
  const tbs=seq(tlv(0xa0,int(Buffer.from([2]))),int(serial),algo,name,seq(time(now),time(end)),name,spki,exts);
  const sig=createSign('sha256').update(tbs).sign(privateKey);
  const der=seq(tbs,algo,bits(sig));
  const pem='-----BEGIN CERTIFICATE-----\n'+der.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n';
  const x=new X509Certificate(pem);
  return {cert:pem,key:privateKey.export({format:'pem',type:'pkcs8'}),fingerprint:x.fingerprint256};
}
// Load or create the coordinator certificate for the chosen bind addresses.
export function coordinatorCertificate(dir,ips){
  const f=path.join(dir,'tls.json');
  try{const c=JSON.parse(fs.readFileSync(f,'utf8'));if(JSON.stringify(c.ips)===JSON.stringify(ips)&&new X509Certificate(c.cert).validToDate>new Date())return c;}catch{}
  fs.mkdirSync(dir,{recursive:true});
  const c={...makeCertificate({ips}),ips};fs.writeFileSync(f,JSON.stringify(c),{mode:0o600});return c;
}
export const normFingerprint=f=>String(f||'').toUpperCase().replace(/[^0-9A-F]/g,'').replace(/(..)(?!$)/g,'$1:');
