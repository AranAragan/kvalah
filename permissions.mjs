import fs from 'node:fs/promises';
import path from 'node:path';

export function contains(root,target){
  const rel=path.relative(root,target);
  return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));
}
export async function canonicalPath(input){
  let probe=path.resolve(input),suffix=[];
  while(true){
    try{return path.join(await fs.realpath(probe),...suffix);}
    catch(e){
      if(e.code!=='ENOENT')throw e;
      const parent=path.dirname(probe);if(parent===probe)throw e;
      suffix.unshift(path.basename(probe));probe=parent;
    }
  }
}
export async function accessPath(run,input,mode,kind,approve){
  if(typeof input!=='string'||input.includes('\0'))throw Error('Некорректный путь');
  const target=await canonicalPath(path.resolve(run.conf.workspace,input));
  const root=await fs.realpath(run.conf.workspace);
  run.grants??=[];
  const allowed=()=>contains(root,target)||run.grants.some(g=>(g.path===target||(g.kind==='directory'&&contains(g.path,target)))&&(g.mode==='write'||mode==='read'));
  if(!allowed()){
    const grant={path:target,mode,kind};
    if(!await approve(grant))return null;
    if(run.controller.signal.aborted)throw Error('Действие остановлено');
    // Permissions are scoped to this task, never to subsequent conversations.
    run.grants.push(grant);
  }
  // Re-resolve after the human approval to detect changed junctions/symlinks.
  if(await canonicalPath(path.resolve(run.conf.workspace,input))!==target)throw Error('Путь изменился во время подтверждения. Запросите доступ заново.');
  return target;
}
