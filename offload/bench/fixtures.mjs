// Deterministic benchmark fixtures (seeded): a CI log, a design doc, a large source file and a small JS project.
import {mkdir,writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
export function rng(seed){let s=seed>>>0;return ()=>{s=(s*1664525+1013904223)>>>0;return s/2**32;};}
export function makeFixtures(seed=2026){
  const r=rng(seed);const pick=a=>a[Math.floor(r()*a.length)];
  const failing=['cart totals include tax','login rejects expired token','search paginates results','upload retries on 503'];
  const log=[];let n=0;
  for(let i=0;i<6000;i++){
    if(i%1500===700){const t=failing[n++];log.push(`  ✖ ${t}`,`    AssertionError [ERR_ASSERTION]: expected ${Math.floor(r()*100)} to equal ${Math.floor(r()*100)}`,`      at test/${t.split(' ')[0]}.test.mjs:${10+Math.floor(r()*200)}:${1+Math.floor(r()*30)}`);continue;}
    log.push(`  ✔ ${pick(['renders','parses','computes','validates','loads'])} ${pick(['header','config','item','price','session','route'])} #${i} (${(r()*20).toFixed(3)}ms)`);
  }
  log.push(`ℹ tests ${6000} ℹ pass ${6000-4} ℹ fail 4`);
  const sections=['Overview','Storage layer','Scheduler','Network protocol','Security model','Release process'];
  const doc=sections.map(s=>`## ${s}\n\n`+Array.from({length:60},()=>`The ${s.toLowerCase()} ${pick(['handles','coordinates','validates','persists','streams'])} ${pick(['requests','chunks','sessions','tokens','events'])} ${pick(['asynchronously','atomically','in batches','per device','with retries'])}.`).join(' ')+'\n').join('\n');
  const src=Array.from({length:2500},(_,i)=>`export function util${i}(a, b) {\n  return a * ${i} + b;\n}`);
  src.splice(1300,0,`export function verifyPasswordHash(input, stored) {\n  // BUG: timing-unsafe comparison\n  return hash(input) == stored;\n}`);
  const project={
    'src/cart.mjs':"import {money} from './money.mjs';\nexport class Cart { total(items){ return money(items.reduce((s,i)=>s+i.price,0)); } }\n",
    'src/money.mjs':"export const money = n => Math.round(n*100)/100;\n",
    'src/checkout.mjs':"import {Cart} from './cart.mjs';\nimport {money} from './money.mjs';\nexport function checkout(items){ return money(new Cart().total(items)); }\n",
    'src/api.mjs':"import {checkout} from './checkout.mjs';\nimport express from 'express';\nexport const app = express();\n",
  };
  return {files:{'ci.log':log.join('\n'),'docs/architecture.md':doc,'src/big-utils.mjs':src.join('\n'),...project},failing,sections};
}
export async function writeFixtures(seed){
  const fx=makeFixtures(seed);const root=await mkdtemp(path.join(tmpdir(),'kvalah-bench-'));
  for(const [p,c] of Object.entries(fx.files)){await mkdir(path.dirname(path.join(root,p)),{recursive:true});await writeFile(path.join(root,p),c);}
  return {root,...fx};
}
// Each task: how a cloud agent would do it WITHOUT offload (what it must read), and the offload call.
export function tasks(fx){
  return [
    {id:'ci-failures',level:2,call:{kind:'logs',instruction:'List each failing test name with its assertion message and file:line.',paths:['ci.log']},
      baseline:{readFiles:['ci.log']},expect:fx.failing,mockPattern:/✖|AssertionError|\.test\.mjs:/},
    {id:'doc-summary',level:2,call:{kind:'summarize',instruction:'Summarize each section of the architecture doc in one sentence; quote each section heading.',paths:['docs/architecture.md']},
      baseline:{readFiles:['docs/architecture.md']},expect:fx.sections.map(s=>'## '+s),mockPattern:/^## /},
    {id:'security-review',level:2,call:{kind:'review',instruction:'Find security problems in password handling.',query:'password hash compare verify',paths:['src/big-utils.mjs']},
      baseline:{readFiles:['src/big-utils.mjs']},expect:['verifyPasswordHash'],mockPattern:/verifyPasswordHash|BUG/},
    {id:'who-imports-money',level:1,compute:{op:'deps',path:'src/money.mjs'},
      baseline:{grep:{pattern:"money.mjs'"}},expect:['src/cart.mjs','src/checkout.mjs']},
    {id:'find-definition',level:1,compute:{op:'symbols',name:'checkout'},
      baseline:{grep:{pattern:'function checkout'}},expect:['src/checkout.mjs']},
    {id:'tiny-inline-transform',level:2,call:{kind:'transform',instruction:'Convert to a markdown table.',context:'a=1\nb=2\nc=3'},
      baseline:{inline:true},expect:['a'],mockPattern:/=/},
  ];
}
