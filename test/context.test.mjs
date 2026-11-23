import test from 'node:test';
import assert from 'node:assert/strict';
import {compactMessages,truncateResult,groupHistory,digestGroups,estimate} from '../agent-state.mjs';

test('B1: truncated tool results stay valid JSON with an explicit marker',()=>{
  const content='x\n'.repeat(20000);
  const result=JSON.stringify({path:'/p/a.txt',hash:'h',totalLines:20001,startLine:1,endLine:20001,truncated:false,content});
  const t=truncateResult(result,3000);
  const parsed=JSON.parse(t.content);
  assert.equal(parsed.truncated,true);assert.ok(parsed.endLine<20001);assert.match(parsed.notice,/startLine=/);
  assert.equal(t.path,'/p/a.txt');assert.ok(t.content.length<=3000);
  const shell=JSON.parse(truncateResult(JSON.stringify({exitCode:1,output:'start '+'y'.repeat(9000)+' FINAL ERROR'}),2000).content);
  assert.match(shell.output,/FINAL ERROR$/,'shell output keeps its tail');
  assert.equal(JSON.parse(truncateResult('not json '.repeat(500),500).content).truncated,true);
});
test('B1: compaction reports truncated reads so the full-read hash is revoked',()=>{
  const big=JSON.stringify({path:'/p/big.js',hash:'h',totalLines:5000,startLine:1,endLine:5000,truncated:false,content:'line\n'.repeat(5000)});
  const msgs=[{role:'system',content:'sys'},{role:'user',content:'go'},{role:'assistant',content:'',tool_calls:[{function:{name:'read_file',arguments:{path:'big.js'}}}]},{role:'tool',tool_name:'read_file',content:big}];
  const revoked=[];const out=compactMessages(msgs,8192,[],{},{onTruncate:p=>revoked.push(p)});
  assert.deepEqual(revoked,['/p/big.js']);
  const tool=out.find(m=>m.role==='tool');
  const json=tool.content.slice(0,tool.content.indexOf('\n\n[kvalah')>0?tool.content.indexOf('\n\n[kvalah'):undefined);
  assert.equal(JSON.parse(json).truncated,true);
});
test('B3: interrupted steps keep synthetic results instead of disappearing',()=>{
  const groups=groupHistory([{role:'user',content:'u'},{role:'assistant',content:'',tool_calls:[{id:'a',function:{name:'write_file',arguments:{}}},{id:'b',function:{name:'run_shell',arguments:{}}}]},{role:'tool',tool_name:'write_file',content:'{"saved":"x"}'}]);
  assert.equal(groups.length,2);assert.equal(groups[1].length,3);assert.match(groups[1][2].content,/skipped/);
});
test('B2: trimming keeps a contiguous tail and replaces older history with a digest',()=>{
  const msgs=[{role:'system',content:'sys'}];
  for(let i=0;i<40;i++){msgs.push({role:'user',content:'задача '+i+' '+'подробности '.repeat(60)});msgs.push({role:'assistant',content:'ответ '+i+' '+'текст '.repeat(80)});}
  msgs.push({role:'user',content:'последний вопрос'});
  const out=compactMessages(msgs,8192,[],{});
  assert.equal(out[0].content,'sys');
  assert.match(out[1].content,/Сводка более ранней части разговора/);
  const kept=out.slice(2).map(m=>m.content.match(/(?:задача|ответ) (\d+)/)?.[1]).filter(Boolean).map(Number);
  for(let i=1;i<kept.length;i++)assert.ok(kept[i]-kept[i-1]<=1,'no gaps: '+kept.join(','));
  assert.match(out.at(-1).content,/^последний вопрос/);
  assert.ok(estimate(out)<8192);
});
test('volatile task state is appended to the last message, system prompt stays stable',()=>{
  const chat={project:{path:'/p'},workflow:{phase:'implement',goal:'g',contract:{},steps:[],revision:3,changes:[],checks:[]},taskMemory:[{name:'read_file',args:'{}',failed:false,count:0,result:'{}'}]};
  const a=compactMessages([{role:'system',content:'S'},{role:'user',content:'hi'}],16384,[],chat);
  chat.workflow.revision=4;
  const b=compactMessages([{role:'system',content:'S'},{role:'user',content:'hi'},{role:'assistant',content:'',tool_calls:[{function:{name:'list_files',arguments:{}}}]},{role:'tool',content:'[]'}],16384,[],chat);
  assert.equal(a[0].content,b[0].content);assert.doesNotMatch(a[0].content,/revision/);
  assert.match(b.at(-1).content,/"revision":4/);assert.equal(b[1].content,'hi');
});
test('digest summarizes tool outcomes',()=>{
  const text=digestGroups([[{role:'assistant',tool_calls:[{function:{name:'run_shell',arguments:{command:'npm test'}}}]},{role:'tool',content:'{"exitCode":1,"output":"1 failing"}'}]],500);
  assert.match(text,/run_shell\(command="npm test"\) → код 1: 1 failing/);
});
