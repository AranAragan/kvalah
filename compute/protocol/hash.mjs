import {createHash} from 'node:crypto';
export const sha256=b=>createHash('sha256').update(b).digest('hex');
// Canonical JSON (sorted keys, no whitespace) for hashing configs and signing manifests.
export function canonicalJSON(v){
  if(v===null||typeof v!=='object')return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(canonicalJSON).join(',')+']';
  return '{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonicalJSON(v[k])).join(',')+'}';
}
export const hashJSON=v=>sha256(canonicalJSON(v));
export const isHex64=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
