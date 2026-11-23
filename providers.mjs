import {tr} from './i18n.mjs';
// Model backends: Ollama native API and any OpenAI-compatible server
// (llama.cpp llama-server, LM Studio, vLLM, SGLang, Jan, OpenRouter...). Both yield the same events.

const timeoutSignal=(signal,ms)=>signal?AbortSignal.any([signal,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms);
async function request(url,options,label){
  try{return await fetch(url,options);}
  catch(e){if(e.name==='AbortError'||e.name==='TimeoutError')throw e;throw Error(tr('prov.unreachable',{name:label,url:url.replace(/\/[^/]*$/,''),error:e.message}));}
}
async function* lines(body){
  const reader=body.getReader(),decoder=new TextDecoder();let carry='';
  while(true){const {value,done}=await reader.read();if(done)break;carry+=decoder.decode(value,{stream:true});let p;while((p=carry.indexOf('\n'))>=0){const line=carry.slice(0,p).replace(/\r$/,'');carry=carry.slice(p+1);yield line;}}
  carry+=decoder.decode();if(carry.trim())yield carry;
}
function imageMime(b64){return b64.startsWith('iVBOR')?'image/png':b64.startsWith('UklGR')?'image/webp':b64.startsWith('R0lGOD')?'image/gif':'image/jpeg';}
const argsObject=a=>{if(a&&typeof a==='object')return a;try{return JSON.parse(a||'{}');}catch{return {};}};

export function ollamaProvider(baseUrl='http://127.0.0.1:11434'){
  const base=baseUrl.replace(/\/+$/,'');
  const call=(route,options={})=>request(base+route,{...options,signal:options.signal||AbortSignal.timeout(10000)},'Ollama').catch(e=>{if(e.name==='TimeoutError')throw Error(tr('prov.ollamaTimeout',{url:base}));throw e;});
  return {
    kind:'ollama',label:'Ollama',base,
    async models(){const r=await call('/api/tags');if(!r.ok)throw Error(tr('prov.ollamaModels'));const data=await r.json();return (data.models||[]).map(m=>({name:m.name,size:m.size}));},
    async capabilities(model){const r=await call('/api/show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model})});if(!r.ok)throw Error(tr('prov.modelInfo',{model}));return (await r.json()).capabilities||[];},
    async health(){const r=await call('/api/ps');const data=r.ok?await r.json():{};return {online:r.ok,running:(data.models||[]).map(m=>({name:m.name,size:m.size,vram:m.size_vram,context:m.context_length}))};},
    async *chat({model,messages,tools,think,options,format,signal,keepAlive='5m'}){
      const payload={model,messages:messages.map(m=>{const out={role:m.role,content:m.content||''};if(m.images?.length)out.images=m.images;if(m.tool_calls?.length)out.tool_calls=m.tool_calls.map(c=>({function:{name:c.function?.name,arguments:argsObject(c.function?.arguments)}}));if(m.role==='tool'&&m.tool_name)out.tool_name=m.tool_name;return out;}),stream:true,options:{num_ctx:options.context,num_predict:options.maxTokens,temperature:options.temperature},keep_alive:keepAlive};
      if(think!==undefined)payload.think=think;
      if(tools?.length)payload.tools=tools;
      if(format)payload.format=format;
      const r=await request(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:timeoutSignal(signal,10*60*1000)},'Ollama');
      if(!r.ok)throw Error((await r.text()).slice(0,500));
      let finished=false;
      for await(const line of lines(r.body)){
        if(!line.trim())continue;const data=JSON.parse(line);if(data.error)throw Error(data.error);
        const m=data.message||{};
        if(m.thinking)yield {type:'thinking',text:m.thinking};
        if(m.content)yield {type:'content',text:m.content};
        if(m.tool_calls?.length)yield {type:'tool_calls',calls:m.tool_calls};
        if(data.done){finished=true;yield {type:'done',reason:data.done_reason==='length'?'length':'stop',stats:{tokens:data.eval_count,evalSeconds:data.eval_duration?data.eval_duration/1e9:null,promptTokens:data.prompt_eval_count,seconds:(data.total_duration||0)/1e9}};}
      }
      if(!finished)throw Error(tr('prov.ollamaStream'));
    }
  };
}

export function openaiProvider(baseUrl='http://127.0.0.1:8080/v1',apiKey=''){
  const base=baseUrl.replace(/\/+$/,'').replace(/\/chat\/completions$/,'');
  const headers=()=>({'Content-Type':'application/json',...(apiKey?{Authorization:'Bearer '+apiKey}:{})});
  async function models(){
    let r;try{r=await request(base+'/models',{headers:headers(),signal:AbortSignal.timeout(10000)},tr('prov.openaiName'));}
    catch(e){if(e.name==='TimeoutError')throw Error(tr('prov.serverTimeout',{url:base}));throw e;}
    if(!r.ok)throw Error(tr('prov.serverModels',{url:base,status:r.status}));
    const data=await r.json();return (data.data||data.models||[]).map(m=>({name:m.id||m.name,size:m.size}));
  }
  return {
    kind:'openai',label:tr('prov.openaiName'),base,models,
    async capabilities(){return ['tools','vision'];},
    async health(){try{const list=await models();return {online:true,running:[],models:list.length};}catch(e){return {online:false,error:e.message};}},
    async *chat({model,messages,tools,options,format,signal}){
      const converted=messages.map(m=>{
        if(m.role==='tool')return {role:'tool',tool_call_id:m.tool_call_id||'call_0',content:m.content||''};
        if(m.role==='assistant'&&m.tool_calls?.length)return {role:'assistant',content:m.content||null,tool_calls:m.tool_calls.map((c,i)=>({id:c.id||'call_'+i,type:'function',function:{name:c.function?.name,arguments:typeof c.function?.arguments==='string'?c.function.arguments:JSON.stringify(c.function?.arguments||{})}}))};
        if(m.images?.length)return {role:m.role,content:[{type:'text',text:m.content||''},...m.images.map(b=>({type:'image_url',image_url:{url:'data:'+imageMime(b)+';base64,'+b}}))]};
        return {role:m.role,content:m.content||''};
      });
      const body={model,messages:converted,stream:true,stream_options:{include_usage:true},max_tokens:options.maxTokens,temperature:options.temperature};
      if(tools?.length){body.tools=tools;body.tool_choice='auto';}
      if(format)body.response_format={type:'json_schema',json_schema:{name:'tool_call',schema:format}};
      const started=Date.now();
      let r=await request(base+'/chat/completions',{method:'POST',headers:headers(),body:JSON.stringify(body),signal:timeoutSignal(signal,10*60*1000)},tr('prov.openaiName'));
      if(r.status===400){
        const text=await r.text();
        if(/stream_options|response_format|json_schema/i.test(text)){delete body.stream_options;delete body.response_format;r=await request(base+'/chat/completions',{method:'POST',headers:headers(),body:JSON.stringify(body),signal:timeoutSignal(signal,10*60*1000)},tr('prov.openaiName'));}
        else throw Error((/tool/i.test(text)?tr('prov.toolsRejected')+' ':'')+text.slice(0,500));
      }
      if(!r.ok)throw Error(tr('prov.serverError',{status:r.status,text:(await r.text()).slice(0,500)}));
      const calls=[];let reason=null,usage=null,first=null,sawDone=false;
      for await(const line of lines(r.body)){
        if(!line.startsWith('data:'))continue;const raw=line.slice(5).trim();
        if(raw==='[DONE]'){sawDone=true;break;}
        let data;try{data=JSON.parse(raw);}catch{continue;}
        if(data.error)throw Error(data.error.message||JSON.stringify(data.error));
        if(data.usage)usage=data.usage;
        const choice=data.choices?.[0];if(!choice)continue;
        const d=choice.delta||choice.message||{};
        const thinking=d.reasoning_content??d.reasoning;
        if(thinking){first??=Date.now();yield {type:'thinking',text:thinking};}
        if(d.content){first??=Date.now();yield {type:'content',text:d.content};}
        for(const t of d.tool_calls||[]){const k=t.index??calls.length;calls[k]??={id:t.id,function:{name:'',arguments:''}};if(t.id)calls[k].id=t.id;if(t.function?.name)calls[k].function.name+=t.function.name;if(t.function?.arguments!==undefined)calls[k].function.arguments+=typeof t.function.arguments==='string'?t.function.arguments:JSON.stringify(t.function.arguments);}
        if(choice.finish_reason)reason=choice.finish_reason;
      }
      if(!reason&&!sawDone)throw Error(tr('prov.serverStream'));
      const list=calls.filter(Boolean);if(list.length)yield {type:'tool_calls',calls:list};
      const seconds=(Date.now()-started)/1000,gen=first?(Date.now()-first)/1000:null;
      yield {type:'done',reason:reason==='length'?'length':'stop',stats:{tokens:usage?.completion_tokens,evalSeconds:gen,promptTokens:usage?.prompt_tokens,seconds}};
    }
  };
}
export function createProvider(settings){
  if(settings.provider==='openai')return openaiProvider(settings.baseUrl||'http://127.0.0.1:8080/v1',settings.apiKey||'');
  return ollamaProvider(settings.ollamaUrl||process.env.OLLAMA_URL||'http://127.0.0.1:11434');
}
