// Output checks: parse structured results, verify quoted evidence against the real inputs (and resolve
// file:line deterministically), and flag injection-like content the cloud agent should not act on.
const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
export const RESULT_SCHEMA={type:'object',properties:{
  summary:{type:'string'},
  draft:{type:'string'},
  findings:{type:'array',items:{type:'object',properties:{text:{type:'string'},quote:{type:'string'},path:{type:'string'}},required:['text','quote']}},
  uncertainty:{type:'string'}},required:['summary','findings']};

export function parseStructured(text){
  const s=String(text).trim().replace(/^```(?:json)?\s*/i,'').replace(/```$/,'').trim();
  try{const v=JSON.parse(s);if(v&&typeof v==='object'&&typeof v.summary==='string'&&Array.isArray(v.findings))return v;}catch{}
  const a=s.indexOf('{'),b=s.lastIndexOf('}');
  if(a>=0&&b>a){try{const v=JSON.parse(s.slice(a,b+1));if(v&&typeof v.summary==='string'&&Array.isArray(v.findings))return v;}catch{}}
  return null;
}
// sources: [{path, text, lineOffset?}] (path null for inline context).
// v0.3 (SEC-04): verification is file-specific. A quote counts as verified only if every quote line occurs, in
// order, on consecutive lines of the CLAIMED file (or of the only file containing it when no path is claimed).
// `quoteVerified` says nothing about whether the finding is correct; `verified` is kept as a compatible alias
// of `quoteVerified`. Malformed findings are counted (invalid), never coerced into strings.
export function verifyFindings(findings,sources,{max=100}={}){
  const prepared=sources.map(s=>({path:s.path??null,off:s.lineOffset||0,unknown:s.lineOffset===null,norm:String(s.text).split('\n').map(norm)}));
  const paths=new Set(prepared.map(s=>s.path));
  const out=[];let invalid=0;
  for(const f of Array.isArray(findings)?findings:[]){
    if(out.length>=max){out.dropped=(out.dropped||0)+1;continue;}
    if(!f||typeof f!=='object'||Array.isArray(f)||typeof f.text!=='string'||typeof f.quote!=='string'||(f.path!=null&&typeof f.path!=='string')){invalid++;continue;}
    const quote=f.quote.trim(),claimed=f.path?f.path.trim():null;
    const o={text:f.text.slice(0,2000),quote:quote.slice(0,1000),path:null,line:null,quoteVerified:false,verified:false,ambiguous:false};
    const q=quote.split('\n').map(norm).filter(Boolean);
    if(quote.length<4||!q.length||q.length>20){out.push(o);continue;}
    const hits=[];
    for(const s of prepared)for(let i=0;i+q.length<=s.norm.length;i++){
      let ok=true;for(let k=0;k<q.length;k++)if(!s.norm[i+k].includes(q[k])){ok=false;break;}
      if(ok){hits.push({path:s.path,line:s.unknown?null:s.off+i+1,...(s.unknown?{lineInTail:i+1}:{})});if(hits.length>50)break;}
    }
    const inClaimed=claimed?hits.filter(h=>h.path===claimed):hits;
    if(inClaimed.length){
      Object.assign(o,{path:inClaimed[0].path,line:inClaimed[0].line,quoteVerified:true,verified:true});
      const files=new Set(inClaimed.map(h=>h.path));
      if(inClaimed.length>1){o.ambiguous=true;o.candidates=inClaimed.slice(0,10);if(files.size>1){o.path=null;o.line=null;}}
    }else if(claimed&&(hits.length||!paths.has(claimed))){
      o.pathMismatch=true;if(hits.length)o.foundIn=hits.slice(0,5);
    }else{
      const first=q[0];for(const s of prepared){const i=s.norm.findIndex(l=>l.includes(first));if(i>=0){o.partial=true;o.path=s.path;o.line=s.off+i+1;break;}}
    }
    out.push(o);
  }
  out.invalid=invalid;
  return out;
}
const INJECTION=[
  [/\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all|system)\b.{0,20}\b(instructions?|prompts?|rules?)/i,'instruction-override'],
  [/\b(you are now|act as|new instructions?|system prompt)\b/i,'role-change'],
  [/<\|[a-z_]{2,24}\|>|\[\/?INST\]|<\/?(system|assistant|user)>|^\s*(system|assistant)\s*:/im,'role-tag'],
  [/(^|[\s`'"(])(rm\s+-rf|curl\s+[^|]*\|\s*(ba)?sh|wget\s+[^|]*\|\s*(ba)?sh|chmod\s+\+x|powershell\s+-enc|Invoke-Expression|iex\s*\()/i,'shell-command'],
  [/\b(run|execute|call)\b.{0,30}\b(tool|command|kvalah_|shell|terminal)\b/i,'action-request'],
  [/\b(api[_ -]?key|password|token|secret)\b.{0,30}\b(send|post|upload|share|paste)\b/i,'exfiltration'],
];
export function injectionWarnings(text,sourcesText=''){
  const w=[];
  for(const [re,type] of INJECTION)if(re.test(text))w.push(type);
  const urls=[...new Set(String(text).match(/https?:\/\/[^\s)"'<>]+/g)||[])];
  const novel=urls.filter(u=>!sourcesText.includes(u));
  if(novel.length)w.push('url-not-in-source');
  return {warnings:[...new Set(w)],novelUrls:novel.slice(0,10)};
}
