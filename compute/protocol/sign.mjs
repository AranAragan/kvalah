// Ed25519 identities and request signing (node:crypto; no custom cryptography).
import {generateKeyPairSync,createPublicKey,createPrivateKey,sign,verify,randomBytes,createHash} from 'node:crypto';
import {canonicalJSON} from './hash.mjs';
export function newKeyPair(){
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  return {publicKey:publicKey.export({format:'der',type:'spki'}).toString('base64'),privateKey:privateKey.export({format:'der',type:'pkcs8'}).toString('base64')};
}
const pub=b64=>createPublicKey({key:Buffer.from(b64,'base64'),format:'der',type:'spki'});
const priv=b64=>createPrivateKey({key:Buffer.from(b64,'base64'),format:'der',type:'pkcs8'});
export function validPublicKey(b64){try{const k=pub(b64);return k.asymmetricKeyType==='ed25519';}catch{return false;}}
export const keyFingerprint=b64=>createHash('sha256').update(Buffer.from(b64,'base64')).digest('hex').slice(0,16).replace(/(.{4})(?!$)/g,'$1-');
export const signBytes=(privB64,bytes)=>sign(null,bytes,priv(privB64)).toString('base64');
export function verifyBytes(pubB64,bytes,sigB64){try{return typeof sigB64==='string'&&verify(null,bytes,pub(pubB64),Buffer.from(sigB64,'base64'));}catch{return false;}}
export const signJSON=(privB64,obj)=>signBytes(privB64,Buffer.from(canonicalJSON(obj)));
export const verifyJSON=(pubB64,obj,sig)=>verifyBytes(pubB64,Buffer.from(canonicalJSON(obj)),sig);
// Request signature: binds method, path+query, body digest, timestamp, nonce and device id.
export const requestPayload=({method,path,bodySha,ts,nonce,deviceId})=>Buffer.from(['KC2',method.toUpperCase(),path,bodySha,String(ts),nonce,deviceId].join('\n'));
export const nonce=()=>randomBytes(16).toString('hex');
