// Vendored verbatim from kvalah v0.9.0 (MIT, (c) Enver Abdullaev) for standalone use. In overlay mode the repo copy is used instead.
// Node registry for "Distribute tasks": other machines running kvalah (paired) or a bare
// Ollama / OpenAI-compatible endpoint. Tracks health, models, latency and load.
// The registry is transport-agnostic: providerFor(node) returns a providers.mjs-style backend.
import {randomUUID} from 'node:crypto';

export const NODE_KINDS=['kvalah','ollama','openai'];
const LINK_TYPES=['thunderbolt','ethernet','wifi','vpn','other'];
export function normalizeLinks(list){
  const out=[],seen=new Set();
  for(const l of Array.isArray(list)?list:[]){
    const url=String(l?.url||'').replace(/\/+$/,'');
    if(!/^http:\/\/[0-9.]+:\d+$/.test(url)||seen.has(url))continue;
    seen.add(url);out.push({url,type:LINK_TYPES.includes(l.type)?l.type:'other'});
    if(out.length>=8)break;
  }
  return out;
}
const clamp=(v,min,max,def)=>{const n=Number(v);return Number.isFinite(n)?Math.min(max,Math.max(min,Math.round(n))):def;};

export function normalizeNode(input,previous={}){
  const n={...previous,...input};
  if(!NODE_KINDS.includes(n.kind))throw Error('Unknown device type');
  const url=String(n.url||'').trim().replace(/\/+$/,'');
  let parsed;try{parsed=new URL(url);}catch{throw Error('Invalid device address');}
  if(!/^https?:$/.test(parsed.protocol))throw Error('Invalid device address');
  return {
    id:typeof n.id==='string'&&/^[a-zA-Z0-9-]{8,64}$/.test(n.id)?n.id:randomUUID(),
    name:String(n.name||parsed.hostname).replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,64)||parsed.hostname,
    kind:n.kind,url,
    token:typeof n.token==='string'?n.token:'',
    apiKey:typeof n.apiKey==='string'?n.apiKey:'',
    backend:['ollama','openai'].includes(n.backend)?n.backend:(n.kind==='openai'?'openai':'ollama'),
    enabled:n.enabled!==false,
    tasks:n.tasks!==false,
    memory:n.kind==='kvalah'&&n.memory===true,
    model:typeof n.model==='string'?n.model.slice(0,200):'',
    maxParallel:clamp(n.maxParallel,1,8,1),
    // Paired kvalah devices can be reachable over several links (Thunderbolt, Ethernet, Wi-Fi).
    links:n.kind==='kvalah'?normalizeLinks(n.links):[],
    link:LINK_TYPES.includes(n.link)?n.link:'',
    added:Number(n.added)||Date.now()
  };
}
// Ollama names are equal with or without the implicit ":latest" tag.
export const sameModel=(a,b)=>{const x=String(a||''),y=String(b||'');return x===y||x.replace(/:latest$/,'')===y.replace(/:latest$/,'');};

export function createRegistry({providerFor,now=Date.now,timeoutMs=8000,offlineAfter=3}={}){
  const nodes=new Map();
  const status=id=>nodes.get(id)?.status;
  const blank=()=>({online:null,latencyMs:null,ewmaMs:null,models:[],error:'',checkedAt:0,inflight:0,ok:0,failed:0,consecutiveFailures:0,info:null});
  const api={
    add(config){const node=normalizeNode(config);const old=nodes.get(node.id);nodes.set(node.id,{...node,status:old?.status||blank()});return api.get(node.id);},
    update(id,patch){const old=nodes.get(id);if(!old)throw Error('Device not found');const {status:s,...config}=old;nodes.set(id,{...normalizeNode({...patch,id,kind:old.kind},config),status:s});return api.get(id);},
    remove(id){return nodes.delete(id);},
    get(id){return nodes.get(id)||null;},
    providerForNode:node=>providerFor(node),
    list(){return [...nodes.values()];},
    serialize(){return api.list().map(({status:s,...config})=>config);},
    load(list){nodes.clear();for(const c of list||[]){try{api.add(c);}catch{}}},
    // Model to use on a node for a requested model: its own pinned model, else the same name, else none.
    modelFor(node,model){
      const models=node.status?.models||[];
      if(node.model&&(!models.length||models.some(m=>sameModel(m,node.model))))return node.model;
      const hit=models.find(m=>sameModel(m,model));
      return hit||null;
    },
    available(node,model){return node.enabled&&node.tasks&&node.status.online===true&&!!api.modelFor(node,model);},
    async check(id){
      const node=nodes.get(id);if(!node)return null;
      const started=now();
      try{
        const backend=providerFor(node);
        let timer;
        const result=await Promise.race([
          backend.probe?backend.probe():backend.models().then(models=>({models:models.map(m=>m.name)})),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),timeoutMs);})
        ]).finally(()=>clearTimeout(timer));
        const ms=Math.max(0,now()-started),s=node.status;
        s.online=true;s.error='';s.latencyMs=ms;s.ewmaMs=s.ewmaMs==null?ms:Math.round(s.ewmaMs*0.7+ms*0.3);
        s.models=(result.models||[]).map(String);s.info=result.info||null;s.consecutiveFailures=0;
        if(result.backend&&['ollama','openai'].includes(result.backend))node.backend=result.backend;
      }catch(e){const s=node.status;s.online=false;s.error=String(e.message||e).slice(0,300);}
      node.status.checkedAt=now();
      return api.get(id);
    },
    async checkAll(){await Promise.all(api.list().filter(n=>n.enabled).map(n=>api.check(n.id)));return api.list();},
    begin(id){const s=status(id);if(s)s.inflight++;},
    end(id,{ok,ms}={}){
      const s=status(id);if(!s)return;
      s.inflight=Math.max(0,s.inflight-1);
      if(ok){s.ok++;s.consecutiveFailures=0;if(Number.isFinite(ms))s.ewmaMs=s.ewmaMs==null?ms:Math.round(s.ewmaMs*0.7+ms*0.3);}
      else{s.failed++;s.consecutiveFailures++;if(s.consecutiveFailures>=offlineAfter){s.online=false;s.error=s.error||'too many failures';}}
    },
    publicList(){return api.list().map(({token,apiKey,status:s,...config})=>({...config,paired:!!token,apiKeySet:!!apiKey,status:{...s}}));}
  };
  return api;
}
