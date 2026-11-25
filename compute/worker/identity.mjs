// Installation identity (spec §9.1): random device_id + Ed25519 key pair generated on first enable.
// Never derived from MAC/serial/IP/username. The private key is sealed by the OS credential store
// (Electron safeStorage → DPAPI / Keychain) when the desktop shell provides it; headless CLI falls back
// to an owner-only file and reports that in diagnostics.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {newKeyPair,keyFingerprint} from '../protocol/sign.mjs';
export async function loadIdentity(dir,secretBox){
  const f=path.join(dir,'identity.json');
  if(fs.existsSync(f)){
    const v=JSON.parse(fs.readFileSync(f,'utf8'));
    const priv=v.sealed?await secretBox.open(v.private_key):v.private_key;
    return {device_id:v.device_id,public_key:v.public_key,private_key:priv,secret_store:v.sealed?secretBox.scheme:'file-0600',key_fingerprint:keyFingerprint(v.public_key),created_at:v.created_at};
  }
  return null;
}
export async function createIdentity(dir,secretBox){
  fs.mkdirSync(dir,{recursive:true});
  const kp=newKeyPair(),device_id='dev-'+randomBytes(16).toString('hex');
  const sealed=secretBox?.available?await secretBox.seal(kp.privateKey):null;
  const rec={version:1,device_id,public_key:kp.publicKey,private_key:sealed??kp.privateKey,sealed:!!sealed,created_at:Date.now()};
  const f=path.join(dir,'identity.json'),tmp=f+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(rec),{mode:0o600});fs.renameSync(tmp,f);
  return loadIdentity(dir,secretBox);
}
export const fileSecretBox={available:false,scheme:'file-0600',seal:async s=>s,open:async s=>s};
