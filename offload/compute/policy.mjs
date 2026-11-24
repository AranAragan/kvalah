// SEC-01 — single data-protection policy applied to every input and every output path.
// Detector = known token formats + private keys + sensitive assignments + entropy (secrets.mjs) + user deny
// patterns, minus user allow patterns. Regex detection is incomplete by nature: it reduces, not eliminates, risk.
import {createHash} from 'node:crypto';
import {scanSecrets,redactSecrets} from './secrets.mjs';
const MAX_DEPTH=12;
export function safeJson(v,max=200_000){const seen=new WeakSet();let s;try{s=JSON.stringify(v,(k,x)=>{if(x&&typeof x==='object'){if(seen.has(x))return '[Circular]';seen.add(x);}return typeof x==='bigint'?String(x):x;});}catch{s='[unserializable]';}return s===undefined?'':s.length>max?s.slice(0,max)+'…[truncated]':s;}
export const BLOCKED='[BLOCKED: sensitive content withheld]';
const parseList=v=>{if(!v)return [];try{const a=JSON.parse(v);if(Array.isArray(a))return a.map(String);}catch{}return String(v).split(';;').map(s=>s.trim()).filter(Boolean);};
export function policyFromEnv(env=process.env){
  return {mode:env.KVALAH_SECRET_POLICY==='block'?'block':'redact',deny:parseList(env.KVALAH_SECRET_DENY),allow:parseList(env.KVALAH_SECRET_ALLOW)};
}
export class SecretBlockedError extends Error{constructor(where,types){super(`Secret-like content detected in ${where} (${types.join(', ')}); blocked by KVALAH_SECRET_POLICY=block`);this.name='SecretBlockedError';this.fatal=true;}}
export function createPolicy({mode='redact',deny=[],allow=[]}={}){
  // v0.4 SEC-04: never echo the pattern (it may itself be a secret)
  const bad=(v,i)=>Error(`Invalid ${v} pattern #${i+1}: not a valid regular expression (value not shown)`);
  const denyRe=deny.map((p,i)=>{try{return new RegExp(p,'g');}catch{throw bad('KVALAH_SECRET_DENY',i);}});
  const allowRe=allow.map((p,i)=>{try{return new RegExp(p);}catch{throw bad('KVALAH_SECRET_ALLOW',i);}});
  const fp=createHash('sha256').update(JSON.stringify({v:1,mode,deny,allow})).digest('hex').slice(0,16);
  function scan(text){
    if(typeof text!=='string'||!text)return [];
    let f=scanSecrets(text);
    for(const re of denyRe){re.lastIndex=0;let m;while((m=re.exec(text))){if(!m[0])break;f.push({type:'custom-deny',start:m.index,end:m.index+m[0].length});}}
    if(allowRe.length)f=f.filter(x=>!allowRe.some(re=>re.test(text.slice(x.start,x.end))));
    f.sort((a,b)=>a.start-b.start||b.end-a.end);const out=[];let last=-1;for(const x of f){if(x.start<last)continue;out.push(x);last=x.end;}
    return out;
  }
  const types=f=>[...new Set(f.map(x=>x.type))];
  return {
    mode,fingerprint:fp,scan,
    // inputs headed to a model (local or LAN): block -> throw, redact -> masked text (line numbers preserved)
    input(text,where){const f=scan(text);if(!f.length)return {text,count:0,types:[]};if(mode==='block')throw new SecretBlockedError(where,types(f));const r=redactSecrets(text,f);return {text:r.text,count:f.length,types:types(f)};},
    // any outgoing string: redact -> masked, block -> withheld
    text(s){if(typeof s!=='string')return s;const f=scan(s);if(!f.length)return s;return mode==='block'?BLOCKED:redactSecrets(s,f).text;},
    // deep-sanitize an outgoing JSON-like value; objects that had a field withheld get blocked:true
    // v0.4 SEC-01: past the depth limit the remaining subtree is serialized (cycle-safe) and filtered as one
    // string; raw data is never returned.
    output(v,depth=0){
      if(depth>MAX_DEPTH){if(v===null||typeof v!=='object')return typeof v==='string'?this.text(v):v;return this.text(safeJson(v));}
      if(typeof v==='string')return this.text(v);
      if(Array.isArray(v))return v.map(x=>this.output(x,depth+1));
      if(v&&typeof v==='object'){const o={};let blocked=false;for(const [k,x] of Object.entries(v)){const y=this.output(x,depth+1);if(y===BLOCKED&&x!==BLOCKED)blocked=true;o[this.text(k)]=y;}if(blocked)o.blocked=true;return o;}
      return v;
    },
    error(e){const msg=this.text(String(e?.message||e));const err=Object.assign(Error(msg),{name:e?.name||'Error'});if(e?.fatal)err.fatal=true;return err;}
  };
}
