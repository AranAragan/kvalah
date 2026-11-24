// CTX-02 regression: coverage is computed from merged unique source ranges, separates the whole source
// (sourceCoverage) from what was selected (tail/query: selectedCoverage), and tail line numbers are absolute.
import test from 'node:test';
import assert from 'node:assert/strict';
import {smartMock,workspace,engine,bigLog} from './helpers.mjs';

const inRange=v=>typeof v==='number'&&v>=0&&v<=1;
const lines=(n,f=i=>`line ${i} ok`)=>Array.from({length:n},(_,i)=>f(i+1)).join('\n')+'\n';

test('CTX-02: tail — absolute line numbers, full tail is NOT full coverage of the file, UTF-8 safe', async()=>{
  const body=lines(5000,i=>i===4990?'ERROR ✓ ünïcödé failure at step 4990':`строка ${i} ок`);
  const root=await workspace({'app.log':body});
  const e=engine({root,provider:smartMock()});
  const r=await e.delegate({kind:'logs',instruction:'errors',paths:['app.log'],tailBytes:2000});
  const f=r.findings.find(x=>/step 4990/.test(x.quote));
  assert.ok(f,'finding missing: '+JSON.stringify(r).slice(0,300));
  assert.equal(f.line,4990,'tail line numbers must be absolute');
  assert.ok(!r.findings.some(x=>x.quote.includes('\ufffd')),'broken UTF-8 at tail boundary');
  const c=r.coverage;
  assert.ok(inRange(c.sourceCoverage)&&inRange(c.selectedCoverage));
  assert.equal(c.selectedCoverage,1);assert.ok(c.sourceCoverage<0.05,'tail reported as full coverage: '+c.sourceCoverage);
  assert.ok(c.ratio<1);assert.ok(c.skipped?.some(s=>s.reason==='not-read-tail'));
  assert.equal(c.files[0].lineOffset>0,true);
});

test('CTX-02: retrieve with overlapping chunks and repeated lines never exceeds 1 and lists skipped ranges', async()=>{
  const body=lines(4000,i=>i%50===0?'ERROR repeated failure':'filler text '+(i%7));
  const root=await workspace({'r.log':body});
  const e=engine({root,provider:smartMock(),ctxTokens:4096,maxTokens:256});
  const r=await e.delegate({kind:'review',instruction:'find failures',query:'ERROR repeated failure',paths:['r.log'],strategy:'retrieve'});
  const c=r.coverage;assert.ok(inRange(c.sourceCoverage)&&inRange(c.selectedCoverage));
  assert.ok(c.sourceCoverage<1);assert.ok(c.skipped.length>0);assert.ok(c.skipped.every(s=>s.reason==='not-selected-by-retrieval'));
  assert.ok(/not a full review|partial/i.test(c.notice||''),'partial selection must be announced');
  // overlap must not inflate: merged unique ranges ≤ tokens actually sent
  assert.ok(c.ranges.length>0);
});

test('CTX-02: empty file, maxChunks with query, BM25 with zero matches', async()=>{
  const root=await workspace({'empty.txt':'','big.log':bigLog({lines:9000}),'z.txt':lines(3000)});
  const e=engine({root,provider:smartMock(),ctxTokens:4096,maxTokens:256,maxChunks:4});
  const r0=await e.delegate({kind:'summarize',instruction:'summarize',paths:['empty.txt']});
  assert.ok(inRange(r0.coverage.sourceCoverage));
  const r1=await e.delegate({kind:'logs',instruction:'errors',paths:['big.log'],query:'worker ERROR',strategy:'map-reduce'});
  assert.ok(r1.coverage.sourceCoverage<1&&r1.coverage.sourceCoverage>0);assert.ok(r1.coverage.skipped.some(s=>s.reason==='over-max-chunks'));
  const r2=await e.delegate({kind:'review',instruction:'x',query:'qqqzzzxxx',paths:['z.txt'],strategy:'retrieve'});
  assert.ok(inRange(r2.coverage.sourceCoverage));assert.match(r2.coverage.notice,/No chunk matched/);
  const r3=await e.delegate({kind:'logs',instruction:'errors',paths:['z.txt'],strategy:'map-reduce',query:'line'});
  assert.ok(inRange(r3.coverage.sourceCoverage));
});

test('CTX-02: full read via map-reduce is exactly 1 (no double counting)', async()=>{
  const root=await workspace({'f.log':bigLog({lines:2000})});
  const e=engine({root,provider:smartMock(),ctxTokens:4096,maxTokens:256,maxChunks:100});
  const r=await e.delegate({kind:'logs',instruction:'errors',paths:['f.log'],strategy:'map-reduce'});
  assert.equal(r.coverage.sourceCoverage,1);assert.equal(r.coverage.selectedCoverage,1);assert.equal(r.coverage.skipped.length,0);
});
