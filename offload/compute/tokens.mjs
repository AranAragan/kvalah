// Token counting without a heavy tokenizer dependency.
import {localFetch} from './netpolicy.mjs';
// 1) Heuristic tuned for BPE tokenizers of open models (Qwen/Llama/Gemma): code & English ≈ 3.5–4 chars/token,
//    Cyrillic/CJK much denser. 2) Self-calibrating: every real call reports prompt_eval_count, and the
//    ratio real/estimated is tracked (EWMA) and applied. 3) Exact counts via llama.cpp `/tokenize` when available.
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
export function heuristicTokens(text){
  if(!text)return 0;
  let ascii=0,cyr=0,cjk=0,other=0,ws=0,punct=0;
  for(const ch of text){
    const c=ch.codePointAt(0);
    if(c===32||c===9||c===10||c===13)ws++;
    else if(c<128){if(/[A-Za-z0-9_]/.test(ch))ascii++;else punct++;}
    else if(c>=0x400&&c<=0x4ff)cyr++;
    else if((c>=0x3040&&c<=0x30ff)||(c>=0x4e00&&c<=0x9fff)||(c>=0xac00&&c<=0xd7af))cjk++;
    else other++;
  }
  // punctuation and newlines are often their own tokens; runs of spaces merge.
  return Math.ceil(ascii/4.2+punct/1.6+ws/6+cyr/2.6+cjk/1.1+other/2);
}
// v0.3 (CTX-01): without an exact tokenizer every count carries a safety margin (+20% until 3 real samples
// calibrated the ratio, then +10%) and is labelled "estimated". With an exact tokenizer, planning still uses the
// fast sync count, but every call is pre-flighted with the exact count; an overflow raises the ratio (bump) so
// the next plan is conservative for this content.
export function createTokenCounter({exact=null}={}){
  let ratio=1,samples=0,exactFailures=0;
  const margin=()=>exact?1:(samples>=3?1.1:1.2);
  return {
    get exactAvailable(){return !!exact&&exactFailures<3;},
    get kind(){return exact&&exactFailures<3?'exact':'estimated';},
    count(text){return Math.ceil(heuristicTokens(text)*ratio*margin());},
    async countExact(text){if(exact&&exactFailures<3){try{return await exact(text);}catch{exactFailures++;}}return this.count(text);},
    // exact count observed above the estimate: never under-plan this content again
    bump(text,exactCount){const h=heuristicTokens(text);if(h>0&&exactCount>0)ratio=Math.max(ratio,clamp(exactCount/h*1.05,0.4,4));},
    // Feed real usage: estimated tokens of the exact prompt text vs prompt_eval_count reported by the server.
    observe(promptText,reportedTokens){
      const est=heuristicTokens(promptText);
      if(!(est>50&&Number.isFinite(reportedTokens)&&reportedTokens>0))return;
      const r=clamp(reportedTokens/est,0.4,2.5);samples++;ratio=samples===1?r:ratio*0.8+r*0.2;
    },
    calibration(){return {ratio:Number(ratio.toFixed(3)),samples,exact:!!exact};}
  };
}
// llama.cpp server: POST {root}/tokenize {content} -> {tokens:[...]}
export function llamaCppTokenizer(base){
  const root=base.replace(/\/v1\/?$/,'');
  const f=localFetch();
  return async text=>{const r=await f(root+'/tokenize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:text}),signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('tokenize '+r.status);const d=await r.json();if(!Array.isArray(d.tokens))throw Error('no tokens');return d.tokens.length;};
}
// Best-effort discovery of the model's context window.
// Ollama: /api/show -> model_info["<arch>.context_length"] (training max) and parameters "num_ctx N" (Modelfile default).
// llama.cpp: /props -> default_generation_settings.n_ctx. LM Studio: /api/v0/models/<id> -> loaded_context_length.
export async function detectContext(provider,model,{fetchImpl=localFetch()}={}){
  const out={modelMax:null,serverCtx:null,source:null};
  try{
    if(provider.kind==='ollama'){
      const r=await fetchImpl(provider.base+'/api/show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model}),signal:AbortSignal.timeout(5000)});
      if(r.ok){const d=await r.json();
        for(const [k,v] of Object.entries(d.model_info||{}))if(/\.context_length$/.test(k)&&Number.isFinite(v))out.modelMax=v;
        const m=/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(d.parameters||'');if(m)out.serverCtx=+m[1];out.source='ollama:/api/show';}
    }else{
      const root=provider.base.replace(/\/v1\/?$/,'');
      let r=await fetchImpl(root+'/props',{signal:AbortSignal.timeout(3000)}).catch(()=>null);
      if(r?.ok){const d=await r.json();const n=d.default_generation_settings?.n_ctx??d.n_ctx;if(Number.isFinite(n)){out.serverCtx=n;out.source='llama.cpp:/props';}}
      if(!out.serverCtx){r=await fetchImpl(root+'/api/v0/models/'+encodeURIComponent(model),{signal:AbortSignal.timeout(3000)}).catch(()=>null);
        if(r?.ok){const d=await r.json();if(Number.isFinite(d.loaded_context_length))out.serverCtx=d.loaded_context_length;if(Number.isFinite(d.max_context_length))out.modelMax=d.max_context_length;out.source='lmstudio:/api/v0';}}
    }
  }catch{}
  return out;
}
// Effective context: what we request (Ollama honours num_ctx per request) capped by the model maximum;
// OpenAI-compatible servers fix n_ctx at load time, so that wins there.
// v0.3: with LAN, plan by the smallest known context among allowed nodes (nodeContexts).
export function effectiveContext({configured,detected={},providerKind,nodeContexts=[]}){
  let ctx=configured;
  if(providerKind!=='ollama'&&detected.serverCtx)ctx=detected.serverCtx;
  if(detected.modelMax)ctx=Math.min(ctx,detected.modelMax);
  for(const n of nodeContexts)if(Number.isFinite(n)&&n>0)ctx=Math.min(ctx,n);
  return ctx;
}
// CACHE-01: model revision for cache keys. Ollama: digest from /api/tags; OpenAI-compatible: model id + owned_by/created.
export async function detectModelDigest(provider,model,{fetchImpl=localFetch()}={}){
  try{
    if(provider.kind==='ollama'){const r=await fetchImpl(provider.base+'/api/tags',{signal:AbortSignal.timeout(3000)});if(r.ok){const m=((await r.json()).models||[]).find(x=>x.name===model||x.name===model+':latest'||x.model===model);if(m?.digest)return m.digest;}}
    else{const r=await fetchImpl(provider.base.replace(/\/+$/,'')+'/models',{signal:AbortSignal.timeout(3000)});if(r.ok){const m=((await r.json()).data||[]).find(x=>x.id===model);if(m)return `${m.id}@${m.created||''}:${m.owned_by||''}`;}}
  }catch{}
  return null;
}
