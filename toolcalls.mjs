// Tolerant tool-call handling for open models: loose JSON, text tool formats, name/argument normalization.
// Everything here is pure (no I/O) so it can be unit-tested.

// Lenient JSON reader: comments, single quotes, unquoted keys, trailing/missing commas,
// Python literals, raw newlines in strings and unclosed brackets at the end of output.
export function looseJSON(input){
  const text=String(input??'').trim();
  try{return JSON.parse(text);}catch{}
  const unfenced=text.replace(/^```[\w-]*\s*\n?/,'').replace(/\n?```\s*$/,'');
  try{return JSON.parse(unfenced);}catch{}
  const start=unfenced.search(/[{[]/);if(start<0)throw Error('JSON не найден');
  const s=unfenced;let i=start;
  const ws=()=>{while(i<s.length){if(/\s/.test(s[i]))i++;else if(s.startsWith('//',i)){while(i<s.length&&s[i]!=='\n')i++;}else if(s.startsWith('/*',i)){const e=s.indexOf('*/',i+2);i=e<0?s.length:e+2;}else break;}};
  const ident=()=>{let j=i;while(j<s.length&&/[\w$.-]/.test(s[j]))j++;const word=s.slice(i,j);i=j;return word;};
  function str(){
    const q=s[i++];let out='';
    while(i<s.length){
      const c=s[i++];
      if(c==='\\'){const n=s[i++];if(n===undefined)break;const map={n:'\n',t:'\t',r:'\r',b:'\b',f:'\f','0':'\0'};
        if(n==='u'&&/^[0-9a-fA-F]{4}$/.test(s.slice(i,i+4))){out+=String.fromCharCode(parseInt(s.slice(i,i+4),16));i+=4;}else out+=map[n]??n;continue;}
      if(c===q)return out;
      out+=c;
    }
    return out;
  }
  function value(){
    ws();if(i>=s.length)throw Error('Неожиданный конец JSON');
    const c=s[i];
    if(c==='{'){
      i++;const obj={};
      while(true){
        ws();if(i>=s.length||s[i]==='}'){i++;return obj;}
        if(s[i]===','){i++;continue;}
        const key=s[i]==='"'||s[i]==="'"?str():ident();
        if(!key){i++;continue;}
        ws();if(s[i]===':'||s[i]==='=')i++;
        ws();if(i>=s.length){obj[key]=null;return obj;}
        obj[key]=value();ws();
        if(s[i]===',')i++;
      }
    }
    if(c==='['){
      i++;const arr=[];
      while(true){ws();if(i>=s.length||s[i]===']'){i++;return arr;}if(s[i]===','){i++;continue;}arr.push(value());}
    }
    if(c==='"'||c==="'")return str();
    const m=/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if(m){i+=m[0].length;return Number(m[0]);}
    const word=ident();
    const literals={true:true,True:true,false:false,False:false,null:null,None:null,undefined:null};
    if(word in literals)return literals[word];
    if(!word)i++;
    return word;
  }
  return value();
}

const NAME_ALIASES={readfile:'read_file',read:'read_file',cat:'read_file',open_file:'read_file',view_file:'read_file',view:'read_file',get_file:'read_file',
  writefile:'write_file',create_file:'write_file',save_file:'write_file',write:'write_file',
  str_replace:'edit_file',str_replace_editor:'edit_file',replace_in_file:'edit_file',edit:'edit_file',replace:'edit_file',
  append:'append_file',append_to_file:'append_file',
  ls:'list_files',list_dir:'list_files',list_directory:'list_files',dir:'list_files',
  shell:'run_shell',bash:'run_shell',powershell:'run_shell',execute_command:'run_shell',run_command:'run_shell',exec:'run_shell',terminal:'run_shell',
  grep:'search_code',search:'search_code',ripgrep:'search_code',rg:'search_code',search_files:'search_code',
  glob:'find_files',find:'find_files',file_search:'find_files',
  patch:'apply_patch',apply_diff:'apply_patch',
  outline:'outline_file',symbols:'outline_file',
  plan:'update_plan',todo_write:'update_plan',finish:'finish_task',done:'finish_task',complete_task:'finish_task'};
function levenshtein(a,b){
  const d=Array.from({length:a.length+1},(_,k)=>[k]);
  for(let j=1;j<=b.length;j++)d[0][j]=j;
  for(let x=1;x<=a.length;x++)for(let y=1;y<=b.length;y++)d[x][y]=Math.min(d[x-1][y]+1,d[x][y-1]+1,d[x-1][y-1]+(a[x-1]===b[y-1]?0:1));
  return d[a.length][b.length];
}
export function normalizeName(raw,names){
  if(typeof raw!=='string')return null;
  if(names.includes(raw))return raw;
  const n=raw.trim().replace(/^(?:functions|function|tools|tool|default_api)[.:]/i,'').replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/[\s-]+/g,'_').toLowerCase();
  if(names.includes(n))return n;
  const alias=NAME_ALIASES[n]??NAME_ALIASES[n.replace(/_/g,'')];
  if(alias&&names.includes(alias))return alias;
  const scored=names.map(name=>[name,levenshtein(n,name)]).sort((a,b)=>a[1]-b[1]);
  if(scored.length&&scored[0][1]<=2&&(scored.length<2||scored[1][1]>scored[0][1]))return scored[0][0];
  return null;
}
const ARG_ALIASES={path:['file_path','filepath','filename','file','target_file','absolute_path','relative_path','path_name','dir_path','directory','folder'],
  command:['cmd','script','commandline','command_line','shell_command'],
  old_text:['old','old_string','oldtext','old_str','search','find','original','old_content','from'],
  new_text:['new','new_string','newtext','new_str','replacement','new_content','to'],
  content:['text','contents','data','body','file_text','file_content','code'],
  cwd:['working_directory','workdir','working_dir','dir'],
  pattern:['query','regex','search_term','term','glob','keyword'],
  patch:['patch_text','diff','input','changes'],
  summary:['message','result','text'],
  name:['project_name','title']};
export function normalizeArgs(name,args,tools){
  const tool=tools.find(t=>t.function.name===name)?.function;
  if(!tool||!args||typeof args!=='object'||Array.isArray(args))return args;
  const props=tool.parameters?.properties||{},out={...args};
  for(const [target,aliases] of Object.entries(ARG_ALIASES)){
    if(!(target in props)||out[target]!==undefined)continue;
    const found=aliases.find(a=>out[a]!==undefined&&!(a in props));
    if(found){out[target]=out[found];delete out[found];}
  }
  for(const [key,spec] of Object.entries(props)){
    const v=out[key];if(v===undefined||v===null){if(v===null)delete out[key];continue;}
    if(spec.type==='integer'&&typeof v==='string'&&/^-?\d+$/.test(v.trim()))out[key]=Number(v);
    if(spec.type==='boolean'&&typeof v==='string')out[key]=/^(true|1|yes|да)$/i.test(v.trim());
    if(spec.type==='string'&&typeof v!=='string'&&key!=='content')out[key]=typeof v==='object'?JSON.stringify(v):String(v);
    if(spec.type==='string'&&key==='content'&&typeof v!=='string')out[key]=typeof v==='object'?JSON.stringify(v,null,2):String(v);
    if((spec.type==='array'||spec.type==='object')&&typeof v==='string'){try{out[key]=looseJSON(v);}catch{}}
  }
  if(name==='list_files'&&out.path===undefined)out.path='.';
  if(name==='update_plan'&&out.note===undefined)out.note='';
  if(name==='verify_project'&&out.artifacts===undefined)out.artifacts=[];
  return out;
}

function callFromObject(obj,names){
  if(!obj||typeof obj!=='object')return null;
  if(obj.function&&typeof obj.function==='object')return callFromObject({...obj.function},names);
  const rawName=obj.name??obj.tool??obj.tool_name??obj.function??obj.action;
  const name=normalizeName(typeof rawName==='string'?rawName:'',names);if(!name)return null;
  let args=obj.arguments??obj.parameters??obj.args??obj.input??obj.params;
  if(typeof args==='string'){try{args=looseJSON(args);}catch{args={};}}
  if(args===undefined){const {name:_n,tool:_t,tool_name:_tn,action:_a,...rest}=obj;args=rest;}
  if(!args||typeof args!=='object'||Array.isArray(args))args={};
  return {function:{name,arguments:args}};
}
function callsFromJSON(text,names){
  let value;try{value=looseJSON(text);}catch{return [];}
  const list=Array.isArray(value)?value:[value];
  return list.map(v=>callFromObject(v,names)).filter(Boolean);
}
function xmlParams(body){
  const args={},re=/<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g;let m;
  while((m=re.exec(body)))args[m[1]]=m[2];
  return args;
}
// Extracts tool calls that a model wrote as text instead of native tool_calls.
export function parseTextToolCalls(text,names){
  const src=String(text||''),found=[];
  const add=(index,end,calls)=>{if(calls.length)found.push({index,end,calls});};
  const taken=(index)=>found.some(f=>index>=f.index&&index<f.end);
  let m;
  const tagged=/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
  while((m=tagged.exec(src))){
    const body=m[1],fn=/^<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/.exec(body.trim());
    if(fn){const name=normalizeName(fn[1],names);if(name)add(m.index,m.index+m[0].length,[{function:{name,arguments:/<parameter=/.test(fn[2])?xmlParams(fn[2]):(()=>{try{return looseJSON(fn[2]);}catch{return {};}})()}}]);}
    else add(m.index,m.index+m[0].length,callsFromJSON(body,names));
    if(!m[0].length)tagged.lastIndex++;
  }
  const fnTag=/<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g;
  while((m=fnTag.exec(src))){if(taken(m.index))continue;const name=normalizeName(m[1],names);if(!name)continue;let args;if(/<parameter=/.test(m[2]))args=xmlParams(m[2]);else{try{args=looseJSON(m[2]);}catch{args={};}}add(m.index,m.index+m[0].length,[{function:{name,arguments:args}}]);}
  const mistral=/\[TOOL_CALLS\]\s*([\s\S]*?)(?=\[TOOL_CALLS\]|$)/g;
  while((m=mistral.exec(src))){
    const body=m[1].trim(),pair=/^([\w.-]+)\s*\[ARGS\]\s*([\s\S]*)$/.exec(body);
    if(pair){const name=normalizeName(pair[1],names);if(name){let args;try{args=looseJSON(pair[2]);}catch{args={};}add(m.index,m.index+m[0].length,[{function:{name,arguments:args}}]);}}
    else add(m.index,m.index+m[0].length,callsFromJSON(body,names));
  }
  const python=/<\|python_tag\|>\s*([\s\S]*?)(?:<\|eom_id\|>|<\|eot_id\|>|$)/g;
  while((m=python.exec(src)))add(m.index,m.index+m[0].length,callsFromJSON(m[1],names));
  const harmony=/to=functions\.([\w-]+)[^\n<]*?(?:<\|constrain\|>\s*json)?\s*<\|message\|>([\s\S]*?)(?:<\|call\|>|<\|end\|>|$)/g;
  while((m=harmony.exec(src))){const name=normalizeName(m[1],names);if(!name)continue;let args;try{args=looseJSON(m[2]);}catch{args={};}add(m.index,m.index+m[0].length,[{function:{name,arguments:args}}]);}
  const fenced=/```[ \t]*(json|tool_call|tool|function_call|tool_code)?[ \t]*\n([\s\S]*?)```/g;
  while((m=fenced.exec(src))){if(taken(m.index))continue;const body=m[2].trim();if(!/^[{[]/.test(body))continue;const calls=callsFromJSON(body,names);
    // Plain ```json blocks are tool calls only when they look exactly like a call.
    if(calls.length&&(m[1]||/"(?:arguments|parameters|args)"\s*:/.test(body)))add(m.index,m.index+m[0].length,calls);}
  if(!found.length){const trimmed=src.trim();if(/^[{[]/.test(trimmed)&&/["']?(?:name|tool)["']?\s*:/.test(trimmed))add(src.indexOf(trimmed),src.length,callsFromJSON(trimmed,names));}
  found.sort((a,b)=>a.index-b.index);
  let cleaned='',pos=0;for(const f of found){if(f.index<pos)continue;cleaned+=src.slice(pos,f.index);pos=f.end;}cleaned+=src.slice(pos);
  const marker=/<tool_call>|\[TOOL_CALLS\]|<\|python_tag\|>|to=functions\.|<function=/.test(src);
  return {calls:found.flatMap(f=>f.calls),cleaned:cleaned.replace(/<\|(?:start|end|channel|message|call|return)\|>/g,'').trim(),malformed:marker&&!found.length};
}

// Text protocol for models without native tool calling.
export function textToolPrompt(tools){
  const lines=tools.map(t=>{const f=t.function,props=f.parameters?.properties||{},req=f.parameters?.required||[];
    const params=Object.entries(props).map(([k,v])=>k+(req.includes(k)?'':'?')+': '+(v.enum?v.enum.join('|'):v.type||'any')).join(', ');
    return '- '+f.name+'('+params+') — '+f.description;});
  return '\n\nTOOLS (text protocol). Native tool calling is unavailable for this model. To call a tool, output exactly one or more blocks and nothing after them:\n<tool_call>\n{"name": "tool_name", "arguments": {"param": "value"}}\n</tool_call>\nUse valid JSON with double quotes; escape newlines inside strings as \\n. Wait for <tool_result> before continuing. When the task is done, answer normally without <tool_call>.\nAvailable tools:\n'+lines.join('\n');
}
export function toolCallSchema(names){
  return {type:'object',properties:{name:{type:'string',enum:names},arguments:{type:'object'}},required:['name','arguments']};
}
// Converts native tool exchanges into plain text messages for the text protocol.
export function toTextProtocol(messages){
  return messages.map(m=>{
    if(m.role==='assistant'&&m.tool_calls?.length){
      const blocks=m.tool_calls.map(c=>'<tool_call>\n'+JSON.stringify({name:c.function?.name,arguments:typeof c.function?.arguments==='string'?looseSafe(c.function.arguments):c.function?.arguments||{}})+'\n</tool_call>').join('\n');
      return {role:'assistant',content:((m.content||'').trim()+'\n'+blocks).trim()};
    }
    if(m.role==='tool')return {role:'user',content:'<tool_result name="'+(m.tool_name||'tool')+'">\n'+m.content+'\n</tool_result>'};
    const {tool_calls,tool_name,tool_call_id,...rest}=m;return rest;
  });
}
function looseSafe(text){try{return looseJSON(text);}catch{return {};}}
