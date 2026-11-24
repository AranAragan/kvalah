// Dependency graph over relative imports; Tarjan SCC for cycles.
import path from 'node:path';
const EXTS=['','.js','.mjs','.cjs','.jsx','.ts','.tsx','.mts','.cts','/index.js','/index.ts','/index.mjs','/index.tsx','/index.jsx'];
export function resolveImport(from,spec,fileSet){
  if(!spec.startsWith('.')&&!spec.startsWith('/'))return null;
  const base=path.posix.normalize(path.posix.join(path.posix.dirname(from),spec));
  for(const e of EXTS){const c=base+e;if(fileSet.has(c))return c;}
  // TS: import './x.js' that maps to x.ts
  const noext=base.replace(/\.(m?js|cjs|jsx)$/,'');
  for(const e of ['.ts','.tsx','.mts','.cts'])if(fileSet.has(noext+e))return noext+e;
  return undefined; // relative but unresolved
}
export function buildGraph(outlines){ // outlines: Map(path -> {imports})
  const files=new Set(outlines.keys());const edges=new Map(),externals=new Map(),unresolved=[];
  for(const [f,o] of outlines){
    const out=new Set();
    for(const imp of o.imports||[]){
      const r=resolveImport(f,imp.source,files);
      if(r===null){const pkg=imp.source.startsWith('@')?imp.source.split('/').slice(0,2).join('/'):imp.source.split('/')[0];if(!pkg.startsWith('node:'))externals.set(pkg,(externals.get(pkg)||0)+1);}
      else if(r===undefined)unresolved.push({from:f,source:imp.source,line:imp.line});
      else out.add(r);
    }
    edges.set(f,[...out].sort());
  }
  const importers=new Map([...files].map(f=>[f,[]]));
  for(const [f,list] of edges)for(const t of list)importers.get(t).push(f);
  return {edges,importers,externals,unresolved,cycles:tarjan(edges)};
}
function tarjan(edges){
  let index=0;const idx=new Map(),low=new Map(),stack=[],on=new Set(),out=[];
  const strong=v=>{
    idx.set(v,index);low.set(v,index);index++;stack.push(v);on.add(v);
    for(const w of edges.get(v)||[]){if(!idx.has(w)){strong(w);low.set(v,Math.min(low.get(v),low.get(w)));}else if(on.has(w))low.set(v,Math.min(low.get(v),idx.get(w)));}
    if(low.get(v)===idx.get(v)){const c=[];let w;do{w=stack.pop();on.delete(w);c.push(w);}while(w!==v);if(c.length>1||(edges.get(v)||[]).includes(v))out.push(c.sort());}
  };
  for(const v of edges.keys())if(!idx.has(v))strong(v);
  return out;
}
