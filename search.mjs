// Read-only project search: .gitignore-aware walking, code search (ripgrep with JS fallback),
// glob file search and a lightweight regex symbol outline.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const HEAVY_DIRS=new Set(['node_modules','.git','.kvalah','.venv','venv','env','__pycache__','.mypy_cache','.pytest_cache','.ruff_cache','.tox','target','obj','.next','.nuxt','.svelte-kit','.gradle','.vs','.idea','dist','build','out','vendor','coverage','.cache','.parcel-cache','.turbo']);
const BINARY_EXT=/\.(exe|dll|pdb|so|dylib|bin|pak|png|jpe?g|gif|webp|ico|bmp|zip|7z|rar|gz|tgz|xz|pdf|docx?|xlsx?|pptx?|mp[34]|wav|ogg|mov|avi|woff2?|ttf|otf|eot|class|jar|pyc|o|a|lib|node|wasm|db|sqlite)$/i;

export function globToRegExp(glob){
  let re='',i=0;const g=String(glob);
  while(i<g.length){
    const c=g[i];
    if(c==='*'){if(g[i+1]==='*'){const slash=g[i+2]==='/';re+=slash?'(?:.*/)?':'.*';i+=slash?3:2;continue;}re+='[^/]*';}
    else if(c==='?')re+='[^/]';
    else if(c==='['){const end=g.indexOf(']',i);if(end>i){re+='['+g.slice(i+1,end).replace(/^!/,'^').replace(/\\/g,'\\\\')+']';i=end+1;continue;}re+='\\[';}
    else if(c==='{'){const end=g.indexOf('}',i);if(end>i){re+='(?:'+g.slice(i+1,end).split(',').map(p=>p.replace(/[.+^$()|\\]/g,'\\$&').replace(/\*/g,'[^/]*')).join('|')+')';i=end+1;continue;}re+='\\{';}
    else re+=/[.+^$()|\\\]]/.test(c)?'\\'+c:c;
    i++;
  }
  return re;
}
export function parseIgnore(text,base=''){
  const rules=[];
  for(let line of String(text).split(/\r?\n/)){
    if(!line.trim()||line.startsWith('#'))continue;
    line=line.replace(/(?<!\\)\s+$/,'');
    let negate=false;if(line.startsWith('!')){negate=true;line=line.slice(1);}
    if(line.startsWith('\\'))line=line.slice(1);
    const dirOnly=line.endsWith('/');if(dirOnly)line=line.slice(0,-1);
    const anchored=line.includes('/');line=line.replace(/^\//,'');
    if(!line)continue;
    const body=globToRegExp(line);
    rules.push({negate,dirOnly,base,regex:new RegExp(anchored?'^'+body+'(?:/.*)?$':'(?:^|/)'+body+'(?:/.*)?$')});
  }
  return rules;
}
// rel uses forward slashes, relative to the walk root.
export function ignored(rules,rel,isDir){
  let result=false;
  for(const r of rules){
    let p=rel;if(r.base){if(!(p===r.base||p.startsWith(r.base+'/')))continue;p=p.slice(r.base.length+1);if(!p)continue;}
    if(r.dirOnly&&!isDir)continue;
    if(r.regex.test(p))result=!r.negate;
  }
  return result;
}
// Walks files under root honoring .gitignore files (root and nested) and heavy build folders.
export async function walkFiles(root,{start=root,limit=5000,maxDepth=40,dirs=false,heavy=true}={}){
  const out=[];let rules=[];
  try{rules=parseIgnore(await fs.readFile(path.join(root,'.gitignore'),'utf8'));}catch{}
  try{rules.push(...parseIgnore(await fs.readFile(path.join(root,'.git','info','exclude'),'utf8')));}catch{}
  const toRel=p=>path.relative(root,p).split(path.sep).join('/');
  async function walk(dir,depth,local){
    if(depth>maxDepth||out.length>=limit)return;
    let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{return;}
    const relDir=toRel(dir);
    let scoped=local;
    if(dir!==root&&entries.some(e=>e.name==='.gitignore'&&e.isFile())){try{scoped=[...local,...parseIgnore(await fs.readFile(path.join(dir,'.gitignore'),'utf8'),relDir)];}catch{}}
    const names=new Set(entries.map(e=>e.name));
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    for(const e of entries){
      if(out.length>=limit)return;
      if(e.isSymbolicLink())continue;
      const full=path.join(dir,e.name),rel=toRel(full),isDir=e.isDirectory();
      if(isDir&&heavy&&(HEAVY_DIRS.has(e.name)||e.name==='bin'&&names.has('obj')))continue;
      if(isDir&&e.name==='.git')continue;
      if(ignored(scoped,rel,isDir))continue;
      if(isDir){if(dirs)out.push({path:rel,full,dir:true});await walk(full,depth+1,scoped);}
      else if(e.isFile())out.push({path:rel,full,dir:false});
    }
  }
  await walk(start,0,rules);
  return {files:out,truncated:out.length>=limit};
}

// Splits "a,b;c" but keeps commas inside {x,y} alternatives.
function splitGlobs(glob){const out=[];let depth=0,cur='';for(const c of String(glob||'')){if(c==='{')depth++;if(c==='}')depth=Math.max(0,depth-1);if((c===','||c===';')&&!depth){if(cur.trim())out.push(cur.trim());cur='';}else cur+=c;}if(cur.trim())out.push(cur.trim());return out;}
function matchGlob(glob,rel){
  if(!glob)return true;
  const patterns=splitGlobs(glob);
  return patterns.some(p=>{const re=new RegExp('^'+globToRegExp(p)+'$');return re.test(rel)||(!p.includes('/')&&re.test(rel.split('/').pop()));});
}
export async function findFiles(root,{pattern='**/*',start=root,limit=200}={}){
  const {files}=await walkFiles(root,{start,limit:20000});
  const hits=files.filter(f=>matchGlob(pattern,f.path));
  return {pattern,files:hits.slice(0,limit).map(f=>f.path),total:hits.length,truncated:hits.length>limit};
}

const ROOT=path.dirname(fileURLToPath(import.meta.url));
let rgPath;
async function ripgrep(){
  if(rgPath!==undefined)return rgPath;
  for(const candidate of [process.env.KVALAH_RG,path.join(ROOT,'bin',process.platform==='win32'?'rg.exe':'rg'),'rg'].filter(Boolean)){
    const ok=await new Promise(resolve=>{const c=spawn(candidate,['--version'],{windowsHide:true,stdio:'ignore'});c.on('error',()=>resolve(false));c.on('close',code=>resolve(code===0));});
    if(ok)return rgPath=candidate;
  }
  return rgPath=null;
}
export function resetRipgrepCache(){rgPath=undefined;}
function searchRegex(pattern,{regex,caseSensitive}){
  const source=regex?pattern:pattern.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(source,caseSensitive?'':'i');
}
// Returns {matches:[{path,line,text}],engine,truncated}.
export async function searchCode(root,{pattern,start=root,glob,regex=false,caseSensitive=false,maxResults=80,useRipgrep=true}={}){
  if(!pattern)throw Error('pattern is required');
  const re=searchRegex(pattern,{regex,caseSensitive});
  const rg=useRipgrep?await ripgrep():null;
  if(rg){
    const args=['--line-number','--no-heading','--color','never','--no-require-git','--max-columns','400','--max-count','30',...[...HEAVY_DIRS].flatMap(d=>['--glob','!**/'+d+'/**'])];
    if(!regex)args.push('--fixed-strings');args.push(caseSensitive?'--case-sensitive':'--ignore-case');
    for(const g of splitGlobs(glob))args.push('--glob',g);
    args.push('--regexp',pattern,'--',path.relative(root,start)||'.');
    const result=await new Promise(resolve=>{
      const child=spawn(rg,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';
      const timer=setTimeout(()=>child.kill(),20000);
      child.stdout.on('data',c=>{if(out.length<400000)out+=c;});child.stderr.on('data',c=>{err+=c;});
      child.on('error',()=>{clearTimeout(timer);resolve(null);});
      child.on('close',code=>{clearTimeout(timer);resolve(code===0||code===1?out:code===2&&out?out:null);});
    });
    if(result!==null){
      const matches=[];
      for(const line of result.split(/\r?\n/)){const m=/^(.*?):(\d+):(.*)$/.exec(line);if(!m)continue;matches.push({path:m[1].replace(/\\/g,'/').replace(/^\.\//,''),line:Number(m[2]),text:m[3].trim().slice(0,300)});if(matches.length>=maxResults)break;}
      return {pattern,engine:'ripgrep',matches,truncated:matches.length>=maxResults};
    }
  }
  const {files}=await walkFiles(root,{start,limit:20000}),matches=[];
  for(const f of files){
    if(BINARY_EXT.test(f.path)||!matchGlob(glob,f.path))continue;
    let stat;try{stat=await fs.stat(f.full);}catch{continue;}
    if(stat.size>1500000)continue;
    const data=await fs.readFile(f.full);if(data.subarray(0,8000).includes(0))continue;
    const lines=data.toString('utf8').split(/\r?\n/);
    for(let i=0;i<lines.length;i++){if(re.test(lines[i])){matches.push({path:f.path,line:i+1,text:lines[i].trim().slice(0,300)});if(matches.length>=maxResults)return {pattern,engine:'builtin',matches,truncated:true};}}
  }
  return {pattern,engine:'builtin',matches,truncated:false};
}

const OUTLINE=[
  [/\.(m?[jt]sx?|cjs|mts|cts)$/i,[
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/,'function'],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/,'class'],
    [/^\s*(?:export\s+)?interface\s+([\w$]+)/,'interface'],
    [/^\s*(?:export\s+)?type\s+([\w$]+)\s*(?:<[^>]*>)?\s*=/,'type'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/,'function'],
    [/^\s*(?:export\s+)?enum\s+([\w$]+)/,'enum'],
    [/^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b|function\b)([\w$]+)\s*\([^)]*\)\s*\{\s*$/,'method']]],
  [/\.py$/i,[[/^\s*(?:async\s+)?def\s+(\w+)/,'function'],[/^\s*class\s+(\w+)/,'class']]],
  [/\.(cs|java|kt|scala)$/i,[
    [/^\s*(?:[\w\[\]]+\s+)*(?:class|interface|enum|struct|record|object)\s+(\w+)/,'type'],
    [/^\s*(?:(?:public|private|protected|internal|static|override|virtual|abstract|async|final|sealed|suspend|fun)\s+)+[\w<>\[\],.? ]*?\b(\w+)\s*\([^;]*$/,'method']]],
  [/\.go$/i,[[/^func\s+(?:\([^)]*\)\s*)?(\w+)/,'function'],[/^type\s+(\w+)/,'type']]],
  [/\.rs$/i,[[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/,'function'],[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod|type)\s+(\w+)/,'type'],[/^\s*impl(?:<[^>]*>)?\s+([\w:<>]+)/,'impl']]],
  [/\.(c|h|cc|cpp|hpp|cxx)$/i,[[/^\s*(?:class|struct|enum|namespace)\s+(\w+)/,'type'],[/^[\w:<>*&\s]+?\b(\w+)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/,'function']]],
  [/\.(ps1|psm1)$/i,[[/^\s*function\s+([\w-]+)/i,'function']]],
  [/\.(md|markdown)$/i,[[/^(#{1,4})\s+(.+)/,'heading']]],
];
export function outline(file,text,limit=300){
  const entry=OUTLINE.find(([ext])=>ext.test(file));if(!entry)return {supported:false,symbols:[]};
  const symbols=[];const lines=text.split(/\r?\n/);
  for(let i=0;i<lines.length&&symbols.length<limit;i++){
    for(const [re,kind] of entry[1]){const m=re.exec(lines[i]);if(m){symbols.push({line:i+1,kind,name:kind==='heading'?m[2].trim():m[1],indent:/^\s*/.exec(lines[i])[0].length});break;}}
  }
  return {supported:true,symbols,truncated:symbols.length>=limit};
}
