import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {heuristicTokens} from '../compute/tokens.mjs';
import {createScheduler} from '../compute/vendor/scheduler.mjs';
import {createOffload} from '../compute/offload.mjs';
import {createFileReader} from '../compute/files.mjs';
import {createCache} from '../compute/cache.mjs';

export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Deterministic "model": extracts lines matching /ERROR|FATAL/ (or a custom pattern) from the data,
// answers map prompts with quoted notes and final prompts with structured JSON. Enforces the context window.
export function smartMock({pattern=/ERROR|FATAL/,delay=0,promptRatio=1.1,overflowCheck=true,reply=null,events=null}={}){
  const calls=[];
  return {kind:'mock',base:'mock://local',calls,
    health:async()=>({online:true}),
    async *chat(req){
      const sys=req.messages[0].content,user=req.messages[1].content;
      const prompt=heuristicTokens(sys+user);
      calls.push({sys,user,prompt,ctx:req.options.context,format:!!req.format,think:req.think,maxTokens:req.options.maxTokens});
      if(overflowCheck&&prompt+req.options.maxTokens>req.options.context)throw Object.assign(Error(`context overflow: ${prompt}+${req.options.maxTokens} > ${req.options.context}`),{fatal:true});
      if(delay)await new Promise((res,rej)=>{const t=setTimeout(res,delay);req.signal?.addEventListener('abort',()=>{clearTimeout(t);rej(req.signal.reason);},{once:true});});
      if(events){yield* (typeof events==='function'?events(req):events);return;}
      const dataPart=user.slice(user.indexOf('Data:'));
      const hits=[];
      for(const l of dataPart.split('\n')){const m=/^NOTE: (.*)$/.exec(l);if(m)hits.push(m[1]);else if(pattern.test(l)&&!l.startsWith('<'))hits.push(l);}
      const isMap=/extract facts from one chunk/.test(sys);
      let text;
      if(reply)text=reply({sys,user,hits,isMap,req});
      else if(isMap)text=hits.length?hits.map(h=>'NOTE: '+h).join('\n'):'NONE';
      else if(req.format){const paths=[...user.matchAll(/path="([^"]+)"/g)].map(m=>m[1]);
        text=JSON.stringify({summary:`Found ${hits.length} matching lines`,draft:'',findings:hits.slice(0,50).map(h=>({text:'match',quote:h,path:paths[0]||''})),uncertainty:'mock'});}
      else text=hits.join('\n')||'nothing';
      yield {type:'content',text};
      yield {type:'done',reason:'stop',stats:{promptTokens:Math.round(prompt*promptRatio),tokens:Math.ceil(text.length/4)}};
    }};
}
export async function workspace(files){
  const root=await mkdtemp(path.join(tmpdir(),'kvo2-'));
  for(const [p,c] of Object.entries(files)){await mkdir(path.dirname(path.join(root,p)),{recursive:true});await writeFile(path.join(root,p),c);}
  return root;
}
export function engine({provider=smartMock(),root=null,maxParallel=2,...opts}={}){
  const scheduler=createScheduler({local:{provider,model:'mock',maxParallel},maxAttempts:1});
  return createOffload({provider,model:'mock',scheduler,readFiles:root?createFileReader({root}):null,cache:createCache(),...opts});
}
// Seeded PRNG for reproducible fixtures
export function rng(seed=42){let s=seed>>>0;return ()=>{s=(s*1664525+1013904223)>>>0;return s/2**32;};}
export function bigLog({lines=8000,seed=7,errorsAt=[100,4000,7990]}={}){
  const r=rng(seed);const out=[];
  for(let i=1;i<=lines;i++){
    if(errorsAt.includes(i))out.push(`2026-11-24T10:${String(i%60).padStart(2,'0')}:00Z ERROR worker-${i} failed: connection reset by peer (code E${i})`);
    else out.push(`2026-11-24T10:${String(i%60).padStart(2,'0')}:00Z INFO request ${Math.floor(r()*1e9).toString(36)} handled in ${Math.floor(r()*500)}ms path=/api/v1/items/${i}`);
  }
  return out.join('\n');
}
