// Dataset Engine (spec §7): import → schema/size validation → license/provenance → PII/secret filter →
// exact + near-duplicate handling → group-aware split → central tokenization → mask validation →
// immutable shards → manifest. Only explicit JSONL files chosen by the administrator are accepted;
// Kvalah chats, uploads and project files have no path into this pipeline.
import {createHash} from 'node:crypto';
import {fail} from '../protocol/errors.mjs';
import {sha256,hashJSON,canonicalJSON} from '../protocol/hash.mjs';
export const PREPROCESSING_VERSION='kc2-dataset-1';
export const LIMITS={file_bytes:64*2**20,line_bytes:64*1024,rows:100000,messages:32,content_chars:16000};
export const LICENSES=['CC0-1.0','CC-BY-4.0','CC-BY-SA-4.0','MIT','Apache-2.0','BSD-3-Clause','ODC-By-1.0','CDLA-Permissive-2.0'];
const ROLES=['system','user','assistant'];
// Filters are heuristics, not a guarantee (documented in docs/compute/threat-model.md).
const PII=[
  ['email',/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['phone',/(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d{3}[\s-]\d{2,3}[\s-]\d{2,4}\b/],
  ['ipv4',/\b(?!127\.0\.0\.1\b)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/],
  ['private_key',/-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api_key',/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,})\b/],
  ['secret_assignment',/\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"']{8,}/i],
  ['card',/\b(?:\d[ -]?){13,19}\b/]
];
const luhn=s=>{const d=s.replace(/\D/g,'');if(d.length<13||d.length>19)return false;let sum=0;for(let i=0;i<d.length;i++){let x=+d[d.length-1-i];if(i%2){x*=2;if(x>9)x-=9;}sum+=x;}return sum%10===0;};
export function piiFlags(text){
  const out=[];
  for(const [name,re] of PII){const m=text.match(re);if(!m)continue;if(name==='card'&&!luhn(m[0]))continue;out.push(name);}
  return out;
}
export const normalizeText=s=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
const rowText=r=>r.messages.map(m=>m.role+': '+m.content).join('\n');
function minhash(text,k=64){
  const words=normalizeText(text).split(' ');const sh=new Set();
  for(let i=0;i<Math.max(1,words.length-2);i++)sh.add(words.slice(i,i+3).join(' '));
  const sig=new Array(k).fill(0xffffffff);
  for(const s of sh){const h=createHash('sha256').update(s).digest();for(let j=0;j<k;j++){const v=h.readUInt32LE((j*4)%32)^Math.imul(j+1,0x9e3779b1)>>>0;if((v>>>0)<sig[j])sig[j]=v>>>0;}}
  return sig;
}
const jaccard=(a,b)=>{let n=0;for(let i=0;i<a.length;i++)if(a[i]===b[i])n++;return n/a.length;};
export function parseJSONL(text){
  if(Buffer.byteLength(text)>LIMITS.file_bytes)fail('TOO_LARGE','dataset file exceeds '+LIMITS.file_bytes+' bytes');
  const rows=[],rejected=[];let n=0;
  for(const line of text.split(/\r?\n/)){
    n++;if(!line.trim())continue;
    if(Buffer.byteLength(line)>LIMITS.line_bytes){rejected.push({line:n,reason:'line_too_long'});continue;}
    let r;try{r=JSON.parse(line);}catch{rejected.push({line:n,reason:'invalid_json'});continue;}
    const why=validateRow(r);if(why){rejected.push({line:n,id:typeof r?.id==='string'?r.id.slice(0,80):undefined,reason:why});continue;}
    rows.push(r);if(rows.length>LIMITS.rows)fail('TOO_LARGE','too many rows');
  }
  return {rows,rejected};
}
export function validateRow(r){
  if(!r||typeof r!=='object'||Array.isArray(r))return 'not_object';
  if(typeof r.id!=='string'||!/^[\w.:-]{1,80}$/.test(r.id))return 'bad_id';
  if(!Array.isArray(r.messages)||!r.messages.length||r.messages.length>LIMITS.messages)return 'bad_messages';
  for(const m of r.messages){
    if(!m||!ROLES.includes(m.role))return 'unsupported_role';
    if(typeof m.content!=='string'||!m.content.trim()||m.content.length>LIMITS.content_chars)return 'bad_content';
    if(Object.keys(m).some(k=>!['role','content'].includes(k)))return 'unsupported_message_field';   // no tool_calls execution, no extras
  }
  if(r.messages.at(-1).role!=='assistant')return 'last_message_not_assistant';
  if(r.messages.findIndex(m=>m.role==='system')>0)return 'system_not_first';
  for(const k of ['domain','language','source','license','group_id'])if(r[k]!==undefined&&typeof r[k]!=='string')return 'bad_'+k;
  if(r.quality_flags!==undefined&&!(Array.isArray(r.quality_flags)&&r.quality_flags.every(x=>typeof x==='string')))return 'bad_quality_flags';
  return null;
}
// Steps up to (and excluding) tokenization. Deterministic for a given input and seed.
export function prepareRows(rows,{seed=1,ratios={validation:0.086,test:0.057},nearThreshold=0.85}={}){
  const excluded=[],stats={input:rows.length,exact_duplicates:0,near_duplicate_links:0,pii:{},license_missing:0,license_not_allowed:0};
  const kept=[];const seenExact=new Map(),seenId=new Set();
  for(const r of rows){
    if(seenId.has(r.id)){excluded.push({id:r.id,reason:'duplicate_id'});continue;}seenId.add(r.id);
    if(!r.license){stats.license_missing++;excluded.push({id:r.id,reason:'license_missing'});continue;}
    if(!LICENSES.includes(r.license)){stats.license_not_allowed++;excluded.push({id:r.id,reason:'license_not_allowed'});continue;}
    const flags=piiFlags(rowText(r));
    if(flags.length){for(const f of flags)stats.pii[f]=(stats.pii[f]||0)+1;excluded.push({id:r.id,reason:'pii_or_secret:'+flags.join(',')});continue;}
    const key=sha256(normalizeText(rowText(r)));
    if(seenExact.has(key)){stats.exact_duplicates++;excluded.push({id:r.id,reason:'exact_duplicate_of:'+seenExact.get(key)});continue;}
    seenExact.set(key,r.id);kept.push(r);
  }
  // Near duplicates join the same split group (prevents leakage across train/validation/test).
  const parent=kept.map((_,i)=>i),find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
  const sigs=kept.map(r=>minhash(rowText(r))),buckets=new Map();
  for(let i=0;i<kept.length;i++)for(let b=0;b<16;b++){const k=b+':'+sigs[i].slice(b*4,b*4+4).join(',');if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(i);}
  for(const list of buckets.values())for(let x=1;x<list.length;x++){const i=list[0],j=list[x];if(find(i)!==find(j)&&jaccard(sigs[i],sigs[j])>=nearThreshold){parent[find(j)]=find(i);stats.near_duplicate_links++;}}
  const groupOf=i=>{const root=find(i);return kept[root].group_id?'g:'+kept[root].group_id:'r:'+kept[root].id;};
  // Explicit group ids also merge: rows sharing group_id or a near-duplicate cluster go to one split.
  const gmap=new Map();
  kept.forEach((r,i)=>{const gs=[groupOf(i)];if(r.group_id)gs.push('g:'+r.group_id);let target=null;for(const g of gs)if(gmap.has(g)){target=gmap.get(g);break;}target??=gs[0];for(const g of gs)gmap.set(g,target);});
  const splits={train:[],validation:[],test:[]};
  kept.forEach((r,i)=>{
    const g=gmap.get(groupOf(i)),u=parseInt(sha256(`${seed}|split|${g}`).slice(0,8),16)/2**32;
    const s=u<ratios.test?'test':u<ratios.test+ratios.validation?'validation':'train';
    splits[s].push({...r,_group:g});
  });
  return {splits,excluded,stats};
}
// Tokenize (via the supplied central tokenizer), validate masks and build immutable shards + manifest.
export async function buildDataset({rows,datasetId,revision,profileId,maxLength,seed=1,tokenizer,shardSize=64,source,provenance}){
  if(!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(datasetId))fail('DATASET_INVALID','dataset id: lowercase letters, digits, . _ -');
  if(!/^[\w.-]{1,40}$/.test(String(revision)))fail('DATASET_INVALID','bad revision');
  const prep=prepareRows(rows,{seed});
  const shards={},manifestShards={},split_counts={},tokens_by_split={},fingerprints={};let tokHash=null,tplHash=null,tokOpts=null;
  const excluded=[...prep.excluded];
  for(const [split,list] of Object.entries(prep.splits)){
    const tok=list.length?await tokenizer(list.map(r=>({id:r.id,messages:r.messages})),maxLength):{rows:[],excluded:[]};
    if(list.length){if(tokHash&&tok.tokenizer_hash!==tokHash)fail('DATASET_INVALID','tokenizer changed during preparation');tokHash=tok.tokenizer_hash;tplHash=tok.chat_template_hash;tokOpts=tok.tokenizer_options||null;}
    for(const e of tok.excluded)excluded.push(e);
    const good=[];
    for(const t of tok.rows){
      // Mask validation: same length, first position never a target, at least one target.
      if(!Array.isArray(t.input_ids)||t.input_ids.length!==t.target_mask.length||t.target_mask[0]!==0||t.input_ids.length>maxLength){excluded.push({id:t.id,reason:'mask_invalid'});continue;}
      if(!t.target_mask.slice(1).some(Boolean)){excluded.push({id:t.id,reason:'no_target_tokens'});continue;}
      good.push({id:t.id,input_ids:t.input_ids.map(Number),target_mask:t.target_mask.map(v=>v?1:0)});
    }
    good.sort((a,b)=>a.id<b.id?-1:1);
    split_counts[split]=good.length;
    tokens_by_split[split]={processed:good.reduce((a,r)=>a+r.input_ids.length,0),supervised:good.reduce((a,r)=>a+r.target_mask.slice(1).filter(Boolean).length,0)};
    fingerprints[split]=hashJSON(good.map(r=>r.id));
    manifestShards[split]=[];
    for(let i=0;i<good.length;i+=shardSize){
      const body={dataset_id:datasetId,revision:String(revision),split,index:i/shardSize,rows:good.slice(i,i+shardSize)};
      const bytes=Buffer.from(canonicalJSON(body)),h=sha256(bytes);shards[h]=bytes;manifestShards[split].push({sha256:h,rows:body.rows.length});
    }
  }
  const licenses=[...new Set(rows.map(r=>r.license).filter(Boolean))].sort();
  const synthetic=rows.length>0&&rows.every(r=>(r.quality_flags||[]).includes('synthetic'));
  const manifest={dataset_id:datasetId,revision:String(revision),license:licenses.join(' AND ')||'unknown',source:source||[...new Set(rows.map(r=>r.source).filter(Boolean))].join(', '),
    provenance:provenance||'imported by coordinator administrator from a local JSONL file',preprocessing_version:PREPROCESSING_VERSION,profile_id:profileId,max_length:maxLength,
    tokenizer_hash:tokHash,chat_template_hash:tplHash,tokenizer_options:tokOpts,split_seed:seed,split_counts,tokens_by_split,shards:manifestShards,split_fingerprint:hashJSON(fingerprints),
    excluded_by_reason:excluded.reduce((a,e)=>{const k=String(e.reason).split(':')[0];a[k]=(a[k]||0)+1;return a;},{}),stats:prep.stats,synthetic,
    status:(split_counts.train||0)>=3000&&(split_counts.validation||0)>=300&&(split_counts.test||0)>=200?'RESEARCH_SIZE':'SMOKE_ONLY'};
  return {manifest,shards,excluded};
}
