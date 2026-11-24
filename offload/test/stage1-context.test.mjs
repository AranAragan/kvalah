import test from 'node:test';
import assert from 'node:assert/strict';
import {heuristicTokens,createTokenCounter,detectContext,effectiveContext} from '../compute/tokens.mjs';
import {chunkText} from '../compute/chunk.mjs';
import {createBM25,terms} from '../compute/bm25.mjs';
import {smartMock,workspace,engine,bigLog} from './helpers.mjs';

test('heuristic tokens: code ≈ 3–5 chars/token, Cyrillic denser',()=>{
  const code='export function computeTotal(items) {\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\n'.repeat(20);
  const ratio=code.length/heuristicTokens(code);assert.ok(ratio>2.5&&ratio<5,'ratio '+ratio);
  const ru='Локальная модель обрабатывает длинные журналы и возвращает краткое резюме. '.repeat(20);
  assert.ok(ru.length/heuristicTokens(ru)<3.2);
});
test('counter self-calibrates from reported prompt_eval_count',()=>{
  const c=createTokenCounter();const text='x '.repeat(2000);const base=c.count(text);
  for(let i=0;i<20;i++)c.observe(text,Math.round(heuristicTokens(text)*1.5));
  // v0.3 (CTX-01): estimated counts carry a +10% margin once calibrated (+20% before)
  assert.ok(base>=heuristicTokens(text)*1.2-1);assert.ok(Math.abs(c.count(text)/heuristicTokens(text)-1.5*1.1)<0.05);assert.equal(c.calibration().samples,20);
});
test('detectContext reads Ollama /api/show and effectiveContext caps it',async()=>{
  const fetchImpl=async(url,opt)=>({ok:true,json:async()=>({model_info:{'qwen3.context_length':40960},parameters:'temperature 0.6\nnum_ctx 8192'})});
  const d=await detectContext({kind:'ollama',base:'http://x'},'m',{fetchImpl});
  assert.equal(d.modelMax,40960);assert.equal(d.serverCtx,8192);
  assert.equal(effectiveContext({configured:65536,detected:d,providerKind:'ollama'}),40960);
  assert.equal(effectiveContext({configured:16384,detected:{serverCtx:4096},providerKind:'openai'}),4096);
});
test('chunkText: full coverage, budget respected, giant lines split',()=>{
  const text=bigLog({lines:3000})+'\n'+'A'.repeat(50000);
  const count=heuristicTokens;const chunks=chunkText(text,{maxTokens:1000,count});
  assert.equal(chunks.map(c=>c.text).join('\n'),text.replace(/A{50000}$/,m=>chunks.filter(c=>c.partial).map(c=>c.text).join('\n')));
  assert.ok(chunks.every(c=>c.tokens<=1000),'budget');
  const lines=chunks.filter(c=>!c.partial);assert.equal(lines[0].startLine,1);
  for(let i=1;i<lines.length;i++)assert.equal(lines[i].startLine,lines[i-1].endLine+1);
  assert.ok(chunks.filter(c=>c.partial).length>=2);
});
test('BM25 ranks the relevant chunk first; identifiers are split',()=>{
  assert.deepEqual(terms('parseUserConfig snake_case'),['parseuserconfig','parse','user','config','snake_case','snake','case']);
  const docs=[{text:'function renderButton() { return html }'},{text:'export function parseUserConfig(path) { readFile(path) }'},{text:'const unrelated = 42'}];
  assert.equal(createBM25(docs).rank('where is the user config parsed',1)[0].index,1);
});
test('small input → direct strategy, structured + verified findings',async()=>{
  const e=engine();
  const r=await e.delegate({kind:'logs',instruction:'list errors',context:'ok\nERROR disk full\nok'});
  assert.equal(r.coverage.strategy,'direct');assert.equal(r.findings[0].quote,'ERROR disk full');assert.equal(r.findings[0].verified,true);assert.equal(r.findings[0].line,2);
});
test('400KB log at 16k ctx: map-reduce reads 100% of chunks, no prompt exceeds context, errors from start/middle/end found',async()=>{
  const log=bigLog({lines:5000,errorsAt:[100,2500,4990]});assert.ok(log.length>400000,String(log.length));
  const provider=smartMock();const root=await workspace({'big.log':log});
  const e=engine({provider,root,ctxTokens:16384,maxChunks:64});
  const r=await e.delegate({kind:'logs',instruction:'List every ERROR line',paths:['big.log']});
  assert.equal(r.coverage.strategy,'map-reduce');assert.equal(r.coverage.ratio,1);assert.equal(r.coverage.chunksUsed,r.coverage.chunksTotal);
  assert.ok(r.coverage.chunksTotal>=5,'chunks '+r.coverage.chunksTotal);
  assert.ok(provider.calls.every(c=>c.prompt+c.maxTokens<=c.ctx));
  const q=r.findings.map(f=>f.quote).join('\n');for(const n of [100,2500,4990])assert.match(q,new RegExp("worker-"+n+" "));
  assert.ok(r.findings.every(f=>f.verified));assert.equal(r.findings.find(f=>/worker-4990 /.test(f.quote)).line,4990);
  assert.equal(r.localTokens.calls,r.coverage.mapCalls+1);
});
test('retrieve: focused review picks the relevant code and reports partial coverage explicitly',async()=>{
  const filler=Array.from({length:3000},(_,i)=>`function helper${i}(a, b) { return a + b * ${i}; }`).join('\n');
  const target='export function validateSessionToken(token) {\n  // FATAL bug: compares with ==\n  return token == expected;\n}';
  const root=await workspace({'src/app.js':filler.slice(0,60000)+'\n'+target+'\n'+filler.slice(60000)});
  const provider=smartMock();const e=engine({provider,root,ctxTokens:8192});
  const r=await e.delegate({kind:'review',instruction:'Review token validation',query:'validateSessionToken token',paths:['src/app.js']});
  assert.equal(r.coverage.strategy,'retrieve');assert.ok(r.coverage.ratio<1);assert.match(r.coverage.notice,/most relevant/);
  assert.ok(provider.calls.at(-1).user.includes('validateSessionToken'));
  assert.ok(provider.calls.every(c=>c.prompt+c.maxTokens<=c.ctx));
});
test('too many chunks without query → explicit error; with query → partial with notice',async()=>{
  const root=await workspace({'big.log':bigLog({lines:4400})});
  const e=engine({root,ctxTokens:4096,maxChunks:4});
  await assert.rejects(e.delegate({kind:'summarize',instruction:'summarize',paths:['big.log'],strategy:'map-reduce'}),/KVALAH_MAX_CHUNKS/);
  const r=await e.delegate({kind:'summarize',instruction:'summarize',paths:['big.log'],strategy:'map-reduce',query:'ERROR worker-4000'});
  assert.equal(r.coverage.chunksUsed,4);assert.match(r.coverage.notice,/most relevant/);assert.match(r.findings.map(f=>f.quote).join(),/worker-4000 /);
});
test('forcing direct on oversized input fails loudly instead of truncating',async()=>{
  const root=await workspace({'big.log':bigLog({lines:4400})});
  await assert.rejects(engine({root}).delegate({kind:'logs',instruction:'x',paths:['big.log'],strategy:'direct'}),/exceeds the context budget/);
});
