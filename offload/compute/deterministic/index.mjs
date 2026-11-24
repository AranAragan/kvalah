// Level 1 — Deterministic Executor. "Never use an LLM where an algorithm suffices."
// Ops: search, outline, symbols, references, deps, hash, stats, todo. All read-only, root-scoped.
import {createHash} from 'node:crypto';
import path from 'node:path';
import {walk} from './walk.mjs';
import {outline,JS_EXT} from './ast.mjs';
import {buildGraph} from './graph.mjs';
export const OPS=['search','outline','symbols','references','deps','hash','stats','todo'];
const CODE_GLOB='**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts,py,go,rs,java,kt,cs}';
const MAX_LINE=4000;
function compilePattern(pattern,{regex=false,caseSensitive=false,word=false}={}){
  if(typeof pattern!=='string'||!pattern||pattern.length>300)throw Error('pattern must be 1–300 characters');
  let src=regex?pattern:pattern.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(regex&&/(\([^)]*[+*][^)]*\)|\[[^\]]*\][+*]|\\[wsdWSD.][+*])[+*{]/.test(src))throw Error('Regex rejected: nested quantifiers (catastrophic backtracking risk)');
  if(word)src=`(?<![\\w$])(?:${src})(?![\\w$])`;
  try{return new RegExp(src,caseSensitive?'':'i');}catch(e){throw Error('Invalid regex: '+e.message);}
}
export function createDeterministic({reader,count=null}){
  if(!reader)return null;
  const outlineCache=new Map(); // path -> {mtimeMs,size,outline}
  async function files(glob){const root=await reader.resolveRoot();return walk(root,{glob});}
  async function getOutline(p){
    const f=await reader.readText(p,{maxBytes:1_000_000});
    if(f.skipped)return {path:f.path,skipped:f.skipped};
    const c=outlineCache.get(f.path);
    if(c&&c.mtimeMs===f.mtimeMs&&c.size===f.size)return c.value;
    const value={path:f.path,lines:f.text.split('\n').length,bytes:f.size,...outline(f.text,f.path)};
    outlineCache.set(f.path,{mtimeMs:f.mtimeMs,size:f.size,value});
    return value;
  }
  async function outlines(glob=CODE_GLOB,limit=5000){
    const {files:list,truncated}=await files(glob);const m=new Map();let scannedBytes=0;
    for(const p of list.slice(0,limit)){const o=await getOutline(p).catch(()=>null);if(o&&!o.skipped){m.set(o.path,o);scannedBytes+=o.bytes;}}
    return {map:m,truncated:truncated||list.length>limit,scannedBytes};
  }
  async function grep(re,{glob,maxResults=200,contextLines=0,maxScanBytes=256_000_000}){
    const {files:list,truncated:walkTrunc}=await files(glob);const matches=[];let filesScanned=0,filesMatched=0,total=0,scannedBytes=0,scanCapped=false;
    const skipped={tooLarge:0,binary:0,changed:0,errors:0,sample:[]};
    for(const p of list){
      if(scannedBytes>=maxScanBytes){scanCapped=true;break;}
      const f=await reader.readText(p,{maxBytes:4_000_000}).catch(e=>({path:p,skipped:'errors',error:e.message}));
      if(f.skipped){const k=f.skipped==='too-large'?'tooLarge':f.skipped==='binary'?'binary':f.skipped==='changed'?'changed':'errors';skipped[k]++;if(skipped.sample.length<20)skipped.sample.push({path:f.path,reason:f.skipped});continue;}
      filesScanned++;scannedBytes+=f.size;
      const lines=f.text.split('\n');let hit=false;
      for(let i=0;i<lines.length;i++){
        const l=lines[i].length>MAX_LINE?lines[i].slice(0,MAX_LINE):lines[i];const m=re.exec(l);if(!m)continue;
        total++;hit=true;
        if(matches.length<maxResults)matches.push({path:f.path,line:i+1,col:m.index+1,text:l.trim().slice(0,300),...(contextLines?{before:lines.slice(Math.max(0,i-contextLines),i).map(s=>s.slice(0,300)),after:lines.slice(i+1,i+1+contextLines).map(s=>s.slice(0,300))}:{})});
      }
      if(hit)filesMatched++;
    }
    return {matches,totalMatches:total,filesScanned,filesMatched,scannedBytes,skipped,truncated:total>matches.length||walkTrunc||scanCapped,...(scanCapped?{scanCapped:true}:{}),...(total>matches.length?{notice:`${total} matches, first ${matches.length} returned; narrow with glob or raise maxResults`}:{})};
  }
  const ops={
    async search(a){return grep(compilePattern(a.pattern,a),{glob:a.glob,maxResults:clampInt(a.maxResults,200,1,2000),contextLines:clampInt(a.contextLines,0,0,5)});},
    async references(a){if(!a.name)throw Error('name required');return {...await grep(compilePattern(a.name,{word:true,caseSensitive:true}),{glob:a.glob||CODE_GLOB,maxResults:clampInt(a.maxResults,300,1,2000)}),precision:'textual',note:'Textual whole-word matches (not type-resolved): may include unrelated identifiers with the same name and miss aliased/re-exported uses.'};},
    async outline(a){if(!a.path)throw Error('path required');return getOutline(a.path);},
    async symbols(a){
      const {map,truncated,scannedBytes}=await outlines(a.glob||CODE_GLOB);const q=a.name?String(a.name).toLowerCase():null;
      const out=[];for(const o of map.values())for(const s of o.symbols)if(!q||s.name.toLowerCase()===q||s.name.toLowerCase().endsWith('.'+q)||(a.fuzzy&&s.name.toLowerCase().includes(q)))out.push({path:o.path,...s});
      const max=clampInt(a.maxResults,500,1,5000);
      return {symbols:out.slice(0,max),total:out.length,filesIndexed:map.size,scannedBytes,truncated:truncated||out.length>max,precision:'syntactic',note:'Declarations from the syntax tree (JS/TS) or line patterns (other languages, approximate); not type-resolved.'};
    },
    async deps(a){
      const {map,truncated,scannedBytes}=await outlines(a.glob||'**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}');
      const g=buildGraph(map);
      // completeness is never assumed: dynamic/non-literal imports, path aliases, unresolved relative imports,
      // parse errors/regex fallbacks and a truncated walk all make the graph incomplete
      const vals=[...map.values()];
      const incomplete={dynamicImports:vals.reduce((n,o)=>n+(o.dynamicNonLiteral||0),0),aliasImports:vals.reduce((n,o)=>n+(o.imports||[]).filter(i=>/^(@\/|~\/|#)/.test(i.source)).length,0),
        unresolved:g.unresolved.length,parseProblems:vals.filter(o=>o.parseErrors>0||o.approximate).length,truncated:!!truncated};
      const complete=!Object.values(incomplete).some(Boolean);
      if(a.path){const p=a.path.replace(/^\.\//,'');if(!g.edges.has(p))throw Error('Not an indexed JS/TS file: '+a.path);
        const transitive=new Set(),stack=[...g.importers.get(p)];while(stack.length){const x=stack.pop();if(transitive.has(x))continue;transitive.add(x);stack.push(...g.importers.get(x));}
        return {path:p,imports:g.edges.get(p),importedBy:g.importers.get(p),transitiveImporters:[...transitive].sort(),externals:[...new Set(map.get(p).imports.filter(i=>!i.source.startsWith('.')).map(i=>i.source))],inCycle:g.cycles.find(c=>c.includes(p))||null,scannedBytes,complete,incomplete,precision:'syntactic'};}
      const orphans=[...g.edges.keys()].filter(f=>!g.importers.get(f).length);
      return {files:g.edges.size,edges:[...g.edges.values()].reduce((n,l)=>n+l.length,0),cycles:g.cycles,externals:Object.fromEntries([...g.externals].sort((a,b)=>b[1]-a[1])),unresolved:g.unresolved.slice(0,100),entryPointsOrOrphans:orphans.slice(0,200),
        graph:a.full?Object.fromEntries(g.edges):undefined,truncated,scannedBytes,complete,incomplete,precision:'syntactic'};
    },
    async hash(a){
      let list=a.paths;if(!list){const w=await files(a.glob||'**/*');list=w.files.slice(0,2000);}
      const out=[];const all=createHash('sha256');
      for(const p of list){const f=await reader.readText(p,{maxBytes:50_000_000}).catch(e=>({path:p,error:e.message}));if(f.error||f.skipped){out.push({path:f.path,error:f.error||f.skipped});continue;}
        const h=createHash('sha256').update(f.text).digest('hex');all.update(f.path+'\0'+h+'\n');out.push({path:f.path,sha256:h,bytes:f.size});}
      return {files:out,combined:all.digest('hex'),algorithm:'sha256'};
    },
    async stats(a){
      const {files:list,truncated}=await files(a.glob||'**/*');const by={};let lines=0,bytes=0;
      for(const p of list.slice(0,10000)){const f=await reader.readText(p,{maxBytes:4_000_000}).catch(()=>null);if(!f||f.skipped)continue;const ext=path.extname(p)||'(none)';const n=f.text.split('\n').length;
        by[ext]??={files:0,lines:0,bytes:0};by[ext].files++;by[ext].lines+=n;by[ext].bytes+=f.size;lines+=n;bytes+=f.size;}
      return {files:list.length,lines,bytes,byExtension:Object.fromEntries(Object.entries(by).sort((x,y)=>y[1].lines-x[1].lines)),truncated};
    },
    async todo(a){return grep(/\b(TODO|FIXME|HACK|XXX|BUG)\b[:(]?/,{glob:a.glob||CODE_GLOB,maxResults:clampInt(a.maxResults,300,1,2000)});}
  };
  return {
    ops:OPS,
    async run(op,args={}){
      if(!OPS.includes(op))throw Error('Unknown op; expected one of '+OPS.join(', '));
      const started=Date.now();const result=await ops[op](args);
      return {level:1,op,ms:Date.now()-started,...result};
    }
  };
}
function clampInt(v,d,min,max){const n=Number.parseInt(v,10);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):d;}
