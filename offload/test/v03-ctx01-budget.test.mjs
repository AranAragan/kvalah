// CTX-01 regression: no formed call may exceed the context window measured by the test tokenizer
// (system + user + wrappers + schema + chat template + output reserve). Without an exact tokenizer the
// response is explicitly marked as estimated.
import test from 'node:test';
import assert from 'node:assert/strict';
import {workspace,engine} from './helpers.mjs';
import {createTokenCounter,heuristicTokens,effectiveContext} from '../compute/tokens.mjs';

// A test tokenizer that disagrees with the heuristic (denser on code/punctuation/non-Latin text).
const harsh=s=>{let n=0;for(const m of String(s).matchAll(/[A-Za-z]{1,3}|\d|\s+|[\u0400-\u04ff]{1,2}|[^\sA-Za-z\d\u0400-\u04ff]/gu))n++;return n;};
const TEMPLATE=12; // per-message chat template overhead of the "server"
function strictProvider(tok,{schemaInPrompt=true}={}){
  const calls=[];
  return {kind:'mock',base:'mock://strict',calls,health:async()=>({online:true}),
    async *chat(req){
      const [sys,user]=req.messages.map(m=>m.content);
      const prompt=tok(sys)+tok(user)+2*TEMPLATE+(schemaInPrompt&&req.format?tok(JSON.stringify(req.format)):0);
      const total=prompt+req.options.maxTokens;calls.push({prompt,total,ctx:req.options.context});
      if(total>req.options.context)throw Object.assign(Error(`overflow ${total} > ${req.options.context}`),{fatal:true});
      const isMap=/extract facts from one chunk/.test(sys);
      const text=isMap?'NOTE: seen':JSON.stringify({summary:'ok',draft:'',findings:[],uncertainty:''});
      yield {type:'content',text};yield {type:'done',reason:'stop',stats:{promptTokens:prompt,tokens:5}};
    }};
}
const cjk='数据处理系统错误日志分析报告'.repeat(400);
const cyr='Ошибка подключения к базе данных при старте сервиса '.repeat(300);
const code=Array.from({length:600},(_,i)=>`export const f${i}=(a,b)=>{return a[${i}]??b?.x||{k:${i}}};`).join('\n');
const emoji='🚀✨🔥 deploy ok 👍 '.repeat(800);
const longLine='x=['+Array.from({length:30000},(_,i)=>i%97).join(',')+'];';
const files={'cjk.txt':cjk,'cyr.txt':cyr,'code.js':code,'emoji.txt':emoji,'min.js':longLine};
const maxInstr='Summarize. '+'Focus on correctness and list every risk. '.repeat(90);

for(const [label,mk] of [
  ['exact tokenizer (llama.cpp-style)',()=>({tok:harsh,counter:createTokenCounter({exact:async t=>harsh(t)})})],
  ['estimated (no exact tokenizer, real tokenizer 15% denser than the heuristic)',()=>{const tok=s=>Math.ceil(heuristicTokens(s)*1.15);return {tok,counter:createTokenCounter()};}],
]){
  test(`CTX-01 ${label}: no call exceeds the window — long line, Unicode, CJK, code, several files, max instruction, small ctx`, async()=>{
    const root=await workspace(files);
    for(const ctxTokens of [2048,4096]){
      const {tok,counter}=mk();const p=strictProvider(tok);
      const e=engine({root,provider:p,counter,ctxTokens,maxTokens:256,maxChunks:400});
      for(const [paths,kind,extra] of [[['min.js'],'summarize',{}],[['cjk.txt','cyr.txt'],'logs',{}],[['code.js'],'review',{query:'export const f42'}],[['emoji.txt','code.js','cyr.txt'],'summarize',{}],[['code.js'],'summarize',{instruction:maxInstr}]]){
        if(extra.instruction===maxInstr&&ctxTokens===2048){ // the instruction alone does not fit: explicit refusal
          await assert.rejects(()=>e.delegate({kind,instruction:'x',paths,...extra}),/context/i);continue;}
        const r=await e.delegate({kind,instruction:'Summarize the data',paths,...extra});
        assert.ok(p.calls.length>0);
        for(const c of p.calls)assert.ok(c.total<=c.ctx,`${label} ctx=${ctxTokens} ${paths}: call ${c.total} > ${c.ctx}`);
        assert.ok(['exact','estimated'].includes(r.coverage.tokenCount),'token count must be labelled');
        if(r.coverage.tokenCount==='estimated')assert.ok(r.checks.warnings.includes('token-count-estimated')||r.coverage.warnings?.some(w=>/estimat/i.test(w)),'missing estimated warning');
      }
    }
  });
}

test('CTX-01: explicit refusal instead of hidden truncation when the fixed part alone cannot fit', async()=>{
  const root=await workspace({'a.txt':'hello'});
  const e=engine({root,provider:strictProvider(harsh),counter:createTokenCounter({exact:async t=>harsh(t)}),ctxTokens:2048,maxTokens:1900});
  await assert.rejects(()=>e.delegate({kind:'summarize',instruction:maxInstr,paths:['a.txt']}),/context|budget|exceed/i);
});

test('CTX-01: LAN planning uses the smallest context among allowed nodes', ()=>{
  assert.equal(effectiveContext({configured:16384,detected:{},providerKind:'ollama',nodeContexts:[8192,32768]}),8192);
  assert.equal(effectiveContext({configured:16384,detected:{modelMax:4096},providerKind:'ollama',nodeContexts:[8192]}),4096);
  assert.equal(effectiveContext({configured:16384,detected:{},providerKind:'ollama',nodeContexts:[]}),16384);
});
