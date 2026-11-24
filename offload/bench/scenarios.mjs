// QA-02: paired benchmark scenarios (seeded corpus + ≥50 tasks). Each scenario is defined once and used by
// both arms: baseline = the same agent with its normal tools; hybrid = the same agent with Kvalah.
//   prompt     — the task as given to the agent (identical in both arms)
//   assert     — objective check of the final answer: every string in `includes` must appear
//   baseline   — what a normal agent reads (mock token estimate only): {read:[paths]} | {grep} | {inline} | {alreadyRead}
//   hybrid     — the Kvalah call the hybrid arm is expected to make: {tool:'compute'|'delegate'|'auto', args}
//   eligible   — part of the pre-declared target set for the savings gate (short / already-read tasks are not:
//                they form the small-task set where Kvalah must not raise cost)
//   mockPattern— lines the deterministic mock model "finds" (mock runs only)
import {mkdir,writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {rng} from './fixtures.mjs';

export function makeCorpus(seed=2026){
  const r=rng(seed);const pick=a=>a[Math.floor(r()*a.length)];const files={};const facts={logs:[],docs:[],review:[],tests:[]};
  // 8 CI logs of different sizes; logs 6–7 have their failures in the last 64 KB (tail scenarios)
  const verbs=['renders','parses','computes','validates','loads','merges'],nouns=['header','config','item','price','session','route','cache','token'];
  for(let k=0;k<8;k++){
    const n=2000+k*900,fails=Array.from({length:2+k%3},(_,j)=>`suite${k} ${pick(verbs)} ${pick(nouns)} case ${j}`);const out=[];
    const at=k>=6?fails.map((_,j)=>n-30-j*7):fails.map((_,j)=>Math.floor((j+1)*n/(fails.length+1)));
    for(let i=0;i<n;i++){const f=at.indexOf(i);
      if(f>=0){out.push(`  ✖ ${fails[f]}`,`    AssertionError [ERR_ASSERTION]: expected ${Math.floor(r()*100)} to equal ${Math.floor(r()*100)}`,`      at test/suite${k}.test.mjs:${10+f}:5`);continue;}
      out.push(`  ✔ ${pick(verbs)} ${pick(nouns)} #${i} (${(r()*20).toFixed(3)}ms)`);}
    files[`logs/ci-${k}.log`]=out.join('\n');facts.logs.push(fails);
  }
  // 6 design docs
  const topics=['storage','scheduler','network','security','release','telemetry'];
  for(const t of topics){const heads=[`Overview of ${t}`,`${t} data model`,`${t} failure modes`,`${t} rollout`];
    files[`docs/${t}.md`]=heads.map(h=>`## ${h}\n\n`+Array.from({length:40},()=>`The ${t} ${pick(['layer','module','service'])} ${pick(['handles','validates','persists','streams'])} ${pick(['requests','chunks','events'])} ${pick(['atomically','in batches','with retries'])}.`).join(' ')+'\n').join('\n');
    facts.docs.push({topic:t,heads});}
  // 6 large files for pre-review, one planted defect each
  const bugs=[['runUserScript','return eval(input);'],['findUser','return db.query("SELECT * FROM users WHERE name = \'" + name + "\'");'],
    ['checkPassword','return hash(input) == stored; // timing-unsafe'],['newSessionToken','return Math.random().toString(36);'],
    ['convertFile','return exec("convert " + userPath);'],['renderComment','el.innerHTML = comment.body;']];
  bugs.forEach(([fn,line],k)=>{const src=Array.from({length:1200},(_,i)=>`export function helper${k}_${i}(a, b) {\n  return a * ${i} + b;\n}`);
    src.splice(500+k*60,0,`export function ${fn}(input, stored, name, userPath, comment, el, db) {\n  ${line}\n}`);
    files[`src/review/r${k}.mjs`]=src.join('\n');facts.review.push({fn,file:`src/review/r${k}.mjs`});});
  // 5 small modules without tests (test drafting)
  for(let k=0;k<5;k++){const fns=[`parseAmount${k}`,`formatAmount${k}`,`roundAmount${k}`];
    files[`src/money/m${k}.mjs`]=fns.map((f,i)=>`export function ${f}(x) {\n  // ${pick(['handles','normalizes','checks'])} input\n  return ${['Number(x)','String(x)','Math.round(x)'][i]};\n}`).join('\n\n')+'\n';
    facts.tests.push({file:`src/money/m${k}.mjs`,fns});}
  // a larger repo: 60 modules in 6 packages, import chains, one cycle, TODOs, a widely used factory
  for(let p=0;p<6;p++)for(let m=0;m<10;m++){
    const imp=m>0?`import {mod${p}_${m-1}} from './mod${m-1}.mjs';\n`:p>0?`import {createWidget} from '../pkg0/widget.mjs';\n`:'';
    files[`src/pkg${p}/mod${m}.mjs`]=`${imp}export function mod${p}_${m}(x) {\n  ${m%4===0?'// TODO: handle negative input\n  ':''}return ${m>0?`mod${p}_${m-1}(x) + 1`:p>0?'createWidget(x).size':'x'};\n}\n`;}
  files['src/pkg0/widget.mjs']="export function createWidget(size) {\n  return {size};\n}\n";
  files['src/cycle/a.mjs']="import {b} from './b.mjs';\nexport const a = () => b();\n";
  files['src/cycle/b.mjs']="import {a} from './a.mjs';\nexport const b = () => 1 || a();\n";
  files['src/api/deprecated.mjs']="export function legacyFetch(url) {\n  return deprecatedApi(url);\n}\nfunction deprecatedApi(u) { return u; }\n";
  files['src/config.mjs']="export const port = Number(process.env.APP_PORT || 8080);\nexport const mode = process.env.APP_MODE || 'dev';\n";
  files['README.md']='# Bench corpus\n\nSmall project used by the paired benchmark.\n';
  return {files,facts};
}
export async function writeCorpus(seed=2026){
  const c=makeCorpus(seed);const root=await mkdtemp(path.join(tmpdir(),'kvalah-paired-'));
  for(const [p,t] of Object.entries(c.files)){await mkdir(path.dirname(path.join(root,p)),{recursive:true});await writeFile(path.join(root,p),t);}
  return {root,...c};
}

export function scenarios(corpus){
  const {facts}=corpus;const S=[];const add=s=>S.push({eligible:!['short','already-read'].includes(s.category),...s});
  const LOGPAT=/✖|AssertionError|\.test\.mjs:/;
  // ci-log (10): whole log, failures only, tail reads
  facts.logs.forEach((fails,k)=>add({id:`ci-log-${k}`,category:'ci-log',prompt:`Which tests failed in logs/ci-${k}.log? Give each test name with its assertion and file:line.`,
    baseline:{read:[`logs/ci-${k}.log`]},hybrid:{tool:'delegate',args:{kind:'logs',instruction:'List each failing test with its assertion message and file:line.',paths:[`logs/ci-${k}.log`],...(k>=6?{tailBytes:65536}:{})}},
    assert:{includes:fails},mockPattern:LOGPAT}));
  [0,3].forEach(k=>add({id:`ci-log-count-${k}`,category:'ci-log',prompt:`How many tests failed in logs/ci-${k}.log and in which test files?`,baseline:{read:[`logs/ci-${k}.log`]},
    hybrid:{tool:'delegate',args:{kind:'logs',instruction:'Count failing tests and list their test files.',paths:[`logs/ci-${k}.log`],query:'failed AssertionError test.mjs'}},assert:{includes:[`test/suite${k}.test.mjs`]},mockPattern:LOGPAT}));
  // search (6)
  const search=[['search-env','Where does the code read environment variables?',{op:'search',pattern:'process.env'},['src/config.mjs'],'process.env'],
    ['search-deprecated','Where is deprecatedApi used?',{op:'search',pattern:'deprecatedApi('},['src/api/deprecated.mjs'],'deprecatedApi'],
    ['search-innerhtml','Find all innerHTML assignments.',{op:'search',pattern:'innerHTML'},['src/review/r5.mjs'],'innerHTML'],
    ['search-eval','Is eval used anywhere?',{op:'search',pattern:'eval('},['src/review/r0.mjs'],'eval('],
    ['search-todo','List the TODO comments in src/.',{op:'todo',glob:'src/**'},['src/pkg0/mod0.mjs','src/pkg5/mod8.mjs'],'TODO'],
    ['search-exec','Where is a shell command built from user input?',{op:'search',pattern:'exec("'},['src/review/r4.mjs'],'exec(']];
  for(const [id,prompt,args,inc,grep] of search)add({id,category:'search',prompt,baseline:{grep},hybrid:{tool:'compute',args},assert:{includes:inc}});
  // outline-deps (6)
  add({id:'deps-importers-widget',category:'outline-deps',prompt:'Which files import src/pkg0/widget.mjs?',baseline:{grep:'widget.mjs'},hybrid:{tool:'compute',args:{op:'deps',path:'src/pkg0/widget.mjs'}},assert:{includes:['src/pkg1/mod0.mjs','src/pkg5/mod0.mjs']}});
  add({id:'deps-cycle',category:'outline-deps',prompt:'Are there import cycles? Name the files.',baseline:{grep:'import '},hybrid:{tool:'compute',args:{op:'deps'}},assert:{includes:['src/cycle/a.mjs','src/cycle/b.mjs']}});
  add({id:'deps-transitive',category:'outline-deps',prompt:'What transitively depends on src/pkg2/mod3.mjs?',baseline:{grep:'mod3.mjs'},hybrid:{tool:'compute',args:{op:'deps',path:'src/pkg2/mod3.mjs'}},assert:{includes:['src/pkg2/mod9.mjs']}});
  add({id:'outline-review',category:'outline-deps',prompt:'Outline src/review/r2.mjs: is there a checkPassword function and where?',baseline:{read:['src/review/r2.mjs']},hybrid:{tool:'compute',args:{op:'outline',path:'src/review/r2.mjs'}},assert:{includes:['checkPassword']}});
  add({id:'symbols-createWidget',category:'outline-deps',prompt:'Where is createWidget defined?',baseline:{grep:'function createWidget'},hybrid:{tool:'compute',args:{op:'symbols',name:'createWidget'}},assert:{includes:['src/pkg0/widget.mjs']}});
  add({id:'references-createWidget',category:'outline-deps',prompt:'List the textual references to createWidget.',baseline:{grep:'createWidget'},hybrid:{tool:'compute',args:{op:'references',name:'createWidget'}},assert:{includes:['src/pkg3/mod0.mjs']}});
  // docs (6)
  facts.docs.forEach(({topic,heads})=>add({id:`docs-${topic}`,category:'docs',prompt:`Summarize docs/${topic}.md section by section (quote each heading).`,baseline:{read:[`docs/${topic}.md`]},
    hybrid:{tool:'delegate',args:{kind:'summarize',instruction:'One sentence per section; quote each section heading.',paths:[`docs/${topic}.md`]}},assert:{includes:heads.map(h=>'## '+h)},mockPattern:/^## /}));
  // tests (5)
  facts.tests.forEach(({file,fns},k)=>add({id:`tests-m${k}`,category:'tests',prompt:`Draft node:test unit tests for every exported function in ${file}.`,baseline:{read:[file]},
    hybrid:{tool:'delegate',args:{kind:'tests',instruction:'Draft node:test unit tests for every exported function; quote each signature.',paths:[file]}},assert:{includes:fns},mockPattern:/^export function/}));
  // pre-review (6)
  facts.review.forEach(({fn,file},k)=>add({id:`review-r${k}`,category:'pre-review',prompt:`Pre-review ${file} for security problems; quote the offending line.`,baseline:{read:[file]},
    hybrid:{tool:'delegate',args:{kind:'review',instruction:'Find security problems; quote the offending line.',query:'eval query SELECT password hash random exec innerHTML input',paths:[file]}},assert:{includes:[fn]},mockPattern:new RegExp(`function ${fn}\\b|eval\\(|SELECT|==|Math\\.random|exec\\(|innerHTML`)}));
  // large-repo (5)
  const pkgFiles=Array.from({length:10},(_,m)=>`src/pkg4/mod${m}.mjs`);
  add({id:'repo-summary-pkg4',category:'large-repo',prompt:'Summarize what package src/pkg4 does, file by file.',baseline:{read:pkgFiles},hybrid:{tool:'delegate',args:{kind:'summarize',instruction:'One line per file: what it exports and imports.',paths:pkgFiles}},assert:{includes:['mod4_9']},mockPattern:/^export function/});
  add({id:'repo-stats',category:'large-repo',prompt:'How many source files and lines does the repository have, by extension?',baseline:{grep:'export'},hybrid:{tool:'compute',args:{op:'stats'}},assert:{includes:['.mjs']}});
  add({id:'repo-graph',category:'large-repo',prompt:'Give the import graph summary: file count, cycles, entry points.',baseline:{grep:'import '},hybrid:{tool:'compute',args:{op:'deps'}},assert:{includes:['cycles']}});
  add({id:'repo-symbols-mod',category:'large-repo',prompt:'Where is mod3_7 defined?',baseline:{grep:'function mod3_7'},hybrid:{tool:'compute',args:{op:'symbols',name:'mod3_7'}},assert:{includes:['src/pkg3/mod7.mjs']}});
  add({id:'repo-review-all',category:'large-repo',prompt:'Pre-review src/review/r1.mjs and src/review/r3.mjs together for injection and weak randomness.',baseline:{read:['src/review/r1.mjs','src/review/r3.mjs']},
    hybrid:{tool:'delegate',args:{kind:'review',instruction:'Find injection and weak randomness; quote lines.',query:'SELECT query random token',paths:['src/review/r1.mjs','src/review/r3.mjs']}},assert:{includes:['findUser','newSessionToken']},mockPattern:/function findUser|function newSessionToken|SELECT|Math\.random/});
  // short (5): tiny inline inputs — the router must answer "do it yourself"
  const short=[['short-table','Convert to a markdown table: a=1, b=2',['a','1']],['short-rename','Rename variable x to count in: let x = 0; x++;',['count']],
    ['short-json','Make this valid JSON: {a:1}',['"a"']],['short-regex','Write a regex for a 4-digit year.',['\\d{4}']],['short-commit','Write a commit message for: fix typo in README',['typo']]];
  for(const [id,prompt,inc] of short)add({id,category:'short',prompt,baseline:{inline:true},hybrid:{tool:'auto',args:{goal:prompt,context:prompt.split(':').slice(1).join(':')||prompt}},assert:{includes:inc}});
  // already-read (5): the agent already has the file in context
  const read=[['read-config','src/config.mjs','Which env vars does src/config.mjs use?',['APP_PORT']],['read-widget','src/pkg0/widget.mjs','What does createWidget return?',['size']],
    ['read-cycle','src/cycle/a.mjs','What does a.mjs import?',['b.mjs']],['read-deprecated','src/api/deprecated.mjs','What does legacyFetch call?',['deprecatedApi']],['read-readme','README.md','What is this project?',['benchmark']]];
  for(const [id,file,prompt,inc] of read)add({id,category:'already-read',prompt:`(file already open) ${prompt}`,baseline:{alreadyRead:[file]},hybrid:{tool:'auto',args:{goal:prompt,paths:[file],contextAlreadyLoaded:true}},assert:{includes:inc}});
  return S;
}
