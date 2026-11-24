// Workspace walker: never follows symlinks, skips VCS/dependency/build dirs and secret-looking files.
import {opendir} from 'node:fs/promises';
import path from 'node:path';
import {isDenied} from '../files.mjs';
export const SKIP_DIRS=new Set(['.git','node_modules','.hg','.svn','dist','build','out','coverage','.next','.nuxt','.cache','.venv','venv','__pycache__','target','.idea','.vscode','vendor','bower_components','.turbo','.parcel-cache']);
export function globToRegExp(glob){
  let re='',i=0;
  while(i<glob.length){
    const c=glob[i];
    if(c==='*'){if(glob[i+1]==='*'){re+=glob[i+2]==='/'?'(?:.*/)?':'.*';i+=glob[i+2]==='/'?3:2;continue;}re+='[^/]*';}
    else if(c==='?')re+='[^/]';
    else if(c==='{'){const end=glob.indexOf('}',i);if(end>i){re+='(?:'+glob.slice(i+1,end).split(',').map(s=>s.replace(/[.+^$()|[\]\\]/g,'\\$&').replace(/\*/g,'[^/]*')).join('|')+')';i=end+1;continue;}re+='\\{';}
    else re+=c.replace(/[.+^$()|[\]\\]/g,'\\$&');
    i++;
  }
  return new RegExp('^'+re+'$');
}
export async function walk(rootReal,{glob=null,maxFiles=20000,maxEntries=200000,signal}={}){
  const re=glob?globToRegExp(glob.replace(/^\.\//,'')):null;
  const out=[];let truncated=false,entries=0;
  const SKIP_LC=new Set([...SKIP_DIRS].map(d=>d.toLowerCase()));
  async function rec(dir,rel){
    if(truncated)return;signal?.throwIfAborted();
    let d;try{d=await opendir(dir);}catch{return;}
    for await(const ent of d){
      if(out.length>=maxFiles||++entries>maxEntries){truncated=true;break;}
      const r=rel?rel+'/'+ent.name:ent.name;
      if(ent.isSymbolicLink())continue;
      if(ent.isDirectory()){if(!SKIP_LC.has(ent.name.toLowerCase())&&!isDenied(r+'/'))await rec(path.join(dir,ent.name),r);continue;}
      if(!ent.isFile()||isDenied(r))continue;
      if(re&&!re.test(r)&&!(glob&&!glob.includes('/')&&re.test(ent.name)))continue;
      out.push(r);
    }
  }
  await rec(rootReal,'');
  out.sort();
  return {files:out,truncated};
}
