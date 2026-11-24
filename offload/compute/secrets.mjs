// Content-based secret detection: known token formats + private key blocks + high-entropy values in
// assignment context. Used before anything is sent to a model (local or LAN).
const RULES=[
  ['private-key',/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----|$)/g],
  ['aws-access-key',/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g],
  ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g],
  ['gitlab-token',/\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['openai-key',/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g],
  ['anthropic-key',/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['google-api-key',/\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['slack-token',/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ['slack-webhook',/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g],
  ['stripe-key',/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
  ['npm-token',/\bnpm_[A-Za-z0-9]{36}\b/g],
  ['huggingface-token',/\bhf_[A-Za-z0-9]{30,}\b/g],
  ['telegram-bot-token',/\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
  ['jwt',/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['bearer-token',/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*/g],
  ['basic-auth-header',/\bBasic\s+[A-Za-z0-9+\/]{16,}={0,2}/g],
  ['url-credentials',/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@[^\s]+/gi],
];
// key = value / key: "value" where the key name says it is sensitive
const ASSIGN=/(?<![A-Za-z0-9])([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*(?:(["'`])([^"'`\n]{4,})\2|([^\s"'`,;]{6,}))/gi;
const PLACEHOLDER=/^(?:true|false|null|undefined|none|nil|process\.env|os\.environ|getenv|\$\{|\$\(|\{\{|<|\*{3,}|x{4,}|\.{3}|changeme|change_me|your[_-]|example|placeholder|redacted|\[REDACTED)/i;
const CODEREF=/^(?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)+$|\(|^\[|^\{|^[A-Za-z_$][\w$]*$/; // member access, calls, literals, bare identifiers
export function entropy(s){const m=new Map();for(const c of s)m.set(c,(m.get(c)||0)+1);let h=0;for(const v of m.values()){const p=v/s.length;h-=p*Math.log2(p);}return h;}
const lineOf=(text,idx)=>{let n=1;for(let i=0;i<idx;i++)if(text.charCodeAt(i)===10)n++;return n;};
const mask=s=>s.length<=8?'***':s.slice(0,4)+'…'+s.slice(-2);

export function scanSecrets(text,{minEntropy=3.5}={}){
  const found=[];
  for(const [type,re] of RULES){re.lastIndex=0;let m;while((m=re.exec(text))){found.push({type,start:m.index,end:m.index+m[0].length,value:m[0]});}}
  ASSIGN.lastIndex=0;let m;
  while((m=ASSIGN.exec(text))){
    const quoted=m[3]!==undefined;const v=quoted?m[3]:m[4];
    if(PLACEHOLDER.test(v.trim()))continue;
    if(quoted){if(v.trim().length<4||/\s{2,}/.test(v)&&entropy(v)<3)continue;}
    else{const envStyle=/^[A-Z0-9_.-]+=\S/.test(m[0]);if(!envStyle&&CODEREF.test(v))continue;if(envStyle&&v.length<6)continue;if(!envStyle&&!(/\d/.test(v)||/[^A-Za-z0-9]/.test(v))&&entropy(v)<minEntropy)continue;}
    const start=m.index+m[0].lastIndexOf(v);found.push({type:quoted?'sensitive-assignment':'high-entropy-assignment',start,end:start+v.length,value:v});
  }
  // de-overlap
  found.sort((a,b)=>a.start-b.start||b.end-a.end);const out=[];let lastEnd=-1;
  for(const f of found){if(f.start<lastEnd)continue;out.push(f);lastEnd=f.end;}
  return out.map(f=>({type:f.type,line:lineOf(text,f.start),preview:mask(f.value),start:f.start,end:f.end}));
}
export function redactSecrets(text,findings=scanSecrets(text)){
  // keeps every newline so line numbers of the rest of the file stay valid
  let out='',pos=0;for(const f of findings){const nl=(text.slice(f.start,f.end).match(/\n/g)||[]).length;out+=text.slice(pos,f.start)+`[REDACTED:${f.type}]`+(nl?(`\n[REDACTED:${f.type}]`).repeat(nl):'');pos=f.end;}
  return {text:out+text.slice(pos),count:findings.length,types:[...new Set(findings.map(f=>f.type))]};
}
