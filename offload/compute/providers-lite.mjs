// Minimal Ollama / OpenAI-compatible providers with the same event contract as kvalah's providers.mjs
// (content | thinking | tool_calls | done{reason,stats{tokens,promptTokens}}). Used when not overlaid into kvalah.
const timeoutSignal=(signal,ms)=>signal?AbortSignal.any([signal,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms);
async function* lines(body){
  const reader=body.getReader(),decoder=new TextDecoder();let carry='';
  while(true){const {value,done}=await reader.read();if(done)break;carry+=decoder.decode(value,{stream:true});let p;while((p=carry.indexOf('\n'))>=0){const line=carry.slice(0,p).replace(/\r$/,'');carry=carry.slice(p+1);yield line;}}
  carry+=decoder.decode();if(carry.trim())yield carry;
}
// v0.3 (SEC-03): fetch is injectable (LAN passes a guarded fetch); cloud-backed models are hidden in local-only mode
export const isCloudModel=m=>/(-|:)cloud$/i.test(String(m?.name??m))||!!m?.remote_host;
// v0.4 SEC-04: error messages show origin + path only (no user:password@, no query string)
export const safeUrl=u=>{try{const x=new URL(u);return x.protocol+'//'+x.host+x.pathname;}catch{return '[invalid url]';}};
const req=async(url,opt,label,fetchImpl=fetch)=>{try{return await fetchImpl(url,opt);}catch(e){if(e.name==='AbortError'||e.name==='TimeoutError')throw e;if(e.name==='NetPolicyError')throw e;throw Error(`${label} unreachable at ${safeUrl(url)}: ${String(e.message).split(String(url)).join(safeUrl(url))}`);}};

export function ollamaProvider(baseUrl='http://127.0.0.1:11434',{headers:extra={},label='Ollama',fetchImpl=fetch,localOnly=false}={}){
  const base=baseUrl.replace(/\/+$/,'');
  const rq=(u,o,l)=>req(u,o,l,fetchImpl);
  return {kind:'ollama',label,base,
    async models(){const r=await rq(base+'/api/tags',{headers:extra,signal:AbortSignal.timeout(10000)},label);if(!r.ok)throw Error('Ollama models: HTTP '+r.status);return ((await r.json()).models||[]).filter(m=>!(localOnly&&isCloudModel(m))).map(m=>({name:m.name,size:m.size}));},
    async health(){const r=await rq(base+'/api/ps',{headers:extra,signal:AbortSignal.timeout(10000)},label);const d=r.ok?await r.json():{};return {online:r.ok,running:(d.models||[]).map(m=>({name:m.name,size:m.size,vram:m.size_vram,context:m.context_length}))};},
    async *chat({model,messages,think,options={},format,signal,keepAlive='5m'}){
      const payload={model,messages:messages.map(m=>({role:m.role,content:m.content||''})),stream:true,options:{num_ctx:options.context,num_predict:options.maxTokens,temperature:options.temperature},keep_alive:keepAlive};
      if(think!==undefined)payload.think=think;if(format)payload.format=format;
      if(localOnly&&isCloudModel(model))throw Object.assign(Error('Cloud-backed model refused in local-only mode: '+model),{fatal:true});
      const r=await rq(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(payload),signal:timeoutSignal(signal,600000)},label);
      if(!r.ok)throw Error((await r.text()).slice(0,500));
      let finished=false;
      for await(const line of lines(r.body)){
        if(!line.trim())continue;const d=JSON.parse(line);if(d.error)throw Error(d.error);
        const m=d.message||{};if(m.thinking)yield {type:'thinking',text:m.thinking};if(m.content)yield {type:'content',text:m.content};
        if(m.tool_calls?.length)yield {type:'tool_calls',calls:m.tool_calls};
        if(d.done){finished=true;yield {type:'done',reason:d.done_reason==='length'?'length':'stop',stats:{tokens:d.eval_count,promptTokens:d.prompt_eval_count,seconds:(d.total_duration||0)/1e9}};}
      }
      if(!finished)throw Error('Ollama stream ended early');
    }};
}
export function openaiProvider(baseUrl='http://127.0.0.1:8080/v1',apiKey='',{headers:extra={},fetchImpl=fetch,localOnly=false}={}){
  const rq=(u,o,l)=>req(u,o,l,fetchImpl);
  const base=baseUrl.replace(/\/+$/,'').replace(/\/chat\/completions$/,'');
  const headers=()=>({'Content-Type':'application/json',...(apiKey?{Authorization:'Bearer '+apiKey}:{}),...extra});
  async function models(){const r=await rq(base+'/models',{headers:headers(),signal:AbortSignal.timeout(10000)},'server');if(!r.ok)throw Error('models: HTTP '+r.status);const d=await r.json();return (d.data||d.models||[]).map(m=>({name:m.id||m.name})).filter(m=>!(localOnly&&isCloudModel(m)));}
  return {kind:'openai',label:'OpenAI-compatible',base,models,
    async health(){try{return {online:true,running:[],models:(await models()).length};}catch(e){return {online:false,error:e.message};}},
    async *chat({model,messages,options={},format,signal}){
      const body={model,messages:messages.map(m=>({role:m.role,content:m.content||''})),stream:true,stream_options:{include_usage:true},max_tokens:options.maxTokens,temperature:options.temperature};
      if(format)body.response_format={type:'json_schema',json_schema:{name:'result',schema:format}};
      if(localOnly&&isCloudModel(model))throw Object.assign(Error('Cloud-backed model refused in local-only mode: '+model),{fatal:true});
      let r=await rq(base+'/chat/completions',{method:'POST',headers:headers(),body:JSON.stringify(body),signal:timeoutSignal(signal,600000)},'server');
      if(r.status===400){const t=await r.text();if(/stream_options|response_format|json_schema/i.test(t)){delete body.stream_options;delete body.response_format;r=await rq(base+'/chat/completions',{method:'POST',headers:headers(),body:JSON.stringify(body),signal:timeoutSignal(signal,600000)},'server');}else throw Error(t.slice(0,500));}
      if(!r.ok)throw Error('HTTP '+r.status+' '+(await r.text()).slice(0,300));
      let reason=null,usage=null,sawDone=false;
      for await(const line of lines(r.body)){
        if(!line.startsWith('data:'))continue;const raw=line.slice(5).trim();if(raw==='[DONE]'){sawDone=true;break;}
        let d;try{d=JSON.parse(raw);}catch{continue;}if(d.error)throw Error(d.error.message||JSON.stringify(d.error));
        if(d.usage)usage=d.usage;const c=d.choices?.[0];if(!c)continue;const delta=c.delta||c.message||{};
        const th=delta.reasoning_content??delta.reasoning;if(th)yield {type:'thinking',text:th};if(delta.content)yield {type:'content',text:delta.content};
        if(delta.tool_calls?.length)yield {type:'tool_calls',calls:delta.tool_calls};if(c.finish_reason)reason=c.finish_reason;
      }
      if(!reason&&!sawDone)throw Error('stream ended early');
      yield {type:'done',reason:reason==='length'?'length':'stop',stats:{tokens:usage?.completion_tokens,promptTokens:usage?.prompt_tokens}};
    }};
}
