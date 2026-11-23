import test from 'node:test';
import assert from 'node:assert/strict';
import {looseJSON,parseTextToolCalls,normalizeName,normalizeArgs,toTextProtocol,textToolPrompt} from '../toolcalls.mjs';

const names=['read_file','write_file','edit_file','run_shell','list_files','search_code','apply_patch','update_plan'];
const tools=names.map(name=>({type:'function',function:{name,description:'d',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'},command:{type:'string'},old_text:{type:'string'},new_text:{type:'string'},startLine:{type:'integer'},regex:{type:'boolean'},pattern:{type:'string'},steps:{type:'array'},note:{type:'string'}},required:[]}}}));

test('looseJSON repairs common model mistakes',()=>{
  assert.deepEqual(looseJSON('{"a": 1,}'),{a:1});
  assert.deepEqual(looseJSON("{'path': 'a.txt', recursive: True}"),{path:'a.txt',recursive:true});
  assert.deepEqual(looseJSON('```json\n{"x": [1, 2,]}\n```'),{x:[1,2]});
  assert.deepEqual(looseJSON('{"content": "line1\nline2"'),{content:'line1\nline2'},'raw newline + unclosed object');
  assert.deepEqual(looseJSON('Sure! {"a": None, // comment\n "b": "\\u0041"}'),{a:null,b:'A'});
  assert.throws(()=>looseJSON('no json here'));
});
test('parses Hermes/Qwen <tool_call> blocks and strips them',()=>{
  const r=parseTextToolCalls('Читаю файл.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.js"}}\n</tool_call>',names);
  assert.equal(r.calls.length,1);assert.equal(r.calls[0].function.name,'read_file');assert.deepEqual(r.calls[0].function.arguments,{path:'a.js'});
  assert.equal(r.cleaned,'Читаю файл.');
});
test('parses unclosed tool_call, multiple calls and Qwen3-coder XML parameters',()=>{
  const r=parseTextToolCalls('<tool_call>{"name":"list_files","arguments":{"path":"."}}</tool_call><tool_call>{"name":"readFile","parameters":{"file_path":"b"}}',names);
  assert.deepEqual(r.calls.map(c=>c.function.name),['list_files','read_file']);
  const x=parseTextToolCalls('<tool_call>\n<function=run_shell>\n<parameter=command>\nnpm test\n</parameter>\n</function>\n</tool_call>',names);
  assert.equal(x.calls[0].function.name,'run_shell');assert.equal(x.calls[0].function.arguments.command,'npm test');
});
test('parses Mistral [TOOL_CALLS], Llama python_tag, harmony and fenced JSON',()=>{
  assert.equal(parseTextToolCalls('[TOOL_CALLS][{"name":"read_file","arguments":{"path":"x"}}]',names).calls[0].function.arguments.path,'x');
  assert.equal(parseTextToolCalls('[TOOL_CALLS]read_file[ARGS]{"path":"y"}',names).calls[0].function.arguments.path,'y');
  assert.equal(parseTextToolCalls('<|python_tag|>{"name": "run_shell", "parameters": {"command": "dir"}}<|eom_id|>',names).calls[0].function.arguments.command,'dir');
  assert.equal(parseTextToolCalls('<|start|>assistant<|channel|>commentary to=functions.list_files <|constrain|>json<|message|>{"path":"."}<|call|>',names).calls[0].function.name,'list_files');
  assert.equal(parseTextToolCalls('Вот вызов:\n```json\n{"name": "search_code", "arguments": {"pattern": "foo"}}\n```',names).calls[0].function.name,'search_code');
  assert.equal(parseTextToolCalls('Пример конфигурации:\n```json\n{"name": "my-app", "version": "1.0.0"}\n```',names).calls.length,0,'ordinary JSON is not a call');
});
test('reports malformed tool calls and ignores unknown tools',()=>{
  const r=parseTextToolCalls('<tool_call>{"name": "delete_everything", "arguments": {}}</tool_call>',names);
  assert.equal(r.calls.length,0);assert.equal(r.malformed,true);
  assert.equal(parseTextToolCalls('Обычный ответ без инструментов.',names).malformed,false);
});
test('normalizes tool names and argument aliases',()=>{
  assert.equal(normalizeName('functions.readFile',names),'read_file');
  assert.equal(normalizeName('bash',names),'run_shell');
  assert.equal(normalizeName('raed_file',names),'read_file');
  assert.equal(normalizeName('completely_unknown',names),null);
  assert.deepEqual(normalizeArgs('edit_file',{file_path:'a',old_string:'x',new_string:'y'},tools),{path:'a',old_text:'x',new_text:'y'});
  assert.deepEqual(normalizeArgs('read_file',{path:'a',startLine:'5'},tools),{path:'a',startLine:5});
  assert.deepEqual(normalizeArgs('update_plan',{steps:'[{"title":"a"}]'},tools),{steps:[{title:'a'}],note:''});
});
test('text protocol conversion keeps the exchange readable for models without tools',()=>{
  const out=toTextProtocol([{role:'system',content:'s'},{role:'assistant',content:'ok',tool_calls:[{id:'1',function:{name:'read_file',arguments:{path:'a'}}}]},{role:'tool',tool_name:'read_file',tool_call_id:'1',content:'{"content":"x"}'}]);
  assert.match(out[1].content,/<tool_call>\n\{"name":"read_file"/);assert.equal(out[1].tool_calls,undefined);
  assert.equal(out[2].role,'user');assert.match(out[2].content,/<tool_result name="read_file">/);
  assert.match(textToolPrompt(tools),/read_file\(path\?: string/);
});
