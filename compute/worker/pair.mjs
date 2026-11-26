// Worker side of enrollment: parse the pairing string, pin the certificate, prove the one-time code with an
// HMAC (the code itself never crosses the wire) and prove key possession with an Ed25519 signature.
import {createHash,createHmac} from 'node:crypto';
import {parsePairing,createClient} from './client.mjs';
import {signBytes} from '../protocol/sign.mjs';
const normCode=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
export async function pairWithCoordinator({pairing,identity,alias,capabilities=null,runtime_version='0.2.0'}){
  const p=parsePairing(pairing);
  const client=createClient({endpoint:p.endpoint,fingerprint:p.fingerprint,identity});
  try{
    const start=await client.post('/v2/pair/start',{},{signed:false});
    const key=createHash('sha256').update(normCode(p.code)).digest();
    const code_mac=createHmac('sha256',key).update(start.challenge+'|'+identity.public_key).digest('base64');
    const signature=signBytes(identity.private_key,Buffer.from(['KC2-PAIR',start.challenge,code_mac,identity.public_key,identity.device_id].join('\n')));
    const done=await client.post('/v2/pair/complete',{challenge:start.challenge,device_id:identity.device_id,public_key:identity.public_key,alias,code_mac,signature,capabilities,runtime_version},{signed:false});
    return {endpoint:p.endpoint,fingerprint:client.fingerprint,project_id:done.project_id,coordinator_key:done.coordinator_key,device_state:done.state,key_fingerprint:done.key_fingerprint,duplicate_alias:done.duplicate_alias,paired_at:Date.now()};
  }finally{client.close();}
}
